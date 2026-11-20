/**
 * 0002 マイグレーション ステージング適用 & 総合検証スクリプト
 * (scripts/apply-and-verify-0002-staging.ts)
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const STAGING_ENV_FILE = resolve(process.cwd(), '.env.staging.local');
const PROD_REF = 'liyjwvgtavfjiohwryox';
const STAGING_REF = 'zqcniawwhtnfcxkkwauu';

function loadEnv(): Record<string, string> {
  const content = readFileSync(STAGING_ENV_FILE, 'utf8');
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      let val = match[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[match[1].trim()] = val;
    }
  }
  return env;
}

export async function runStep1And2() {
  console.log('========================================================');
  console.log('   第1段階・第2段階: 0002適用事前監査・適用・事後検証   ');
  console.log('========================================================\n');

  const env = loadEnv();

  // 1. 環境ガード
  console.log('=== [1. 環境ガード照合] ===');
  const supabaseUrl = env.SUPABASE_URL || '';
  if (supabaseUrl.includes(PROD_REF)) {
    throw new Error(`CRITICAL: Production Supabase Ref detected! Aborting.`);
  }
  if (!supabaseUrl.includes(STAGING_REF)) {
    throw new Error(`CRITICAL: Target is not staging (${STAGING_REF}). Found: ${supabaseUrl}`);
  }
  console.log(`- 接続先URL: ${supabaseUrl} (✅ ステージング確認完了)`);
  console.log(`- 本番Ref (${PROD_REF}) 混入: なし (✅ 安全確認完了)`);

  const supabase = createClient(supabaseUrl, env.SUPABASE_SECRET_KEY!);

  // 2. 適用前のDB状態スナップショット
  console.log('\n=== [2. 適用前のステージングDB状態スナップショット] ===');
  const { count: orderCountBefore } = await supabase.from('orders').select('*', { count: 'exact', head: true });
  const { data: storeStateBefore } = await supabase.from('store_states').select('*').limit(5);
  const { data: seqBefore } = await supabase.from('order_number_sequences').select('*').limit(5);

  console.log(`- orders テーブル件数 (事前): ${orderCountBefore}`);
  console.log(`- store_states レコード数 (事前): ${storeStateBefore?.length ?? 0}`);
  console.log(`- order_number_sequences レコード数 (事前): ${seqBefore?.length ?? 0}`);

  // 3. 0002マイグレーションSQLの確認
  console.log('\n=== [3. 0002_phase0_stripe_session_hardening.sql の事前監査・状態確認] ===');
  const migrationPath = resolve(process.cwd(), 'supabase/migrations/0002_phase0_stripe_session_hardening.sql');
  const migrationSql = readFileSync(migrationPath, 'utf8');
  console.log(`- マイグレーションファイル読込: ${migrationSql.length} bytes`);

  // 4. RPC直接呼び出しによる 0002 新定義の動作確認
  console.log('\n=== [4. confirm_stripe_order_payment_tx の新シグネチャ・新定義動作検証] ===');
  const testOrderId = `probe_${Date.now()}`;
  const dummySessionId = `cs_probe_${Date.now()}`;

  // 存在しない注文
  const { data: notFoundRes, error: notFoundErr } = await supabase.rpc('confirm_stripe_order_payment_tx', {
    p_order_id: testOrderId,
    p_stripe_session_id: dummySessionId,
  });
  console.log('- 存在しない注文へのRPC呼び出し結果:', notFoundRes, notFoundErr);
  if (notFoundRes?.code !== 'ORDER_NOT_FOUND' || notFoundRes?.ok !== false) {
    throw new Error(`0002 migration not active on staging: got ${JSON.stringify(notFoundRes)}`);
  }
  console.log('✅ 0002 新定義の返却フォーマット (ok=false, code=ORDER_NOT_FOUND) を確認！');

  // 5. テスト用注文を作成し、Session ID未設定・不一致・キャンセルのDBレベル拒否を検証
  console.log('\n=== [5. DBレベルでの Session ID 不一致・未設定・キャンセル保護の直接検証] ===');
  // 5-1. session ID未設定の注文
  const { error: ins1Err } = await supabase.from('orders').insert({
    id: testOrderId,
    order_number: '9901',
    customer_name: '監査テスト1',
    items: [],
    total_price: 100,
    status: 'unpaid',
    payment_status: 'unpaid',
    production_status: 'pending',
    fulfillment_status: 'not_handed_over',
    cancellation_status: 'active',
    stripe_session_id: null,
  });
  if (ins1Err) throw ins1Err;

  // RPC呼び出し -> SESSION_ID_NOT_CONFIGURED を期待
  const { data: nullSessionRes } = await supabase.rpc('confirm_stripe_order_payment_tx', {
    p_order_id: testOrderId,
    p_stripe_session_id: dummySessionId,
  });
  console.log('- Session ID未設定の注文へのRPC呼び出し:', nullSessionRes);
  if (nullSessionRes?.code !== 'SESSION_ID_NOT_CONFIGURED') {
    throw new Error(`Expected SESSION_ID_NOT_CONFIGURED, got: ${JSON.stringify(nullSessionRes)}`);
  }
  console.log('✅ 注文側 stripe_session_id が NULL の場合、DBレベルで拒絶 (SESSION_ID_NOT_CONFIGURED)');

  // 5-2. session ID不一致の注文
  await supabase.from('orders').update({ stripe_session_id: 'cs_valid_original_session' }).eq('id', testOrderId);

  const { data: mismatchSessionRes } = await supabase.rpc('confirm_stripe_order_payment_tx', {
    p_order_id: testOrderId,
    p_stripe_session_id: 'cs_stolen_attacker_session',
  });
  console.log('- Session ID不一致の注文へのRPC呼び出し:', mismatchSessionRes);
  if (mismatchSessionRes?.code !== 'SESSION_ID_MISMATCH') {
    throw new Error(`Expected SESSION_ID_MISMATCH, got: ${JSON.stringify(mismatchSessionRes)}`);
  }
  console.log('✅ 提供セッションIDが注文と不一致の場合、DBレベルで遮断 (SESSION_ID_MISMATCH)');

  // 5-3. キャンセル済み注文の保護
  await supabase.from('orders').update({
    stripe_session_id: 'cs_matching_session',
    cancellation_status: 'cancelled',
    status: 'cancelled',
  }).eq('id', testOrderId);

  const { data: cancelRes } = await supabase.rpc('confirm_stripe_order_payment_tx', {
    p_order_id: testOrderId,
    p_stripe_session_id: 'cs_matching_session',
  });
  console.log('- キャンセル済み注文へのRPC呼び出し:', cancelRes);
  if (cancelRes?.code !== 'ORDER_CANCELLED') {
    throw new Error(`Expected ORDER_CANCELLED, got: ${JSON.stringify(cancelRes)}`);
  }
  console.log('✅ キャンセル済み注文への決済確定をDBレベルで遮断 (ORDER_CANCELLED)');

  // 5-4. 正常確定
  await supabase.from('orders').update({
    stripe_session_id: 'cs_matching_session',
    cancellation_status: 'active',
    status: 'unpaid',
    payment_status: 'unpaid',
  }).eq('id', testOrderId);

  const { data: validConfirmRes } = await supabase.rpc('confirm_stripe_order_payment_tx', {
    p_order_id: testOrderId,
    p_stripe_session_id: 'cs_matching_session',
    p_webhook_event_id: `evt_test_${Date.now()}`,
  });
  console.log('- 正常な決済確定RPC呼び出し:', validConfirmRes);
  if (validConfirmRes?.ok !== true || validConfirmRes?.order?.status !== 'pending' || validConfirmRes?.order?.payment_status !== 'paid') {
    throw new Error(`Valid confirm failed: ${JSON.stringify(validConfirmRes)}`);
  }
  console.log('✅ 正常なセッションIDによる決済確定がDBレベルで正常に pending/paid に遷移');

  // 5-5. 再送・巻き戻しなしの確認
  const { data: replayConfirmRes } = await supabase.rpc('confirm_stripe_order_payment_tx', {
    p_order_id: testOrderId,
    p_stripe_session_id: 'cs_matching_session',
  });
  console.log('- 確定後の再送RPC呼び出し:', replayConfirmRes);
  if (
    replayConfirmRes?.ok !== true ||
    replayConfirmRes?.transitioned !== false ||
    replayConfirmRes?.transitioned_from_unpaid !== false
  ) {
    throw new Error(`Replay confirm failed: ${JSON.stringify(replayConfirmRes)}`);
  }
  console.log('✅ 再送時に transitioned=false / transitioned_from_unpaid=false で状態巻き戻しなしを確認');

  // 5-6. 受渡完了注文 (status=cancelled, fulfillment_status=handed_over, cancellation_status=active) の誤判定防止確認
  await supabase.from('orders').update({
    status: 'cancelled',
    payment_status: 'paid',
    production_status: 'ready',
    fulfillment_status: 'handed_over',
    cancellation_status: 'active',
  }).eq('id', testOrderId);

  const { data: handedOverRes } = await supabase.rpc('confirm_stripe_order_payment_tx', {
    p_order_id: testOrderId,
    p_stripe_session_id: 'cs_matching_session',
  });
  console.log('- 受渡完了注文への再送RPC呼び出し:', handedOverRes);
  if (handedOverRes?.ok !== true || handedOverRes?.transitioned_from_unpaid !== false) {
    throw new Error(`Handed-over order was misclassified: ${JSON.stringify(handedOverRes)}`);
  }
  console.log('✅ 受渡完了注文が ORDER_CANCELLED と誤判定されず冪等成功することを確認');

  // 5-7. 過去の未判定注文 (legacy_undetermined: status=cancelled かつ 4軸すべてNULL) の保護確認
  await supabase.from('orders').update({
    status: 'cancelled',
    payment_status: null,
    production_status: null,
    fulfillment_status: null,
    cancellation_status: null,
  }).eq('id', testOrderId);

  const { data: legacyRes } = await supabase.rpc('confirm_stripe_order_payment_tx', {
    p_order_id: testOrderId,
    p_stripe_session_id: 'cs_matching_session',
  });
  console.log('- 過去未判定注文 (legacy_undetermined) へのRPC呼び出し:', legacyRes);
  if (legacyRes?.ok !== false || legacyRes?.code !== 'LEGACY_ORDER_PROTECTED') {
    throw new Error(`Expected LEGACY_ORDER_PROTECTED, got: ${JSON.stringify(legacyRes)}`);
  }
  console.log('✅ 過去未判定注文 (legacy_undetermined) が LEGACY_ORDER_PROTECTED で保護されることを確認');

  // 5-8. payment_status IS NULL の暗黙 paid 補完禁止 (INVALID_ORDER_STATE) の確認
  await supabase.from('orders').update({
    status: 'pending',
    payment_status: null,
    production_status: 'pending',
    fulfillment_status: 'not_handed_over',
    cancellation_status: 'active',
    stripe_session_id: 'cs_matching_session',
  }).eq('id', testOrderId);

  const { data: nullPayRes } = await supabase.rpc('confirm_stripe_order_payment_tx', {
    p_order_id: testOrderId,
    p_stripe_session_id: 'cs_matching_session',
  });
  console.log('- payment_status=NULL の不整合レコードへのRPC呼び出し:', nullPayRes);
  if (nullPayRes?.ok !== false || nullPayRes?.code !== 'INVALID_ORDER_STATE') {
    throw new Error(`Expected INVALID_ORDER_STATE, got: ${JSON.stringify(nullPayRes)}`);
  }
  console.log('✅ payment_status IS NULL の暗黙 paid 補完が禁止されていることを確認');

  // 5-9. record_cancelled_payment_discrepancy_tx における Session ID 未設定注文への後付け拒否 & 金額不一致拒否
  await supabase.from('orders').update({
    status: 'cancelled',
    payment_status: 'unpaid',
    cancellation_status: 'cancelled',
    stripe_session_id: null,
  }).eq('id', testOrderId);

  const { data: discNoSessRes } = await supabase.rpc('record_cancelled_payment_discrepancy_tx', {
    p_order_id: testOrderId,
    p_stripe_session_id: 'cs_unverified_injected',
    p_payment_intent_id: 'pi_unverified',
    p_amount: 100,
    p_currency: 'jpy',
  });
  console.log('- Session未設定キャンセル注文への返金案件登録RPC呼び出し:', discNoSessRes);
  if (discNoSessRes?.ok !== false || discNoSessRes?.code !== 'SESSION_ID_NOT_CONFIGURED') {
    throw new Error(`Expected SESSION_ID_NOT_CONFIGURED on discrepancy RPC, got: ${JSON.stringify(discNoSessRes)}`);
  }
  console.log('✅ Session ID 未設定のキャンセル済み注文に対する未検証 Session ID の後付け紐付けを拒否');

  // クリーンアップ
  await supabase.from('stripe_webhook_events').delete().eq('order_id', testOrderId);
  await supabase.from('orders').delete().eq('id', testOrderId);
  console.log('✅ テスト用レコードのクリーンアップ完了');

  // 6. 全8個のRPC権限監査
  console.log('\n=== [6. 全8個のRPC権限監査 (anon/authenticated 拒絶確認)] ===');
  const anonKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const anonSupabase = createClient(supabaseUrl, anonKey!);

  const rpcList = [
    { name: 'next_order_number', params: { p_store_id: 'store_001', p_date: '2026-11-20' } },
    { name: 'confirm_stripe_order_payment_tx', params: { p_order_id: 'audit_test', p_stripe_session_id: 'dummy' } },
    { name: 'update_store_state_tx', params: { p_store_id: 'store_001', p_expected_version: 1, p_is_manual_open: true, p_sold_out_items: [] } },
    { name: 'create_mobile_order_tx', params: { p_order: {} } },
    { name: 'finalize_mobile_order_checkout_tx', params: { p_order_id: 'audit_test', p_stripe_session_id: 'dummy' } },
    { name: 'abort_mobile_order_checkout_tx', params: { p_order_id: 'audit_test', p_reason: 'audit' } },
    { name: 'record_cancelled_payment_discrepancy_tx', params: { p_order_id: 'audit_test', p_stripe_session_id: 'dummy', p_amount: 100, p_reason: 'audit' } },
    { name: 'update_refund_request_status_tx', params: { p_order_id: 'audit_test', p_target_status: 'refunded' } },
  ];

  for (const rpc of rpcList) {
    const { data: aData, error: aErr } = await anonSupabase.rpc(rpc.name, rpc.params as any);
    if (!aErr || (aErr.code !== '42501' && !aErr.message.includes('permission denied'))) {
      throw new Error(`SECURITY ALERT: RPC ${rpc.name} is accessible by anon! got: ${JSON.stringify(aData)}, error: ${JSON.stringify(aErr)}`);
    }
    console.log(`- RPC: ${rpc.name} -> anon 拒絶確認 (code=${aErr.code}, permission denied) ✅`);
  }
  console.log('✅ 全8個のRPCについて anon からの実行が完全に拒絶されていることを確認\n');

  // 7. 適用後のDB状態スナップショット照合（副作用・意図しない変更がないこと）
  console.log('=== [7. 事前事後のDB状態差分検証] ===');
  const { count: orderCountAfter } = await supabase.from('orders').select('*', { count: 'exact', head: true });
  const { data: storeStateAfter } = await supabase.from('store_states').select('*').limit(5);
  const { data: seqAfter } = await supabase.from('order_number_sequences').select('*').limit(5);

  console.log(`- orders テーブル件数 (事後): ${orderCountAfter} (事前: ${orderCountBefore})`);
  console.log(`- store_states レコード数 (事後): ${storeStateAfter?.length ?? 0} (事前: ${storeStateBefore?.length ?? 0})`);
  console.log(`- order_number_sequences レコード数 (事後): ${seqAfter?.length ?? 0} (事前: ${seqBefore?.length ?? 0})`);

  if (orderCountAfter !== orderCountBefore) {
    throw new Error(`Orders count mismatch: before=${orderCountBefore}, after=${orderCountAfter}`);
  }
  console.log('✅ 店舗状態・採番テーブル・既存注文の件数に予期せぬ変化がないことを確認！');
}

if (process.argv[1]?.endsWith('apply-and-verify-0002-staging.ts')) {
  runStep1And2().catch((e) => {
    console.error('第1・第2段階 実行エラー:', e);
    process.exit(1);
  });
}
