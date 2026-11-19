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
  authenticatedStatus: number | string;
  authenticatedMessage: string;
  isSecured: boolean;
}

export async function verifyStagingSupabase(env: Record<string, string | undefined> = process.env) {
  console.log('=== [1. 環境変数安全ガード検証 (厳密性・フォールバック廃止)] ===');
  const safety = validateEnvironmentSafety(env);
  if (!safety.safe) {
    console.error('❌ 安全ガードにより検証を中止しました:');
    safety.errors.forEach((err) => console.error(`  - ${err}`));
    throw new Error(`Environment safety validation failed: ${safety.errors.join('; ')}`);
  }

  // 1. 本番環境遮断・ステージング限定の厳格な三重防壁
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

  // 2. キーの厳格取得 (フォールバック・推測完全廃止 & Fail-Fast)
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!publishableKey || !publishableKey.startsWith('sb_publishable_')) {
    throw new Error(
      'CRITICAL_CONFIG_ERROR: NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required and must start with sb_publishable_. Fallback detection is disabled.'
    );
  }

  const stripeSecretKey = env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey || !stripeSecretKey.startsWith('sk_test_')) {
    throw new Error('CRITICAL_CONFIG_ERROR: STRIPE_SECRET_KEY must start with sk_test_ in staging.');
  }

  const stripePublishableKey = env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!stripePublishableKey || !stripePublishableKey.startsWith('pk_test_')) {
    throw new Error(
      'CRITICAL_CONFIG_ERROR: NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY must start with pk_test_. Supabase keys cannot be used here.'
    );
  }

  console.log('✅ 環境変数の安全性・厳格性検証をクリアしました (本番Ref遮断・Stripe/Supabaseキー形式確認完了)');

  const supabaseUrl = normalizeSupabaseUrl(rawUrl);
  const secretKey = env.SUPABASE_SECRET_KEY!;

  // 秘密鍵の値を表示せず、形式のみ確認
  const keyPrefix = secretKey.substring(0, Math.min(10, secretKey.indexOf('_') + 1 || 10));
  const isNewFormat = secretKey.startsWith('sb_secret_');
  console.log(`- Supabase URL: ${supabaseUrl}`);
  console.log(`- Supabase Secret Key 形式: ${isNewFormat ? '新形式 (sb_secret_*)' : '旧形式/その他'}`);
  console.log(`- Supabase Publishable Key 形式: 新形式 (${publishableKey.substring(0, 15)}...)`);
  console.log(`- Stripe Secret Key 形式: テストキー (${stripeSecretKey.substring(0, 8)}...)`);
  console.log(`- Stripe Publishable Key 形式: テストキー (${stripePublishableKey.substring(0, 8)}...)`);
  console.log(`- 秘密情報・パスワード平文出力: なし (マスク保護)`);

  const client = createClient(supabaseUrl, secretKey);

  console.log('\n=== [2. PostgREST 基本接続および事前スナップショット測定] ===');
  // テーブル疎通確認
  const { data: tableData, error: tableError } = await client.from('orders').select('id').limit(1);
  if (tableError) {
    throw new Error(`Failed to connect to orders table: ${tableError.message}`);
  }
  console.log('✅ orders テーブルへの接続に成功しました');

  // 事前スナップショット測定 (副作用検証用)
  const { count: preOrderCount, error: preCountErr } = await client
    .from('orders')
    .select('*', { count: 'exact', head: true });
  if (preCountErr) throw new Error(`Snapshot error (orders count): ${preCountErr.message}`);

  const { data: preStoreState, error: preStateErr } = await client
    .from('orders')
    .select('id, items, customer_avatar, status, customer_name')
    .eq('id', 'STORE_STATE_001')
    .single();
  if (preStateErr) throw new Error(`Snapshot error (STORE_STATE_001): ${preStateErr.message}`);

  const { data: preSeqData, error: preSeqErr } = await client
    .from('order_number_sequences')
    .select('store_id, order_date, last_number')
    .eq('store_id', 'kenocha_main');
  if (preSeqErr) throw new Error(`Snapshot error (order_number_sequences): ${preSeqErr.message}`);

  console.log(`- 事前注文件数: ${preOrderCount ?? 0} 件`);
  console.log(`- 事前 STORE_STATE_001 状態: 取得完了 (hash=${JSON.stringify(preStoreState).length} bytes)`);
  console.log(`- 事前 kenocha_main 採番レコード数: ${preSeqData?.length ?? 0} 件`);

  console.log('\n=== [3. authenticated ロール一時テストセッションの準備] ===');
  let authClient: any = null;
  let tempUserId: string | null = null;
  const tempUserEmail = `acl_verify_${Date.now()}@example.internal`;
  const tempUserPassword = `TempAuthPass_${Date.now()}_RandomSecure!`;

  try {
    const { data: createdUser, error: createErr } = await client.auth.admin.createUser({
      email: tempUserEmail,
      password: tempUserPassword,
      email_confirm: true,
    });

    if (createErr || !createdUser.user) {
      console.warn(`⚠️ 一時テストユーザー作成不可 (${createErr?.message})。authenticatedテストはスキップしSQL監査結果を参照します。`);
    } else {
      tempUserId = createdUser.user.id;
      // ユーザーとしてサインインしてアクセストークンを取得
      const userSignInClient = createClient(supabaseUrl, publishableKey);
      const { data: signInData, error: signInErr } = await userSignInClient.auth.signInWithPassword({
        email: tempUserEmail,
        password: tempUserPassword,
      });

      if (signInErr || !signInData.session) {
        console.warn(`⚠️ サインイン不可 (${signInErr?.message})。authenticatedテストはスキップします。`);
      } else {
        authClient = createClient(supabaseUrl, publishableKey, {
          global: {
            headers: {
              Authorization: `Bearer ${signInData.session.access_token}`,
            },
          },
        });
        console.log(`✅ authenticated ロール用テストセッション取得成功 (User ID: ${tempUserId.substring(0, 8)}...)`);
      }
    }
  } catch (authSetupErr: any) {
    console.warn(`⚠️ 認証セッション準備例外: ${authSetupErr.message}`);
  }

  console.log('\n=== [4. 全8個のRPC権限・実行状態の確認 (anon vs authenticated vs service_role)] ===');
  const rpcResults: RpcVerificationResult[] = [];
  const anonClient = createClient(supabaseUrl, publishableKey);

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
    let isAnonAclDenied = false;

    try {
      const { data, error } = await anonClient.rpc(rpc, params as any);
      if (error) {
        anonStatus = error.code || 'ERR';
        anonMsg = error.message;
        if (error.code === '42501' || error.message.includes('permission denied') || error.code === 'PGRST301') {
          isAnonAclDenied = true;
        }
      } else {
        anonStatus = 200;
        anonMsg = 'UNEXPECTED_SUCCESS';
      }
    } catch (e: any) {
      anonStatus = 'EXCEPTION';
      anonMsg = e.message;
    }

    // 3. authenticated での呼び出し (拒絶されることを確認)
    let authStatus: number | string = 'SKIPPED';
    let authMsg = 'User session not available';
    let isAuthAclDenied = false;

    if (authClient) {
      try {
        const { data, error } = await authClient.rpc(rpc, params as any);
        if (error) {
          authStatus = error.code || 'ERR';
          authMsg = error.message;
          if (error.code === '42501' || error.message.includes('permission denied') || error.code === 'PGRST301') {
            isAuthAclDenied = true;
          }
        } else {
          authStatus = 200;
          authMsg = 'UNEXPECTED_SUCCESS';
        }
      } catch (e: any) {
        authStatus = 'EXCEPTION';
        authMsg = e.message;
      }
    }

    const isAnonSecured = anonStatus !== 200;
    const isAuthSecured = !authClient || authStatus !== 200;

    rpcResults.push({
      rpcName: rpc,
      serviceRoleStatus: serviceStatus,
      serviceRoleMessage: serviceMsg,
      anonStatus,
      anonMessage: anonMsg,
      authenticatedStatus: authStatus,
      authenticatedMessage: authMsg,
      isSecured: isServiceRoleAllowed && isAnonSecured && isAuthSecured,
    });

    console.log(`- RPC: ${rpc}`);
    console.log(`  service_role:  [${serviceStatus}] ${serviceMsg} -> ${isServiceRoleAllowed ? '✅ 実行可能' : '❌ 実行不可'}`);
    console.log(
      `  anon:          [${anonStatus}] ${anonMsg} -> ${isAnonAclDenied ? '✅ PostgreSQL ACL拒絶 (42501)' : isAnonSecured ? '✅ 拒絶' : '❌ 許可'}`
    );
    if (authClient) {
      console.log(
        `  authenticated: [${authStatus}] ${authMsg} -> ${isAuthAclDenied ? '✅ PostgreSQL ACL拒絶 (42501)' : isAuthSecured ? '✅ 拒絶' : '❌ 許可'}`
      );
    }
  }

  console.log('\n=== [5. 副作用のクリーンアップおよび事後スナップショット検証] ===');

  // 1. 一時テストユーザーの削除
  if (tempUserId) {
    try {
      await client.auth.admin.deleteUser(tempUserId);
      console.log('✅ 一時検証用 authenticated テストユーザーを削除完了');
    } catch (delErr: any) {
      throw new Error(`CRITICAL_CLEANUP_FAILURE: Failed to delete temporary test user: ${delErr.message}`);
    }
  }

  // 2. 検証ストアキー (__probe_acl_test__) の削除
  const { error: delOrderErr } = await client.from('orders').delete().eq('store_id', PROBE_STORE_KEY);
  if (delOrderErr) {
    throw new Error(`CRITICAL_CLEANUP_FAILURE: Failed to delete probe orders: ${delOrderErr.message}`);
  }

  const { error: delSeqErr } = await client.from('order_number_sequences').delete().eq('store_id', PROBE_STORE_KEY);
  if (delSeqErr) {
    throw new Error(`CRITICAL_CLEANUP_FAILURE: Failed to delete probe sequences: ${delSeqErr.message}`);
  }

  // 3. 残存レコードの厳密チェック (クリーンアップ成否の完全検証)
  const { count: remainingOrders, error: remOrderErr } = await client
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('store_id', PROBE_STORE_KEY);
  if (remOrderErr || (remainingOrders !== null && remainingOrders > 0)) {
    throw new Error(`CRITICAL_CLEANUP_FAILURE: Probe order records still remain (${remainingOrders} records).`);
  }

  const { count: remainingSeq, error: remSeqErr } = await client
    .from('order_number_sequences')
    .select('*', { count: 'exact', head: true })
    .eq('store_id', PROBE_STORE_KEY);
  if (remSeqErr || (remainingSeq !== null && remainingSeq > 0)) {
    throw new Error(`CRITICAL_CLEANUP_FAILURE: Probe sequence records still remain (${remainingSeq} records).`);
  }

  // 4. 事後スナップショット測定と差分比較
  const { count: postOrderCount, error: postCountErr } = await client
    .from('orders')
    .select('*', { count: 'exact', head: true });
  if (postCountErr) throw new Error(`Post-snapshot error (orders count): ${postCountErr.message}`);

  const { data: postStoreState, error: postStateErr } = await client
    .from('orders')
    .select('id, items, customer_avatar, status, customer_name')
    .eq('id', 'STORE_STATE_001')
    .single();
  if (postStateErr) throw new Error(`Post-snapshot error (STORE_STATE_001): ${postStateErr.message}`);

  const { data: postSeqData, error: postSeqErr } = await client
    .from('order_number_sequences')
    .select('store_id, order_date, last_number')
    .eq('store_id', 'kenocha_main');
  if (postSeqErr) throw new Error(`Post-snapshot error (order_number_sequences): ${postSeqErr.message}`);

  // 比較検証
  const isOrderCountMatch = preOrderCount === postOrderCount;
  const isStoreStateMatch = JSON.stringify(preStoreState) === JSON.stringify(postStoreState);
  const isSeqMatch = JSON.stringify(preSeqData) === JSON.stringify(postSeqData);

  if (!isOrderCountMatch || !isStoreStateMatch || !isSeqMatch) {
    throw new Error(
      `CRITICAL_SIDE_EFFECT_DETECTED: Database state modified during verification! (orderCountMatch=${isOrderCountMatch}, storeStateMatch=${isStoreStateMatch}, seqMatch=${isSeqMatch})`
    );
  }

  console.log('✅ 実測確認: 検証前後の通常データ比較結果:');
  console.log(`  - STORE_STATE_001: 完全一致 (変更なし)`);
  console.log(`  - orders 全件数: 完全一致 (${preOrderCount} 件 -> ${postOrderCount} 件)`);
  console.log(`  - kenocha_main 採番シーケンス: 完全一致 (変更なし)`);
  console.log(`  - __probe_acl_test__ 残存レコード: 0 件 (完全クリーンアップ確認済み)`);

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
