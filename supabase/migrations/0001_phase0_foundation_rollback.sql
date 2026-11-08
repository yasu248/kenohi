-- =============================================================================
-- Phase 0 Safe Non-Destructive Rollback SQL: 0001_phase0_foundation_rollback.sql
--
-- 【重要方針: データ非破壊の原則】
-- 1. マイグレーション適用後に作成された注文データ・決済確認記録 (`stripe_webhook_events`)・
--    採番履歴 (`order_number_sequences`)・認証監査情報 (`auth_sessions`, `auth_login_rate_limits`)・
--    および `orders` テーブルの拡張カラムは、無条件に DROP / DELETE しません。
-- 2. 旧アプリケーションコードは追加カラム・新設テーブルが存在していても 100% 互換動作します
--    （追加カラムは NULL 許容または DEFAULT 値を持つため、旧コードの INSERT / UPDATE / SELECT を妨げません）。
-- 3. 新コード稼働中に採番された最新の注文番号を `STORE_STATE_001` (`currentOrderDate`, `lastOrderNumber`) に
--    逆同期（バックポート）することで、旧コードへ切り戻した直後も注文番号の重複・巻き戻りを防止します。
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. 最新注文番号の `STORE_STATE_001` への逆同期（旧コード切り戻し時の採番連続性保証）
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_today_jst TEXT := to_char(NOW() AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD');
  v_seq_last INTEGER := 0;
  v_orders_max INTEGER := 0;
  v_latest_num INTEGER := 0;
  v_state_raw TEXT;
  v_state_json JSONB;
BEGIN
  -- 新採番テーブルの当日最終番号を取得
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'order_number_sequences'
  ) THEN
    SELECT COALESCE(MAX(last_number), 0)
    INTO v_seq_last
    FROM public.order_number_sequences
    WHERE store_id = 'kenocha_main'
      AND order_date = v_today_jst;
  END IF;

  -- orders テーブルの当日最大注文番号を取得
  SELECT COALESCE(MAX(order_number::INTEGER), 0)
  INTO v_orders_max
  FROM public.orders
  WHERE id <> 'STORE_STATE_001'
    AND created_at >= (v_today_jst || 'T00:00:00+09:00')::TIMESTAMPTZ
    AND created_at <= (v_today_jst || 'T23:59:59.999999+09:00')::TIMESTAMPTZ
    AND order_number ~ '^\d+$'
    AND (order_number::INTEGER) BETWEEN 1 AND 9999;

  v_latest_num := GREATEST(v_seq_last, v_orders_max);

  -- 当日の注文番号が存在する場合、STORE_STATE_001 の開店状態・欠品情報を保持したまま
  -- currentOrderDate と lastOrderNumber のみを最新値へ同期する
  IF v_latest_num > 0 THEN
    SELECT customer_avatar
    INTO v_state_raw
    FROM public.orders
    WHERE id = 'STORE_STATE_001'
    FOR UPDATE;

    IF v_state_raw IS NOT NULL THEN
      BEGIN
        v_state_json := v_state_raw::JSONB;
      EXCEPTION WHEN OTHERS THEN
        v_state_json := '{}'::JSONB;
      END;

      v_state_json := jsonb_set(v_state_json, '{currentOrderDate}', to_jsonb(v_today_jst), TRUE);
      v_state_json := jsonb_set(
        v_state_json,
        '{lastOrderNumber}',
        to_jsonb(GREATEST(COALESCE((v_state_json->>'lastOrderNumber')::INTEGER, 0), v_latest_num)),
        TRUE
      );

      UPDATE public.orders
      SET customer_avatar = v_state_json::TEXT
      WHERE id = 'STORE_STATE_001';
    END IF;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. 進行中の新規キャンセル注文・受渡完了注文の旧 status 互換性確認
--    (Phase 0 コードは常に旧 status カラムも同時に更新しているため追加変換は不要ですが、
--     念のため status が NULL のレコードがないことを保証します)
-- -----------------------------------------------------------------------------
UPDATE public.orders
SET status = 'unpaid'
WHERE status IS NULL AND id <> 'STORE_STATE_001';

-- -----------------------------------------------------------------------------
-- 【注意】以下のテーブル・カラムはデータを保持するため DROP しません:
--   - public.orders の追加カラム (store_id, source, external_order_id, payment_status,
--     production_status, fulfillment_status, cancellation_status, refunded_amount,
--     stripe_session_id, updated_at)
--   - public.order_number_sequences (採番履歴)
--   - public.stripe_webhook_events (Webhook処理状態・監査記録)
--   - public.auth_sessions (スタッフセッション履歴)
--   - public.auth_login_rate_limits (レート制限記録)
-- -----------------------------------------------------------------------------

COMMIT;
