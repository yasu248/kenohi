-- =============================================================================
-- Safe Incident Containment & Recovery SQL:
-- supabase/migrations/0002_phase0_stripe_session_hardening_rollback.sql
--
-- 【重要原則】
-- 旧 0001 の confirm_stripe_order_payment_tx 定義への単純復元は、
-- 「stripe_session_id 未検証（別注文の支払済みSession流用が可能）」および
-- 「status <> 'unpaid' に対する一律 payment_status = 'paid' 上書き」の脆弱性を
-- 復活させるため、通常のロールバック手順としては絶対に使用しないこと。
--
-- 障害発生時は以下の Fail-Closed（安全側停止）手順により、
-- 1. 新規注文受付の即時停止 (STORE_STATE_001.isManualOpen = false)
-- 2. 未処理決済・保留中Webhookイベント・返金待ち案件の監査抽出
-- 3. Stripe API 実ステータスとの照合および修正版RPCでの再確定
-- を実施する。
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Step 1: 新規モバイル注文受付の即時安全停止 (Fail-Closed)
--         既存の営業日・欠品設定・採番履歴を一切破壊せず isManualOpen のみを false に更新
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_raw TEXT;
  v_json JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('store_state:kenocha_main'));

  SELECT customer_avatar
  INTO v_raw
  FROM public.orders
  WHERE id = 'STORE_STATE_001'
  FOR UPDATE;

  IF FOUND AND v_raw IS NOT NULL THEN
    BEGIN
      v_json := v_raw::JSONB;
      v_json := jsonb_set(v_json, '{isManualOpen}', 'false'::jsonb, true);

      UPDATE public.orders
      SET
        customer_avatar = v_json::text,
        updated_at = NOW()
      WHERE id = 'STORE_STATE_001';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'STORE_STATE_001 JSON parse skipped during emergency freeze';
    END;
  END IF;
END $$;

COMMIT;

-- -----------------------------------------------------------------------------
-- Step 2: 未処理決済・保留中イベントの照合用監査クエリ (Read-Only)
--         ※ 障害調査時に実行し、出力された stripe_session_id を Stripe API
--           (stripe.checkout.sessions.retrieve) と突合して実決済状態を確認する。
-- -----------------------------------------------------------------------------

-- [監査クエリ A] Stripeセッション発行済みだがDB上で未決済 (unpaid) のまま残っている注文一覧
-- SELECT
--   id AS order_id,
--   order_number,
--   total_price,
--   status,
--   payment_status,
--   cancellation_status,
--   stripe_session_id,
--   created_at,
--   updated_at
-- FROM public.orders
-- WHERE id <> 'STORE_STATE_001'
--   AND (status = 'unpaid' OR COALESCE(payment_status, 'unpaid') = 'unpaid')
--   AND stripe_session_id IS NOT NULL
-- ORDER BY created_at DESC;

-- [監査クエリ B] 処理中 (processing) または恒久エラー (failed_permanent) として記録された Webhook イベント一覧
-- SELECT
--   event_id,
--   session_id,
--   order_id,
--   status,
--   attempt_count,
--   error_code,
--   error_message,
--   started_at,
--   processed_at,
--   updated_at
-- FROM public.stripe_webhook_events
-- WHERE status IN ('processing', 'failed_permanent')
-- ORDER BY updated_at DESC;

-- [監査クエリ C] キャンセル競合により返金対応待ち (requires_manual_attention = true) となっている案件一覧
-- SELECT
--   r.id AS refund_request_id,
--   r.order_id,
--   o.order_number,
--   r.stripe_session_id,
--   r.payment_intent_id,
--   r.amount,
--   r.refund_status,
--   r.last_error,
--   r.requires_manual_attention,
--   r.created_at
-- FROM public.order_refund_requests r
-- JOIN public.orders o ON o.id = r.order_id
-- WHERE r.requires_manual_attention = TRUE
--    OR r.refund_status IN ('pending', 'failed')
-- ORDER BY r.created_at DESC;
