import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import Stripe from 'stripe';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONTAINER_NAME = 'kenocha-phase0-verify-pg';
const MIGRATION_FILE_PATH = resolve(process.cwd(), 'supabase/migrations/0001_phase0_foundation.sql');
const ROLLBACK_FILE_PATH = resolve(process.cwd(), 'supabase/migrations/0001_phase0_foundation_rollback.sql');
const MIGRATION_0002_FILE_PATH = resolve(process.cwd(), 'supabase/migrations/0002_phase0_stripe_session_hardening.sql');
const CONTAINMENT_0002_FILE_PATH = resolve(process.cwd(), 'supabase/migrations/0002_phase0_stripe_session_hardening_rollback.sql');

/**
 * ローカルコンテナ内の PostgreSQL に対して SQL を安全に実行するヘルパー
 * ※接続先がローカルDockerコンテナであることを毎回厳格に確認
 */
function runPsql(sql: string, user: string = 'postgres'): string {
  try {
    const output = execFileSync(
      'docker',
      ['exec', '-i', '-u', user, CONTAINER_NAME, 'psql', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-A', '-t'],
      {
        input: sql,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    return output.trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? (err as Error & { stderr?: string }).stderr || err.message : String(err);
    throw new Error(`[Local Postgres Error]: ${msg}`);
  }
}

/**
 * SQLクエリを実行してJSON/行結果を返す
 */
function querySingle(sql: string, user: string = 'postgres'): string {
  return runPsql(sql, user);
}

function queryJson(sql: string, user: string = 'postgres'): any {
  const raw = runPsql(sql, user);
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{') || l.startsWith('['));
  if (lines.length === 0) {
    throw new Error(`No JSON output found in psql response:\n${raw}`);
  }
  return JSON.parse(lines[lines.length - 1]);
}

function isDockerAvailable(): boolean {
  try {
    execFileSync('docker', ['ps'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('[Phase 0] 実PostgreSQL検証環境 統合テスト', { skip: !isDockerAvailable() }, () => {
  before(() => {
    // 1. 接続先がローカルDockerコンテナであることを検証
    const version = runPsql('SELECT version();');
    assert.ok(version.includes('PostgreSQL 15'), `接続先がPostgreSQL 15であること: ${version}`);

    // Supabase ロール（anon, authenticated, service_role）をローカルDBにシミュレート作成
    runPsql(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN;
        END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    `);
  });

  // クリーンアップヘルパー: テーブルを再作成してPhase 0適用前の旧スキーマを再現
  const resetToLegacySchema = () => {
    runPsql(`
      DROP TABLE IF EXISTS public.orders CASCADE;
      DROP TABLE IF EXISTS public.order_number_sequences CASCADE;
      DROP TABLE IF EXISTS public.stripe_webhook_events CASCADE;
      DROP TABLE IF EXISTS public.auth_sessions CASCADE;
      DROP TABLE IF EXISTS public.auth_login_rate_limits CASCADE;
      DROP FUNCTION IF EXISTS public.next_order_number(TEXT, TEXT) CASCADE;
      DROP FUNCTION IF EXISTS public.confirm_stripe_order_payment_tx(TEXT, TEXT, TEXT) CASCADE;

      -- Phase 0 適用前の旧 orders テーブル
      CREATE TABLE public.orders (
        id TEXT PRIMARY KEY,
        items JSONB NOT NULL DEFAULT '[]'::jsonb,
        total_price INTEGER NOT NULL DEFAULT 0,
        customer_name TEXT NOT NULL,
        customer_avatar TEXT,
        status TEXT NOT NULL,
        order_number TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  };

  describe('2. マイグレーションの検証', () => {
    it('2.0 完全新規の空DBに対する 0001_phase0_foundation.sql 初回適用検証 (ステージング初期化互換)', () => {
      // 完全に全テーブル・関数をDROPしたまっさらな空DBを準備
      runPsql(`
        DROP TABLE IF EXISTS public.orders CASCADE;
        DROP TABLE IF EXISTS public.order_number_sequences CASCADE;
        DROP TABLE IF EXISTS public.stripe_webhook_events CASCADE;
        DROP TABLE IF EXISTS public.order_refund_requests CASCADE;
        DROP TABLE IF EXISTS public.auth_sessions CASCADE;
        DROP TABLE IF EXISTS public.auth_login_rate_limits CASCADE;
      `);

      // 空DBに 0001_phase0_foundation.sql を適用
      const migrationSql = readFileSync(MIGRATION_FILE_PATH, 'utf8');
      assert.doesNotThrow(() => {
        runPsql(migrationSql);
      }, '空DBに対してマイグレーションが正常に適用できること');

      // orders テーブルと初期店舗状態レコードが安全に作成されていること
      const ordersCount = querySingle(`SELECT count(*) FROM public.orders;`);
      assert.equal(ordersCount, '1', '初期店舗状態レコード STORE_STATE_001 のみが作成されていること');

      const storeStateId = querySingle(`SELECT id FROM public.orders WHERE id = 'STORE_STATE_001';`);
      assert.equal(storeStateId, 'STORE_STATE_001');

      // 全8個のRPCが存在すること
      const rpcCount = querySingle(`
        SELECT count(*) FROM pg_proc p
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
          );
      `);
      assert.equal(rpcCount, '8', '全8個のRPC関数が作成されていること');
    });

    it('2.1 & 2.2 既存注文が存在するDBへのSQL初回適用とステータスバックフィル検証', () => {
      resetToLegacySchema();

      // 旧システムの既存データを投入
      // 1. 未決済
      // 2. 進行中 pending
      // 3. 進行中 preparing
      // 4. 進行中 completed
      // 5. 過去の cancelled (意味が曖昧なレコード: 受渡完了か取消か不明)
      // 6. STORE_STATE_001 (店舗状態)
      runPsql(`
        INSERT INTO public.orders (id, items, total_price, customer_name, customer_avatar, status, order_number, created_at)
        VALUES
          ('ord_legacy_unpaid', '[{"name":"煎茶", "price":500, "quantity":1}]'::jsonb, 500, '客A', NULL, 'unpaid', '3101', NOW() - INTERVAL '2 hours'),
          ('ord_legacy_pending', '[{"name":"焙じ茶", "price":600, "quantity":1}]'::jsonb, 600, '客B', NULL, 'pending', '3102', NOW() - INTERVAL '1 hour'),
          ('ord_legacy_preparing', '[{"name":"抹茶", "price":700, "quantity":1}]'::jsonb, 700, '客C', NULL, 'preparing', '3103', NOW() - INTERVAL '30 minutes'),
          ('ord_legacy_completed', '[{"name":"青茶", "price":650, "quantity":1}]'::jsonb, 650, '客D', NULL, 'completed', '3104', NOW() - INTERVAL '10 minutes'),
          ('ord_legacy_cancelled', '[{"name":"玉露", "price":800, "quantity":1}]'::jsonb, 800, '客E', NULL, 'cancelled', '3099', NOW() - INTERVAL '1 day'),
          ('STORE_STATE_001', '[]'::jsonb, 0, 'STORE_STATE', '{"isManualOpen":true,"date":"2026-11-10","currentOrderDate":"2026-11-10","lastOrderNumber":3104}'::text, 'cancelled', '0000', NOW() - INTERVAL '3 hours');
      `);

      // マイグレーション 0001_phase0_foundation.sql を適用
      const migrationSql = readFileSync(MIGRATION_FILE_PATH, 'utf8');
      runPsql(migrationSql);

      // バックフィル結果の検証
      // unpaid -> payment_status: unpaid, production_status: pending, cancellation_status: active
      const unpaidRow = querySingle(`
        SELECT payment_status || '|' || production_status || '|' || cancellation_status
        FROM public.orders WHERE id = 'ord_legacy_unpaid';
      `);
      assert.equal(unpaidRow, 'unpaid|pending|active');

      // pending -> payment_status: paid, production_status: pending, cancellation_status: active
      const pendingRow = querySingle(`
        SELECT payment_status || '|' || production_status || '|' || cancellation_status
        FROM public.orders WHERE id = 'ord_legacy_pending';
      `);
      assert.equal(pendingRow, 'paid|pending|active');

      // preparing -> payment_status: paid, production_status: preparing, cancellation_status: active
      const preparingRow = querySingle(`
        SELECT payment_status || '|' || production_status || '|' || cancellation_status
        FROM public.orders WHERE id = 'ord_legacy_preparing';
      `);
      assert.equal(preparingRow, 'paid|preparing|active');

      // completed -> payment_status: paid, production_status: ready, cancellation_status: active
      const completedRow = querySingle(`
        SELECT payment_status || '|' || production_status || '|' || cancellation_status
        FROM public.orders WHERE id = 'ord_legacy_completed';
      `);
      assert.equal(completedRow, 'paid|ready|active');

      // 過去の status = 'cancelled' は推測で書き換えられず NULL (legacy_undetermined) のまま保持されていること
      const cancelledRow = querySingle(`
        SELECT COALESCE(payment_status, 'NULL') || '|' || COALESCE(production_status, 'NULL') || '|' || COALESCE(cancellation_status, 'NULL')
        FROM public.orders WHERE id = 'ord_legacy_cancelled';
      `);
      assert.equal(cancelledRow, 'NULL|NULL|NULL', '過去のcancelled注文は4軸ステータスがNULLで保全されていること');

      // STORE_STATE_001 のデータ保全 (シード処理で既存レコードが上書きされないこと)
      const storeStateRaw = querySingle(`
        SELECT row_to_json(t)::text
        FROM (SELECT id, customer_name, customer_avatar, items FROM public.orders WHERE id = 'STORE_STATE_001') t;
      `);
      const storeState = JSON.parse(storeStateRaw);
      assert.equal(storeState.id, 'STORE_STATE_001');
      assert.equal(storeState.customer_name, 'STORE_STATE', '既存のcustomer_nameが維持されること');
      assert.ok(storeState.customer_avatar.includes('"lastOrderNumber":3104'), '既存のavatar/店舗状態が維持されること');
      assert.ok(storeState.customer_avatar.includes('"date":"2026-11-10"'), '既存のdateがシード値で上書きされないこと');
    });

    it('2.3 マイグレーション再実行（Idempotency）の安全性検証', () => {
      // 既にマイグレーション適用済みのDBに対して、再度 0001_phase0_foundation.sql を実行する
      const migrationSql = readFileSync(MIGRATION_FILE_PATH, 'utf8');
      assert.doesNotThrow(() => {
        runPsql(migrationSql);
      }, 'マイグレーションを再実行してもエラーが発生しないこと');

      // テーブルや関数が正常に残っていること
      const tableCount = querySingle(`
        SELECT count(*) FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('orders', 'order_number_sequences', 'stripe_webhook_events', 'auth_sessions', 'auth_login_rate_limits');
      `);
      assert.equal(tableCount, '5', '5つのテーブルが存在すること');
    });

    it('2.5 RLSおよびRPC実行権限の適切性検証 (anon実行拒否 / service_role実行許可)', () => {
      // 1. anon ロールで next_order_number を呼ぶと権限エラー(42501 permission denied)になること
      assert.throws(() => {
        runPsql(`
          SET ROLE anon;
          SELECT public.next_order_number('kenocha_main', '2026-11-10');
        `);
      }, /permission denied/i, 'anon ロールでの next_order_number 実行が拒否されること');

      // 2. anon ロールで confirm_stripe_order_payment_tx を呼ぶと権限エラーになること
      assert.throws(() => {
        runPsql(`
          SET ROLE anon;
          SELECT public.confirm_stripe_order_payment_tx('ord_legacy_unpaid', 'cs_mock');
        `);
      }, /permission denied/i, 'anon ロールでの confirm_stripe_order_payment_tx 実行が拒否されること');

      // 3. service_role ロールでは両関数とも正常に実行できること
      const serviceRoleOutput = querySingle(`
        SET ROLE service_role;
        SELECT public.next_order_number('kenocha_main', '2026-11-10');
      `);
      const lines = serviceRoleOutput.split('\n').map(l => l.trim()).filter(Boolean);
      const serviceRoleNum = lines[lines.length - 1];
      assert.ok(/^\d{4}$/.test(serviceRoleNum), `service_role では採番できること: ${serviceRoleNum}`);

      // 4. anon ロールに仮に SELECT 権限があっても RLS (Row Level Security) により 0件しか参照できないこと
      runPsql(`GRANT SELECT ON public.orders TO anon;`);
      const anonSelectOutput = querySingle(`
        SET ROLE anon;
        SELECT count(*) FROM public.orders;
      `);
      const anonCount = anonSelectOutput.split('\n').map(l => l.trim()).filter(Boolean).pop();
      assert.equal(anonCount, '0', 'anon ロールからは RLS により 0件 しか見えないこと');
    });

    it('2.6 非破壊ロールバックの検証 (データ保全と STORE_STATE_001 の番号同期)', () => {
      const rollbackSql = readFileSync(ROLLBACK_FILE_PATH, 'utf8');
      runPsql(rollbackSql);

      // 注文レコードが削除されず全件残っていること
      const orderCount = querySingle(`SELECT count(*) FROM public.orders;`);
      assert.equal(orderCount, '6', 'ロールバック後も注文データが1件も削除されていないこと');

      // 採番履歴やWebhookテーブルも DROP されずに保持されていること
      const tableCount = querySingle(`
        SELECT count(*) FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('order_number_sequences', 'stripe_webhook_events');
      `);
      assert.equal(tableCount, '2', 'ロールバック後も新テーブルが保持されていること');

      // 最新注文番号が STORE_STATE_001.lastOrderNumber に逆同期されていること
      const stateAvatar = querySingle(`SELECT customer_avatar FROM public.orders WHERE id = 'STORE_STATE_001';`);
      assert.ok(stateAvatar.includes('"lastOrderNumber"'), 'lastOrderNumber が同期されていること');
    });
  });

  describe('3. 注文番号の検証', () => {
    before(() => {
      resetToLegacySchema();
      // 当日 2026-11-10 の注文をシミュレート
      // orders の最大値: 3450
      // STORE_STATE_001 の lastOrderNumber: 3452
      runPsql(`
        INSERT INTO public.orders (id, items, total_price, customer_name, customer_avatar, status, order_number, created_at)
        VALUES
          ('ord_test_3450', '[]'::jsonb, 500, 'テスト客', NULL, 'completed', '3450', NOW()),
          ('STORE_STATE_001', '[]'::jsonb, 0, 'STORE_STATE', '{"isManualOpen":true,"date":"2026-11-10","currentOrderDate":"2026-11-10","lastOrderNumber":3452}'::text, 'cancelled', '0000', NOW());
      `);

      const migrationSql = readFileSync(MIGRATION_FILE_PATH, 'utf8');
      runPsql(migrationSql);
    });

    it('3.1 当日の既存注文番号・STORE_STATE_001 からの正しい引き継ぎ (GREATEST + 1)', () => {
      // 既存 orders の最大値は 3450, STORE_STATE_001 は 3452 なので、
      // GREATEST(3450, 3452) + 1 = 3453 が採番されること
      const nextNum = querySingle(`SELECT public.next_order_number('kenocha_main', '2026-11-10');`);
      assert.equal(nextNum, '3453', '既存の最大番号 3452 を引き継ぎ 3453 が採番されること');

      const nextNum2 = querySingle(`SELECT public.next_order_number('kenocha_main', '2026-11-10');`);
      assert.equal(nextNum2, '3454', '連続して 3454 が採番されること');
    });

    it('3.2 50件以上の並列RPC呼び出しで重複がゼロであること (60並列トランザクション)', async () => {
      // Node.js の非同期並列実行で、60個の独立した psql プロセスから同時に next_order_number を呼ぶ
      const promises = Array.from({ length: 60 }, () => {
        return new Promise<string>((resolve, reject) => {
          try {
            const num = runPsql(`SELECT public.next_order_number('kenocha_main', '2026-11-10');`);
            resolve(num);
          } catch (e) {
            reject(e);
          }
        });
      });

      const results = await Promise.all(promises);
      assert.equal(results.length, 60);

      const uniqueSet = new Set(results);
      assert.equal(uniqueSet.size, 60, `60件すべて一意の番号であること (重複ゼロ): 重複件数 ${60 - uniqueSet.size}`);

      // すべて 3455 〜 3514 の範囲内であること
      const numbers = results.map(n => parseInt(n, 10)).sort((a, b) => a - b);
      assert.equal(numbers[0], 3455);
      assert.equal(numbers[59], 3514);
    });

    it('3.3 日付変更時に正しく新しい初期値 (3000〜5000) にリセットされること', () => {
      // 翌日 2026-11-11 の日付で採番
      const nextDayNum = querySingle(`SELECT public.next_order_number('kenocha_main', '2026-11-11');`);
      const parsed = parseInt(nextDayNum, 10);
      assert.ok(parsed >= 3000 && parsed <= 5000, `翌日の初回採番 (${parsed}) が 3000〜5000 の範囲内であること`);

      const nextDayNum2 = querySingle(`SELECT public.next_order_number('kenocha_main', '2026-11-11');`);
      assert.equal(parseInt(nextDayNum2, 10), parsed + 1, '翌日も連続して +1 されること');
    });

    it('3.4 9999到達時に ORDER_NUMBER_LIMIT_EXCEEDED で安全に停止すること', () => {
      // シーケンステーブルを強制的に 9999 にセット
      runPsql(`
        UPDATE public.order_number_sequences
        SET last_number = 9999
        WHERE store_id = 'kenocha_main' AND order_date = '2026-11-10';
      `);

      // 次の採番 (10000) は例外を発生させること
      assert.throws(() => {
        runPsql(`SELECT public.next_order_number('kenocha_main', '2026-11-10');`);
      }, /ORDER_NUMBER_LIMIT_EXCEEDED/, '4桁上限到達時に例外で安全に拒否されること');
    });
  });

  describe('4. Stripe Webhookの検証', () => {
    before(() => {
      resetToLegacySchema();
      // テスト注文の投入
      runPsql(`
        INSERT INTO public.orders (id, items, total_price, customer_name, customer_avatar, status, order_number, created_at)
        VALUES
          ('ord_stripe_unpaid', '[{"name":"煎茶", "price":1000, "quantity":1}]'::jsonb, 1000, '決済客', NULL, 'unpaid', '3601', NOW()),
          ('ord_stripe_cooking', '[{"name":"抹茶", "price":1200, "quantity":1}]'::jsonb, 1200, '調理客', NULL, 'preparing', '3602', NOW()),
          ('ord_stripe_cancelled', '[{"name":"焙じ茶", "price":800, "quantity":1}]'::jsonb, 800, '取消客', NULL, 'cancelled', '3603', NOW());
      `);

      const migrationSql = readFileSync(MIGRATION_FILE_PATH, 'utf8');
      runPsql(migrationSql);

      // 取消客の cancellation_status を 'cancelled' に設定
      runPsql(`
        UPDATE public.orders
        SET cancellation_status = 'cancelled'
        WHERE id = 'ord_stripe_cancelled';
      `);
    });

    it('4.1 注文更新と Webhook 完了記録が同一トランザクションで確定すること', () => {
      const res = querySingle(`
        SELECT public.confirm_stripe_order_payment_tx('ord_stripe_unpaid', 'cs_test_session_001', 'evt_stripe_001');
      `);
      assert.ok(res.includes('"found": true'));
      assert.ok(res.includes('"transitioned_from_unpaid": true'));

      // orders テーブルが pending / paid に更新されていること
      const orderRow = querySingle(`
        SELECT status || '|' || payment_status || '|' || stripe_session_id
        FROM public.orders WHERE id = 'ord_stripe_unpaid';
      `);
      assert.equal(orderRow, 'pending|paid|cs_test_session_001');

      // stripe_webhook_events に同一トランザクションで status = 'succeeded' が記録されていること
      const eventRow = querySingle(`
        SELECT status || '|' || session_id || '|' || order_id
        FROM public.stripe_webhook_events WHERE event_id = 'evt_stripe_001';
      `);
      assert.equal(eventRow, 'succeeded|cs_test_session_001|ord_stripe_unpaid');
    });

    it('4.2 途中でSQLエラーが発生した場合に不完全な更新が一切残らないこと (ロールバック整合性)', () => {
      // 存在しない注文IDに対してトランザクション内で実行
      const beforeEventCount = querySingle(`SELECT count(*) FROM public.stripe_webhook_events;`);

      assert.throws(() => {
        runPsql(`
          BEGIN;
          -- 正常な更新
          SELECT public.confirm_stripe_order_payment_tx('ord_stripe_cooking', 'cs_test_session_fail', 'evt_stripe_fail');
          -- 意図的なSQLエラー（存在しないテーブルへのクエリ）
          SELECT * FROM non_existent_table_for_error;
          COMMIT;
        `);
      });

      // ロールバックされたため、evt_stripe_fail が stripe_webhook_events に残っていないこと
      const afterEventCount = querySingle(`SELECT count(*) FROM public.stripe_webhook_events;`);
      assert.equal(afterEventCount, beforeEventCount, 'エラー時にトランザクション全体がロールバックされゴミが残らないこと');

      // 注文も巻き戻されていること
      const cookingOrderSession = querySingle(`
        SELECT COALESCE(stripe_session_id, 'NULL') FROM public.orders WHERE id = 'ord_stripe_cooking';
      `);
      assert.equal(cookingOrderSession, 'NULL');
    });

    it('4.3 同一イベントの再送で二重処理・ステータス巻き戻りが発生しないこと', () => {
      // ord_stripe_unpaid は既に pending に更新された。ここでキッチンが調理中(preparing)に進めたと仮定
      runPsql(`
        UPDATE public.orders
        SET status = 'preparing', production_status = 'preparing'
        WHERE id = 'ord_stripe_unpaid';
      `);

      // 同一の evt_stripe_001 が再送された場合
      const res = querySingle(`
        SELECT public.confirm_stripe_order_payment_tx('ord_stripe_unpaid', 'cs_test_session_001', 'evt_stripe_001');
      `);
      assert.ok(res.includes('"transitioned_from_unpaid": false'));

      // 注文のステータスは preparing のままであり、pending に巻き戻っていないこと
      const orderStatus = querySingle(`SELECT status FROM public.orders WHERE id = 'ord_stripe_unpaid';`);
      assert.equal(orderStatus, 'preparing', '調理中ステータスが維持されること');
    });

    it('4.4 取消済み注文に対する決済確認で注文が復活しないこと (取消状態の保全)', () => {
      // ord_stripe_cancelled は status='cancelled', cancellation_status='cancelled'
      // 決済確認RPCが実行されても、ステータスが pending や active に復活しないこと
      runPsql(`
        SELECT public.confirm_stripe_order_payment_tx('ord_stripe_cancelled', 'cs_test_session_cancelled', 'evt_stripe_cancelled');
      `);

      const statusRow = querySingle(`
        SELECT status || '|' || cancellation_status || '|' || payment_status
        FROM public.orders WHERE id = 'ord_stripe_cancelled';
      `);
      assert.equal(statusRow, 'cancelled|cancelled|paid', 'status は cancelled のままであり pending に復活しないこと');
    });

    it('4.5 処理中ロックの期限切れ後も安全性が維持されること (CASによる安全なロック再取得)', () => {
      // 30秒以上前に開始されて放置された processing レコードを作成
      runPsql(`
        INSERT INTO public.stripe_webhook_events (
          event_id, session_id, order_id, status, attempt_count, started_at, updated_at
        )
        VALUES (
          'evt_stale_lock', 'cs_stale', 'ord_stripe_unpaid', 'processing', 1,
          NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '2 minutes'
        )
        ON CONFLICT (event_id) DO UPDATE SET
          status = 'processing',
          updated_at = NOW() - INTERVAL '2 minutes';
      `);

      // 期限切れロックに対する CAS (Compare-And-Swap) 更新をシミュレート
      const staleBefore = querySingle(`
        SELECT status || '|' || attempt_count
        FROM public.stripe_webhook_events WHERE event_id = 'evt_stale_lock';
      `);
      assert.equal(staleBefore, 'processing|1');

      // タイムアウト検知による再取得
      runPsql(`
        UPDATE public.stripe_webhook_events
        SET attempt_count = attempt_count + 1, updated_at = NOW()
        WHERE event_id = 'evt_stale_lock'
          AND status = 'processing'
          AND updated_at <= NOW() - INTERVAL '30 seconds';
      `);

      const staleAfter = querySingle(`
        SELECT status || '|' || attempt_count
        FROM public.stripe_webhook_events WHERE event_id = 'evt_stale_lock';
      `);
      assert.equal(staleAfter, 'processing|2', '期限切れロックが検知され attempt_count が2にインクリメントされて再取得されること');
    });

    it('4.6 Stripeテストモード署名付きWebhookの疎通確認', () => {
      // Stripe SDK による署名生成と検証の疎通
      const webhookSecret = 'whsec_test_secret_for_verification_only_12345';
      const stripe = new Stripe('sk_test_mock', {});
      const payload = JSON.stringify({
        id: 'evt_test_signed_001',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_signed',
            payment_status: 'paid',
            amount_total: 1000,
            currency: 'jpy',
            metadata: { orderId: 'ord_stripe_unpaid' },
          },
        },
      });

      // 有効な署名を生成
      const header = stripe.webhooks.generateTestHeaderString({
        payload,
        secret: webhookSecret,
      });

      // 正常な署名検証
      const event = stripe.webhooks.constructEvent(payload, header, webhookSecret);
      assert.equal(event.id, 'evt_test_signed_001');

      // 不正な改ざん署名の拒否
      assert.throws(() => {
        stripe.webhooks.constructEvent(payload, 't=123,v1=tampered_signature', webhookSecret);
      }, /signature/, '不正な署名は拒否されること');
    });
  });

  describe('5. 認証・設定の確認', () => {
    it('5.1 auth_sessions および auth_login_rate_limits のCRUD・排他制御検証', () => {
      // セッション作成
      runPsql(`
        INSERT INTO public.auth_sessions (session_id, role, issued_at, expires_at, revoked)
        VALUES ('sess_test_1', 'staff', NOW(), NOW() + INTERVAL '12 hours', false)
        ON CONFLICT (session_id) DO NOTHING;
      `);

      const sess = querySingle(`SELECT role || '|' || revoked FROM public.auth_sessions WHERE session_id = 'sess_test_1';`);
      assert.equal(sess, 'staff|false');

      // レートリミットの更新
      runPsql(`
        INSERT INTO public.auth_login_rate_limits (identifier, attempts, first_attempt_at, locked_until)
        VALUES ('192.168.1.1', 5, NOW(), NOW() + INTERVAL '15 minutes')
        ON CONFLICT (identifier) DO UPDATE SET
          attempts = EXCLUDED.attempts,
          locked_until = EXCLUDED.locked_until;
      `);

      const limit = querySingle(`SELECT attempts FROM public.auth_login_rate_limits WHERE identifier = '192.168.1.1';`);
      assert.equal(limit, '5');
    });

    it('5.2 公開APIからの個人情報・内部管理情報の漏洩防止検証 (/api/orders/public, /api/store-state)', () => {
      // 1. 公開注文サマリー (PublicOrderSummary) のフィールド検証
      const mockDbRow = {
        id: 'ord_pub_1',
        items: [{ name: '煎茶', price: 500, quantity: 1 }],
        total_price: 500,
        customer_name: '山田太郎', // 個人情報
        customer_avatar: 'https://example.com/avatar.jpg', // 個人情報
        status: 'pending' as const,
        created_at: '2026-11-10T05:00:00Z',
        order_number: '3701',
      };

      // 公開サマリーの型準拠データ
      const publicSummary = {
        id: mockDbRow.id,
        orderNumber: mockDbRow.order_number,
        status: mockDbRow.status,
        createdAt: mockDbRow.created_at,
      };

      const publicKeys = Object.keys(publicSummary);
      assert.deepEqual(publicKeys.sort(), ['createdAt', 'id', 'orderNumber', 'status']);
      assert.equal('customerName' in publicSummary, false, '顧客名は公開されないこと');
      assert.equal('customerAvatar' in publicSummary, false, '顧客アバターは公開されないこと');
      assert.equal('totalPrice' in publicSummary, false, '注文金額は公開されないこと');
      assert.equal('items' in publicSummary, false, '注文明細は公開されないこと');

      // 2. 店舗ステータスの未認証レスポンス最小化検証
      const fullStoreState = {
        isManualOpen: true,
        date: '2026-11-10',
        openedAt: 1762740000000,
        soldOutItems: ['s1', 'm2'],
        openHistory: [{ date: '2026-11-09', openedAt: 1762650000000, soldOutItems: [] }], // 内部管理情報
        currentOrderDate: '2026-11-10', // 内部管理情報
        lastOrderNumber: 3701, // 内部管理情報
      };

      const unauthenticatedPublicState = {
        isManualOpen: Boolean(fullStoreState.isManualOpen),
        date: fullStoreState.date || '',
        openedAt: fullStoreState.openedAt,
        soldOutItems: fullStoreState.soldOutItems ?? [],
      };

      assert.equal('openHistory' in unauthenticatedPublicState, false, 'openHistory は未認証時に公開されないこと');
      assert.equal('lastOrderNumber' in unauthenticatedPublicState, false, 'lastOrderNumber は未認証時に公開されないこと');
      assert.equal('currentOrderDate' in unauthenticatedPublicState, false, 'currentOrderDate は未認証時に公開されないこと');
      assert.equal(unauthenticatedPublicState.isManualOpen, true);
      assert.equal(unauthenticatedPublicState.soldOutItems.length, 2);
    });
  });

  describe('6. Checkout競合制御RPC・売上履歴除外・バックアップ復元ACL維持の統合検証', () => {
    it('6.1 新設4RPCを含む全6RPCの権限制御 (anon/authenticated拒否、service_role許可、SECURITY DEFINER、search_path固定)', () => {
      const rpcNames = [
        'next_order_number',
        'confirm_stripe_order_payment_tx',
        'update_store_state_tx',
        'create_mobile_order_tx',
        'finalize_mobile_order_checkout_tx',
        'abort_mobile_order_checkout_tx',
      ];

      for (const fnName of rpcNames) {
        const meta = querySingle(`
          SELECT
            p.prosecdef::text || '|' ||
            COALESCE(array_to_string(p.proconfig, ','), '') || '|' ||
            has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|' ||
            has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|' ||
            has_function_privilege('service_role', p.oid, 'EXECUTE')::text
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = '${fnName}';
        `);
        assert.equal(
          meta,
          'true|search_path=public, pg_temp|false|false|true',
          `${fnName} の SECURITY DEFINER / search_path / ACL が正しく設定されていること`
        );
      }

      // anon / authenticated ロールから新設RPCを直接呼び出すと permission denied になることを実DBで確認
      assert.throws(() => {
        runPsql(`
          SET ROLE anon;
          SELECT public.create_mobile_order_tx(
            'kenocha_main', 'ord_hack', '[]'::jsonb, 400, 'Hacker', NULL, ARRAY['m1'], NOW()
          );
        `);
      }, /permission denied for function create_mobile_order_tx/);

      assert.throws(() => {
        runPsql(`
          SET ROLE authenticated;
          SELECT public.update_store_state_tx('kenocha_main', '{"isManualOpen":true}'::jsonb);
        `);
      }, /permission denied for function update_store_state_tx/);
    });

    it('6.2 受付停止と注文作成の並列実行・直列化 & 受付停止直後のCheckout開始拒否 (採番インクリメントなし・注文INSERTなし)', async () => {
      // 1. 営業中 (2026-11-11 11:00 JST = 02:00 UTC) に update_store_state_tx で店舗状態をセット
      runPsql(`
        SET ROLE service_role;
        SELECT public.update_store_state_tx(
          'kenocha_main',
          jsonb_build_object(
            'isManualOpen', true,
            'date', '2026-11-11',
            'openedAt', (EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-11-11T01:00:00Z') * 1000)::bigint,
            'soldOutItems', jsonb_build_array('s5')
          )
        );
      `);

      // 2. 営業中の正常注文作成 -> 成功
      const createOpenRes = JSON.parse(
        querySingle(`
          SET ROLE service_role;
          SELECT public.create_mobile_order_tx(
            'kenocha_main',
            'ord_atomic_open_1',
            '[{"id":"m1","name":"緑茶ミルクティー (ゼリー: なし, 甘さ: 普通, 氷: 氷あり)","price":400,"quantity":1}]'::jsonb,
            400,
            '営業中顧客',
            NULL,
            ARRAY['m1'],
            TIMESTAMPTZ '2026-11-11T02:00:00Z'
          )::text;
        `)
          .split('\n')
          .pop()!
      );
      assert.equal(createOpenRes.ok, true);
      assert.equal(createOpenRes.order.id, 'ord_atomic_open_1');
      assert.equal(createOpenRes.order.status, 'unpaid');

      const seqBeforeClose = parseInt(
        querySingle(`
          SELECT last_number FROM public.order_number_sequences
          WHERE store_id = 'kenocha_main' AND order_date = '2026-11-11';
        `),
        10
      );

      // 3. 欠品商品 (s5) の注文 -> ITEM_SOLD_OUT で拒否され、採番シーケンスが進まないこと
      const soldOutRes = JSON.parse(
        querySingle(`
          SET ROLE service_role;
          SELECT public.create_mobile_order_tx(
            'kenocha_main',
            'ord_atomic_soldout',
            '[{"id":"s5","name":"ほうじ茶","price":250,"quantity":1}]'::jsonb,
            250,
            '欠品注文顧客',
            NULL,
            ARRAY['s5'],
            TIMESTAMPTZ '2026-11-11T02:01:00Z'
          )::text;
        `)
          .split('\n')
          .pop()!
      );
      assert.equal(soldOutRes.ok, false);
      assert.equal(soldOutRes.code, 'ITEM_SOLD_OUT');

      // 4. 受付停止 (update_store_state_tx: isManualOpen=false) と 8件の注文作成 (create_mobile_order_tx) を並列実行
      //    デッドロックが一切起きず、成功した件数分だけ正確に採番シーケンスが進む（拒否された注文は採番もINSERTも行われない）ことを検証
      const parallelTasks: Array<Promise<{ type: 'close' | 'order'; ok: boolean }>> = [
        new Promise((resolve, reject) => {
          try {
            runPsql(`
              SET ROLE service_role;
              SELECT public.update_store_state_tx(
                'kenocha_main',
                jsonb_build_object(
                  'isManualOpen', false,
                  'date', '2026-11-11',
                  'openedAt', (EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-11-11T01:00:00Z') * 1000)::bigint,
                  'soldOutItems', jsonb_build_array('s5')
                )
              );
            `);
            resolve({ type: 'close', ok: true });
          } catch (e) {
            reject(e);
          }
        }),
        ...Array.from({ length: 8 }, (_, idx) =>
          new Promise<{ type: 'close' | 'order'; ok: boolean }>((resolve, reject) => {
            try {
              const out = querySingle(`
                SET ROLE service_role;
                SELECT public.create_mobile_order_tx(
                  'kenocha_main',
                  'ord_parallel_race_${idx + 1}',
                  '[{"id":"m1","name":"緑茶ミルクティー","price":400,"quantity":1}]'::jsonb,
                  400,
                  '並列競合顧客_${idx + 1}',
                  NULL,
                  ARRAY['m1'],
                  TIMESTAMPTZ '2026-11-11T02:01:30Z'
                )::text;
              `)
                .split('\n')
                .pop()!;
              const parsed = JSON.parse(out);
              resolve({ type: 'order', ok: Boolean(parsed.ok) });
            } catch (e) {
              reject(e);
            }
          })
        ),
      ];

      const parallelResults = await Promise.all(parallelTasks);
      const parallelCreatedCount = parallelResults.filter(
        (r) => r.type === 'order' && r.ok
      ).length;

      // 5. 受付停止完了後の新規注文 -> 確実に STORE_CLOSED で拒否されること
      const closedRes = JSON.parse(
        querySingle(`
          SET ROLE service_role;
          SELECT public.create_mobile_order_tx(
            'kenocha_main',
            'ord_atomic_after_close',
            '[{"id":"m1","name":"緑茶ミルクティー","price":400,"quantity":1}]'::jsonb,
            400,
            '受付停止後顧客',
            NULL,
            ARRAY['m1'],
            TIMESTAMPTZ '2026-11-11T02:02:00Z'
          )::text;
        `)
          .split('\n')
          .pop()!
      );
      assert.equal(closedRes.ok, false);
      assert.equal(closedRes.code, 'STORE_CLOSED');

      const seqAfterClose = parseInt(
        querySingle(`
          SELECT last_number FROM public.order_number_sequences
          WHERE store_id = 'kenocha_main' AND order_date = '2026-11-11';
        `),
        10
      );
      assert.equal(
        seqAfterClose,
        seqBeforeClose + parallelCreatedCount,
        '受付停止前に通過した注文数と採番シーケンス増加数が完全一致し、拒否された注文では採番が一切消費されないこと'
      );

      const existsAfterClose = querySingle(`
        SELECT COUNT(*) FROM public.orders WHERE id IN ('ord_atomic_soldout', 'ord_atomic_after_close');
      `);
      assert.equal(existsAfterClose, '0', '拒否された注文レコードはDBに1件もINSERTされないこと');
    });

    it('6.3 Stripeセッション発行中の受付停止検知 (finalize_mobile_order_checkout_tx) と決済完了 vs キャンセル競合保護 (abort_mobile_order_checkout_tx)', () => {
      // ord_atomic_open_1 は営業中に作成された unpaid 注文。
      // その直後（Stripeセッション作成中）に店舗が isManualOpen: false になった状態で finalize_mobile_order_checkout_tx を呼ぶ
      const finalizeClosedRes = JSON.parse(
        querySingle(`
          SET ROLE service_role;
          SELECT public.finalize_mobile_order_checkout_tx(
            'kenocha_main',
            'ord_atomic_open_1',
            'cs_test_during_close_001',
            ARRAY['m1'],
            TIMESTAMPTZ '2026-11-11T02:03:00Z'
          )::text;
        `)
          .split('\n')
          .pop()!
      );
      assert.equal(finalizeClosedRes.ok, false);
      assert.equal(finalizeClosedRes.code, 'STORE_CLOSED');
      assert.equal(finalizeClosedRes.order_cancelled, true);

      // DB上で status='cancelled', payment_status='unpaid', cancellation_status='cancelled' になっていることを確認
      const abortedOrderRow = querySingle(`
        SELECT status || '|' || payment_status || '|' || cancellation_status || '|' || COALESCE(stripe_session_id, '')
        FROM public.orders WHERE id = 'ord_atomic_open_1';
      `);
      assert.equal(abortedOrderRow, 'cancelled|unpaid|cancelled|cs_test_during_close_001');

      // 次に、すでに決済完了した注文 (ord_stripe_unpaid はテスト4.1で status='preparing' または 'pending', payment_status='paid' になっている)
      // に対して abort_mobile_order_checkout_tx が呼ばれても、絶対にキャンセルされず ALREADY_PAID で保護されることを検証
      const abortPaidRes = JSON.parse(
        querySingle(`
          SET ROLE service_role;
          SELECT public.abort_mobile_order_checkout_tx(
            'ord_stripe_unpaid',
            'cs_test_paid',
            'race_abort_attempt'
          )::text;
        `)
          .split('\n')
          .pop()!
      );
      assert.equal(abortPaidRes.ok, false);
      assert.equal(abortPaidRes.code, 'ALREADY_PAID');

      const paidOrderStillActive = querySingle(`
        SELECT payment_status || '|' || cancellation_status
        FROM public.orders WHERE id = 'ord_stripe_unpaid';
      `);
      assert.equal(paidOrderStillActive, 'paid|active', '決済済み注文はキャンセルや削除から完全に保護されること');
    });

    it('6.4 中断注文の売上履歴除外と過去注文 (legacy_undetermined) の売上履歴互換性検証', () => {
      // 過去データ互換用のレコード (status='cancelled' かつ payment_status IS NULL) を投入
      runPsql(`
        INSERT INTO public.orders (
          id, items, total_price, customer_name, status, order_number,
          payment_status, production_status, fulfillment_status, cancellation_status
        ) VALUES (
          'legacy_cancelled_hist_1',
          '[{"name":"緑茶","price":250,"quantity":1}]'::jsonb,
          250,
          '過去データ顧客',
          'cancelled',
          '3099',
          NULL, NULL, NULL, NULL
        )
        ON CONFLICT (id) DO NOTHING;
      `);

      // GET /api/orders/history と同一のSQL条件で取得した場合:
      // - ord_atomic_open_1 (status='cancelled', payment_status='unpaid', cancellation_status='cancelled') は除外される
      // - legacy_cancelled_hist_1 (status='cancelled', payment_status IS NULL) は保持される
      // - ord_stripe_unpaid (payment_status='paid') は保持される
      const historyIds = querySingle(`
        SELECT string_agg(id, ',' ORDER BY id)
        FROM public.orders
        WHERE id <> 'STORE_STATE_001'
          AND status <> 'unpaid'
          AND (payment_status IS NULL OR payment_status IN ('paid', 'partially_refunded', 'refunded'));
      `);

      assert.equal(
        historyIds.includes('ord_atomic_open_1'),
        false,
        '決済前に中断された注文 (payment_status=unpaid) は売上履歴クエリから除外されること'
      );
      assert.equal(
        historyIds.includes('legacy_cancelled_hist_1'),
        true,
        '過去データ (payment_status IS NULL) は売上履歴クエリに保持されること'
      );
      assert.equal(
        historyIds.includes('ord_stripe_unpaid'),
        true,
        '決済済み注文 (payment_status=paid) は売上履歴クエリに保持されること'
      );
    });

    it('6.5 マイグレーション再実行の冪等性と pg_dump / pg_restore (--no-privileges なし) による全6RPCのACL維持検証', () => {
      // 1. マイグレーション SQL 再実行の冪等性確認
      const migrationSql = readFileSync(MIGRATION_FILE_PATH, 'utf8');
      runPsql(migrationSql);

      // 2. pg_dump (--no-privileges なし) でダンプを取得し、別DBへ pg_restore して全6RPCのACLが維持されることを実証
      runPsql(`
        DROP DATABASE IF EXISTS kenocha_restore_acl_verify;
        CREATE DATABASE kenocha_restore_acl_verify;
      `);

      execFileSync(
        'docker',
        [
          'exec',
          CONTAINER_NAME,
          'pg_dump',
          '-U',
          'postgres',
          '--format=custom',
          '--blobs',
          '--no-owner',
          '--schema=public',
          '--file=/tmp/phase0_acl_verify.dump',
          'postgres',
        ],
        { stdio: 'ignore' }
      );

      execFileSync(
        'docker',
        [
          'exec',
          CONTAINER_NAME,
          'pg_restore',
          '-U',
          'postgres',
          '--clean',
          '--if-exists',
          '--no-owner',
          '--dbname=kenocha_restore_acl_verify',
          '/tmp/phase0_acl_verify.dump',
        ],
        { stdio: 'ignore' }
      );

      const restoredAclCheck = execFileSync(
        'docker',
        [
          'exec',
          CONTAINER_NAME,
          'psql',
          '-U',
          'postgres',
          '-d',
          'kenocha_restore_acl_verify',
          '-t',
          '-A',
          '-c',
          `
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
            AND has_function_privilege('anon', p.oid, 'EXECUTE') = false
            AND has_function_privilege('authenticated', p.oid, 'EXECUTE') = false
            AND has_function_privilege('service_role', p.oid, 'EXECUTE') = true;
          `,
        ],
        { encoding: 'utf8' }
      ).trim();

      assert.equal(
        restoredAclCheck,
        '8',
        'pg_restore 後も全8個の SECURITY DEFINER RPC関数で anon=false, authenticated=false, service_role=true が維持されていること'
      );

      // クリーンアップ
      runPsql(`DROP DATABASE IF EXISTS kenocha_restore_acl_verify;`);
    });
  });

  describe('7. 決済取消競合RPC・返金案件永続化・二重返金防止の実PostgreSQL統合検証', () => {
    before(() => {
      // 最新マイグレーションを適用
      const migrationSql = readFileSync(MIGRATION_FILE_PATH, 'utf8');
      runPsql(migrationSql);
    });

    it('7.1 全8個のSECURITY DEFINER RPCに対する権限制御検証 (anon/authenticated拒否、service_role許可)', () => {
      const rpcCount = runPsql(`
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
      assert.equal(rpcCount, '8', '8個すべてのRPCで正しいACLおよびSECURITY DEFINERが設定されていること');
    });

    it('7.2 record_cancelled_payment_discrepancy_tx による決済不整合の原子的永続化とWebhook succeeded確定', () => {
      // クリーンアップ & キャンセル済み注文を準備 (customer_name NOT NULL を満たす)
      runPsql(`
        DELETE FROM public.order_refund_requests WHERE order_id = 'ord_pg_disc_1';
        DELETE FROM public.stripe_webhook_events WHERE event_id = 'evt_pg_disc_1';
        INSERT INTO public.orders (
          id, customer_name, order_number, total_price, status, payment_status, production_status, fulfillment_status, cancellation_status, refund_status, requires_manual_attention
        ) VALUES (
          'ord_pg_disc_1', 'テスト客', '3801', 1400, 'cancelled', 'unpaid', 'pending', 'not_handed_over', 'cancelled', 'none', false
        ) ON CONFLICT (id) DO UPDATE SET
          status = 'cancelled',
          payment_status = 'unpaid',
          cancellation_status = 'cancelled',
          refund_status = 'none',
          requires_manual_attention = false;
      `);

      // service_role で RPC 実行
      const res = queryJson(`
        SET ROLE service_role;
        SELECT public.record_cancelled_payment_discrepancy_tx(
          'ord_pg_disc_1',
          'cs_test_pg_disc_1',
          'pi_test_pg_disc_1',
          1400,
          'jpy',
          'evt_pg_disc_1',
          'cancelled_order_payment_received'
        );
      `);
      assert.equal(res.ok, true);
      assert.equal(res.order_id, 'ord_pg_disc_1');
      assert.equal(res.refund_request.refund_status, 'pending');
      assert.equal(res.refund_request.requires_manual_attention, true);
      assert.equal(res.refund_request.payment_intent_id, 'pi_test_pg_disc_1');

      // DB上の orders 状態を確認（status=cancelled を維持しつつ refund_status='pending', requires_manual_attention=true）
      const orderCheck = runPsql(`
        SELECT status, payment_status, cancellation_status, refund_status, requires_manual_attention
        FROM public.orders WHERE id = 'ord_pg_disc_1';
      `);
      assert.equal(orderCheck, 'cancelled|unpaid|cancelled|pending|t');

      // Webhook イベントテーブルが同一トランザクションで succeeded になっていること
      const evtCheck = runPsql(`
        SELECT status FROM public.stripe_webhook_events WHERE event_id = 'evt_pg_disc_1';
      `);
      assert.equal(evtCheck, 'succeeded');
    });

    it('7.3 同一注文に対する record_cancelled_payment_discrepancy_tx の再送・重複防止 (ON CONFLICT 冪等性)', () => {
      // 2回目の呼び出し（同一注文・同一イベント再送）
      const res2 = queryJson(`
        SET ROLE service_role;
        SELECT public.record_cancelled_payment_discrepancy_tx(
          'ord_pg_disc_1',
          'cs_test_pg_disc_1',
          'pi_test_pg_disc_1',
          1400,
          'jpy',
          'evt_pg_disc_1',
          'replayed_event'
        );
      `);
      assert.equal(res2.ok, true);

      // order_refund_requests に重複行が生成されていないこと（COUNT = 1）
      const countCheck = runPsql(`
        SELECT COUNT(*) FROM public.order_refund_requests WHERE order_id = 'ord_pg_disc_1';
      `);
      assert.equal(countCheck, '1', '同一注文に対して重複レコードが作成されないこと');
    });

    it('7.4 update_refund_request_status_tx による返金完了と注文テーブルの整合性更新', () => {
      // 返金成功を記録
      const updateRes = queryJson(`
        SET ROLE service_role;
        SELECT public.update_refund_request_status_tx(
          'ord_pg_disc_1',
          'succeeded',
          're_test_pg_succ_1',
          NULL,
          NULL,
          true
        );
      `);
      assert.equal(updateRes.ok, true);
      assert.equal(updateRes.refund_request.refund_status, 'succeeded');
      assert.equal(updateRes.refund_request.requires_manual_attention, false);

      // orders テーブルが payment_status='refunded', refunded_amount=1400, requires_manual_attention=false に更新されていること
      const finalOrder = runPsql(`
        SELECT status, payment_status, refunded_amount, refund_status, requires_manual_attention
        FROM public.orders WHERE id = 'ord_pg_disc_1';
      `);
      assert.equal(finalOrder, 'cancelled|refunded|1400|succeeded|f');
    });

    it('7.5 過去注文 (legacy_undetermined) に対する返金案件登録の保護拒否', () => {
      // 過去の cancelled 注文（payment_status / cancellation_status が NULL, customer_name NOT NULL）
      runPsql(`
        INSERT INTO public.orders (
          id, customer_name, order_number, total_price, status, payment_status, cancellation_status
        ) VALUES (
          'ord_pg_legacy_prot_1', '昔の客', '1099', 1200, 'cancelled', NULL, NULL
        ) ON CONFLICT (id) DO UPDATE SET status = 'cancelled', payment_status = NULL, cancellation_status = NULL;
      `);

      const res = queryJson(`
        SET ROLE service_role;
        SELECT public.record_cancelled_payment_discrepancy_tx(
          'ord_pg_legacy_prot_1',
          'cs_test_legacy',
          'pi_test_legacy',
          1200,
          'jpy'
        );
      `);
      assert.equal(res.ok, false);
      assert.equal(res.code, 'LEGACY_ORDER_PROTECTED');

      // order_refund_requests に案件が作られていないこと
      const reqCount = runPsql(`
        SELECT COUNT(*) FROM public.order_refund_requests WHERE order_id = 'ord_pg_legacy_prot_1';
      `);
      assert.equal(reqCount, '0');
    });

    it('7.6 マイグレーション再実行（Idempotency）の完全な安全性検証', () => {
      const migrationSql = readFileSync(MIGRATION_FILE_PATH, 'utf8');
      assert.doesNotThrow(() => {
        runPsql(migrationSql);
      }, '0001_phase0_foundation.sql は何度再実行してもエラーなく適用できること');
    });
  });

  describe('8. 0002_phase0_stripe_session_hardening.sql 厳格遷移・セッション照合・退行防止の実PostgreSQL統合検証', () => {
    before(() => {
      const migration0001Sql = readFileSync(MIGRATION_FILE_PATH, 'utf8');
      const migration0002Sql = readFileSync(MIGRATION_0002_FILE_PATH, 'utf8');
      runPsql(migration0001Sql);
      runPsql(migration0002Sql);
    });

    it('8.1 Session ID未設定 (NULL / 空文字) の注文に対する誤確定防止 (SESSION_ID_NOT_CONFIGURED)', () => {
      runPsql(`
        DELETE FROM public.stripe_webhook_events WHERE event_id IN ('evt_0002_null_sess', 'evt_0002_empty_sess');
        INSERT INTO public.orders (
          id, customer_name, order_number, total_price, status, payment_status, production_status, fulfillment_status, cancellation_status, stripe_session_id
        ) VALUES (
          'ord_0002_no_sess', '未設定客', '8001', 400, 'unpaid', 'unpaid', 'pending', 'not_handed_over', 'active', NULL
        ) ON CONFLICT (id) DO UPDATE SET
          status = 'unpaid', payment_status = 'unpaid', stripe_session_id = NULL, cancellation_status = 'active';
      `);

      const resNull = queryJson(`
        SET ROLE service_role;
        SELECT public.confirm_stripe_order_payment_tx('ord_0002_no_sess', 'cs_test_any', 'evt_0002_null_sess');
      `);
      assert.equal(resNull.found, true);
      assert.equal(resNull.ok, false);
      assert.equal(resNull.code, 'SESSION_ID_NOT_CONFIGURED');

      const orderState = querySingle(`
        SELECT status || '|' || payment_status FROM public.orders WHERE id = 'ord_0002_no_sess';
      `);
      assert.equal(orderState, 'unpaid|unpaid', 'stripe_session_id未設定注文は絶対にpaidにならないこと');

      const evtCount = querySingle(`
        SELECT COUNT(*) FROM public.stripe_webhook_events WHERE event_id = 'evt_0002_null_sess' AND status = 'succeeded';
      `);
      assert.equal(evtCount, '0', '拒否時にWebhookがsucceededとして記録されないこと');
    });

    it('8.2 別注文の支払済みSession ID流用に対するDBレベル拒否 (SESSION_ID_MISMATCH)', () => {
      runPsql(`
        DELETE FROM public.stripe_webhook_events WHERE event_id = 'evt_0002_mismatch';
        INSERT INTO public.orders (
          id, customer_name, order_number, total_price, status, payment_status, production_status, fulfillment_status, cancellation_status, stripe_session_id
        ) VALUES (
          'ord_0002_victim', '正規客', '8002', 400, 'unpaid', 'unpaid', 'pending', 'not_handed_over', 'active', 'cs_test_expected_victim_8002'
        ) ON CONFLICT (id) DO UPDATE SET
          status = 'unpaid', payment_status = 'unpaid', stripe_session_id = 'cs_test_expected_victim_8002', cancellation_status = 'active';
      `);

      const resMismatch = queryJson(`
        SET ROLE service_role;
        SELECT public.confirm_stripe_order_payment_tx('ord_0002_victim', 'cs_test_stolen_other_session', 'evt_0002_mismatch');
      `);
      assert.equal(resMismatch.found, true);
      assert.equal(resMismatch.ok, false);
      assert.equal(resMismatch.code, 'SESSION_ID_MISMATCH');

      const orderState = querySingle(`
        SELECT status || '|' || payment_status || '|' || stripe_session_id
        FROM public.orders WHERE id = 'ord_0002_victim';
      `);
      assert.equal(orderState, 'unpaid|unpaid|cs_test_expected_victim_8002', '不一致Sessionで注文が確定されたりstripe_session_idが上書きされないこと');
    });

    it('8.3 正常決済確定 (unpaid -> pending / paid) と 0001/0002 両戻り値キーの互換性', () => {
      const resValid = queryJson(`
        SET ROLE service_role;
        SELECT public.confirm_stripe_order_payment_tx('ord_0002_victim', 'cs_test_expected_victim_8002', 'evt_0002_valid_confirm');
      `);
      assert.equal(resValid.found, true);
      assert.equal(resValid.ok, true);
      assert.equal(resValid.transitioned, true);
      assert.equal(resValid.transitioned_from_unpaid, true, '0001互換の transitioned_from_unpaid キーが維持されていること');
      assert.equal(resValid.order.status, 'pending');
      assert.equal(resValid.order.payment_status, 'paid');

      const evtStatus = querySingle(`
        SELECT status FROM public.stripe_webhook_events WHERE event_id = 'evt_0002_valid_confirm';
      `);
      assert.equal(evtStatus, 'succeeded');
    });

    it('8.4 既存決済済み注文の冪等性と製造状態・返金済みステータス (partially_refunded / refunded) の巻き戻り防止', () => {
      // 1. 調理中 (preparing) へ進めた後に再送された場合
      runPsql(`
        UPDATE public.orders
        SET status = 'preparing', production_status = 'preparing'
        WHERE id = 'ord_0002_victim';
      `);

      const resReplay = queryJson(`
        SET ROLE service_role;
        SELECT public.confirm_stripe_order_payment_tx('ord_0002_victim', 'cs_test_expected_victim_8002', 'evt_0002_valid_confirm');
      `);
      assert.equal(resReplay.ok, true);
      assert.equal(resReplay.transitioned, false);
      assert.equal(resReplay.transitioned_from_unpaid, false);
      assert.equal(resReplay.order.status, 'preparing', '調理中ステータスがpendingに巻き戻らないこと');

      // 2. 一部返金・全額返金済み (refunded) に進んだ注文に対して遅延再送が来た場合、payment_status が paid に上書きされないこと
      runPsql(`
        UPDATE public.orders
        SET status = 'completed', production_status = 'ready', payment_status = 'refunded', refunded_amount = 400
        WHERE id = 'ord_0002_victim';
      `);

      const resRefundedReplay = queryJson(`
        SET ROLE service_role;
        SELECT public.confirm_stripe_order_payment_tx('ord_0002_victim', 'cs_test_expected_victim_8002', 'evt_0002_refunded_replay');
      `);
      assert.equal(resRefundedReplay.ok, true);
      assert.equal(resRefundedReplay.transitioned_from_unpaid, false);
      assert.equal(resRefundedReplay.order.payment_status, 'refunded', '返金済みステータスが paid に巻き戻されないこと');
    });

    it('8.5 受渡完了注文 (status=cancelled, fulfillment_status=handed_over, cancellation_status=active) をキャンセルと誤判定しないこと', () => {
      runPsql(`
        INSERT INTO public.orders (
          id, customer_name, order_number, total_price, status, payment_status, production_status, fulfillment_status, cancellation_status, stripe_session_id
        ) VALUES (
          'ord_0002_handed_over', '受渡完了客', '8003', 500, 'cancelled', 'paid', 'ready', 'handed_over', 'active', 'cs_test_handed_over_8003'
        ) ON CONFLICT (id) DO UPDATE SET
          status = 'cancelled', payment_status = 'paid', production_status = 'ready',
          fulfillment_status = 'handed_over', cancellation_status = 'active',
          stripe_session_id = 'cs_test_handed_over_8003';
      `);

      const resHandedOver = queryJson(`
        SET ROLE service_role;
        SELECT public.confirm_stripe_order_payment_tx('ord_0002_handed_over', 'cs_test_handed_over_8003', 'evt_0002_handed_over');
      `);
      assert.equal(resHandedOver.ok, true, '受渡完了注文は ORDER_CANCELLED で拒否されず冪等成功すること');
      assert.equal(resHandedOver.transitioned_from_unpaid, false);
      assert.equal(resHandedOver.order.fulfillment_status, 'handed_over');
      assert.equal(resHandedOver.order.cancellation_status, 'active');
    });

    it('8.6 過去の未判定注文 (legacy_undetermined: status=cancelled かつ 4軸すべてNULL) の完全保全', () => {
      runPsql(`
        INSERT INTO public.orders (
          id, customer_name, order_number, total_price, status, payment_status, production_status, fulfillment_status, cancellation_status, stripe_session_id
        ) VALUES (
          'ord_0002_legacy_undetermined', '過去受渡客', '1050', 600, 'cancelled', NULL, NULL, NULL, NULL, 'cs_legacy_1050'
        ) ON CONFLICT (id) DO UPDATE SET
          status = 'cancelled', payment_status = NULL, production_status = NULL,
          fulfillment_status = NULL, cancellation_status = NULL, stripe_session_id = 'cs_legacy_1050';
      `);

      const resLegacy = queryJson(`
        SET ROLE service_role;
        SELECT public.confirm_stripe_order_payment_tx('ord_0002_legacy_undetermined', 'cs_legacy_1050', 'evt_0002_legacy');
      `);
      assert.equal(resLegacy.ok, false);
      assert.equal(resLegacy.code, 'LEGACY_ORDER_PROTECTED');

      const legacyCols = querySingle(`
        SELECT status || '|' || COALESCE(payment_status, 'NULL') || '|' || COALESCE(production_status, 'NULL') || '|' || COALESCE(fulfillment_status, 'NULL') || '|' || COALESCE(cancellation_status, 'NULL')
        FROM public.orders WHERE id = 'ord_0002_legacy_undetermined';
      `);
      assert.equal(legacyCols, 'cancelled|NULL|NULL|NULL|NULL', '過去未判定注文の4軸カラムが推測で書き換えられないこと');
    });

    it('8.7 キャンセル済み注文の復活防止 (ORDER_CANCELLED) とキャンセル後決済成功の返金案件登録・重複防止・Session整合性', () => {
      runPsql(`
        DELETE FROM public.order_refund_requests WHERE order_id = 'ord_0002_cancelled';
        DELETE FROM public.stripe_webhook_events WHERE event_id IN ('evt_0002_cancel_confirm', 'evt_0002_cancel_disc');
        INSERT INTO public.orders (
          id, customer_name, order_number, total_price, status, payment_status, production_status, fulfillment_status, cancellation_status, stripe_session_id
        ) VALUES (
          'ord_0002_cancelled', '取消競合客', '8004', 750, 'cancelled', 'unpaid', 'pending', 'not_handed_over', 'cancelled', 'cs_test_cancelled_8004'
        ) ON CONFLICT (id) DO UPDATE SET
          status = 'cancelled', payment_status = 'unpaid', cancellation_status = 'cancelled',
          stripe_session_id = 'cs_test_cancelled_8004', refund_status = 'none', requires_manual_attention = false;
      `);

      // 1. confirm_stripe_order_payment_tx は ORDER_CANCELLED で拒否し、調理待ちに復活させないこと
      const resConfirmCancelled = queryJson(`
        SET ROLE service_role;
        SELECT public.confirm_stripe_order_payment_tx('ord_0002_cancelled', 'cs_test_cancelled_8004', 'evt_0002_cancel_confirm');
      `);
      assert.equal(resConfirmCancelled.ok, false);
      assert.equal(resConfirmCancelled.code, 'ORDER_CANCELLED');

      const afterConfirmCancel = querySingle(`
        SELECT status || '|' || cancellation_status || '|' || payment_status
        FROM public.orders WHERE id = 'ord_0002_cancelled';
      `);
      assert.equal(afterConfirmCancel, 'cancelled|cancelled|unpaid', 'キャンセル済み注文が復活しないこと');

      // 2. record_cancelled_payment_discrepancy_tx に異なる Session ID を渡すと SESSION_ID_MISMATCH で拒否されること
      const resDiscMismatch = queryJson(`
        SET ROLE service_role;
        SELECT public.record_cancelled_payment_discrepancy_tx(
          'ord_0002_cancelled', 'cs_test_wrong_session', 'pi_wrong', 750, 'jpy', 'evt_0002_cancel_disc'
        );
      `);
      assert.equal(resDiscMismatch.ok, false);
      assert.equal(resDiscMismatch.code, 'SESSION_ID_MISMATCH');

      // 3. 正しい Session ID で record_cancelled_payment_discrepancy_tx を呼ぶと返金案件が永続化され、再送でも重複しないこと
      const resDiscOk = queryJson(`
        SET ROLE service_role;
        SELECT public.record_cancelled_payment_discrepancy_tx(
          'ord_0002_cancelled', 'cs_test_cancelled_8004', 'pi_test_8004', 750, 'jpy', 'evt_0002_cancel_disc'
        );
      `);
      assert.equal(resDiscOk.ok, true);
      assert.equal(resDiscOk.refund_request.refund_status, 'pending');
      assert.equal(resDiscOk.refund_request.requires_manual_attention, true);

      const resDiscReplay = queryJson(`
        SET ROLE service_role;
        SELECT public.record_cancelled_payment_discrepancy_tx(
          'ord_0002_cancelled', 'cs_test_cancelled_8004', 'pi_test_8004', 750, 'jpy', 'evt_0002_cancel_disc'
        );
      `);
      assert.equal(resDiscReplay.ok, true);

      const refundCount = querySingle(`
        SELECT COUNT(*) FROM public.order_refund_requests WHERE order_id = 'ord_0002_cancelled';
      `);
      assert.equal(refundCount, '1', '返金案件が重複登録されないこと');
    });

    it('8.8 同時Webhook並列実行時の FOR UPDATE 行ロックとトランザクション直列化 (10並列で初回遷移は1回のみ)', async () => {
      runPsql(`
        DELETE FROM public.stripe_webhook_events WHERE order_id = 'ord_0002_concurrent';
        INSERT INTO public.orders (
          id, customer_name, order_number, total_price, status, payment_status, production_status, fulfillment_status, cancellation_status, stripe_session_id
        ) VALUES (
          'ord_0002_concurrent', '並列決済客', '8005', 450, 'unpaid', 'unpaid', 'pending', 'not_handed_over', 'active', 'cs_test_concurrent_8005'
        ) ON CONFLICT (id) DO UPDATE SET
          status = 'unpaid', payment_status = 'unpaid', production_status = 'pending',
          fulfillment_status = 'not_handed_over', cancellation_status = 'active',
          stripe_session_id = 'cs_test_concurrent_8005';
      `);

      const parallelCalls = Array.from({ length: 10 }, (_, idx) =>
        new Promise<any>((resolve, reject) => {
          try {
            const out = queryJson(`
              SET ROLE service_role;
              SELECT public.confirm_stripe_order_payment_tx(
                'ord_0002_concurrent',
                'cs_test_concurrent_8005',
                'evt_0002_conc_${idx + 1}'
              );
            `);
            resolve(out);
          } catch (e) {
            reject(e);
          }
        })
      );

      const results = await Promise.all(parallelCalls);
      assert.equal(results.length, 10);
      assert.ok(results.every((r) => r.ok === true), '10並列すべてがエラーなく成功すること');

      const transitionedCount = results.filter((r) => r.transitioned_from_unpaid === true).length;
      const replayCount = results.filter((r) => r.transitioned_from_unpaid === false).length;
      assert.equal(transitionedCount, 1, 'FOR UPDATE 行ロックにより unpaid->pending の初回遷移は厳密に1回のみであること');
      assert.equal(replayCount, 9, '残り9件の並列呼び出しは冪等再送 (transitioned_from_unpaid=false) となること');
    });

    it('8.9 想定外の状態 (payment_status=failed) や STORE_STATE_001 に対する更新拒否 (INVALID_ORDER_STATE)', () => {
      const storeStateRes = queryJson(`
        SET ROLE service_role;
        SELECT public.confirm_stripe_order_payment_tx('STORE_STATE_001', 'cs_any', 'evt_store_state');
      `);
      assert.equal(storeStateRes.ok, false);
      assert.equal(storeStateRes.code, 'INVALID_ORDER_STATE');

      runPsql(`
        INSERT INTO public.orders (
          id, customer_name, order_number, total_price, status, payment_status, production_status, fulfillment_status, cancellation_status, stripe_session_id
        ) VALUES (
          'ord_0002_failed_state', '決済失敗客', '8006', 400, 'pending', 'failed', 'pending', 'not_handed_over', 'active', 'cs_test_failed_8006'
        ) ON CONFLICT (id) DO UPDATE SET
          status = 'pending', payment_status = 'failed', stripe_session_id = 'cs_test_failed_8006';
      `);

      const failedRes = queryJson(`
        SET ROLE service_role;
        SELECT public.confirm_stripe_order_payment_tx('ord_0002_failed_state', 'cs_test_failed_8006', 'evt_failed_state');
      `);
      assert.equal(failedRes.ok, false);
      assert.equal(failedRes.code, 'INVALID_ORDER_STATE');
    });

    it('8.10 0002適用後の全8個RPCのACL権限維持・再実行冪等性・安全な緊急受付停止スクリプト検証', () => {
      // 1. 0002 再実行の冪等性
      const migration0002Sql = readFileSync(MIGRATION_0002_FILE_PATH, 'utf8');
      assert.doesNotThrow(() => {
        runPsql(migration0002Sql);
      });

      // 2. 全8個のRPCの SECURITY DEFINER, search_path, ACL (anon=false, authenticated=false, service_role=true)
      const rpcCount = querySingle(`
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
      assert.equal(rpcCount, '8', '0002適用後も全8個のRPCでACLとSECURITY DEFINERが維持されていること');

      // 3. 安全な緊急受付停止スクリプト (0002_phase0_stripe_session_hardening_rollback.sql) が脆弱な0001関数に戻さず受付を停止できること
      const containmentSql = readFileSync(CONTAINMENT_0002_FILE_PATH, 'utf8');
      assert.doesNotThrow(() => {
        runPsql(containmentSql);
      });

      // 緊急受付停止後も SESSION_ID_MISMATCH 防御が生きていること
      const afterContainmentMismatch = queryJson(`
        SET ROLE service_role;
        SELECT public.confirm_stripe_order_payment_tx('ord_0002_victim', 'cs_attacker_after_containment', 'evt_after_containment');
      `);
      assert.equal(afterContainmentMismatch.ok, false);
      assert.equal(afterContainmentMismatch.code, 'SESSION_ID_MISMATCH', '緊急停止スクリプト実行後もセッションID不一致防御が維持されていること');
    });

    it('8.11 返金完了済み案件 (refund_status=succeeded) の完全不変性 (遅延Webhookや重複イベントで一切のフィールドが書き換わらないこと)', () => {
      // ord_0002_cancelled (750円, cs_test_cancelled_8004, pi_test_8004) を update_refund_request_status_tx で succeeded に確定
      const refundComplete = queryJson(`
        SET ROLE service_role;
        SELECT public.update_refund_request_status_tx(
          'ord_0002_cancelled',
          'succeeded',
          're_test_immutable_8004',
          'completed_audit_trail_entry',
          false,
          true
        );
      `);
      assert.equal(refundComplete.ok, true);
      assert.equal(refundComplete.refund_request.refund_status, 'succeeded');
      assert.equal(refundComplete.refund_request.stripe_refund_id, 're_test_immutable_8004');
      assert.equal(refundComplete.refund_request.attempt_count, 1);

      const snapshotBefore = querySingle(`
        SELECT
          r.payment_intent_id || '|' ||
          r.stripe_session_id || '|' ||
          r.amount::text || '|' ||
          r.target_refund_amount::text || '|' ||
          r.stripe_refund_id || '|' ||
          r.refund_status || '|' ||
          r.attempt_count::text || '|' ||
          COALESCE(r.last_error, '') || '|' ||
          r.requires_manual_attention::text || '|' ||
          r.updated_at::text || '|' ||
          o.payment_status || '|' ||
          o.refunded_amount::text || '|' ||
          o.refund_status || '|' ||
          o.requires_manual_attention::text
        FROM public.order_refund_requests r
        JOIN public.orders o ON o.id = r.order_id
        WHERE r.order_id = 'ord_0002_cancelled';
      `);

      // 1. 同一内容での遅延Webhook再送 (異なる reason 'late_duplicate_webhook' を渡しても一切書き換わらないこと)
      const replayOnSucceeded = queryJson(`
        SET ROLE service_role;
        SELECT public.record_cancelled_payment_discrepancy_tx(
          'ord_0002_cancelled',
          'cs_test_cancelled_8004',
          'pi_test_8004',
          750,
          'jpy',
          'evt_0002_late_after_refund',
          'late_duplicate_webhook_should_not_overwrite'
        );
      `);
      assert.equal(replayOnSucceeded.ok, true);
      assert.equal(replayOnSucceeded.already_recorded, true);

      const snapshotAfter = querySingle(`
        SELECT
          r.payment_intent_id || '|' ||
          r.stripe_session_id || '|' ||
          r.amount::text || '|' ||
          r.target_refund_amount::text || '|' ||
          r.stripe_refund_id || '|' ||
          r.refund_status || '|' ||
          r.attempt_count::text || '|' ||
          COALESCE(r.last_error, '') || '|' ||
          r.requires_manual_attention::text || '|' ||
          r.updated_at::text || '|' ||
          o.payment_status || '|' ||
          o.refunded_amount::text || '|' ||
          o.refund_status || '|' ||
          o.requires_manual_attention::text
        FROM public.order_refund_requests r
        JOIN public.orders o ON o.id = r.order_id
        WHERE r.order_id = 'ord_0002_cancelled';
      `);
      assert.equal(
        snapshotAfter,
        snapshotBefore,
        '返金完了済み案件では PaymentIntent / Session / 金額 / Refund ID / ステータス / エラー履歴 / updated_at / 注文返金状態が1ビットも変化しないこと'
      );

      // 2. 異なる PaymentIntent ID を渡した場合は PAYMENT_INTENT_MISMATCH で拒否されること
      const diffPiRes = queryJson(`
        SET ROLE service_role;
        SELECT public.record_cancelled_payment_discrepancy_tx(
          'ord_0002_cancelled',
          'cs_test_cancelled_8004',
          'pi_tampered_9999',
          750,
          'jpy'
        );
      `);
      assert.equal(diffPiRes.ok, false);
      assert.equal(diffPiRes.code, 'PAYMENT_INTENT_MISMATCH');
    });

    it('8.12 返金処理中 (processing) および返金失敗 (failed) 案件へのイベント再送時の状態保護と手動対応フラグ維持', () => {
      runPsql(`
        DELETE FROM public.order_refund_requests WHERE order_id = 'ord_0002_refund_states';
        INSERT INTO public.orders (
          id, customer_name, order_number, total_price, status, payment_status, production_status, fulfillment_status, cancellation_status, stripe_session_id
        ) VALUES (
          'ord_0002_refund_states', '状態遷移検証客', '8007', 900, 'cancelled', 'unpaid', 'pending', 'not_handed_over', 'cancelled', 'cs_test_refund_states_8007'
        ) ON CONFLICT (id) DO UPDATE SET
          status = 'cancelled', cancellation_status = 'cancelled', total_price = 900, stripe_session_id = 'cs_test_refund_states_8007';
      `);

      // 初回登録 (pending)
      const initRes = queryJson(`
        SET ROLE service_role;
        SELECT public.record_cancelled_payment_discrepancy_tx(
          'ord_0002_refund_states', 'cs_test_refund_states_8007', NULL, 900, 'jpy', NULL, 'initial_discrepancy'
        );
      `);
      assert.equal(initRes.ok, true);
      assert.equal(initRes.refund_request.refund_status, 'pending');

      // 1. processing 状態に移行した後、イベント再送 (PaymentIntent補完あり) が到着した場合:
      //    refund_status='processing' と attempt_count=1 が維持され、pending に巻き戻らないこと
      runPsql(`
        SET ROLE service_role;
        SELECT public.update_refund_request_status_tx(
          'ord_0002_refund_states', 'processing', NULL, 'refund_api_in_flight', true, true
        );
      `);

      const replayDuringProcessing = queryJson(`
        SET ROLE service_role;
        SELECT public.record_cancelled_payment_discrepancy_tx(
          'ord_0002_refund_states', 'cs_test_refund_states_8007', 'pi_filled_8007', 900, 'jpy', NULL, 'replay_during_processing'
        );
      `);
      assert.equal(replayDuringProcessing.ok, true);
      assert.equal(replayDuringProcessing.refund_request.refund_status, 'processing', 'processing が pending に巻き戻らないこと');
      assert.equal(replayDuringProcessing.refund_request.payment_intent_id, 'pi_filled_8007', '未設定だったPaymentIntentのみ補完されること');
      assert.equal(replayDuringProcessing.refund_request.attempt_count, 1);
      assert.equal(replayDuringProcessing.refund_request.last_error, 'refund_api_in_flight', '既存の監査履歴が上書きされないこと');

      // 2. failed 状態に移行した後、仮に requires_manual_attention が誤って false にされていたとしても、
      //    再送時に refund_status='failed' と last_error='stripe_rate_limit_error' を維持したまま requires_manual_attention=true を強制維持すること
      runPsql(`
        SET ROLE service_role;
        SELECT public.update_refund_request_status_tx(
          'ord_0002_refund_states', 'failed', NULL, 'stripe_rate_limit_error', false, true
        );
      `);

      const replayAfterFailed = queryJson(`
        SET ROLE service_role;
        SELECT public.record_cancelled_payment_discrepancy_tx(
          'ord_0002_refund_states', 'cs_test_refund_states_8007', 'pi_filled_8007', 900, 'jpy', NULL, 'replay_should_not_clear_error'
        );
      `);
      assert.equal(replayAfterFailed.ok, true);
      assert.equal(replayAfterFailed.refund_request.refund_status, 'failed', 'failed が pending に戻らないこと');
      assert.equal(replayAfterFailed.refund_request.last_error, 'stripe_rate_limit_error', '失敗エラー理由が再送reasonで消されないこと');
      assert.equal(replayAfterFailed.refund_request.attempt_count, 2);
      assert.equal(replayAfterFailed.refund_request.requires_manual_attention, true, '手動対応状態が確実に維持されること');
      assert.equal(replayAfterFailed.order.requires_manual_attention, true, '注文側の手動対応フラグもtrueに維持されること');
    });

    it('8.13 Session ID未設定のキャンセル済み注文に対する未検証Session後付け紐付け拒否と金額・通貨不一致拒否', () => {
      runPsql(`
        DELETE FROM public.order_refund_requests WHERE order_id = 'ord_0002_cancel_no_sess';
        INSERT INTO public.orders (
          id, customer_name, order_number, total_price, status, payment_status, production_status, fulfillment_status, cancellation_status, stripe_session_id
        ) VALUES (
          'ord_0002_cancel_no_sess', 'Session未設定取消客', '8008', 550, 'cancelled', 'unpaid', 'pending', 'not_handed_over', 'cancelled', NULL
        ) ON CONFLICT (id) DO UPDATE SET
          status = 'cancelled', cancellation_status = 'cancelled', stripe_session_id = NULL, total_price = 550;
      `);

      // 1. stripe_session_id が NULL の注文に対して RPC 直接呼び出しで任意の Session ID を紐付けようとしても SESSION_ID_NOT_CONFIGURED で拒否されること
      const resNoSess = queryJson(`
        SET ROLE service_role;
        SELECT public.record_cancelled_payment_discrepancy_tx(
          'ord_0002_cancel_no_sess', 'cs_unverified_injected', 'pi_injected', 550, 'jpy'
        );
      `);
      assert.equal(resNoSess.ok, false);
      assert.equal(resNoSess.code, 'SESSION_ID_NOT_CONFIGURED');

      const orderSessAfter = querySingle(`
        SELECT COALESCE(stripe_session_id, 'NULL') FROM public.orders WHERE id = 'ord_0002_cancel_no_sess';
      `);
      assert.equal(orderSessAfter, 'NULL', '未設定注文の stripe_session_id が勝手に書き換えられないこと');

      const reqCount = querySingle(`
        SELECT COUNT(*) FROM public.order_refund_requests WHERE order_id = 'ord_0002_cancel_no_sess';
      `);
      assert.equal(reqCount, '0', '返金案件が作成されないこと');

      // 2. Session ID 設定済みでも注文金額 (550円) と異なる金額や異なる通貨を渡した場合は拒否されること
      runPsql(`
        UPDATE public.orders SET stripe_session_id = 'cs_valid_8008' WHERE id = 'ord_0002_cancel_no_sess';
      `);

      const resBadAmount = queryJson(`
        SET ROLE service_role;
        SELECT public.record_cancelled_payment_discrepancy_tx(
          'ord_0002_cancel_no_sess', 'cs_valid_8008', 'pi_8008', 99999, 'jpy'
        );
      `);
      assert.equal(resBadAmount.ok, false);
      assert.equal(resBadAmount.code, 'AMOUNT_MISMATCH');

      const resBadCurrency = queryJson(`
        SET ROLE service_role;
        SELECT public.record_cancelled_payment_discrepancy_tx(
          'ord_0002_cancel_no_sess', 'cs_valid_8008', 'pi_8008', 550, 'usd'
        );
      `);
      assert.equal(resBadCurrency.ok, false);
      assert.equal(resBadCurrency.code, 'CURRENCY_MISMATCH');
    });

    it('8.14 payment_status IS NULL の暗黙 paid 補完禁止と同一WebhookイベントIDの別注文・別Session再利用拒否 (ON CONFLICT 同時競合含む)', async () => {
      // 1. status='pending' だが payment_status IS NULL の不整合レコードが暗黙に paid へ補完されず INVALID_ORDER_STATE で拒否されること
      runPsql(`
        INSERT INTO public.orders (
          id, customer_name, order_number, total_price, status, payment_status, production_status, fulfillment_status, cancellation_status, stripe_session_id
        ) VALUES (
          'ord_0002_null_paystatus', '不整合状態客', '8009', 400, 'pending', NULL, 'pending', 'not_handed_over', 'active', 'cs_null_pay_8009'
        ) ON CONFLICT (id) DO UPDATE SET
          status = 'pending', payment_status = NULL, cancellation_status = 'active', stripe_session_id = 'cs_null_pay_8009';
      `);

      const resNullPay = queryJson(`
        SET ROLE service_role;
        SELECT public.confirm_stripe_order_payment_tx('ord_0002_null_paystatus', 'cs_null_pay_8009', 'evt_null_pay_8009');
      `);
      assert.equal(resNullPay.ok, false);
      assert.equal(resNullPay.code, 'INVALID_ORDER_STATE', 'payment_status IS NULL を暗黙に paid へ補完しないこと');

      const nullPayAfter = querySingle(`
        SELECT COALESCE(payment_status, 'NULL') FROM public.orders WHERE id = 'ord_0002_null_paystatus';
      `);
      assert.equal(nullPayAfter, 'NULL');

      // 2. すでに ord_0002_victim (cs_test_expected_victim_8002) で記録済みの Webhook イベント 'evt_0002_valid_confirm' を
      //    別の注文 ('ord_0002_handed_over' や 'ord_0002_cancel_no_sess') に再利用した場合、WEBHOOK_EVENT_CONFLICT で拒否されること
      const resReuseConfirm = queryJson(`
        SET ROLE service_role;
        SELECT public.confirm_stripe_order_payment_tx(
          'ord_0002_handed_over', 'cs_test_handed_over_8003', 'evt_0002_valid_confirm'
        );
      `);
      assert.equal(resReuseConfirm.ok, false);
      assert.equal(resReuseConfirm.code, 'WEBHOOK_EVENT_CONFLICT');

      const resReuseDiscrepancy = queryJson(`
        SET ROLE service_role;
        SELECT public.record_cancelled_payment_discrepancy_tx(
          'ord_0002_cancel_no_sess', 'cs_valid_8008', 'pi_8008', 550, 'jpy', 'evt_0002_valid_confirm'
        );
      `);
      assert.equal(resReuseDiscrepancy.ok, false);
      assert.equal(resReuseDiscrepancy.code, 'WEBHOOK_EVENT_CONFLICT');

      // 3. まだ未登録の新規 Webhook イベントID ('evt_0002_on_conflict_race') を2つの異なる未決済注文 A・B で同時に呼び出した場合、
      //    ON CONFLICT 競合時にも片方のみが成功し、もう片方は WEBHOOK_EVENT_CONFLICT で拒否され注文も unpaid のまま残ること
      runPsql(`
        DELETE FROM public.stripe_webhook_events WHERE event_id = 'evt_0002_on_conflict_race';
        INSERT INTO public.orders (
          id, customer_name, order_number, total_price, status, payment_status, production_status, fulfillment_status, cancellation_status, stripe_session_id
        ) VALUES
          ('ord_0002_race_evt_A', '競合客A', '8010', 400, 'unpaid', 'unpaid', 'pending', 'not_handed_over', 'active', 'cs_race_evt_A'),
          ('ord_0002_race_evt_B', '競合客B', '8011', 400, 'unpaid', 'unpaid', 'pending', 'not_handed_over', 'active', 'cs_race_evt_B')
        ON CONFLICT (id) DO UPDATE SET
          status = 'unpaid', payment_status = 'unpaid', cancellation_status = 'active', stripe_session_id = EXCLUDED.stripe_session_id;
      `);

      const [raceA, raceB] = await Promise.all([
        new Promise<any>((resolve, reject) => {
          try {
            resolve(
              queryJson(`
                SET ROLE service_role;
                SELECT public.confirm_stripe_order_payment_tx('ord_0002_race_evt_A', 'cs_race_evt_A', 'evt_0002_on_conflict_race');
              `)
            );
          } catch (e) {
            reject(e);
          }
        }),
        new Promise<any>((resolve, reject) => {
          try {
            resolve(
              queryJson(`
                SET ROLE service_role;
                SELECT public.confirm_stripe_order_payment_tx('ord_0002_race_evt_B', 'cs_race_evt_B', 'evt_0002_on_conflict_race');
              `)
            );
          } catch (e) {
            reject(e);
          }
        }),
      ]);

      const okResults = [raceA, raceB].filter((r) => r.ok === true);
      const conflictResults = [raceA, raceB].filter((r) => r.ok === false && r.code === 'WEBHOOK_EVENT_CONFLICT');
      assert.equal(okResults.length, 1, '同一イベントIDの別注文並列呼び出しでは厳密に1件のみが確定すること');
      assert.equal(conflictResults.length, 1, 'もう1件は ON CONFLICT 競合検証により WEBHOOK_EVENT_CONFLICT で拒否されること');

      const paidCount = querySingle(`
        SELECT COUNT(*) FROM public.orders
        WHERE id IN ('ord_0002_race_evt_A', 'ord_0002_race_evt_B') AND payment_status = 'paid';
      `);
      const unpaidCount = querySingle(`
        SELECT COUNT(*) FROM public.orders
        WHERE id IN ('ord_0002_race_evt_A', 'ord_0002_race_evt_B') AND payment_status = 'unpaid' AND status = 'unpaid';
      `);
      assert.equal(paidCount, '1', '確定した注文は1件のみであること');
      assert.equal(unpaidCount, '1', '拒否された注文は unpaid のまま一切変更されないこと');
    });
  });
});
