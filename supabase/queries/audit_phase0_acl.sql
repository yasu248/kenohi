-- =============================================================================
-- Phase 0 RPC 権限（ACL）監査クエリ: audit_phase0_acl.sql
--
-- 目的:
-- 全8個の原子的RPC関数について、PostgreSQLシステムカタログ (pg_proc) および
-- has_function_privilege() を用いてロール別のEXECUTE権限を厳密に監査する。
--
-- 合格判定基準:
-- - anon ロール:           EXECUTE権限 FALSE（公開拒絶）
-- - authenticated ロール:  EXECUTE権限 FALSE（ログインユーザー拒絶）
-- - service_role ロール:   EXECUTE権限 TRUE（サーバー専用実行許可）
-- =============================================================================

SELECT
  p.proname AS rpc_name,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  p.prosecdef AS is_security_definer,
  CASE
    WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN '❌ PERMITTED (VULNERABLE)'
    ELSE '✅ REVOKED (SECURE)'
  END AS anon_acl,
  CASE
    WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN '❌ PERMITTED (VULNERABLE)'
    ELSE '✅ REVOKED (SECURE)'
  END AS authenticated_acl,
  CASE
    WHEN has_function_privilege('service_role', p.oid, 'EXECUTE') THEN '✅ GRANTED (OPERATIONAL)'
    ELSE '❌ REVOKED (UNAVAILABLE)'
  END AS service_role_acl,
  -- 総合判定
  CASE
    WHEN NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
     AND has_function_privilege('service_role', p.oid, 'EXECUTE')
     AND p.prosecdef = TRUE
    THEN 'PASS'
    ELSE 'FAIL'
  END AS audit_verdict
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
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
