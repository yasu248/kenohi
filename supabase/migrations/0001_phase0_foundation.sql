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
ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_login_rate_limits ENABLE ROW LEVEL SECURITY;

COMMIT;
