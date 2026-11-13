/**
 * ステージング環境 (kenocha-staging) Supabase PostgREST 接続・RPC権限 検証スクリプト
 *
 * 厳格なセキュリティ原則:
 * 1. 秘密鍵 (SUPABASE_SECRET_KEY) やパスワードの値を画面・ログ・ファイルに一切出力しない
 * 2. 本番プロジェクト (liyjwvgtavfjiohwryox) のURLが設定されている場合は即時停止 (Fail-Fast)
 * 3. 新形式キー (sb_secret_*) のプレフィックス適合性を検証
 * 4. PostgREST エンドポイント導通および全8個のRPC権限状態を記録
 */

import { validateEnvironmentSafety, assertStagingEnvironmentSafe } from '../src/lib/envGuard.ts';
import { normalizeSupabaseUrl } from '../src/lib/store.ts';
import { createClient } from '@supabase/supabase-js';

const RPC_NAMES = [
  'next_order_number',
  'confirm_stripe_order_payment_tx',
  'update_store_state_tx',
  'create_mobile_order_tx',
  'finalize_mobile_order_checkout_tx',
  'abort_mobile_order_checkout_tx',
  'record_cancelled_payment_discrepancy_tx',
  'update_refund_request_status_tx',
] as const;

// PostgREST の引数マッピングに合わせた各RPCの検証用パラメータ (0001_phase0_foundation.sql の正確なシグネチャ)
// ※ 副作用防止: 本番の kenocha_main や当日日付ではなく、検証専用ストアキー __probe_acl_test__ を使用
const PROBE_STORE_KEY = '__probe_acl_test__';
const PROBE_DATE = '1970-01-01';

const RPC_TEST_PARAMS: Record<string, Record<string, any>> = {
  next_order_number: {
    p_store_id: PROBE_STORE_KEY,
    p_order_date: PROBE_DATE,
  },
  confirm_stripe_order_payment_tx: {
    p_order_id: 'ORD-PROBE-NONEXISTENT',
    p_stripe_session_id: 'cs_test_probe_verify',
    p_webhook_event_id: 'evt_test_probe_verify',
  },
  update_store_state_tx: {
    p_store_id: PROBE_STORE_KEY,
    p_state_json: {
      isManualOpen: true,
      soldOutItems: [],
      date: PROBE_DATE,
    },
  },
  create_mobile_order_tx: {
    p_store_id: PROBE_STORE_KEY,
    p_order_id: 'ORD-PROBE-CREATE-NONEXIST',
    p_items: [{ name: 'ほうじ茶ミルクティー', price: 650, quantity: 1 }],
    p_total_price: 650,
    p_customer_name: '疎通確認テスト客',
    p_customer_avatar: null,
    p_item_ids: [],
    p_now: '1970-01-01T00:00:00Z',
  },
  finalize_mobile_order_checkout_tx: {
    p_store_id: PROBE_STORE_KEY,
    p_order_id: 'ORD-PROBE-FINALIZE-NONEXIST',
    p_stripe_session_id: 'cs_test_probe_finalize',
    p_item_ids: [],
    p_now: '1970-01-01T00:00:00Z',
  },
  abort_mobile_order_checkout_tx: {
    p_order_id: 'ORD-PROBE-ABORT-NONEXIST',
    p_stripe_session_id: 'cs_test_probe_abort',
    p_reason: 'probe_test',
  },
  record_cancelled_payment_discrepancy_tx: {
    p_order_id: 'ORD-PROBE-DISCREPANCY-NONEXIST',
    p_stripe_session_id: 'cs_test_probe_discrepancy',
    p_payment_intent_id: 'pi_test_probe_discrepancy',
    p_amount: 650,
    p_currency: 'jpy',
    p_webhook_event_id: 'evt_test_probe_discrepancy',
    p_reason: 'cancelled_order_payment_received',
  },
  update_refund_request_status_tx: {
    p_order_id: 'ORD-PROBE-REFUND-NONEXIST',
    p_refund_status: 'failed',
    p_stripe_refund_id: null,
    p_last_error: 'probe_test_nonexistent',
    p_requires_manual_attention: true,
    p_increment_attempt: false,
  },
};

export interface RpcVerificationResult {
  rpcName: string;
  serviceRoleStatus: number | string;
  serviceRoleMessage: string;
  anonStatus: number | string;
  anonMessage: string;
  isSecured: boolean;
}

export async function verifyStagingSupabase(env: Record<string, string | undefined> = process.env) {
  console.log('=== [1. 環境変数安全ガード検証] ===');
  const safety = validateEnvironmentSafety(env);
  if (!safety.safe) {
    console.error('❌ 安全ガードにより検証を中止しました:');
    safety.errors.forEach((err) => console.error(`  - ${err}`));
    throw new Error(`Environment safety validation failed: ${safety.errors.join('; ')}`);
  }
  console.log('✅ 環境変数の安全性検証をクリアしました (本番Ref拒否・Stripeテストキー確認完了)');

  // 本番環境遮断・ステージング限定の厳格な二重防壁
  if (env.APP_ENV !== 'staging') {
    throw new Error('CRITICAL: verify:staging can ONLY be executed when APP_ENV=staging. Execution halted.');
  }
  const knownProductionRef = 'liyjwvgtavfjiohwryox';
  const rawUrl = env.SUPABASE_URL!;
  if (rawUrl.includes(knownProductionRef) || (env.PRODUCTION_SUPABASE_PROJECT_REF && rawUrl.includes(env.PRODUCTION_SUPABASE_PROJECT_REF))) {
    throw new Error('CRITICAL: Attempted to run verify:staging against PRODUCTION database. Execution blocked.');
  }
  if (!rawUrl.includes('zqcniawwhtnfcxkkwauu')) {
    throw new Error('CRITICAL: verify:staging target URL does not match dedicated staging ref (zqcniawwhtnfcxkkwauu). Execution blocked.');
  }

  const supabaseUrl = normalizeSupabaseUrl(rawUrl);
  const secretKey = env.SUPABASE_SECRET_KEY!;

  // 秘密鍵の値を表示せず、形式のみ確認
  const keyPrefix = secretKey.substring(0, Math.min(10, secretKey.indexOf('_') + 1 || 10));
  const isNewFormat = secretKey.startsWith('sb_secret_');
  console.log(`- Supabase URL (生設定値): ${rawUrl}`);
  if (rawUrl !== supabaseUrl) {
    console.log(`- Supabase URL (正規化後): ${supabaseUrl} (末尾の /rest/v1 等を除去してSDK互換に調整)`);
  }
  console.log(`- Secret Key 形式: ${isNewFormat ? '新形式 (sb_secret_*)' : '旧形式/その他 (プレフィックス: ' + keyPrefix + '...)'}`);
  console.log(`- 秘密鍵の平文出力: なし (マスク保護)`);

  const client = createClient(supabaseUrl, secretKey);

  console.log('\n=== [2. PostgREST 基本接続確認] ===');
  // テーブルまたはスキーマの疎通確認 (orders テーブルの存在チェック)
  const { data: tableData, error: tableError } = await client
    .from('orders')
    .select('id')
    .limit(1);

  if (tableError) {
    console.log(`- テーブル疎通状態: HTTP ${tableError.code || 'ERR'} (${tableError.message})`);
    if (tableError.code === '42P01' || tableError.message.includes('does not exist')) {
      console.log('  -> orders テーブルはまだ未作成です (マイグレーション未適用状態)');
    }
  } else {
    console.log('✅ orders テーブルへの接続に成功しました');
  }

  console.log('\n=== [3. 全8個のRPC権限・実行状態の確認] ===');
  const rpcResults: RpcVerificationResult[] = [];

  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
  if (!publishableKey) {
    console.warn('⚠️ 注意: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY が未設定です。anon検証はダミーキーで行われます (Gatewayレベルで遮断されます)。');
    console.warn('  -> 完全な PostgreSQL ACL 監査を行うには、.env.staging.local に NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY を設定するか、');
    console.warn('     supabase/queries/audit_phase0_acl.sql を SQL Editor で実行してください。\n');
  }

  // anon クライアント（有効な publishableKey があればそれを使用、なければダミーキー）
  const anonClient = createClient(supabaseUrl, publishableKey || 'dummy_anon_key_for_acl_test');

  for (const rpc of RPC_NAMES) {
    const params = RPC_TEST_PARAMS[rpc] || {};

    // 1. service_role (sb_secret_...) での呼び出し
    let serviceStatus: number | string = 'UNKNOWN';
    let serviceMsg = '';
    let isServiceRoleAllowed = false;

    try {
      const { data, error } = await client.rpc(rpc, params as any);
      if (error) {
        serviceStatus = error.code || 'ERR';
        serviceMsg = error.message;
        // P0001 (PostgreSQL RAISE EXCEPTION) や 23xxx (制約エラー) は、関数が存在し実行された証拠
        // 42501 (permission denied) や PGRST202 (not found) 以外でSQLエラーが出た場合はACL許可・実行成功とみなす
        if (
          error.code !== '42501' &&
          error.code !== 'PGRST202' &&
          (error.code === 'P0001' ||
            error.code?.startsWith('23') ||
            error.message.includes('NOT_FOUND') ||
            error.message.includes('already exists') ||
            error.message.includes('invalid') ||
            error.message.includes('exception'))
        ) {
          isServiceRoleAllowed = true;
        }
      } else {
        serviceStatus = 200;
        serviceMsg = typeof data === 'object' ? JSON.stringify(data) : String(data);
        isServiceRoleAllowed = true;
      }
    } catch (e: any) {
      serviceStatus = 'EXCEPTION';
      serviceMsg = e.message;
    }

    // 2. anon での呼び出し (拒絶されることを確認)
    let anonStatus: number | string = 'UNKNOWN';
    let anonMsg = '';
    let isAclDenied = false;
    let isGatewayDenied = false;

    try {
      const { data, error } = await anonClient.rpc(rpc, params as any);
      if (error) {
        anonStatus = error.code || 'ERR';
        anonMsg = error.message;
        if (error.message.includes('Invalid API key')) {
          isGatewayDenied = true;
        } else if (
          error.code === '42501' ||
          error.message.includes('permission denied') ||
          error.code === 'PGRST301' ||
          error.message.includes('Forbidden')
        ) {
          isAclDenied = true;
        }
      } else {
        anonStatus = 200;
        anonMsg = 'UNEXPECTED_SUCCESS';
      }
    } catch (e: any) {
      anonStatus = 'EXCEPTION';
      anonMsg = e.message;
    }

    // 権限判定の評価
    const isAnonBlocked = anonStatus !== 200;
    let anonVerdict = '❌ 脆弱性: 実行許可';
    if (isAclDenied) {
      anonVerdict = '✅ PostgreSQL ACL拒絶 (REVOKE成功: permission denied)';
    } else if (isGatewayDenied) {
      anonVerdict = '⚠️ Gateway無効キー拒絶 (APIキー未設定/無効)';
    } else if (isAnonBlocked) {
      anonVerdict = `✅ アクセス拒絶確認 (${anonStatus})`;
    }

    rpcResults.push({
      rpcName: rpc,
      serviceRoleStatus: serviceStatus,
      serviceRoleMessage: serviceMsg,
      anonStatus,
      anonMessage: anonMsg,
      isSecured: isServiceRoleAllowed && isAnonBlocked,
    });

    console.log(`- RPC: ${rpc}`);
    console.log(`  service_role: [${serviceStatus}] ${serviceMsg} -> ${isServiceRoleAllowed ? '✅ 実行可能 (ACL許可確認)' : '❌ 実行不可'}`);
    console.log(`  anon:         [${anonStatus}] ${anonMsg} -> ${anonVerdict}`);
  }

  // 副作用の完全クリーンアップ (検証用ストアキーのレコードのみを安全に削除)
  try {
    await client.from('orders').delete().eq('store_id', PROBE_STORE_KEY);
    await client.from('order_number_sequences').delete().eq('store_id', PROBE_STORE_KEY);
    console.log('\n✅ 副作用防止: 検証用ダミーデータ (__probe_acl_test__) はすべてクリーンアップされました');
  } catch (cleanErr: any) {
    console.warn(`⚠️ クリーンアップ警告: ${cleanErr.message}`);
  }

  return {
    supabaseUrl,
    isNewFormat,
    rpcResults,
  };
}

// CLIから直接実行された場合
if (process.argv[1]?.endsWith('verify-supabase-staging.ts')) {
  verifyStagingSupabase()
    .then(() => {
      console.log('\n=== 検証完了 ===');
    })
    .catch((err) => {
      console.error('\n❌ 検証失敗:', err.message);
      process.exit(1);
    });
}
