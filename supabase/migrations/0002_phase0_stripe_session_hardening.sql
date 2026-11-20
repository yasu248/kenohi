-- =============================================================================
-- Migration: 0002_phase0_stripe_session_hardening.sql
-- Description: Stripe Checkout Session ID の厳格な整合性検証・状態遷移ガード・返金案件不変性強化
--
-- 監査対応要件:
-- 1. 0001 の安全機構（FOR UPDATE 行ロック、同一トランザクションでの stripe_webhook_events 確定、
--    transitioned_from_unpaid 戻り値キー、SECURITY DEFINER / search_path / ACL 制限）を完全維持する。
-- 2. デッドロック防止のためのロック取得順序を全 RPC で厳格に統一する:
--      Lock Level 1: pg_advisory_xact_lock(hashtext('store_state:' || store_id)) + orders(STORE_STATE_001)
--      Lock Level 2: pg_advisory_xact_lock(hashtext('order_seq:' || store_id || ':' || order_date)) + order_number_sequences
--      Lock Level 3: public.orders (id = p_order_id FOR UPDATE)
--      Lock Level 4: public.order_refund_requests (order_id = p_order_id FOR UPDATE)
--      Lock Level 5: public.stripe_webhook_events (event_id = p_webhook_event_id FOR UPDATE / ON CONFLICT)
-- 3. システム管理レコード (STORE_STATE_001) および過去未判定注文 (legacy_undetermined:
--    status = 'cancelled' かつ 4軸カラムすべて NULL) を保護し、誤更新・誤判定を防止する。
-- 4. 注文レコードの stripe_session_id が未設定 (NULL / 空文字) または引数 p_stripe_session_id と
--    不一致の場合は、IS DISTINCT FROM を用いて NULL を含むあらゆる不一致を検出し、
--    confirm_stripe_order_payment_tx / record_cancelled_payment_discrepancy_tx の双方で
--    DB レベルで拒否する (SESSION_ID_NOT_CONFIGURED / SESSION_ID_MISMATCH)。
--    RPC 直接呼び出しによる未設定注文への Session ID 後付け補完は一切許可しない。
-- 5. 同一 Webhook イベント ID (p_webhook_event_id) が異なる注文 ID または異なる Session ID に
--    再利用された場合は、事前 FOR UPDATE チェックおよび INSERT ... ON CONFLICT DO UPDATE の
--    WHERE 句 (IS NOT DISTINCT FROM) + RETURNING FOUND 検証の二段構えにより、同時競合時を含め
--    WEBHOOK_EVENT_CONFLICT として確実に拒否し、注文・返金データを一切更新しない。
-- 6. キャンセル済み注文 (cancellation_status = 'cancelled') は ORDER_CANCELLED として拒否し、
--    絶対に調理待ち (pending / active) へ復活させない。
-- 7. 受渡完了注文 (status = 'cancelled' かつ fulfillment_status = 'handed_over' かつ
--    cancellation_status = 'active') をキャンセル済みと誤判定せず、冪等再送として安全に処理する。
-- 8. status <> 'unpaid' を一律に UPDATE する設計や payment_status IS NULL の暗黙 paid 補完を廃止し、
--    明示的に許可された状態遷移のみを実行する。
-- 9. record_cancelled_payment_discrepancy_tx における返金案件の不変性・状態遷移保護:
--    - 注文金額 (total_price) と p_amount、および通貨 ('jpy') の一致を DB レベルでも検証する。
--    - すでに refund_status = 'succeeded' の返金完了案件は完全不変 (Immutable) とし、
--      遅延 Webhook や再送によって PaymentIntent ID / Session ID / 金額 / Refund ID /
--      ステータス / エラー履歴 / 注文の返金完了状態が一切変更されないことを保証する。
--    - refund_status IN ('processing', 'failed', 'pending') の既存案件に対する再送時も、
--      既存の PaymentIntent ID・金額・ステータス・エラー履歴 (last_error)・attempt_count を上書きせず、
--      pending / failed の手動対応フラグ (requires_manual_attention = TRUE) を確実に維持する。
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. 原子的決済確定 RPC の強化 (confirm_stripe_order_payment_tx)
-- -----------------------------------------------------------------------------
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
  v_webhook_evt public.stripe_webhook_events%ROWTYPE;
  v_transitioned BOOLEAN := FALSE;
  v_is_initial_confirm BOOLEAN := FALSE;
  v_is_idempotent_replay BOOLEAN := FALSE;
BEGIN
  -- 0. システム管理レコード (STORE_STATE_001) または空IDの保護
  IF p_order_id IS NULL OR TRIM(p_order_id) = '' OR p_order_id = 'STORE_STATE_001' THEN
    RETURN jsonb_build_object(
      'found', FALSE,
      'ok', FALSE,
      'code', 'INVALID_ORDER_STATE',
      'message', '不正な注文IDが指定されました。'
    );
  END IF;

  -- Lock Level 3: 対象注文を行ロックして取得 (同時Webhook・キャンセルとの競合を直列化)
  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'found', FALSE,
      'ok', FALSE,
      'code', 'ORDER_NOT_FOUND',
      'message', '対象の注文が見つかりません。'
    );
  END IF;

  -- 1. 過去の未判定注文 (legacy_undetermined: status = 'cancelled' かつ 4軸すべて NULL) の保護
  --    ※ 過去の受渡完了データの可能性があるため、推測で書き換えたり返金対象にしない
  IF v_order.status = 'cancelled'
     AND v_order.payment_status IS NULL
     AND v_order.production_status IS NULL
     AND v_order.fulfillment_status IS NULL
     AND v_order.cancellation_status IS NULL THEN
    RETURN jsonb_build_object(
      'found', TRUE,
      'ok', FALSE,
      'code', 'LEGACY_ORDER_PROTECTED',
      'message', '過去データ (legacy_undetermined) の注文は決済確定の対象外です。'
    );
  END IF;

  -- 2. 注文レコードの stripe_session_id 未設定 (NULL / 空文字) または入力セッションID未指定の拒否
  IF p_stripe_session_id IS NULL OR TRIM(p_stripe_session_id) = ''
     OR v_order.stripe_session_id IS NULL OR TRIM(v_order.stripe_session_id) = '' THEN
    RETURN jsonb_build_object(
      'found', TRUE,
      'ok', FALSE,
      'code', 'SESSION_ID_NOT_CONFIGURED',
      'message', '注文にStripeセッションIDが設定されていません。決済を確定できません。'
    );
  END IF;

  -- 3. 記録された stripe_session_id と入力 p_stripe_session_id の厳格な一致検証 (IS DISTINCT FROM で NULL 含む不一致を完全遮断)
  IF v_order.stripe_session_id IS DISTINCT FROM p_stripe_session_id THEN
    RETURN jsonb_build_object(
      'found', TRUE,
      'ok', FALSE,
      'code', 'SESSION_ID_MISMATCH',
      'message', '提供されたStripeセッションIDが注文レコードと一致しません。'
    );
  END IF;

  -- 4. Lock Level 5 (事前確認): Webhook イベントIDの注文・セッション束縛検証
  IF p_webhook_event_id IS NOT NULL AND TRIM(p_webhook_event_id) <> '' THEN
    SELECT *
    INTO v_webhook_evt
    FROM public.stripe_webhook_events
    WHERE event_id = p_webhook_event_id
    FOR UPDATE;

    IF FOUND THEN
      IF v_webhook_evt.order_id IS DISTINCT FROM p_order_id
         OR v_webhook_evt.session_id IS DISTINCT FROM p_stripe_session_id THEN
        RETURN jsonb_build_object(
          'found', TRUE,
          'ok', FALSE,
          'code', 'WEBHOOK_EVENT_CONFLICT',
          'message', '同一のWebhookイベントIDが異なる注文IDまたはセッションIDに再利用されました。'
        );
      END IF;

      IF v_webhook_evt.status = 'failed_permanent' THEN
        RETURN jsonb_build_object(
          'found', TRUE,
          'ok', FALSE,
          'code', 'WEBHOOK_EVENT_FAILED_PERMANENT',
          'message', 'このWebhookイベントはすでに恒久的検証エラーとして記録されています。'
        );
      END IF;
    END IF;
  END IF;

  -- 5. キャンセル済み注文の保護
  --    ※ キッチン受渡完了は status = 'cancelled' かつ fulfillment_status = 'handed_over' かつ cancellation_status = 'active' となるため、
  --      cancellation_status = 'cancelled' または (status = 'cancelled' かつ fulfillment_status <> 'handed_over') を厳密に判定する。
  IF COALESCE(v_order.cancellation_status, 'active') = 'cancelled'
     OR (v_order.status = 'cancelled' AND COALESCE(v_order.fulfillment_status, 'not_handed_over') <> 'handed_over') THEN
    RETURN jsonb_build_object(
      'found', TRUE,
      'ok', FALSE,
      'code', 'ORDER_CANCELLED',
      'message', '注文はすでにキャンセルされています。調理待ちへ復活できません。',
      'order', to_jsonb(v_order)
    );
  END IF;

  -- 6. 明示的に許可された決済状態遷移の事前判定（payment_status IS NULL の暗黙補完や想定外状態の更新を禁止）
  IF v_order.status = 'unpaid'
     AND v_order.payment_status = 'unpaid'
     AND v_order.cancellation_status = 'active'
     AND COALESCE(v_order.fulfillment_status, 'not_handed_over') = 'not_handed_over' THEN
    v_is_initial_confirm := TRUE;
  ELSIF v_order.cancellation_status = 'active'
    AND v_order.payment_status IN ('paid', 'partially_refunded', 'refunded')
    AND (
      (v_order.status IN ('pending', 'preparing', 'completed')
       AND COALESCE(v_order.fulfillment_status, 'not_handed_over') = 'not_handed_over')
      OR (v_order.status = 'cancelled' AND v_order.fulfillment_status = 'handed_over')
    ) THEN
    v_is_idempotent_replay := TRUE;
  ELSE
    RETURN jsonb_build_object(
      'found', TRUE,
      'ok', FALSE,
      'code', 'INVALID_ORDER_STATE',
      'message', format(
        '決済確定できない注文状態です (status=%s, payment_status=%s, fulfillment_status=%s, cancellation_status=%s)',
        COALESCE(v_order.status, 'NULL'),
        COALESCE(v_order.payment_status, 'NULL'),
        COALESCE(v_order.fulfillment_status, 'NULL'),
        COALESCE(v_order.cancellation_status, 'NULL')
      )
    );
  END IF;

  -- 7. Lock Level 5 (確定): Webhook 経由の場合は注文更新の前にイベントを succeeded に確定し、
  --    ON CONFLICT 同時競合時にも order_id / session_id の一致 (IS NOT DISTINCT FROM) を強制する
  IF p_webhook_event_id IS NOT NULL AND TRIM(p_webhook_event_id) <> '' THEN
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
      processed_at = COALESCE(public.stripe_webhook_events.processed_at, NOW()),
      updated_at = NOW()
    WHERE public.stripe_webhook_events.order_id IS NOT DISTINCT FROM p_order_id
      AND public.stripe_webhook_events.session_id IS NOT DISTINCT FROM p_stripe_session_id
      AND public.stripe_webhook_events.status <> 'failed_permanent'
    RETURNING * INTO v_webhook_evt;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'found', TRUE,
        'ok', FALSE,
        'code', 'WEBHOOK_EVENT_CONFLICT',
        'message', '同一のWebhookイベントIDが異なる注文ID・セッションIDで使用されているか、恒久エラー状態のため確定できません。'
      );
    END IF;
  END IF;

  -- 8. 注文ステータスの更新実行
  IF v_is_initial_confirm THEN
    -- [遷移A] 未決済 (unpaid) -> 調理待ち・決済完了 (pending / paid)
    UPDATE public.orders
    SET
      status = 'pending',
      payment_status = 'paid',
      production_status = 'pending',
      fulfillment_status = 'not_handed_over',
      cancellation_status = 'active',
      updated_at = NOW()
    WHERE id = p_order_id
    RETURNING * INTO v_order;

    v_transitioned := TRUE;
  ELSE
    -- [遷移B] すでに決済確定済みの進行中または受渡完了注文の冪等再送（レコード不変）
    v_transitioned := FALSE;
  END IF;

  -- 0001 互換の 'transitioned_from_unpaid' と 0002 の 'transitioned' の両方を返却
  RETURN jsonb_build_object(
    'found', TRUE,
    'ok', TRUE,
    'transitioned', v_transitioned,
    'transitioned_from_unpaid', v_transitioned,
    'order', to_jsonb(v_order)
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. キャンセル後決済不整合の返金案件記録 RPC の厳格化・返金済み案件不変性保証
--    (record_cancelled_payment_discrepancy_tx)
-- -----------------------------------------------------------------------------
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
  v_existing_req public.order_refund_requests%ROWTYPE;
  v_has_existing_req BOOLEAN := FALSE;
  v_webhook_evt public.stripe_webhook_events%ROWTYPE;
  v_clean_pi TEXT := NULLIF(TRIM(COALESCE(p_payment_intent_id, '')), '');
  v_already_recorded BOOLEAN := FALSE;
BEGIN
  -- 0. システム管理レコード (STORE_STATE_001) または空IDの保護
  IF p_order_id IS NULL OR TRIM(p_order_id) = '' OR p_order_id = 'STORE_STATE_001' THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'INVALID_ORDER_STATE');
  END IF;

  -- Lock Level 3: 対象注文を行ロック
  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'ORDER_NOT_FOUND');
  END IF;

  -- 1. 旧データ（legacy_undetermined: payment_status IS NULL かつ cancellation_status IS NULL）は保護
  IF v_order.payment_status IS NULL AND v_order.cancellation_status IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'LEGACY_ORDER_PROTECTED',
      'message', '過去注文（legacy_undetermined）は返金自動対象外です'
    );
  END IF;

  -- 2. 注文ステータスがキャンセル済みでない場合は不整合ではないため拒否
  IF COALESCE(v_order.cancellation_status, 'active') <> 'cancelled' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'ORDER_NOT_CANCELLED',
      'message', '注文は取消状態ではありません'
    );
  END IF;

  -- 3. Session ID の厳格検証:
  --    注文側の stripe_session_id が未設定 (NULL / 空文字) の場合は、未検証 Session ID の後付け紐付けを拒否する。
  IF p_stripe_session_id IS NULL OR TRIM(p_stripe_session_id) = ''
     OR v_order.stripe_session_id IS NULL OR TRIM(v_order.stripe_session_id) = '' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'SESSION_ID_NOT_CONFIGURED',
      'message', '注文レコードにStripeセッションIDが設定されていないため、返金案件を登録できません'
    );
  END IF;

  IF v_order.stripe_session_id IS DISTINCT FROM p_stripe_session_id THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'SESSION_ID_MISMATCH',
      'message', '提供されたStripeセッションIDが注文レコードと一致しません'
    );
  END IF;

  -- 4. 金額・通貨の厳格検証 (注文の total_price および JPY と一致しない返金案件登録を拒否)
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount IS DISTINCT FROM v_order.total_price THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'AMOUNT_MISMATCH',
      'message', format('返金対象金額 (%s) が注文金額 (%s) と一致しません', COALESCE(p_amount::text, 'NULL'), v_order.total_price::text)
    );
  END IF;

  IF p_currency IS NULL OR LOWER(TRIM(p_currency)) <> 'jpy' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'code', 'CURRENCY_MISMATCH',
      'message', format('不正な通貨が指定されました (%s)', COALESCE(p_currency, 'NULL'))
    );
  END IF;

  -- 5. Lock Level 4: 既存の返金案件レコードを行ロックして整合性を事前確認
  SELECT *
  INTO v_existing_req
  FROM public.order_refund_requests
  WHERE order_id = p_order_id
  FOR UPDATE;

  IF FOUND THEN
    v_has_existing_req := TRUE;

    IF v_existing_req.stripe_session_id IS DISTINCT FROM p_stripe_session_id THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'code', 'SESSION_ID_MISMATCH',
        'message', '既存の返金案件のStripeセッションIDと一致しません'
      );
    END IF;

    IF v_existing_req.payment_intent_id IS NOT NULL
       AND v_clean_pi IS NOT NULL
       AND v_existing_req.payment_intent_id IS DISTINCT FROM v_clean_pi THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'code', 'PAYMENT_INTENT_MISMATCH',
        'message', '既存の返金案件のPaymentIntent IDと一致しません'
      );
    END IF;

    IF v_existing_req.amount IS DISTINCT FROM p_amount
       OR v_existing_req.target_refund_amount IS DISTINCT FROM p_amount THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'code', 'AMOUNT_MISMATCH',
        'message', '既存の返金案件の金額と一致しません'
      );
    END IF;
  END IF;

  -- 6. Lock Level 5: Webhook イベントIDの注文・セッション束縛検証および確定
  --    (ON CONFLICT 同時競合時にも IS NOT DISTINCT FROM で別注文・別セッションへの流用を遮断)
  IF p_webhook_event_id IS NOT NULL AND TRIM(p_webhook_event_id) <> '' THEN
    SELECT *
    INTO v_webhook_evt
    FROM public.stripe_webhook_events
    WHERE event_id = p_webhook_event_id
    FOR UPDATE;

    IF FOUND THEN
      IF v_webhook_evt.order_id IS DISTINCT FROM p_order_id
         OR v_webhook_evt.session_id IS DISTINCT FROM p_stripe_session_id THEN
        RETURN jsonb_build_object(
          'ok', FALSE,
          'code', 'WEBHOOK_EVENT_CONFLICT',
          'message', '同一のWebhookイベントIDが異なる注文IDまたはセッションIDに再利用されました'
        );
      END IF;

      IF v_webhook_evt.status = 'failed_permanent' THEN
        RETURN jsonb_build_object(
          'ok', FALSE,
          'code', 'WEBHOOK_EVENT_FAILED_PERMANENT',
          'message', 'このWebhookイベントはすでに恒久的検証エラーとして記録されています'
        );
      END IF;
    END IF;

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
      processed_at = COALESCE(public.stripe_webhook_events.processed_at, NOW()),
      updated_at = NOW()
    WHERE public.stripe_webhook_events.order_id IS NOT DISTINCT FROM p_order_id
      AND public.stripe_webhook_events.session_id IS NOT DISTINCT FROM p_stripe_session_id
      AND public.stripe_webhook_events.status <> 'failed_permanent'
    RETURNING * INTO v_webhook_evt;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'code', 'WEBHOOK_EVENT_CONFLICT',
        'message', '同一のWebhookイベントIDが異なる注文ID・セッションIDで使用されているか、恒久エラー状態です'
      );
    END IF;
  END IF;

  -- 7. 返金案件および注文テーブルの更新実行
  IF v_has_existing_req THEN
    v_already_recorded := TRUE;

    IF v_existing_req.refund_status = 'succeeded' THEN
      -- [不変性保証 A] すでに返金完了 (succeeded) している案件:
      -- PaymentIntent ID / Session ID / 返金対象金額 / 返金実行金額 / Stripe Refund ID /
      -- 返金完了ステータス / エラー履歴 / 注文テーブルの状態を一切変更せずそのまま保持する。
      v_req := v_existing_req;

    ELSIF v_existing_req.refund_status = 'processing' THEN
      -- [状態保護 B] 返金処理実行中 (processing) の案件:
      -- refund_status ('processing')・金額・Refund ID・attempt_count・last_error・requires_manual_attention を維持し、
      -- payment_intent_id が未設定だった場合のみ補完する。
      IF v_existing_req.payment_intent_id IS NULL AND v_clean_pi IS NOT NULL THEN
        UPDATE public.order_refund_requests
        SET
          payment_intent_id = v_clean_pi,
          updated_at = NOW()
        WHERE order_id = p_order_id
        RETURNING * INTO v_req;
      ELSE
        v_req := v_existing_req;
      END IF;

    ELSE
      -- [状態保護 C] 返金待ち (pending) または返金失敗 (failed) の案件:
      -- 既存の refund_status ('pending' または 'failed')、金額、attempt_count、既存のエラー履歴 (last_error) を上書きせず保持し、
      -- 手動対応フラグ (requires_manual_attention = TRUE) が決して消えないよう保証する。
      UPDATE public.order_refund_requests
      SET
        payment_intent_id = COALESCE(public.order_refund_requests.payment_intent_id, v_clean_pi),
        last_error = COALESCE(public.order_refund_requests.last_error, p_reason),
        requires_manual_attention = TRUE,
        updated_at = CASE
          WHEN (public.order_refund_requests.payment_intent_id IS NULL AND v_clean_pi IS NOT NULL)
            OR public.order_refund_requests.requires_manual_attention IS NOT TRUE
          THEN NOW()
          ELSE public.order_refund_requests.updated_at
        END
      WHERE order_id = p_order_id
      RETURNING * INTO v_req;

      IF v_order.requires_manual_attention IS NOT TRUE OR v_order.refund_status IS DISTINCT FROM v_req.refund_status THEN
        UPDATE public.orders
        SET
          refund_status = v_req.refund_status,
          requires_manual_attention = TRUE,
          updated_at = NOW()
        WHERE id = p_order_id
        RETURNING * INTO v_order;
      END IF;
    END IF;

  ELSE
    -- [新規登録] 返金案件が存在しない場合のみ新規作成
    v_already_recorded := FALSE;

    UPDATE public.orders
    SET
      refund_status = 'pending',
      requires_manual_attention = TRUE,
      updated_at = NOW()
    WHERE id = p_order_id
    RETURNING * INTO v_order;

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
      v_clean_pi,
      p_amount,
      'jpy',
      p_amount,
      'pending',
      NULL,
      0,
      p_reason,
      TRUE,
      NOW(),
      NOW()
    )
    RETURNING * INTO v_req;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'order_id', p_order_id,
    'already_recorded', v_already_recorded,
    'refund_request', to_jsonb(v_req),
    'order', to_jsonb(v_order)
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. 返金ステータス更新 RPC のロック順序統一 (update_refund_request_status_tx)
--    Lock Level 3 (orders) -> Lock Level 4 (order_refund_requests) の順に統一
-- -----------------------------------------------------------------------------
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
  -- Lock Level 3: 対象注文を先行して行ロック（record_cancelled_payment_discrepancy_tx とのデッドロックを完全防止）
  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  -- Lock Level 4: 対象返金案件を行ロック
  SELECT *
  INTO v_req
  FROM public.order_refund_requests
  WHERE order_id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'REFUND_REQUEST_NOT_FOUND');
  END IF;

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
-- 4. SECURITY DEFINER 関数の実行権限制限 (0001 と同一の安全なロール確認方式)
--    - PUBLIC / anon / authenticated から EXECUTE 権限を剥奪
--    - service_role のみに EXECUTE 権限を付与
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.confirm_stripe_order_payment_tx(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_cancelled_payment_discrepancy_tx(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_refund_request_status_tx(TEXT, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.confirm_stripe_order_payment_tx(TEXT, TEXT, TEXT) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION public.record_cancelled_payment_discrepancy_tx(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION public.update_refund_request_status_tx(TEXT, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN) FROM anon';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.confirm_stripe_order_payment_tx(TEXT, TEXT, TEXT) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.record_cancelled_payment_discrepancy_tx(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.update_refund_request_status_tx(TEXT, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN) FROM authenticated';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.confirm_stripe_order_payment_tx(TEXT, TEXT, TEXT) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.record_cancelled_payment_discrepancy_tx(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.update_refund_request_status_tx(TEXT, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN) TO service_role';
  END IF;
END $$;

COMMIT;
