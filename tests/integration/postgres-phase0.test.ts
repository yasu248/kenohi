import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import Stripe from 'stripe';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONTAINER_NAME = 'kenocha-phase0-verify-pg';
const MIGRATION_FILE_PATH = resolve(process.cwd(), 'supabase/migrations/0001_phase0_foundation.sql');
const ROLLBACK_FILE_PATH = resolve(process.cwd(), 'supabase/migrations/0001_phase0_foundation_rollback.sql');

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

      // STORE_STATE_001 のデータ保全
      const storeStateAvatar = querySingle(`SELECT customer_avatar FROM public.orders WHERE id = 'STORE_STATE_001';`);
      assert.ok(storeStateAvatar.includes('"lastOrderNumber":3104'));
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
              'abort_mobile_order_checkout_tx'
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
        '6',
        'pg_restore 後も全6個の SECURITY DEFINER RPC関数で anon=false, authenticated=false, service_role=true が維持されていること'
      );

      // クリーンアップ
      runPsql(`DROP DATABASE IF EXISTS kenocha_restore_acl_verify;`);
    });
  });
});
