-- =============================================================================
-- Phase 0 Foundation Migration: 0001_phase0_foundation.sql
--
-- 目的:
-- 1. 既存カラム・既存データを一切削除せず、4軸ステータス・外部注文ID・返金額カラムを追加
-- 2. 既存の `status = 'cancelled'` レコードは意味が曖昧（受渡完了 or 注文取消）なため、
--    推測で書き換えず 4軸カラムを NULL（未判定 `legacy_undetermined`）のまま保持
-- 3. 進行中（`unpaid` / `pending` / `preparing` / `completed`）のレコードのみ安全にバックフィル
-- 4. Vercel 複数インスタンス間で一意性が保証される PostgreSQL 原子的採番テーブルと RPC 関数を作成
-- 5. Stripe Webhook の重複排除テーブルおよびスタッフ認証・レートリミット用永続テーブルを作成
-- 6. RLS (Row Level Security) を有効化し、ブラウザからの anon キー直アクセスを遮断しつつ
--    サーバーサイド (service_role / secret key) のみ操作可能に設定
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. orders テーブルの非破壊カラム拡張
-- -----------------------------------------------------------------------------
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS store_id TEXT NOT NULL DEFAULT 'kenocha_main',
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'mobile',
  ADD COLUMN IF NOT EXISTS external_order_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_status TEXT,
  ADD COLUMN IF NOT EXISTS production_status TEXT,
  ADD COLUMN IF NOT EXISTS fulfillment_status TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_status TEXT,
  ADD COLUMN IF NOT EXISTS refunded_amount INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_status TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS requires_manual_attention BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stripe_session_id TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 値ドメインの CHECK 制約（NULL 許容により過去データの未判定状態を保持）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_payment_status_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_payment_status_check
      CHECK (payment_status IS NULL OR payment_status IN ('unpaid', 'paid', 'partially_refunded', 'refunded', 'failed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_refund_status_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_refund_status_check
      CHECK (refund_status IN ('none', 'pending', 'processing', 'succeeded', 'failed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_production_status_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_production_status_check
      CHECK (production_status IS NULL OR production_status IN ('pending', 'preparing', 'ready'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_fulfillment_status_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_fulfillment_status_check
      CHECK (fulfillment_status IS NULL OR fulfillment_status IN ('not_handed_over', 'handed_over'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_cancellation_status_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_cancellation_status_check
      CHECK (cancellation_status IS NULL OR cancellation_status IN ('active', 'cancelled'));
  END IF;
END $$;

-- 外部注文の二重登録を防止する部分一意インデックス
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_source_external_order_id
  ON public.orders (source, external_order_id)
  WHERE external_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_store_created_at
  ON public.orders (store_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 2. 既存データの安全なバックフィル（意味が確定している進行中ステータスのみ）
-- ※ status = 'cancelled' の過去レコードは受渡完了か注文取消か判別不能なため、
--   推測で変更せず NULL（legacy_undetermined）のまま保持します。
-- -----------------------------------------------------------------------------
UPDATE public.orders
SET
  payment_status = 'unpaid',
  production_status = 'pending',
  fulfillment_status = 'not_handed_over',
  cancellation_status = 'active'
WHERE id <> 'STORE_STATE_001'
  AND status = 'unpaid'
  AND payment_status IS NULL;

UPDATE public.orders
SET
  payment_status = 'paid',
  production_status = 'pending',
  fulfillment_status = 'not_handed_over',
  cancellation_status = 'active'
WHERE id <> 'STORE_STATE_001'
  AND status = 'pending'
  AND payment_status IS NULL;

UPDATE public.orders
SET
  payment_status = 'paid',
  production_status = 'preparing',
  fulfillment_status = 'not_handed_over',
  cancellation_status = 'active'
WHERE id <> 'STORE_STATE_001'
  AND status = 'preparing'
  AND payment_status IS NULL;

UPDATE public.orders
SET
  payment_status = 'paid',
  production_status = 'ready',
  fulfillment_status = 'not_handed_over',
  cancellation_status = 'active'
WHERE id <> 'STORE_STATE_001'
  AND status = 'completed'
  AND payment_status IS NULL;

-- -----------------------------------------------------------------------------
-- 3. 注文番号の原子的採番テーブルと RPC 関数 (Phase 0-E / 監査修正 A)
--    - 当日の orders テーブル最大注文番号と STORE_STATE_001.lastOrderNumber の両方を確認し、
--      既存番号が存在する場合は GREATEST(orders最大値, STORE_STATE最終値) + 1 から引き継ぐ
--    - 既存番号がない新しい日付の場合は 3000〜5000 のランダム初期値で開始する
--    - 4桁上限 (9999) を超える場合は例外 (ORDER_NUMBER_LIMIT_EXCEEDED) で安全に拒否する
--    - pg_advisory_xact_lock と ON CONFLICT DO UPDATE により同時注文時の重複を完全に防止する
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_number_sequences (
  store_id TEXT NOT NULL,
  order_date TEXT NOT NULL, -- JST 'YYYY-MM-DD'
  last_number INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (store_id, order_date)
);

CREATE OR REPLACE FUNCTION public.next_order_number(
  p_store_id TEXT,
  p_order_date TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_max_orders_num INTEGER := 0;
  v_state_raw TEXT;
  v_state_json JSONB;
  v_state_last_num INTEGER := 0;
  v_existing_max INTEGER := 0;
  v_initial_number INTEGER;
  v_assigned_number INTEGER;
  v_day_start TIMESTAMPTZ;
  v_day_end TIMESTAMPTZ;
BEGIN
  -- 店舗 + 日付単位のトランザクションアドバイザリロック（初回初期化時の同時実行競合を完全防止）
  PERFORM pg_advisory_xact_lock(hashtext('order_seq:' || COALESCE(p_store_id, 'kenocha_main') || ':' || p_order_date));

  -- 1. 当日 (JST 00:00:00〜23:59:59.999999) の orders テーブル内の最大注文番号を取得
  v_day_start := (p_order_date || 'T00:00:00+09:00')::TIMESTAMPTZ;
  v_day_end   := (p_order_date || 'T23:59:59.999999+09:00')::TIMESTAMPTZ;

  SELECT COALESCE(MAX(order_number::INTEGER), 0)
  INTO v_max_orders_num
  FROM public.orders
  WHERE id <> 'STORE_STATE_001'
    AND COALESCE(store_id, 'kenocha_main') = p_store_id
    AND created_at >= v_day_start
    AND created_at <= v_day_end
    AND order_number ~ '^\d+$'
    AND (order_number::INTEGER) BETWEEN 1 AND 9999;

  -- 2. STORE_STATE_001 に保存された当日最終番号を確認（旧コードからの引き継ぎ整合性）
  IF p_store_id = 'kenocha_main' THEN
    SELECT customer_avatar
    INTO v_state_raw
    FROM public.orders
    WHERE id = 'STORE_STATE_001'
    LIMIT 1;

    IF v_state_raw IS NOT NULL THEN
      BEGIN
        v_state_json := v_state_raw::JSONB;
        IF (v_state_json->>'currentOrderDate') = p_order_date
           AND (v_state_json->>'lastOrderNumber') ~ '^\d+$' THEN
          v_state_last_num := (v_state_json->>'lastOrderNumber')::INTEGER;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_state_last_num := 0;
      END;
    END IF;
  END IF;

  -- 3. 既存最大番号の決定（orders と STORE_STATE_001 の大きい方を採用）
  v_existing_max := GREATEST(COALESCE(v_max_orders_num, 0), COALESCE(v_state_last_num, 0));

  IF v_existing_max > 0 THEN
    v_initial_number := v_existing_max + 1;
  ELSE
    -- 当日の注文がまだ1件も存在しない場合は 3000〜5000 のランダム初期値
    v_initial_number := floor(random() * (5000 - 3000 + 1) + 3000)::INTEGER;
  END IF;

  -- 4. 原子的 INSERT / UPDATE（万一シーケンス値より大きな既存番号があっても GREATEST で追い越して +1 採番）
  INSERT INTO public.order_number_sequences (store_id, order_date, last_number, updated_at)
  VALUES (p_store_id, p_order_date, v_initial_number, NOW())
  ON CONFLICT (store_id, order_date)
  DO UPDATE SET
    last_number = GREATEST(public.order_number_sequences.last_number, v_existing_max) + 1,
    updated_at = NOW()
  RETURNING last_number INTO v_assigned_number;

  -- 5. 4桁番号上限 (9999) チェック（超過時はトランザクションをロールバックし異常採番を阻止）
  IF v_assigned_number > 9999 THEN
    RAISE EXCEPTION 'ORDER_NUMBER_LIMIT_EXCEEDED: Daily 4-digit order number limit (9999) reached for store % on %',
      p_store_id, p_order_date
      USING ERRCODE = 'P0001';
  END IF;

  RETURN v_assigned_number::TEXT;
END;
$$;

-- マイグレーション適用時点での当日既存番号の事前引き継ぎシード
DO $$
DECLARE
  v_today_jst TEXT := to_char(NOW() AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD');
  v_max_orders INTEGER := 0;
  v_state_raw TEXT;
  v_state_json JSONB;
  v_state_last INTEGER := 0;
  v_seed_last INTEGER := 0;
BEGIN
  SELECT COALESCE(MAX(order_number::INTEGER), 0)
  INTO v_max_orders
  FROM public.orders
  WHERE id <> 'STORE_STATE_001'
    AND created_at >= (v_today_jst || 'T00:00:00+09:00')::TIMESTAMPTZ
    AND created_at <= (v_today_jst || 'T23:59:59.999999+09:00')::TIMESTAMPTZ
    AND order_number ~ '^\d+$'
    AND (order_number::INTEGER) BETWEEN 1 AND 9999;

  SELECT customer_avatar INTO v_state_raw
  FROM public.orders
  WHERE id = 'STORE_STATE_001'
  LIMIT 1;

  IF v_state_raw IS NOT NULL THEN
    BEGIN
      v_state_json := v_state_raw::JSONB;
      IF (v_state_json->>'currentOrderDate') = v_today_jst
         AND (v_state_json->>'lastOrderNumber') ~ '^\d+$' THEN
        v_state_last := (v_state_json->>'lastOrderNumber')::INTEGER;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_state_last := 0;
    END;
  END IF;

  v_seed_last := GREATEST(v_max_orders, v_state_last);

  IF v_seed_last > 0 THEN
    INSERT INTO public.order_number_sequences (store_id, order_date, last_number, updated_at)
    VALUES ('kenocha_main', v_today_jst, v_seed_last, NOW())
    ON CONFLICT (store_id, order_date)
    DO UPDATE SET
      last_number = GREATEST(public.order_number_sequences.last_number, EXCLUDED.last_number),
      updated_at = NOW();
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. Stripe Webhook イベント状態管理テーブル & 原子的決済確定 RPC (Phase 0-D / 監査修正 B)
--    - 単なるイベントID先書きではなく、processing / succeeded / failed_permanent の状態管理を行う
--    - 注文更新と Webhook 処理完了記録を同一トランザクションで確定する RPC を提供する
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'succeeded', 'failed_permanent')),
  attempt_count INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.stripe_webhook_events
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'processing',
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS error_code TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stripe_webhook_events_status_check'
  ) THEN
    ALTER TABLE public.stripe_webhook_events
      ADD CONSTRAINT stripe_webhook_events_status_check
      CHECK (status IN ('processing', 'succeeded', 'failed_permanent'));
  END IF;
END $$;

-- 注文の決済確定と Webhook イベントの succeeded 記録を同一トランザクションで実行する RPC
CREATE OR REPLACE FUNCTION public.confirm_stripe_order_payment_tx(
  p_order_id TEXT,
  p_stripe_session_id TEXT,
  p_webhook_event_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_transitioned BOOLEAN := FALSE;
BEGIN
  -- 対象注文を行ロックして取得
  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', FALSE);
  END IF;

  IF v_order.status = 'unpaid' THEN
    UPDATE public.orders
    SET
      status = 'pending',
      payment_status = 'paid',
      production_status = 'pending',
      fulfillment_status = 'not_handed_over',
      cancellation_status = 'active',
      stripe_session_id = p_stripe_session_id,
      updated_at = NOW()
    WHERE id = p_order_id
    RETURNING * INTO v_order;

    v_transitioned := TRUE;
  ELSE
    -- すでに pending / preparing / completed 等に進んでいる場合は製造状態を巻き戻さない
    UPDATE public.orders
    SET
      payment_status = 'paid',
      stripe_session_id = p_stripe_session_id,
      updated_at = NOW()
    WHERE id = p_order_id
    RETURNING * INTO v_order;

    v_transitioned := FALSE;
  END IF;

  -- Webhook 経由の場合は同一トランザクション内でイベントを succeeded に確定する
  IF p_webhook_event_id IS NOT NULL THEN
    INSERT INTO public.stripe_webhook_events (
      event_id,
      session_id,
      order_id,
      status,
      attempt_count,
      error_code,
      error_message,
      started_at,
      processed_at,
      updated_at
    )
    VALUES (
      p_webhook_event_id,
      p_stripe_session_id,
      p_order_id,
      'succeeded',
      1,
      NULL,
      NULL,
      NOW(),
      NOW(),
      NOW()
    )
    ON CONFLICT (event_id)
    DO UPDATE SET
      status = 'succeeded',
      error_code = NULL,
      error_message = NULL,
      processed_at = NOW(),
      updated_at = NOW();
  END IF;

  RETURN jsonb_build_object(
    'found', TRUE,
    'transitioned_from_unpaid', v_transitioned,
    'order', to_jsonb(v_order)
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 4B. 注文受付停止・欠品更新とモバイル注文作成の直列化 & Checkout 競合制御 RPC
--     ロック順序の統一（デッドロック防止）:
--       Lock Level 1: pg_advisory_xact_lock(hashtext('store_state:' || store_id)) + orders(STORE_STATE_001)
--       Lock Level 2: pg_advisory_xact_lock(hashtext('order_seq:' || store_id || ':' || order_date)) + order_number_sequences
--       Lock Level 3: orders(id <> 'STORE_STATE_001')
-- -----------------------------------------------------------------------------

-- 店舗状態 (STORE_STATE_001: 開店・受付停止・欠品リスト) を排他ロック下で更新する RPC
CREATE OR REPLACE FUNCTION public.update_store_state_tx(
  p_store_id TEXT,
  p_state_json JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_store_key TEXT := COALESCE(NULLIF(p_store_id, ''), 'kenocha_main');
BEGIN
  -- Lock Level 1: store_state アドバイザリロックを取得（注文作成・Checkout確定と直列化）
  PERFORM pg_advisory_xact_lock(hashtext('store_state:' || v_store_key));

  INSERT INTO public.orders (
    id,
    items,
    total_price,
    customer_name,
    customer_avatar,
    status,
    order_number,
    store_id,
    source,
    updated_at
  )
  VALUES (
    'STORE_STATE_001',
    '[]'::jsonb,
    0,
    'STORE_STATE',
    p_state_json::text,
    'cancelled',
    '0000',
    v_store_key,
    'mobile',
    NOW()
  )
  ON CONFLICT (id)
  DO UPDATE SET
    customer_avatar = EXCLUDED.customer_avatar,
    updated_at = NOW();

  RETURN jsonb_build_object(
    'ok', TRUE,
    'state', p_state_json
  );
END;
$$;

-- 受付状態・営業時間・欠品をDBトランザクション内で検証し、注文番号採番と注文INSERTを同一トランザクションで実行する RPC
CREATE OR REPLACE FUNCTION public.create_mobile_order_tx(
  p_store_id TEXT,
  p_order_id TEXT,
  p_items JSONB,
  p_total_price INTEGER,
  p_customer_name TEXT,
  p_customer_avatar TEXT DEFAULT NULL,
  p_item_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
  p_now TIMESTAMPTZ DEFAULT NOW()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_store_key TEXT := COALESCE(NULLIF(p_store_id, ''), 'kenocha_main');
  v_state_raw TEXT;
  v_state_json JSONB;
  v_now_ts TIMESTAMPTZ := COALESCE(p_now, NOW());
  v_now_jst TIMESTAMP;
  v_today_jst TEXT;
  v_current_hour INTEGER;
  v_opened_at_ms BIGINT;
  v_opened_hour INTEGER;
  v_sold_out_id TEXT;
  v_order_number TEXT;
  v_inserted_order public.orders%ROWTYPE;
BEGIN
  -- Lock Level 1: store_state ロックを取得し STORE_STATE_001 を確認
  PERFORM pg_advisory_xact_lock(hashtext('store_state:' || v_store_key));

  SELECT customer_avatar
  INTO v_state_raw
  FROM public.orders
  WHERE id = 'STORE_STATE_001'
  FOR SHARE;

  IF NOT FOUND OR v_state_raw IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'STORE_STATE_UNAVAILABLE',
      'message', '現在、店舗の受付状態を確認できないため注文を受け付けられません。しばらくしてから再度お試しください。'
    );
  END IF;

  BEGIN
    v_state_json := v_state_raw::JSONB;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'STORE_STATE_UNAVAILABLE',
      'message', '現在、店舗の受付状態を確認できないため注文を受け付けられません。しばらくしてから再度お試しください。'
    );
  END;

  -- JST 日付と現在時刻の算出
  v_now_jst := v_now_ts AT TIME ZONE 'Asia/Tokyo';
  v_today_jst := to_char(v_now_jst, 'YYYY-MM-DD');
  v_current_hour := EXTRACT(HOUR FROM v_now_jst)::INTEGER;

  -- 手動開店フラグと営業日付の確認
  IF COALESCE((v_state_json->>'isManualOpen')::BOOLEAN, FALSE) IS NOT TRUE
     OR COALESCE(v_state_json->>'date', '') <> v_today_jst THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'STORE_CLOSED',
      'message', '現在、注文の受付を停止しています（営業時間外または受付停止中）。'
    );
  END IF;

  -- 15時自動クローズ判定（isStoreCurrentlyOpen と同一ロジック）
  IF (v_state_json ? 'openedAt') AND (v_state_json->>'openedAt') ~ '^\d+$' THEN
    v_opened_at_ms := (v_state_json->>'openedAt')::BIGINT;
    v_opened_hour := EXTRACT(HOUR FROM (to_timestamp(v_opened_at_ms / 1000.0) AT TIME ZONE 'Asia/Tokyo'))::INTEGER;
    IF v_current_hour >= 15 AND v_opened_hour < 15 THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'code', 'STORE_CLOSED',
        'message', '現在、注文の受付を停止しています（営業時間外または受付停止中）。'
      );
    END IF;
  ELSE
    IF v_current_hour >= 15 THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'code', 'STORE_CLOSED',
        'message', '現在、注文の受付を停止しています（営業時間外または受付停止中）。'
      );
    END IF;
  END IF;

  -- 欠品商品 (soldOutItems) のチェック
  IF p_item_ids IS NOT NULL AND array_length(p_item_ids, 1) > 0
     AND jsonb_typeof(v_state_json->'soldOutItems') = 'array' THEN
    SELECT req_id
    INTO v_sold_out_id
    FROM unnest(p_item_ids) AS req_id
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_state_json->'soldOutItems') AS sold_id
      WHERE sold_id = req_id
    )
    LIMIT 1;

    IF v_sold_out_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'code', 'ITEM_SOLD_OUT',
        'sold_out_id', v_sold_out_id,
        'message', '申し訳ございません。選択された商品は現在欠品中です。'
      );
    END IF;
  END IF;

  -- Lock Level 2: 同一トランザクション内で注文番号を原子的採番
  v_order_number := public.next_order_number(v_store_key, v_today_jst);

  -- Lock Level 3: 同一トランザクション内で未決済注文を INSERT
  INSERT INTO public.orders (
    id,
    items,
    total_price,
    customer_name,
    customer_avatar,
    status,
    order_number,
    store_id,
    source,
    external_order_id,
    payment_status,
    production_status,
    fulfillment_status,
    cancellation_status,
    refunded_amount,
    stripe_session_id,
    created_at,
    updated_at
  )
  VALUES (
    p_order_id,
    p_items,
    p_total_price,
    p_customer_name,
    p_customer_avatar,
    'unpaid',
    v_order_number,
    v_store_key,
    'mobile',
    NULL,
    'unpaid',
    'pending',
    'not_handed_over',
    'active',
    0,
    NULL,
    v_now_ts,
    v_now_ts
  )
  RETURNING * INTO v_inserted_order;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'order', to_jsonb(v_inserted_order)
  );
END;
$$;

-- Stripe Checkout セッション発行直後に受付状態を再確認し、営業中なら stripe_session_id を記録、
-- 受付停止・欠品化されていた場合は未決済注文を原子的に中断キャンセルする RPC
CREATE OR REPLACE FUNCTION public.finalize_mobile_order_checkout_tx(
  p_store_id TEXT,
  p_order_id TEXT,
  p_stripe_session_id TEXT,
  p_item_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
  p_now TIMESTAMPTZ DEFAULT NOW()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_store_key TEXT := COALESCE(NULLIF(p_store_id, ''), 'kenocha_main');
  v_state_raw TEXT;
  v_state_json JSONB;
  v_order public.orders%ROWTYPE;
  v_now_ts TIMESTAMPTZ := COALESCE(p_now, NOW());
  v_now_jst TIMESTAMP;
  v_today_jst TEXT;
  v_current_hour INTEGER;
  v_opened_at_ms BIGINT;
  v_opened_hour INTEGER;
  v_sold_out_id TEXT;
  v_reject_code TEXT := NULL;
  v_reject_msg TEXT := NULL;
BEGIN
  -- Lock Level 1: store_state ロックを取得
  PERFORM pg_advisory_xact_lock(hashtext('store_state:' || v_store_key));

  SELECT customer_avatar
  INTO v_state_raw
  FROM public.orders
  WHERE id = 'STORE_STATE_001'
  FOR SHARE;

  -- Lock Level 3: 対象注文を行ロック
  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'ORDER_NOT_FOUND',
      'message', '対象の注文が見つかりません。'
    );
  END IF;

  -- 店舗状態の評価
  IF v_state_raw IS NULL THEN
    v_reject_code := 'STORE_STATE_UNAVAILABLE';
    v_reject_msg := '店舗状態の確認中にエラーが発生したため、注文を中断しました。';
  ELSE
    BEGIN
      v_state_json := v_state_raw::JSONB;
    EXCEPTION WHEN OTHERS THEN
      v_reject_code := 'STORE_STATE_UNAVAILABLE';
      v_reject_msg := '店舗状態の確認中にエラーが発生したため、注文を中断しました。';
    END;
  END IF;

  IF v_reject_code IS NULL THEN
    v_now_jst := v_now_ts AT TIME ZONE 'Asia/Tokyo';
    v_today_jst := to_char(v_now_jst, 'YYYY-MM-DD');
    v_current_hour := EXTRACT(HOUR FROM v_now_jst)::INTEGER;

    IF COALESCE((v_state_json->>'isManualOpen')::BOOLEAN, FALSE) IS NOT TRUE
       OR COALESCE(v_state_json->>'date', '') <> v_today_jst THEN
      v_reject_code := 'STORE_CLOSED';
      v_reject_msg := '現在、注文の受付を停止しています（営業時間外または受付停止中）。';
    ELSIF (v_state_json ? 'openedAt') AND (v_state_json->>'openedAt') ~ '^\d+$' THEN
      v_opened_at_ms := (v_state_json->>'openedAt')::BIGINT;
      v_opened_hour := EXTRACT(HOUR FROM (to_timestamp(v_opened_at_ms / 1000.0) AT TIME ZONE 'Asia/Tokyo'))::INTEGER;
      IF v_current_hour >= 15 AND v_opened_hour < 15 THEN
        v_reject_code := 'STORE_CLOSED';
        v_reject_msg := '現在、注文の受付を停止しています（営業時間外または受付停止中）。';
      END IF;
    ELSIF v_current_hour >= 15 THEN
      v_reject_code := 'STORE_CLOSED';
      v_reject_msg := '現在、注文の受付を停止しています（営業時間外または受付停止中）。';
    END IF;
  END IF;

  IF v_reject_code IS NULL
     AND p_item_ids IS NOT NULL AND array_length(p_item_ids, 1) > 0
     AND jsonb_typeof(v_state_json->'soldOutItems') = 'array' THEN
    SELECT req_id
    INTO v_sold_out_id
    FROM unnest(p_item_ids) AS req_id
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_state_json->'soldOutItems') AS sold_id
      WHERE sold_id = req_id
    )
    LIMIT 1;

    IF v_sold_out_id IS NOT NULL THEN
      v_reject_code := 'ITEM_SOLD_OUT';
      v_reject_msg := '申し訳ございません。選択された商品は現在欠品中です。';
    END IF;
  END IF;

  -- Stripe セッション作成中に受付停止または欠品化された場合:
  -- 決済済み注文を決してキャンセルしないよう保護しつつ、未決済注文を中断キャンセルする
  IF v_reject_code IS NOT NULL THEN
    IF v_order.status = 'unpaid' AND COALESCE(v_order.payment_status, 'unpaid') = 'unpaid' THEN
      UPDATE public.orders
      SET
        status = 'cancelled',
        payment_status = 'unpaid',
        cancellation_status = 'cancelled',
        stripe_session_id = COALESCE(p_stripe_session_id, stripe_session_id),
        updated_at = NOW()
      WHERE id = p_order_id
      RETURNING * INTO v_order;
    END IF;

    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', v_reject_code,
      'sold_out_id', v_sold_out_id,
      'message', v_reject_msg,
      'order_cancelled', (v_order.cancellation_status = 'cancelled')
    );
  END IF;

  -- 正常: stripe_session_id を記録して Checkout 進行中として確定
  UPDATE public.orders
  SET
    stripe_session_id = p_stripe_session_id,
    updated_at = NOW()
  WHERE id = p_order_id
  RETURNING * INTO v_order;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'order', to_jsonb(v_order)
  );
END;
$$;

-- Checkout 中断時に未決済注文のみを安全にキャンセルする RPC（決済済み注文は絶対にキャンセル・削除しない）
CREATE OR REPLACE FUNCTION public.abort_mobile_order_checkout_tx(
  p_order_id TEXT,
  p_stripe_session_id TEXT DEFAULT NULL,
  p_reason TEXT DEFAULT 'checkout_aborted'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  -- Lock Level 3: 対象注文を行ロック
  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'ORDER_NOT_FOUND'
    );
  END IF;

  -- すでに決済完了している場合、または調理・呼出・受渡完了に進んでいる場合は絶対にキャンセルしない
  IF COALESCE(v_order.payment_status, 'unpaid') IN ('paid', 'partially_refunded', 'refunded')
     OR v_order.status IN ('pending', 'preparing', 'completed')
     OR COALESCE(v_order.fulfillment_status, 'not_handed_over') = 'handed_over' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'ALREADY_PAID',
      'status', v_order.status,
      'payment_status', v_order.payment_status
    );
  END IF;

  UPDATE public.orders
  SET
    status = 'cancelled',
    payment_status = 'unpaid',
    cancellation_status = 'cancelled',
    stripe_session_id = COALESCE(p_stripe_session_id, stripe_session_id),
    updated_at = NOW()
  WHERE id = p_order_id
  RETURNING * INTO v_order;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'cancelled', TRUE,
    'reason', p_reason,
    'order', to_jsonb(v_order)
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 4C. 決済成功・注文取消不整合の永続化 & 返金管理テーブル・RPC (Phase 0-F)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_refund_requests (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  stripe_session_id TEXT,
  payment_intent_id TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'jpy',
  target_refund_amount INTEGER NOT NULL,
  refund_status TEXT NOT NULL DEFAULT 'pending' CHECK (refund_status IN ('pending', 'processing', 'succeeded', 'failed')),
  stripe_refund_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  requires_manual_attention BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT order_refund_requests_order_id_key UNIQUE (order_id)
);

CREATE INDEX IF NOT EXISTS idx_order_refund_requests_status_attention
  ON public.order_refund_requests (refund_status, requires_manual_attention);

-- 決済成功・注文取消の不整合を検知し、安全に返金案件として永続化する RPC
CREATE OR REPLACE FUNCTION public.record_cancelled_payment_discrepancy_tx(
  p_order_id TEXT,
  p_stripe_session_id TEXT,
  p_payment_intent_id TEXT,
  p_amount INTEGER,
  p_currency TEXT DEFAULT 'jpy',
  p_webhook_event_id TEXT DEFAULT NULL,
  p_reason TEXT DEFAULT 'cancelled_order_payment_received'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_req public.order_refund_requests%ROWTYPE;
BEGIN
  -- Lock Level 3: 対象注文を行ロック
  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'ORDER_NOT_FOUND');
  END IF;

  -- 旧データ（legacy_undetermined: payment_status IS NULL かつ cancellation_status IS NULL）は保護
  IF v_order.payment_status IS NULL AND v_order.cancellation_status IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'LEGACY_ORDER_PROTECTED',
      'message', '過去注文（legacy_undetermined）は返金自動対象外です'
    );
  END IF;

  -- 注文ステータスがキャンセル済みでない場合は不整合ではないため拒否
  IF COALESCE(v_order.cancellation_status, 'active') <> 'cancelled' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'ORDER_NOT_CANCELLED',
      'message', '注文は取消状態ではありません'
    );
  END IF;

  -- orders テーブルの状態を更新（返金待ち & 管理者要対応）
  -- 注文ステータスは 'cancelled' を絶対に維持し、製造・受渡には進めない
  UPDATE public.orders
  SET
    refund_status = CASE
      WHEN refund_status = 'succeeded' THEN 'succeeded'
      ELSE 'pending'
    END,
    requires_manual_attention = CASE
      WHEN refund_status = 'succeeded' THEN FALSE
      ELSE TRUE
    END,
    stripe_session_id = COALESCE(p_stripe_session_id, stripe_session_id),
    updated_at = NOW()
  WHERE id = p_order_id
  RETURNING * INTO v_order;

  -- order_refund_requests に原子的・冪等に記録（ON CONFLICT DO UPDATE で重複登録防止）
  INSERT INTO public.order_refund_requests (
    id,
    order_id,
    stripe_session_id,
    payment_intent_id,
    amount,
    currency,
    target_refund_amount,
    refund_status,
    stripe_refund_id,
    attempt_count,
    last_error,
    requires_manual_attention,
    created_at,
    updated_at
  )
  VALUES (
    'refreq_' || p_order_id,
    p_order_id,
    p_stripe_session_id,
    p_payment_intent_id,
    p_amount,
    LOWER(COALESCE(p_currency, 'jpy')),
    p_amount,
    'pending',
    NULL,
    0,
    p_reason,
    TRUE,
    NOW(),
    NOW()
  )
  ON CONFLICT (order_id)
  DO UPDATE SET
    stripe_session_id = COALESCE(EXCLUDED.stripe_session_id, public.order_refund_requests.stripe_session_id),
    payment_intent_id = COALESCE(EXCLUDED.payment_intent_id, public.order_refund_requests.payment_intent_id),
    amount = EXCLUDED.amount,
    target_refund_amount = EXCLUDED.target_refund_amount,
    last_error = EXCLUDED.last_error,
    updated_at = NOW()
  RETURNING * INTO v_req;

  -- Webhook 経由の場合は、同一トランザクション内でイベントを succeeded（不整合検知・案件永続化完了）として確定
  IF p_webhook_event_id IS NOT NULL THEN
    INSERT INTO public.stripe_webhook_events (
      event_id,
      session_id,
      order_id,
      status,
      attempt_count,
      error_code,
      error_message,
      started_at,
      processed_at,
      updated_at
    )
    VALUES (
      p_webhook_event_id,
      p_stripe_session_id,
      p_order_id,
      'succeeded',
      1,
      NULL,
      NULL,
      NOW(),
      NOW(),
      NOW()
    )
    ON CONFLICT (event_id)
    DO UPDATE SET
      status = 'succeeded',
      error_code = NULL,
      error_message = NULL,
      processed_at = NOW(),
      updated_at = NOW();
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'order_id', p_order_id,
    'refund_request', to_jsonb(v_req),
    'order', to_jsonb(v_order)
  );
END;
$$;

-- 返金実行状態（succeeded / failed / processing）を安全に更新する RPC
CREATE OR REPLACE FUNCTION public.update_refund_request_status_tx(
  p_order_id TEXT,
  p_refund_status TEXT,
  p_stripe_refund_id TEXT DEFAULT NULL,
  p_last_error TEXT DEFAULT NULL,
  p_requires_manual_attention BOOLEAN DEFAULT NULL,
  p_increment_attempt BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req public.order_refund_requests%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_new_attention BOOLEAN;
BEGIN
  -- Lock Level 3: 対象注文・返金案件を行ロック
  SELECT *
  INTO v_req
  FROM public.order_refund_requests
  WHERE order_id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'REFUND_REQUEST_NOT_FOUND');
  END IF;

  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF p_requires_manual_attention IS NOT NULL THEN
    v_new_attention := p_requires_manual_attention;
  ELSIF p_refund_status = 'succeeded' THEN
    v_new_attention := FALSE;
  ELSIF p_refund_status = 'failed' THEN
    v_new_attention := TRUE;
  ELSE
    v_new_attention := v_req.requires_manual_attention;
  END IF;

  UPDATE public.order_refund_requests
  SET
    refund_status = p_refund_status,
    stripe_refund_id = COALESCE(p_stripe_refund_id, stripe_refund_id),
    last_error = COALESCE(p_last_error, last_error),
    attempt_count = CASE WHEN p_increment_attempt THEN attempt_count + 1 ELSE attempt_count END,
    requires_manual_attention = v_new_attention,
    updated_at = NOW()
  WHERE order_id = p_order_id
  RETURNING * INTO v_req;

  IF FOUND THEN
    UPDATE public.orders
    SET
      refund_status = p_refund_status,
      requires_manual_attention = v_new_attention,
      payment_status = CASE
        WHEN p_refund_status = 'succeeded' THEN 'refunded'
        ELSE payment_status
      END,
      refunded_amount = CASE
        WHEN p_refund_status = 'succeeded' THEN v_req.target_refund_amount
        ELSE refunded_amount
      END,
      updated_at = NOW()
    WHERE id = p_order_id
    RETURNING * INTO v_order;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'refund_request', to_jsonb(v_req),
    'order', to_jsonb(v_order)
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. スタッフ認証セッション & ログイン試行回数制限テーブル (Phase 0-B)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.auth_sessions (
  session_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('staff', 'admin')),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.auth_login_rate_limits (
  identifier TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 6. Row Level Security (RLS) の有効化
--    ※ Next.js API Route は SUPABASE_SECRET_KEY (service_role) を使用するため RLS をバイパスし、
--      万が一 anon key が外部に漏洩してもブラウザから直接テーブルを読み書きできないように保護します。
-- -----------------------------------------------------------------------------
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_number_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_refund_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_login_rate_limits ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 7. SECURITY DEFINER 関数の実行権限制限 (Phase 0 / 監査修正)
--    - PUBLIC / anon / authenticated から EXECUTE 権限を剥奪
--    - service_role のみに EXECUTE 権限を付与
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.next_order_number(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_stripe_order_payment_tx(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_store_state_tx(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_mobile_order_tx(TEXT, TEXT, JSONB, INTEGER, TEXT, TEXT, TEXT[], TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_mobile_order_checkout_tx(TEXT, TEXT, TEXT, TEXT[], TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.abort_mobile_order_checkout_tx(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_cancelled_payment_discrepancy_tx(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_refund_request_status_tx(TEXT, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.next_order_number(TEXT, TEXT) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION public.confirm_stripe_order_payment_tx(TEXT, TEXT, TEXT) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION public.update_store_state_tx(TEXT, JSONB) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION public.create_mobile_order_tx(TEXT, TEXT, JSONB, INTEGER, TEXT, TEXT, TEXT[], TIMESTAMPTZ) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION public.finalize_mobile_order_checkout_tx(TEXT, TEXT, TEXT, TEXT[], TIMESTAMPTZ) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION public.abort_mobile_order_checkout_tx(TEXT, TEXT, TEXT) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION public.record_cancelled_payment_discrepancy_tx(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION public.update_refund_request_status_tx(TEXT, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN) FROM anon';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.next_order_number(TEXT, TEXT) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.confirm_stripe_order_payment_tx(TEXT, TEXT, TEXT) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.update_store_state_tx(TEXT, JSONB) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.create_mobile_order_tx(TEXT, TEXT, JSONB, INTEGER, TEXT, TEXT, TEXT[], TIMESTAMPTZ) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.finalize_mobile_order_checkout_tx(TEXT, TEXT, TEXT, TEXT[], TIMESTAMPTZ) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.abort_mobile_order_checkout_tx(TEXT, TEXT, TEXT) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.record_cancelled_payment_discrepancy_tx(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.update_refund_request_status_tx(TEXT, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN) FROM authenticated';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.next_order_number(TEXT, TEXT) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.confirm_stripe_order_payment_tx(TEXT, TEXT, TEXT) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.update_store_state_tx(TEXT, JSONB) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.create_mobile_order_tx(TEXT, TEXT, JSONB, INTEGER, TEXT, TEXT, TEXT[], TIMESTAMPTZ) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.finalize_mobile_order_checkout_tx(TEXT, TEXT, TEXT, TEXT[], TIMESTAMPTZ) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.abort_mobile_order_checkout_tx(TEXT, TEXT, TEXT) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.record_cancelled_payment_discrepancy_tx(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.update_refund_request_status_tx(TEXT, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN) TO service_role';
  END IF;
END $$;

COMMIT;
