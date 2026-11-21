#!/usr/bin/env bash
# =============================================================================
# Gate 2: 本番暗号化バックアップを用いた独立ローカル PostgreSQL 17 復元検証
#         ＆ 0001 -> 0002 マイグレーションドライラン スクリプト
#
# 安全設計:
# - 既存の本番・ステージングDBには一切接続しません
# - 新規専用コンテナ (postgres:17-alpine) を --network none / ホストポート非公開 で起動します
# - すべてのDB操作は docker exec 経由のみで実行します
# - 一時復号ファイルは OneDrive/Git 外 ($HOME/.kenocha-backups/prod-gate2) に chmod 600 で作成し、
#   終了時 (成功・失敗問わず trap) に一時復号ファイル・専用コンテナを必ず削除します
# - 暗号化済み本番バックアップ (.dump.enc) は削除せず保持します
# - 顧客名・アイコン・注文明細などの個人情報は一切出力しません
# =============================================================================

set -euo pipefail

BACKUP_DIR="$HOME/.kenocha-backups/prod-gate2"
ENC_FILE="${1:-$BACKUP_DIR/kenocha_prod_public_20261121_161303.dump.enc}"
EXPECTED_SHA256="d43244a7f9fb3b1b0ab91033c893bce4d22380b5fbc6fcb8adbfb2e81330f925"
CONTAINER_NAME="kenocha-gate2-prod-restore-pg17"
RESTORE_DB="kenocha_restore_verify"
TMP_DUMP="$BACKUP_DIR/.tmp_restore_verify_$$.dump"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIG_0001="$REPO_ROOT/supabase/migrations/0001_phase0_foundation.sql"
MIG_0002="$REPO_ROOT/supabase/migrations/0002_phase0_stripe_session_hardening.sql"

cleanup() {
  echo ""
  echo "=== [10. 一時検証環境・復号ファイルのクリーンアップ] ==="
  if [[ -f "$TMP_DUMP" ]]; then
    rm -f "$TMP_DUMP"
    echo "✅ 一時復号ファイルを削除しました"
  else
    echo "✅ 一時復号ファイルは存在しません（削除済み）"
  fi

  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    docker rm -f "$CONTAINER_NAME" >/dev/null
    echo "✅ 専用検証コンテナ ($CONTAINER_NAME) を完全削除しました"
  else
    echo "✅ 専用検証コンテナは残存していません"
  fi

  if [[ -f "$ENC_FILE" ]]; then
    echo "✅ 暗号化済み本番バックアップは保持されています: $(ls -lh "$ENC_FILE" | awk '{print $1, $5, $9}')"
  else
    echo "⚠️ 暗号化済み本番バックアップが見つかりません: $ENC_FILE"
  fi
}
trap cleanup EXIT

echo "========================================================================="
echo "  Gate 2: 本番実バックアップ 独立 PostgreSQL 17 復元検証 & ドライラン"
echo "========================================================================="

if [[ ! -f "$ENC_FILE" ]]; then
  echo "❌ エラー: 暗号化バックアップファイルが見つかりません: $ENC_FILE"
  exit 1
fi

echo ""
echo "=== [1. 暗号化バックアップのローカル復号 & SHA-256 整合性検証] ==="
echo "暗号化時に設定した AES-256-CBC パスフレーズを入力してください:"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$ENC_FILE" -out "$TMP_DUMP"
chmod 600 "$TMP_DUMP"

ACTUAL_SHA256="$(shasum -a 256 "$TMP_DUMP" | awk '{print $1}')"
echo "- 期待 SHA-256: $EXPECTED_SHA256"
echo "- 実測 SHA-256: $ACTUAL_SHA256"
if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
  echo "❌ エラー: 復号後の SHA-256 が取得時の値と一致しません。復元を中止します。"
  exit 1
fi
echo "✅ SHA-256 完全一致を確認"

echo ""
echo "=== [2. ネットワーク完全隔離 (--network none / ポート非公開) PostgreSQL 17 コンテナ起動] ==="
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

PG_VER="$(docker exec "$CONTAINER_NAME" psql -U postgres -d postgres -A -t -c "SELECT version();")"
echo "- 起動コンテナ: $CONTAINER_NAME (NetworkMode: $(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER_NAME"), PublishedPorts: $(docker inspect -f '{{json .NetworkSettings.Ports}}' "$CONTAINER_NAME"))"
echo "- PostgreSQL バージョン: $PG_VER"

echo ""
echo "=== [3. 空の検証DBおよび Supabase 互換ロール (anon / authenticated / service_role / supabase_admin) 準備] ==="
docker exec -i "$CONTAINER_NAME" psql -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE DATABASE kenocha_restore_verify;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN CREATE ROLE supabase_admin WITH SUPERUSER; END IF;
END $$;
SQL
# 空の検証DBのデフォルト public スキーマを削除し、ダンプ内の CREATE SCHEMA public / ACL をそのまま復元可能にする
docker exec "$CONTAINER_NAME" psql -U postgres -d "$RESTORE_DB" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS public;" >/dev/null
echo "✅ 空の検証DB ($RESTORE_DB) および基本ロールを準備完了"

echo ""
echo "=== [4. pg_restore (--no-owner --exit-on-error) による実バックアップ復元] ==="
docker cp "$TMP_DUMP" "$CONTAINER_NAME:/tmp/prod_backup.dump"
# 復元直前にホスト側の一時復号ファイルは即座に削除（コンテナ内のみに限定）
rm -f "$TMP_DUMP"

set +e
RESTORE_OUT="$(docker exec "$CONTAINER_NAME" pg_restore \
  -U postgres \
  --no-owner \
  --exit-on-error \
  --dbname="$RESTORE_DB" \
  /tmp/prod_backup.dump 2>&1)"
RESTORE_RC=$?
set -e

docker exec "$CONTAINER_NAME" rm -f /tmp/prod_backup.dump

if [[ $RESTORE_RC -ne 0 ]]; then
  echo "❌ pg_restore でエラーが発生したため停止します (exit code: $RESTORE_RC):"
  echo "$RESTORE_OUT"
  exit 1
fi
echo "✅ pg_restore がエラーゼロ (exit code: 0) で完了しました"

echo ""
echo "=== [5. 復元データの整合性・スキーマ・RLS・ポリシー・ACL検証 (個人情報出力なし)] ==="
docker exec -i "$CONTAINER_NAME" psql -U postgres -d "$RESTORE_DB" -v ON_ERROR_STOP=1 <<'SQL'
\pset format aligned
\pset border 2

SELECT
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE id <> 'STORE_STATE_001') AS customer_orders,
  COUNT(*) FILTER (WHERE id <> 'STORE_STATE_001' AND status = 'cancelled') AS cancelled_orders,
  COUNT(*) FILTER (WHERE id <> 'STORE_STATE_001' AND status = 'unpaid') AS unpaid_orders,
  COUNT(DISTINCT id) AS distinct_ids,
  COUNT(DISTINCT order_number) FILTER (WHERE id <> 'STORE_STATE_001') AS distinct_customer_order_numbers
FROM public.orders;

SELECT
  id,
  status,
  order_number,
  (customer_avatar::jsonb ->> 'isManualOpen') AS is_manual_open,
  (customer_avatar::jsonb ->> 'date') AS store_date,
  (customer_avatar::jsonb ->> 'lastOrderNumber') AS last_order_number,
  jsonb_array_length(customer_avatar::jsonb -> 'openHistory') AS open_history_days,
  jsonb_array_length(customer_avatar::jsonb -> 'soldOutItems') AS sold_out_items_count
FROM public.orders
WHERE id = 'STORE_STATE_001';

SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'orders'
ORDER BY ordinal_position;

SELECT
  schemaname,
  tablename,
  rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

SELECT
  relname AS table_name,
  pg_get_userbyid(relowner) AS owner,
  relacl::text AS table_acl
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY relname;

SELECT
  p.proname AS function_name,
  pg_get_userbyid(p.proowner) AS owner,
  p.prosecdef AS security_definer,
  p.proacl::text AS function_acl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY p.proname;

SELECT
  c.relname AS table_name,
  t.tgname AS trigger_name,
  t.tgenabled AS enabled
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal
ORDER BY c.relname, t.tgname;
SQL

echo ""
echo "=== [6. 復元済み独立DB上での 0001 -> 0002 マイグレーション ドライラン] ==="
docker exec -i "$CONTAINER_NAME" psql -U postgres -d "$RESTORE_DB" -v ON_ERROR_STOP=1 < "$MIG_0001" >/dev/null
echo "✅ 0001_phase0_foundation.sql ドライラン適用成功"
docker exec -i "$CONTAINER_NAME" psql -U postgres -d "$RESTORE_DB" -v ON_ERROR_STOP=1 < "$MIG_0002" >/dev/null
echo "✅ 0002_phase0_stripe_session_hardening.sql ドライラン適用成功"

echo ""
echo "=== [7. 0001 -> 0002 ドライラン後の全88件保全・旧cancelled/unpaid保護・全8個RPC権限検証] ==="
docker exec -i "$CONTAINER_NAME" psql -U postgres -d "$RESTORE_DB" -v ON_ERROR_STOP=1 <<'SQL'
\pset format aligned
\pset border 2

SELECT
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE id = 'STORE_STATE_001') AS store_state_rows,
  COUNT(*) FILTER (
    WHERE id <> 'STORE_STATE_001'
      AND status = 'cancelled'
      AND payment_status IS NULL
      AND production_status IS NULL
      AND fulfillment_status IS NULL
      AND cancellation_status IS NULL
  ) AS legacy_cancelled_protected_rows,
  COUNT(*) FILTER (
    WHERE id <> 'STORE_STATE_001'
      AND status = 'unpaid'
      AND payment_status = 'unpaid'
      AND cancellation_status = 'active'
      AND stripe_session_id IS NULL
  ) AS backfilled_unpaid_rows
FROM public.orders;

SELECT
  p.proname AS rpc_name,
  p.prosecdef AS sec_def,
  COALESCE(array_to_string(p.proconfig, ','), '') AS config,
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

-- 旧 cancelled 注文 (1件抽出) に対する 0002 保護確認 (LEGACY_ORDER_PROTECTED)
WITH res AS (
  SELECT public.confirm_stripe_order_payment_tx(
    (SELECT id FROM public.orders WHERE id <> 'STORE_STATE_001' AND status = 'cancelled' LIMIT 1),
    'cs_test_probe'
  ) AS payload
)
SELECT
  'legacy_cancelled_probe' AS probe_type,
  payload ->> 'ok' AS ok,
  payload ->> 'code' AS code
FROM res;

-- 旧 unpaid 注文 (1件抽出) に対する 0002 保護確認 (SESSION_ID_NOT_CONFIGURED)
WITH res AS (
  SELECT public.confirm_stripe_order_payment_tx(
    (SELECT id FROM public.orders WHERE id <> 'STORE_STATE_001' AND status = 'unpaid' LIMIT 1),
    'cs_test_probe'
  ) AS payload
)
SELECT
  'legacy_unpaid_probe' AS probe_type,
  payload ->> 'ok' AS ok,
  payload ->> 'code' AS code
FROM res;

-- STORE_STATE_001 の保全確認 (ドライラン後も設定・履歴が完全維持)
SELECT
  (customer_avatar::jsonb ->> 'isManualOpen') AS is_manual_open,
  (customer_avatar::jsonb ->> 'date') AS store_date,
  (customer_avatar::jsonb ->> 'lastOrderNumber') AS last_order_number,
  jsonb_array_length(customer_avatar::jsonb -> 'openHistory') AS open_history_days
FROM public.orders
WHERE id = 'STORE_STATE_001';
SQL

echo ""
echo "🎉 Gate 2 本番実バックアップ復元テスト & 0001 -> 0002 ドライラン完了！"
