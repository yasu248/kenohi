-- =============================================================================
-- Rollback Migration: 0002_phase0_stripe_session_hardening_rollback.sql
-- Description: 0001_phase0_foundation.sql の confirm_stripe_order_payment_tx 定義へロールバック
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
    'transitioned', v_transitioned,
    'order', to_jsonb(v_order)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_stripe_order_payment_tx(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_stripe_order_payment_tx(TEXT, TEXT, TEXT) TO service_role;
