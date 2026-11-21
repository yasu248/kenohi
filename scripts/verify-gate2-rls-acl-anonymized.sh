#!/usr/bin/env bash
# =============================================================================
# Gate 2: 匿名化データを用いた独立 PostgreSQL 17 環境での RLS・ACL・権限検証
#
# - 本番・ステージングDBには一切接続しません
# - 本番実データ・個人情報は一切使用しません（100% 匿名合成データ）
# - --network none / ホストポート非公開コンテナで実行し、終了時に必ず削除します
# =============================================================================

set -euo pipefail

CONTAINER_NAME="kenocha-gate2-rls-acl-anon-pg17"
VERIFY_DB="kenocha_rls_acl_verify"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIG_0001="$REPO_ROOT/supabase/migrations/0001_phase0_foundation.sql"
MIG_0002="$REPO_ROOT/supabase/migrations/0002_phase0_stripe_session_hardening.sql"

cleanup() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    docker rm -f "$CONTAINER_NAME" >/dev/null
    echo "✅ 匿名化RLS/ACL検証コンテナ ($CONTAINER_NAME) を完全削除しました"
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

# 1. Supabase互換ロール（service_role は Supabase 同様 BYPASSRLS、anon/authenticated は NOBYPASSRLS）
#    ＋ 本番同型 DEFAULT ACL ＋ 本番同型 public.orders + RLS + service_role_only ポリシー + 匿名データ
docker exec -i "$CONTAINER_NAME" psql -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE DATABASE kenocha_rls_acl_verify;
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
SQL

docker exec -i "$CONTAINER_NAME" psql -U postgres -d "$VERIFY_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

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

-- 100% 匿名合成データ（本番データは一切含まない）
INSERT INTO public.orders (id, order_number, customer_name, customer_avatar, status, total_price, items)
VALUES
  ('STORE_STATE_001', '0000', 'STORE_STATE', '{"isManualOpen":false,"date":"2026-11-20","lastOrderNumber":4065,"openHistory":[],"soldOutItems":[]}', 'cancelled', 0, '[]'::jsonb),
  ('anon_cancelled_1', '4001', 'Anon User 1', NULL, 'cancelled', 500, '[]'::jsonb),
  ('anon_unpaid_1', '4002', 'Anon User 2', NULL, 'unpaid', 600, '[]'::jsonb);
SQL

# 2. 0001 -> 0002 適用
docker exec -i "$CONTAINER_NAME" psql -U postgres -d "$VERIFY_DB" -v ON_ERROR_STOP=1 < "$MIG_0001" >/dev/null
docker exec -i "$CONTAINER_NAME" psql -U postgres -d "$VERIFY_DB" -v ON_ERROR_STOP=1 < "$MIG_0002" >/dev/null

# 3. 網羅的 RLS / ACL / SECURITY DEFINER / 実アクセス挙動検証
docker exec -i "$CONTAINER_NAME" psql -U postgres -d "$VERIFY_DB" -v ON_ERROR_STOP=1 <<'SQL'
\pset format aligned
\pset border 2

\echo '=== [A. ロール属性確認 (BYPASSRLS)] ==='
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
FROM pg_roles
WHERE rolname IN ('anon', 'authenticated', 'service_role')
ORDER BY rolname;

\echo '=== [B. 全6テーブルの RLS 有効状態・ポリシー・ACL 棚卸し] ==='
SELECT
  t.tablename,
  t.rowsecurity AS rls_enabled,
  COALESCE((
    SELECT string_agg(p.policyname || '(' || array_to_string(p.roles, ',') || ':' || p.cmd || ')', ', ' ORDER BY p.policyname)
    FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = t.tablename
  ), '<NO POLICY / DENY ALL NON-BYPASSRLS>') AS policies,
  pg_get_userbyid(c.relowner) AS owner
FROM pg_tables t
JOIN pg_class c ON c.relname = t.tablename
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
WHERE t.schemaname = 'public'
ORDER BY t.tablename;

\echo '=== [C. SECURITY DEFINER 全8 RPC の所有者・search_path・EXECUTE権限] ==='
SELECT
  p.proname AS rpc_name,
  pg_get_userbyid(p.proowner) AS owner,
  p.prosecdef AS sec_def,
  COALESCE(array_to_string(p.proconfig, ','), '') AS config,
  has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_exec
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'next_order_number',
    'confirm_stripe_order_payment_tx',
    'update_store_state_tx',
    'create_mobile_order_tx',
    'finalize_mobile_order_checkout_tx',
    'abort_mobile_order_checkout_tx',
    'record_cancelled_payment_discrepancy_tx',
    'update_refund_request_status_tx'
  )
ORDER BY p.proname;

\echo '=== [D. 実アクセス検証: anon / authenticated / service_role のテーブルCRUD & RPC実行] ==='
CREATE TEMP TABLE rls_acl_test_results (
  seq serial,
  role_name text,
  target text,
  operation text,
  expected text,
  actual text,
  passed boolean
);

DO $$
DECLARE
  v_role text;
  v_table text;
  v_cnt integer;
  v_err text;
  v_tables text[] := ARRAY[
    'orders',
    'order_number_sequences',
    'stripe_webhook_events',
    'order_refund_requests',
    'auth_sessions',
    'auth_login_rate_limits'
  ];
BEGIN
  -- 1. anon & authenticated: 全6テーブルの SELECT が 0件 であること
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_table IN ARRAY v_tables LOOP
      EXECUTE format('SET LOCAL ROLE %I', v_role);
      EXECUTE format('SELECT COUNT(*) FROM public.%I', v_table) INTO v_cnt;
      RESET ROLE;
      INSERT INTO rls_acl_test_results(role_name, target, operation, expected, actual, passed)
      VALUES (v_role, v_table, 'SELECT', '0 rows (RLS deny)', v_cnt || ' rows', v_cnt = 0);
    END LOOP;

    -- anon & authenticated: public.orders への INSERT 拒否 (42501)
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', v_role);
      INSERT INTO public.orders (id, order_number, customer_name, status, total_price, items)
      VALUES ('evil_' || v_role, '9999', 'evil', 'pending', 100, '[]'::jsonb);
      RESET ROLE;
      INSERT INTO rls_acl_test_results(role_name, target, operation, expected, actual, passed)
      VALUES (v_role, 'orders', 'INSERT', '42501 denied', 'UNEXPECTED SUCCESS', false);
    EXCEPTION WHEN insufficient_privilege THEN
      RESET ROLE;
      INSERT INTO rls_acl_test_results(role_name, target, operation, expected, actual, passed)
      VALUES (v_role, 'orders', 'INSERT', '42501 denied', '42501 ' || SQLERRM, true);
    END;

    -- anon & authenticated: public.orders への UPDATE 影響行数 0
    EXECUTE format('SET LOCAL ROLE %I', v_role);
    UPDATE public.orders SET status = 'paid' WHERE id = 'anon_unpaid_1';
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    RESET ROLE;
    INSERT INTO rls_acl_test_results(role_name, target, operation, expected, actual, passed)
    VALUES (v_role, 'orders', 'UPDATE', '0 rows affected', v_cnt || ' rows affected', v_cnt = 0);

    -- anon & authenticated: public.orders への DELETE 影響行数 0
    EXECUTE format('SET LOCAL ROLE %I', v_role);
    DELETE FROM public.orders WHERE id = 'anon_unpaid_1';
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    RESET ROLE;
    INSERT INTO rls_acl_test_results(role_name, target, operation, expected, actual, passed)
    VALUES (v_role, 'orders', 'DELETE', '0 rows affected', v_cnt || ' rows affected', v_cnt = 0);

    -- anon & authenticated: RPC 実行拒否 (42501)
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', v_role);
      PERFORM public.confirm_stripe_order_payment_tx('anon_unpaid_1', 'cs_test_evil');
      RESET ROLE;
      INSERT INTO rls_acl_test_results(role_name, target, operation, expected, actual, passed)
      VALUES (v_role, 'confirm_stripe_order_payment_tx', 'EXECUTE', '42501 denied', 'UNEXPECTED SUCCESS', false);
    EXCEPTION WHEN insufficient_privilege THEN
      RESET ROLE;
      INSERT INTO rls_acl_test_results(role_name, target, operation, expected, actual, passed)
      VALUES (v_role, 'confirm_stripe_order_payment_tx', 'EXECUTE', '42501 denied', '42501 ' || SQLERRM, true);
    END;
  END LOOP;

  -- 2. service_role: public.orders SELECT (3 rows) & RPC EXECUTE 許可
  SET LOCAL ROLE service_role;
  SELECT COUNT(*) INTO v_cnt FROM public.orders;
  RESET ROLE;
  INSERT INTO rls_acl_test_results(role_name, target, operation, expected, actual, passed)
  VALUES ('service_role', 'orders', 'SELECT', '3 rows allowed', v_cnt || ' rows', v_cnt = 3);

  SET LOCAL ROLE service_role;
  PERFORM public.confirm_stripe_order_payment_tx('anon_unpaid_1', 'cs_test_probe');
  RESET ROLE;
  INSERT INTO rls_acl_test_results(role_name, target, operation, expected, actual, passed)
  VALUES ('service_role', 'confirm_stripe_order_payment_tx', 'EXECUTE', 'allowed', 'allowed (executed cleanly)', true);

  -- service_role: 新規テーブル (stripe_webhook_events) への INSERT/SELECT/DELETE 許可
  SET LOCAL ROLE service_role;
  INSERT INTO public.stripe_webhook_events (event_id, session_id, order_id, status)
  VALUES ('evt_rls_probe', 'cs_test_rls_probe', 'anon_unpaid_1', 'processing');
  SELECT COUNT(*) INTO v_cnt FROM public.stripe_webhook_events WHERE event_id = 'evt_rls_probe';
  DELETE FROM public.stripe_webhook_events WHERE event_id = 'evt_rls_probe';
  RESET ROLE;
  INSERT INTO rls_acl_test_results(role_name, target, operation, expected, actual, passed)
  VALUES ('service_role', 'stripe_webhook_events', 'INSERT/SELECT/DELETE', '1 row allowed', v_cnt || ' row', v_cnt = 1);

  -- anon & authenticated: 新規テーブル (stripe_webhook_events) への INSERT 拒否 (42501)
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', v_role);
      INSERT INTO public.stripe_webhook_events (event_id, session_id, order_id, status)
      VALUES ('evt_evil_' || v_role, 'cs_evil', 'anon_unpaid_1', 'processing');
      RESET ROLE;
      INSERT INTO rls_acl_test_results(role_name, target, operation, expected, actual, passed)
      VALUES (v_role, 'stripe_webhook_events', 'INSERT', '42501 denied', 'UNEXPECTED SUCCESS', false);
    EXCEPTION WHEN insufficient_privilege THEN
      RESET ROLE;
      INSERT INTO rls_acl_test_results(role_name, target, operation, expected, actual, passed)
      VALUES (v_role, 'stripe_webhook_events', 'INSERT', '42501 denied', '42501 ' || SQLERRM, true);
    END;
  END LOOP;
END $$;

SELECT seq, role_name, target, operation, expected, passed
FROM rls_acl_test_results
ORDER BY seq;

SELECT
  COUNT(*) AS total_checks,
  COUNT(*) FILTER (WHERE passed) AS passed_checks,
  COUNT(*) FILTER (WHERE NOT passed) AS failed_checks
FROM rls_acl_test_results;
SQL
