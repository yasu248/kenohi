/**
 * Gate 2: 独立検証DB (ローカルDocker PostgreSQL 15) における
 * 本番同型8カラムスキーマ・匿名化88件データによるバックアップ・復元検証スクリプト
 * (scripts/verify-gate2-backup-restore.ts)
 *
 * ※ 本番Supabase (liyjwvgtavfjiohwryox) には一切接続しません。
 * ※ 個人情報は一切使用せず、完全に匿名化されたダミーデータで本番88件分布を再現します。
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONTAINER_NAME = 'kenocha-phase0-verify-pg';
const SOURCE_DB = 'kenocha_gate2_source';
const RESTORE_DB = 'kenocha_gate2_restored';
const DUMP_PATH_IN_CONTAINER = '/tmp/kenocha_gate2_verify.dump';
const MIGRATION_0001_PATH = resolve(process.cwd(), 'supabase/migrations/0001_phase0_foundation.sql');
const MIGRATION_0002_PATH = resolve(process.cwd(), 'supabase/migrations/0002_phase0_stripe_session_hardening.sql');

function runPsql(db: string, sql: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', '-u', 'postgres', CONTAINER_NAME, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-A', '-t'],
    { input: sql, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  ).trim();
}

export function runGate2BackupRestoreTest() {
  console.log('==================================================================');
  console.log('  Gate 2: 独立検証DB (匿名化・本番同型88件) バックアップ復元テスト  ');
  console.log('==================================================================\n');

  try {
    // 1. 独立検証用ソースDBおよびリストア先DBを初期化
    runPsql('postgres', `
      DROP DATABASE IF EXISTS ${SOURCE_DB};
      DROP DATABASE IF EXISTS ${RESTORE_DB};
      CREATE DATABASE ${SOURCE_DB};
      CREATE DATABASE ${RESTORE_DB};
    `);

    // 2. 本番DB (liyjwvgtavfjiohwryox) の Step 1-A 監査結果と100%同一の8カラムスキーマを構築
    runPsql(SOURCE_DB, `
      CREATE TABLE public.orders (
        id text NOT NULL PRIMARY KEY,
        order_number text,
        customer_name text,
        customer_avatar text,
        status text DEFAULT 'pending'::text,
        total_price integer,
        items jsonb,
        created_at timestamp with time zone DEFAULT now()
      );
    `);

    // 3. 匿名化した全88件 (STORE_STATE_001 1件 + cancelled 62件 + unpaid 25件) を投入
    const storeStateJson = JSON.stringify({
      isManualOpen: false,
      date: '2026-11-20',
      openedAt: 1795134801342,
      soldOutItems: ['s4', 's5', 'm3', 'm5', 's2', 'm1'],
      openHistory: Array.from({ length: 38 }, (_, i) => ({
        date: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`,
        openedAt: 1790838501686 + i * 86400000,
        soldOutItems: [],
      })),
      currentOrderDate: '2026-11-17',
      lastOrderNumber: 4065,
    }).replace(/'/g, "''");

    const cancelledValues = Array.from({ length: 62 }, (_, i) => {
      const id = `anon_cancelled_${String(i + 1).padStart(3, '0')}`;
      const orderNum = String(3001 + i);
      return `('${id}', '${orderNum}', '匿名客C${i + 1}', NULL, 'cancelled', 400, '[{"id":"m4","name":"ほうじ茶ミルクティー","price":400,"quantity":1}]'::jsonb, '2026-11-17T01:34:43.57631+00:00'::timestamptz - interval '${i} hours')`;
    }).join(',\n');

    const unpaidValues = Array.from({ length: 25 }, (_, i) => {
      const id = `anon_unpaid_${String(i + 1).padStart(3, '0')}`;
      const orderNum = String(5001 + i);
      return `('${id}', '${orderNum}', '匿名客U${i + 1}', NULL, 'unpaid', 250, '[{"id":"s1","name":"緑茶","price":250,"quantity":1}]'::jsonb, '2026-10-20T05:43:08.461692+00:00'::timestamptz - interval '${i} days')`;
    }).join(',\n');

    runPsql(SOURCE_DB, `
      INSERT INTO public.orders (id, order_number, customer_name, customer_avatar, status, total_price, items, created_at)
      VALUES
        ('STORE_STATE_001', '0000', 'STORE_STATE', '${storeStateJson}', 'cancelled', 0, '[]'::jsonb, '2026-09-14T05:41:29.682162+00:00'::timestamptz),
        ${cancelledValues},
        ${unpaidValues};
    `);

    const sourceHash = runPsql(SOURCE_DB, `
      SELECT md5(string_agg(row_to_json(t)::text, '' ORDER BY id))
      FROM public.orders t;
    `);
    const sourceSchema = runPsql(SOURCE_DB, `
      SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || COALESCE(column_default, 'NULL'), '|' ORDER BY ordinal_position)
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'orders';
    `);
    console.log(`- ソースDB構築完了: 88件投入, 全行MD5ハッシュ=${sourceHash}`);

    // 4. pg_dump (--format=custom --blobs --no-owner --schema=public) でバックアップ取得
    execFileSync('docker', [
      'exec',
      CONTAINER_NAME,
      'pg_dump',
      '-U',
      'postgres',
      '--format=custom',
      '--blobs',
      '--no-owner',
      '--schema=public',
      `--file=${DUMP_PATH_IN_CONTAINER}`,
      SOURCE_DB,
    ]);
    console.log('✅ pg_dump (custom format) によるバックアップ取得完了');

    // 5. 独立した空の検証DB (kenocha_gate2_restored) へ pg_restore で復元
    execFileSync('docker', [
      'exec',
      CONTAINER_NAME,
      'pg_restore',
      '-U',
      'postgres',
      '--clean',
      '--if-exists',
      '--no-owner',
      `--dbname=${RESTORE_DB}`,
      DUMP_PATH_IN_CONTAINER,
    ]);
    console.log('✅ pg_restore による独立検証DBへの復元完了\n');

    // 6. 復元後データの8項目整合性検証
    console.log('=== [復元データの8項目整合性検証] ===');
    const totalCount = runPsql(RESTORE_DB, `SELECT COUNT(*) FROM public.orders;`);
    const customerCount = runPsql(RESTORE_DB, `SELECT COUNT(*) FROM public.orders WHERE id <> 'STORE_STATE_001';`);
    const cancelledCount = runPsql(RESTORE_DB, `SELECT COUNT(*) FROM public.orders WHERE id <> 'STORE_STATE_001' AND status = 'cancelled';`);
    const unpaidCount = runPsql(RESTORE_DB, `SELECT COUNT(*) FROM public.orders WHERE id <> 'STORE_STATE_001' AND status = 'unpaid';`);
    const distinctIdCount = runPsql(RESTORE_DB, `SELECT COUNT(DISTINCT id) FROM public.orders;`);
    const distinctOrderNumCount = runPsql(RESTORE_DB, `SELECT COUNT(DISTINCT order_number) FROM public.orders WHERE id <> 'STORE_STATE_001';`);
    const restoredStoreStateRaw = runPsql(RESTORE_DB, `SELECT customer_avatar FROM public.orders WHERE id = 'STORE_STATE_001';`);
    const restoredStoreState = JSON.parse(restoredStoreStateRaw);
    const restoredSchema = runPsql(RESTORE_DB, `
      SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || COALESCE(column_default, 'NULL'), '|' ORDER BY ordinal_position)
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'orders';
    `);
    const restoredHash = runPsql(RESTORE_DB, `
      SELECT md5(string_agg(row_to_json(t)::text, '' ORDER BY id))
      FROM public.orders t;
    `);

    assert.equal(totalCount, '88', '注文総数88件であること');
    assert.equal(customerCount, '87', '顧客注文87件であること');
    assert.equal(cancelledCount, '62', '過去cancelled注文62件であること');
    assert.equal(unpaidCount, '25', '未払い注文25件であること');
    assert.equal(distinctIdCount, '88', '全88件の注文IDが一意であること');
    assert.equal(distinctOrderNumCount, '87', '全87件の注文番号が一意であること');
    assert.equal(restoredStoreState.isManualOpen, false);
    assert.equal(restoredStoreState.lastOrderNumber, 4065);
    assert.equal(restoredStoreState.openHistory.length, 38);
    assert.equal(restoredSchema, sourceSchema, '既存テーブルと8カラム定義が完全一致すること');
    assert.equal(restoredHash, sourceHash, '全88件のレコードハッシュが1ビットも欠損なく完全一致すること');

    console.log(`- 注文総数: ${totalCount}件 (期待値: 88) ✅`);
    console.log(`- 顧客注文数: ${customerCount}件 (期待値: 87) ✅`);
    console.log(`- 過去cancelled注文: ${cancelledCount}件 (期待値: 62) ✅`);
    console.log(`- 未払い注文: ${unpaidCount}件 (期待値: 25) ✅`);
    console.log(`- STORE_STATE_001: isManualOpen=${restoredStoreState.isManualOpen}, lastOrderNumber=${restoredStoreState.lastOrderNumber}, openHistory=${restoredStoreState.openHistory.length}日分 ✅`);
    console.log(`- ID一意性: ${distinctIdCount}/88, 注文番号一意性: ${distinctOrderNumCount}/87 ✅`);
    console.log(`- スキーマ8カラム一致: 完全一致 ✅`);
    console.log(`- 全行MD5ハッシュ一致 (${restoredHash}): 欠損・改変ゼロ ✅\n`);

    // 7. 復元済み独立DBに対する 0001 -> 0002 マイグレーションドライラン
    console.log('=== [復元済み独立DB上での 0001 -> 0002 ドライラン検証] ===');
    runPsql(RESTORE_DB, `
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    `);
    runPsql(RESTORE_DB, readFileSync(MIGRATION_0001_PATH, 'utf8'));
    runPsql(RESTORE_DB, readFileSync(MIGRATION_0002_PATH, 'utf8'));

    const postMigCheck = runPsql(RESTORE_DB, `
      SELECT
        COUNT(*) || '|' ||
        COUNT(*) FILTER (WHERE id = 'STORE_STATE_001') || '|' ||
        COUNT(*) FILTER (WHERE id <> 'STORE_STATE_001' AND status = 'cancelled' AND payment_status IS NULL AND cancellation_status IS NULL) || '|' ||
        COUNT(*) FILTER (WHERE id <> 'STORE_STATE_001' AND status = 'unpaid' AND payment_status = 'unpaid' AND cancellation_status = 'active')
      FROM public.orders;
    `);
    assert.equal(postMigCheck, '88|1|62|25', '0001+0002適用後も 88|1|62|25 が完全保全されること');

    const aclCount = runPsql(RESTORE_DB, `
      SELECT COUNT(*)
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
        AND p.prosecdef = true
        AND p.proconfig::text LIKE '%search_path=public, pg_temp%'
        AND has_function_privilege('anon', p.oid, 'EXECUTE') = false
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE') = false
        AND has_function_privilege('service_role', p.oid, 'EXECUTE') = true;
    `);
    assert.equal(aclCount, '8', '全8個RPCのACL権限が正しく設定されること');
    console.log(`- 0001 + 0002 ドライラン結果: total|store_state|legacy_cancelled|backfilled_unpaid = ${postMigCheck} ✅`);
    console.log(`- 全8個RPC ACL検証: ${aclCount}/8 (anon=false, authenticated=false, service_role=true) ✅\n`);

    console.log('🎉 Gate 2 独立検証DB復元テスト＆ドライラン: 全項目 PASS！');
  } finally {
    // 一時DBとダンプファイルを確実に破棄
    runPsql('postgres', `
      DROP DATABASE IF EXISTS ${SOURCE_DB};
      DROP DATABASE IF EXISTS ${RESTORE_DB};
    `);
    execFileSync('docker', ['exec', CONTAINER_NAME, 'rm', '-f', DUMP_PATH_IN_CONTAINER]);
    console.log('✅ 一時検証DBおよびダンプファイルの安全な破棄完了');
  }
}

if (process.argv[1]?.endsWith('verify-gate2-backup-restore.ts')) {
  runGate2BackupRestoreTest();
}
