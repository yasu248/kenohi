-- =============================================================================
-- Migration: 0002_phase0_stripe_session_hardening.sql
-- Description: Stripe Checkout Session ID の厳格な整合性検証および未設定セッション拒否の強化
--
-- 要件:
-- 1. confirm_stripe_order_payment_tx において、注文レコードに記録された stripe_session_id と
--    提供された p_stripe_session_id の厳格な一致を原子的に検証する
-- 2. 注文側の stripe_session_id が NULL または空文字列の場合は無条件に拒絶する (SESSION_ID_NOT_CONFIGURED)
-- 3. 不一致の場合は SESSION_ID_MISMATCH として決済確定を遮断する
-- 4. キャンセル済み注文の調理待ち復活を遮断する (ORDER_CANCELLED)
-- 5. すでに進行中の製造状態 (preparing/completed/ready) を巻き戻さない
-- =============================================================================

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
    RETURN jsonb_build_object(
      'found', FALSE,
      'ok', FALSE,
      'code', 'ORDER_NOT_FOUND',
      'message', '対象の注文が見つかりません。'
    );
  END IF;

  -- 1. 注文レコードの stripe_session_id が未設定 (NULL または 空文字) の場合は拒絶
  IF v_order.stripe_session_id IS NULL OR TRIM(v_order.stripe_session_id) = '' THEN
    RETURN jsonb_build_object(
      'found', TRUE,
      'ok', FALSE,
      'code', 'SESSION_ID_NOT_CONFIGURED',
      'message', '注文にStripeセッションIDが設定されていません。決済を確定できません。'
    );
  END IF;

  -- 2. 提供されたセッションIDが注文レコードと完全一致するか厳格に検証 (Cross-Session スプーフィング遮断)
  IF v_order.stripe_session_id <> p_stripe_session_id THEN
    RETURN jsonb_build_object(
      'found', TRUE,
      'ok', FALSE,
      'code', 'SESSION_ID_MISMATCH',
      'message', '提供されたStripeセッションIDが注文レコードと一致しません。'
    );
  END IF;

  -- 3. キャンセル済み注文は絶対に通常の調理待ちに復活させない
  IF COALESCE(v_order.cancellation_status, 'active') = 'cancelled' OR v_order.status = 'cancelled' THEN
    RETURN jsonb_build_object(
      'found', TRUE,
      'ok', FALSE,
      'code', 'ORDER_CANCELLED',
      'message', '注文はすでにキャンセルされています。調理待ちへ復活できません。'
    );
  END IF;

  -- 4. 正常確定処理
  IF v_order.status = 'unpaid' THEN
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
    -- すでに pending / preparing / completed 等に進んでいる場合は製造状態を巻き戻さない
    UPDATE public.orders
    SET
      payment_status = 'paid',
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
    'ok', TRUE,
    'transitioned', v_transitioned,
    'order', to_jsonb(v_order)
  );
END;
$$;

-- 権限管理: anon / authenticated からの EXECUTE を明示的に剥奪し、service_role にのみ許可
REVOKE ALL ON FUNCTION public.confirm_stripe_order_payment_tx(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_stripe_order_payment_tx(TEXT, TEXT, TEXT) TO service_role;
