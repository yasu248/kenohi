-- =============================================================================
-- Phase 0 Rollback SQL: 0001_phase0_foundation_rollback.sql
--
-- 注意:
-- 既存データを保護するため、orders テーブルに追加した拡張カラムの DROP は
-- 必要な場合のみ実行してください（カラムを残したままでも旧コードは動作します）。
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.next_order_number(TEXT, TEXT);
DROP TABLE IF EXISTS public.order_number_sequences;
DROP TABLE IF EXISTS public.stripe_webhook_events;
DROP TABLE IF EXISTS public.auth_sessions;
DROP TABLE IF EXISTS public.auth_login_rate_limits;

DROP INDEX IF EXISTS public.idx_orders_source_external_order_id;
DROP INDEX IF EXISTS public.idx_orders_store_created_at;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_payment_status_check,
  DROP CONSTRAINT IF EXISTS orders_production_status_check,
  DROP CONSTRAINT IF EXISTS orders_fulfillment_status_check,
  DROP CONSTRAINT IF EXISTS orders_cancellation_status_check;

-- カラム自体も削除して完全に元に戻す場合のみ以下を実行:
-- ALTER TABLE public.orders
--   DROP COLUMN IF EXISTS store_id,
--   DROP COLUMN IF EXISTS source,
--   DROP COLUMN IF EXISTS external_order_id,
--   DROP COLUMN IF EXISTS payment_status,
--   DROP COLUMN IF EXISTS production_status,
--   DROP COLUMN IF EXISTS fulfillment_status,
--   DROP COLUMN IF EXISTS cancellation_status,
--   DROP COLUMN IF EXISTS refunded_amount,
--   DROP COLUMN IF EXISTS stripe_session_id,
--   DROP COLUMN IF EXISTS updated_at;

COMMIT;
