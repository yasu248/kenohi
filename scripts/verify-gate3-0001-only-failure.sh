#!/usr/bin/env bash
# =============================================================================
# Gate 3 事前障害検証: 0001 適用後に 0002 が失敗した状態の再現・検証
#
# - 100% 匿名合成データのみ使用（本番実データ・個人情報ゼロ）
# - 既存の本番・ステージングDBには一切接続しません
# - --network none / ホストポート非公開 PostgreSQL 17 コンテナで実行し、終了時自動削除
# =============================================================================

set -euo pipefail

CONTAINER_NAME="kenocha-gate3-0001-only-pg17"
VERIFY_DB="kenocha_0001_only_verify"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIG_0001="$REPO_ROOT/supabase/migrations/0001_phase0_foundation.sql"
MIG_0002="$REPO_ROOT/supabase/migrations/0002_phase0_stripe_session_hardening.sql"

cleanup() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    docker rm -f "$CONTAINER_NAME" >/dev/null
    echo "✅ 0001単体障害検証コンテナ ($CONTAINER_NAME) を完全削除しました"
  fi
}
trap cleanup EXIT

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker run -d \
  --name "$CONTAINER_NAME" \
  --network none \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  postgres:17-alpine >/dev/null

for i in $(seq 1 30); do
  if docker exec "$CONTAINER_NAME" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
docker exec "$CONTAINER_NAME" pg_isready -U postgres >/dev/null

# 1. 本番同型スキーマ + Supabase互換ロール + 匿名合成データ構築
docker exec -i "$CONTAINER_NAME" psql -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE DATABASE kenocha_0001_only_verify;
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
SQL

docker exec -i "$CONTAINER_NAME" psql -U postgres -d "$VERIFY_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;

CREATE TABLE public.orders (
  id text PRIMARY KEY,
  order_number text,
  customer_name text,
  customer_avatar text,
  status text DEFAULT 'pending'::text,
  total_price integer,
  items jsonb,
  created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_only ON public.orders
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.orders (id, order_number, customer_name, customer_avatar, status, total_price, items)
VALUES
  ('STORE_STATE_001', '0000', 'STORE_STATE', '{"isManualOpen":false,"date":"2026-11-20","lastOrderNumber":4065,"openHistory":[{"date":"2026-11-20","openedAt":"10:00","soldOutItems":[]}],"soldOutItems":[]}', 'cancelled', 0, '[]'::jsonb),
  ('anon_cancelled_1', '4001', 'Anon C1', NULL, 'cancelled', 500, '[]'::jsonb),
  ('anon_unpaid_1', '4002', 'Anon U1', NULL, 'unpaid', 250, '[]'::jsonb);
SQL

# 2. 0001 適用成功
docker exec -i "$CONTAINER_NAME" psql -U postgres -d "$VERIFY_DB" -v ON_ERROR_STOP=1 < "$MIG_0001" >/dev/null
echo "=== [Step 1] 0001_phase0_foundation.sql 適用完了 ==="

# 3. 0002 が途中で失敗した状態を意図的に再現（BEGIN; ... 強制エラー -> 自動ロールバック）
set +e
FAIL_0002_OUT="$(docker exec -i "$CONTAINER_NAME" psql -U postgres -d "$VERIFY_DB" -v ON_ERROR_STOP=1 2>&1 <<'SQL'
BEGIN;
  CREATE OR REPLACE FUNCTION public.confirm_stripe_order_payment_tx(
    p_order_id TEXT,
    p_stripe_session_id TEXT,
    p_webhook_event_id TEXT DEFAULT NULL
  ) RETURNS JSONB LANGUAGE plpgsql AS $$ BEGIN RETURN '{"broken":true}'::jsonb; END; $$;
  -- 0002 途中で予期せぬエラーが発生した状態を模擬
  DO $$ BEGIN RAISE EXCEPTION 'SIMULATED_0002_MID_TRANSACTION_FAILURE'; END $$;
COMMIT;
SQL
)"
FAIL_0002_RC=$?
set -e
echo "=== [Step 2] 0002 途中失敗を再現 (exit code: $FAIL_0002_RC -> トランザクション自動ロールバック) ==="
echo "$FAIL_0002_OUT" | grep -E "ERROR:|SIMULATED" || true

# 4. 0001のみ適用された状態での全7観点検証
echo ""
echo "=== [Step 3] 0001のみ適用状態での各項目実測 ==="
docker exec -i "$CONTAINER_NAME" psql -U postgres -d "$VERIFY_DB" -v ON_ERROR_STOP=1 <<'SQL'
\pset format aligned
\pset border 2

-- (1) 既存注文データ保全 & (2) 店舗停止状態維持
SELECT
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE id = 'STORE_STATE_001' AND (customer_avatar::jsonb ->> 'isManualOpen') = 'false') AS store_closed_preserved,
  COUNT(*) FILTER (WHERE id = 'anon_cancelled_1' AND status = 'cancelled' AND payment_status IS NULL) AS legacy_cancelled_preserved,
  COUNT(*) FILTER (WHERE id = 'anon_unpaid_1' AND status = 'unpaid' AND payment_status = 'unpaid' AND stripe_session_id IS NULL) AS legacy_unpaid_preserved
FROM public.orders;

-- (3) 旧アプリとの読み取り互換性 (main: getOrders / getStoreState 相当)
SELECT
  'legacy_app_read_compat' AS check_name,
  (SELECT COUNT(*) FROM public.orders WHERE status NOT IN ('cancelled', 'unpaid')) AS legacy_kitchen_visible_rows,
  (SELECT (customer_avatar::jsonb ->> 'isManualOpen') FROM public.orders WHERE id = 'STORE_STATE_001') AS legacy_store_open;

-- (4) 旧Webhook挙動 (main: updateOrderStatus(orderId, 'pending') 相当をROLLBACK内で検証)
BEGIN;
  UPDATE public.orders SET status = 'pending' WHERE id = 'anon_unpaid_1';
  SELECT
    'legacy_webhook_direct_update' AS check_name,
    status AS legacy_status_after,
    payment_status AS new_payment_status_after,
    stripe_session_id
  FROM public.orders WHERE id = 'anon_unpaid_1';
ROLLBACK;

-- (5a) 新RPC (0001 create_mobile_order_tx) による店舗停止中の新規注文遮断確認
SELECT
  'phase0_rpc_new_order_when_closed' AS check_name,
  (public.create_mobile_order_tx(
    'anon_new_1', 'Anon New', '[]'::jsonb, 250, '2026-11-21', 'kenocha_main', ARRAY[]::text[], NOW()
  ) ->> 'ok') AS ok,
  (public.create_mobile_order_tx(
    'anon_new_1', 'Anon New', '[]'::jsonb, 250, '2026-11-21', 'kenocha_main', ARRAY[]::text[], NOW()
  ) ->> 'code') AS code;

-- (5b) 旧アプリ直接 INSERT (main: POST /api/checkout -> addOrder 相当をROLLBACK内で検証)
BEGIN;
  INSERT INTO public.orders (id, order_number, customer_name, status, total_price, items)
  VALUES ('legacy_bypass_1', '4066', 'Legacy Bypass', 'unpaid', 250, '[]'::jsonb);
  SELECT
    'legacy_app_direct_insert_when_closed' AS check_name,
    id,
    status,
    payment_status,
    stripe_session_id
  FROM public.orders WHERE id = 'legacy_bypass_1';
ROLLBACK;

-- (6a) 0001時点での全8 RPC の権限 (ACL) 確認
SELECT
  COUNT(*) AS rpc_count,
  COUNT(*) FILTER (WHERE prosecdef AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE')) AS acl_locked_count
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'next_order_number', 'confirm_stripe_order_payment_tx', 'update_store_state_tx',
    'create_mobile_order_tx', 'finalize_mobile_order_checkout_tx', 'abort_mobile_order_checkout_tx',
    'record_cancelled_payment_discrepancy_tx', 'update_refund_request_status_tx'
  );

-- (6b) 0001時点の confirm_stripe_order_payment_tx の弱点実証 (ROLLBACK内で検証)
--      ※0002未適用だと stripe_session_id IS NULL の旧unpaid注文を cs_test_probe で確定してしまう!
BEGIN;
  WITH res AS (
    SELECT public.confirm_stripe_order_payment_tx('anon_unpaid_1', 'cs_test_probe') AS payload
  )
  SELECT
    '0001_only_unpaid_probe_vulnerability' AS check_name,
    payload ->> 'ok' AS ok,
    payload ->> 'code' AS code
  FROM res;
ROLLBACK;
SQL

# 5. (7) 正規 0002 再適用による完全復旧検証
echo ""
echo "=== [Step 4] 正規 0002_phase0_stripe_session_hardening.sql 再適用による復旧検証 ==="
docker exec -i "$CONTAINER_NAME" psql -U postgres -d "$VERIFY_DB" -v ON_ERROR_STOP=1 < "$MIG_0002" >/dev/null
echo "✅ 0002 再適用成功 (exit code: 0)"

docker exec -i "$CONTAINER_NAME" psql -U postgres -d "$VERIFY_DB" -v ON_ERROR_STOP=1 <<'SQL'
\pset format aligned
\pset border 2

WITH c_res AS (
  SELECT public.confirm_stripe_order_payment_tx('anon_cancelled_1', 'cs_test_probe') AS payload
),
u_res AS (
  SELECT public.confirm_stripe_order_payment_tx('anon_unpaid_1', 'cs_test_probe') AS payload
)
SELECT 'post_0002_recovery_cancelled' AS check_name, payload ->> 'ok' AS ok, payload ->> 'code' AS code FROM c_res
UNION ALL
SELECT 'post_0002_recovery_unpaid' AS check_name, payload ->> 'ok' AS ok, payload ->> 'code' AS code FROM u_res;

SELECT
  COUNT(*) AS rpc_count_after_0002,
  COUNT(*) FILTER (WHERE prosecdef AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE')) AS acl_locked_after_0002
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'next_order_number', 'confirm_stripe_order_payment_tx', 'update_store_state_tx',
    'create_mobile_order_tx', 'finalize_mobile_order_checkout_tx', 'abort_mobile_order_checkout_tx',
    'record_cancelled_payment_discrepancy_tx', 'update_refund_request_status_tx'
  );
SQL
