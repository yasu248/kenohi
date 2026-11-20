/**
 * 0002 マイグレーション ステージング適用後 10項目総合検証スクリプト
 * (scripts/apply-and-verify-0002-staging.ts)
 */

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const STAGING_ENV_FILE = resolve(process.cwd(), '.env.staging.local');
const MIGRATION_0002_PATH = resolve(
  process.cwd(),
  'supabase/migrations/0002_phase0_stripe_session_hardening.sql'
);
const EXPECTED_SHA256 = '9a34d924eac5f166cf4399b4f8a1ef518bc864c7d8b57a7bc29eb19145fe5e6e';
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

export async function runStagingPostMigrationVerification() {
  console.log('==============================================================');
  console.log('   0002_phase0_stripe_session_hardening ステージング総合検証   ');
  console.log('==============================================================\n');

  const env = loadEnv();

  // 0. 環境ガードとSQLチェックサム確認
  console.log('=== [0. 環境ガード & SQLチェックサム照合] ===');
  const supabaseUrl = env.SUPABASE_URL || '';
  if (supabaseUrl.includes(PROD_REF)) {
    throw new Error(`CRITICAL: Production Supabase Ref (${PROD_REF}) detected! Aborting.`);
  }
  if (!supabaseUrl.includes(STAGING_REF)) {
    throw new Error(`CRITICAL: Target is not staging (${STAGING_REF}). Found: ${supabaseUrl}`);
  }

  const sqlBytes = readFileSync(MIGRATION_0002_PATH, 'utf8');
  const actualSha256 = crypto.createHash('sha256').update(sqlBytes, 'utf8').digest('hex');
  console.log(`- 接続先URL: ${supabaseUrl} (✅ ステージング限定確認)`);
  console.log(`- 0002 SQL SHA-256: ${actualSha256}`);
  if (actualSha256 !== EXPECTED_SHA256) {
    throw new Error(`SQL SHA-256 mismatch! expected=${EXPECTED_SHA256}, actual=${actualSha256}`);
  }
  console.log('✅ ローカルPostgreSQL 42件統合テスト通過版と完全一致を確認\n');

  const supabase = createClient(supabaseUrl, env.SUPABASE_SECRET_KEY!);

  // 事前スナップショットの記録
  const { data: ordersBefore, error: obErr } = await supabase
    .from('orders')
    .select('id, status, payment_status, customer_avatar, updated_at')
    .order('id');
  if (obErr) throw obErr;

  const { data: refundsBefore, error: rbErr } = await supabase
    .from('order_refund_requests')
    .select('id, order_id, refund_status')
    .order('id');
  if (rbErr) throw rbErr;

  const { data: eventsBefore, error: ebErr } = await supabase
    .from('stripe_webhook_events')
    .select('event_id, order_id, session_id, status')
    .order('event_id');
  if (ebErr) throw ebErr;

  const { data: seqBefore, error: sbErr } = await supabase
    .from('order_number_sequences')
    .select('store_id, order_date, last_number')
    .order('order_date');
  if (sbErr) throw sbErr;

  const prefix = `probe_0002_${Date.now()}`;
  const orderIdA = `${prefix}_ord_A`;
  const orderIdB = `${prefix}_ord_B`;
  const orderIdCancel = `${prefix}_ord_cancel`;
  const sessionA = `cs_test_${prefix}_A`;
  const sessionB = `cs_test_${prefix}_B`;
  const sessionCancel = `cs_test_${prefix}_cancel`;
  const evtValidA = `evt_${prefix}_valid_A`;
  const evtRaceShared = `evt_${prefix}_race_shared`;
  const evtCancelDisc = `evt_${prefix}_cancel_disc`;
  const evtLateAfterRefund = `evt_${prefix}_late_refund`;

  try {
    // 1. RPC定義・EXECUTE権限監査 (anon / authenticated 拒否、service_role 許可)
    console.log('=== [1. 全8個のRPC定義 & EXECUTE権限監査 (anon / authenticated / service_role)] ===');
    const { data: notFoundProbe, error: nfErr } = await supabase.rpc('confirm_stripe_order_payment_tx', {
      p_order_id: `${prefix}_non_existent`,
      p_stripe_session_id: 'cs_dummy',
    });
    if (nfErr) throw nfErr;
    if (notFoundProbe?.ok !== false || notFoundProbe?.code !== 'ORDER_NOT_FOUND') {
      throw new Error(`0002 RPC definition not active on staging! Got: ${JSON.stringify(notFoundProbe)}`);
    }
    console.log('- service_role: 0002 新シグネチャ・戻り値 (ok=false, code=ORDER_NOT_FOUND) 確認 ✅');

    const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!publishableKey) throw new Error('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is missing');
    const anonClient = createClient(supabaseUrl, publishableKey);

    // 検証用の一時 authenticated ユーザーを作成して全8個のRPC拒否を確認
    const tempEmail = `audit.${Date.now()}@example.com`;
    const tempPassword = `AuditPass!${Date.now()}#XyZ`;
    const { data: createdUser, error: createUserErr } = await supabase.auth.admin.createUser({
      email: tempEmail,
      password: tempPassword,
      email_confirm: true,
    });
    if (createUserErr || !createdUser.user) {
      throw new Error(`Failed to create temp auth user: ${createUserErr?.message}`);
    }

    const authClient = createClient(supabaseUrl, publishableKey);
    const { error: signInErr } = await authClient.auth.signInWithPassword({
      email: tempEmail,
      password: tempPassword,
    });
    if (signInErr) {
      await supabase.auth.admin.deleteUser(createdUser.user.id);
      throw new Error(`Failed to sign in temp auth user: ${signInErr.message}`);
    }

    const rpcAuditTargets = [
      { name: 'next_order_number', params: { p_store_id: 'kenocha_main', p_order_date: '2026-11-20' } },
      { name: 'confirm_stripe_order_payment_tx', params: { p_order_id: 'audit', p_stripe_session_id: 'cs_audit' } },
      { name: 'update_store_state_tx', params: { p_store_id: 'kenocha_main', p_state_json: {} } },
      {
        name: 'create_mobile_order_tx',
        params: {
          p_store_id: 'kenocha_main',
          p_order_id: 'audit',
          p_items: [],
          p_total_price: 400,
          p_customer_name: 'audit',
        },
      },
      {
        name: 'finalize_mobile_order_checkout_tx',
        params: { p_store_id: 'kenocha_main', p_order_id: 'audit', p_stripe_session_id: 'cs_audit' },
      },
      { name: 'abort_mobile_order_checkout_tx', params: { p_order_id: 'audit' } },
      {
        name: 'record_cancelled_payment_discrepancy_tx',
        params: {
          p_order_id: 'audit',
          p_stripe_session_id: 'cs_audit',
          p_payment_intent_id: 'pi_audit',
          p_amount: 400,
        },
      },
      {
        name: 'update_refund_request_status_tx',
        params: { p_order_id: 'audit', p_refund_status: 'succeeded' },
      },
    ];

    try {
      for (const rpc of rpcAuditTargets) {
        const { error: anonErr } = await anonClient.rpc(rpc.name, rpc.params as any);
        if (!anonErr || anonErr.code !== '42501') {
          throw new Error(`anon was NOT denied 42501 on ${rpc.name}: ${JSON.stringify(anonErr)}`);
        }
        const { error: authErr } = await authClient.rpc(rpc.name, rpc.params as any);
        if (!authErr || authErr.code !== '42501') {
          throw new Error(`authenticated was NOT denied 42501 on ${rpc.name}: ${JSON.stringify(authErr)}`);
        }
        console.log(`- RPC ${rpc.name}: anon=[42501 拒否] / authenticated=[42501 拒否] ✅`);
      }
    } finally {
      await authClient.auth.signOut();
      const { error: delUserErr } = await supabase.auth.admin.deleteUser(createdUser.user.id);
      if (delUserErr) {
        throw new Error(`Failed to cleanup temp auth user ${createdUser.user.id}: ${delUserErr.message}`);
      }
      console.log('- 検証用一時認証ユーザーの削除確認完了 ✅\n');
    }

    // 2. 未払いSessionの決済誤確定防止 & Session ID未設定拒否
    console.log('=== [2. Session ID未設定・未払い注文の誤確定防止] ===');
    const { error: insAErr } = await supabase.from('orders').insert({
      id: orderIdA,
      order_number: '9801',
      customer_name: '0002検証客A',
      items: [],
      total_price: 400,
      status: 'unpaid',
      payment_status: 'unpaid',
      production_status: 'pending',
      fulfillment_status: 'not_handed_over',
      cancellation_status: 'active',
      stripe_session_id: null,
    });
    if (insAErr) throw insAErr;

    const { data: nullSessRes } = await supabase.rpc('confirm_stripe_order_payment_tx', {
      p_order_id: orderIdA,
      p_stripe_session_id: sessionA,
    });
    if (nullSessRes?.ok !== false || nullSessRes?.code !== 'SESSION_ID_NOT_CONFIGURED') {
      throw new Error(`Expected SESSION_ID_NOT_CONFIGURED, got: ${JSON.stringify(nullSessRes)}`);
    }
    console.log('- stripe_session_id=NULL の注文への確定呼び出し -> SESSION_ID_NOT_CONFIGURED で拒否 ✅\n');

    // 3. 別Session流用拒否 (SESSION_ID_MISMATCH)
    console.log('=== [3. 別注文のSession ID流用拒否 (SESSION_ID_MISMATCH)] ===');
    await supabase.from('orders').update({ stripe_session_id: sessionA }).eq('id', orderIdA);

    const { data: mismatchRes } = await supabase.rpc('confirm_stripe_order_payment_tx', {
      p_order_id: orderIdA,
      p_stripe_session_id: 'cs_test_stolen_other_order',
    });
    if (mismatchRes?.ok !== false || mismatchRes?.code !== 'SESSION_ID_MISMATCH') {
      throw new Error(`Expected SESSION_ID_MISMATCH, got: ${JSON.stringify(mismatchRes)}`);
    }
    console.log('- 不一致Session IDでの確定呼び出し -> SESSION_ID_MISMATCH で拒否 ✅\n');

    // 4 & 5. 正常な決済確定と Webhook イベントID再利用拒否 (ON CONFLICT 同時競合含む)
    console.log('=== [4 & 5. 正常な決済確定 & WebhookイベントID別注文再利用拒否 (並列ON CONFLICT含む)] ===');
    const { data: validConfirmRes } = await supabase.rpc('confirm_stripe_order_payment_tx', {
      p_order_id: orderIdA,
      p_stripe_session_id: sessionA,
      p_webhook_event_id: evtValidA,
    });
    if (
      validConfirmRes?.ok !== true ||
      validConfirmRes?.transitioned !== true ||
      validConfirmRes?.transitioned_from_unpaid !== true ||
      validConfirmRes?.order?.status !== 'pending' ||
      validConfirmRes?.order?.payment_status !== 'paid'
    ) {
      throw new Error(`Valid confirmation failed: ${JSON.stringify(validConfirmRes)}`);
    }
    console.log('- 正規Session IDでの初回決済確定 -> status=pending, payment_status=paid, transitioned_from_unpaid=true ✅');

    // 別注文Bを作成し、既存の evtValidA を再利用しようとすると WEBHOOK_EVENT_CONFLICT で拒否されること
    const { error: insBErr } = await supabase.from('orders').insert({
      id: orderIdB,
      order_number: '9802',
      customer_name: '0002検証客B',
      items: [],
      total_price: 450,
      status: 'unpaid',
      payment_status: 'unpaid',
      production_status: 'pending',
      fulfillment_status: 'not_handed_over',
      cancellation_status: 'active',
      stripe_session_id: sessionB,
    });
    if (insBErr) throw insBErr;

    const { data: reuseEvtRes } = await supabase.rpc('confirm_stripe_order_payment_tx', {
      p_order_id: orderIdB,
      p_stripe_session_id: sessionB,
      p_webhook_event_id: evtValidA,
    });
    if (reuseEvtRes?.ok !== false || reuseEvtRes?.code !== 'WEBHOOK_EVENT_CONFLICT') {
      throw new Error(`Expected WEBHOOK_EVENT_CONFLICT on event reuse, got: ${JSON.stringify(reuseEvtRes)}`);
    }
    console.log('- 既存WebhookイベントIDの別注文への再利用 -> WEBHOOK_EVENT_CONFLICT で拒否 ✅');

    // 未登録の同一イベントID (evtRaceShared) を orderIdA と orderIdB で同時並列に呼び出し、片方のみ成功・もう片方は WEBHOOK_EVENT_CONFLICT で拒否されることを確認
    const [raceResA, raceResB] = await Promise.all([
      supabase.rpc('confirm_stripe_order_payment_tx', {
        p_order_id: orderIdA,
        p_stripe_session_id: sessionA,
        p_webhook_event_id: evtRaceShared,
      }),
      supabase.rpc('confirm_stripe_order_payment_tx', {
        p_order_id: orderIdB,
        p_stripe_session_id: sessionB,
        p_webhook_event_id: evtRaceShared,
      }),
    ]);
    const racePayloads = [raceResA.data, raceResB.data];
    const raceOkCount = racePayloads.filter((r) => r?.ok === true).length;
    const raceConflictCount = racePayloads.filter(
      (r) => r?.ok === false && r?.code === 'WEBHOOK_EVENT_CONFLICT'
    ).length;
    if (raceOkCount !== 1 || raceConflictCount !== 1) {
      throw new Error(`Parallel event conflict race failed: ${JSON.stringify(racePayloads)}`);
    }
    console.log('- 未登録WebhookイベントIDの別注文同時競合 (ON CONFLICT) -> 1件のみ成功・1件はWEBHOOK_EVENT_CONFLICTで拒否 ✅\n');

    // 6. Webhook再送・並列処理・受渡完了 (handed_over) / 過去未判定 (legacy_undetermined) 保護
    console.log('=== [6. Webhook再送・10並列処理・受渡完了/過去未判定注文の保護] ===');
    await supabase
      .from('orders')
      .update({ status: 'unpaid', payment_status: 'unpaid', production_status: 'pending' })
      .eq('id', orderIdB);

    const parallelConfirmB = await Promise.all(
      Array.from({ length: 10 }, (_, idx) =>
        supabase.rpc('confirm_stripe_order_payment_tx', {
          p_order_id: orderIdB,
          p_stripe_session_id: sessionB,
          p_webhook_event_id: `evt_${prefix}_par_B_${idx}`,
        })
      )
    );
    const parBData = parallelConfirmB.map((r) => r.data);
    const transitionedBCount = parBData.filter((d) => d?.transitioned_from_unpaid === true).length;
    const replayBCount = parBData.filter((d) => d?.transitioned_from_unpaid === false).length;
    if (transitionedBCount !== 1 || replayBCount !== 9) {
      throw new Error(
        `Expected 1 initial transition and 9 replays on 10 parallel calls, got transitioned=${transitionedBCount}, replay=${replayBCount}`
      );
    }
    console.log('- 同一注文への10並列Webhook処理 -> FOR UPDATE直列化により初回遷移1回・冪等再送9回 ✅');

    // 受渡完了 (status='cancelled', fulfillment_status='handed_over', cancellation_status='active') の誤判定防止
    await supabase
      .from('orders')
      .update({
        status: 'cancelled',
        payment_status: 'paid',
        production_status: 'ready',
        fulfillment_status: 'handed_over',
        cancellation_status: 'active',
      })
      .eq('id', orderIdA);

    const { data: handedOverRes } = await supabase.rpc('confirm_stripe_order_payment_tx', {
      p_order_id: orderIdA,
      p_stripe_session_id: sessionA,
    });
    if (handedOverRes?.ok !== true || handedOverRes?.transitioned_from_unpaid !== false) {
      throw new Error(`Handed-over order was misclassified: ${JSON.stringify(handedOverRes)}`);
    }
    console.log('- 受渡完了注文 (status=cancelled, fulfillment_status=handed_over) の再送 -> ORDER_CANCELLED誤判定なし・冪等成功 ✅');

    // 過去未判定注文 (legacy_undetermined: status='cancelled' かつ 4軸すべてNULL) の保護
    await supabase
      .from('orders')
      .update({
        status: 'cancelled',
        payment_status: null,
        production_status: null,
        fulfillment_status: null,
        cancellation_status: null,
      })
      .eq('id', orderIdA);

    const { data: legacyRes } = await supabase.rpc('confirm_stripe_order_payment_tx', {
      p_order_id: orderIdA,
      p_stripe_session_id: sessionA,
    });
    if (legacyRes?.ok !== false || legacyRes?.code !== 'LEGACY_ORDER_PROTECTED') {
      throw new Error(`Expected LEGACY_ORDER_PROTECTED, got: ${JSON.stringify(legacyRes)}`);
    }
    console.log('- 過去未判定注文 (legacy_undetermined) -> LEGACY_ORDER_PROTECTED で完全保全 ✅\n');

    // 7 & 8. キャンセル競合・返金案件登録・返金済み案件の不変性
    console.log('=== [7 & 8. キャンセル競合・返金案件登録・返金済み案件の不変性検証] ===');
    const { error: insCancelErr } = await supabase.from('orders').insert({
      id: orderIdCancel,
      order_number: '9803',
      customer_name: '0002取消検証客',
      items: [],
      total_price: 600,
      status: 'cancelled',
      payment_status: 'unpaid',
      production_status: 'pending',
      fulfillment_status: 'not_handed_over',
      cancellation_status: 'cancelled',
      stripe_session_id: null,
    });
    if (insCancelErr) throw insCancelErr;

    // Session未設定のキャンセル注文に後付けでSession IDを紐付けようとしても拒否されること
    const { data: cancelNoSessRes } = await supabase.rpc('record_cancelled_payment_discrepancy_tx', {
      p_order_id: orderIdCancel,
      p_stripe_session_id: sessionCancel,
      p_payment_intent_id: 'pi_test_cancel_1',
      p_amount: 600,
      p_currency: 'jpy',
    });
    if (cancelNoSessRes?.ok !== false || cancelNoSessRes?.code !== 'SESSION_ID_NOT_CONFIGURED') {
      throw new Error(`Expected SESSION_ID_NOT_CONFIGURED, got: ${JSON.stringify(cancelNoSessRes)}`);
    }
    console.log('- Session ID未設定のキャンセル注文への返金案件登録 -> SESSION_ID_NOT_CONFIGURED で後付け拒否 ✅');

    // 正規のSession IDを設定した上で confirm_stripe_order_payment_tx が ORDER_CANCELLED で復活を拒否すること
    await supabase.from('orders').update({ stripe_session_id: sessionCancel }).eq('id', orderIdCancel);

    const { data: confirmCancelRes } = await supabase.rpc('confirm_stripe_order_payment_tx', {
      p_order_id: orderIdCancel,
      p_stripe_session_id: sessionCancel,
    });
    if (confirmCancelRes?.ok !== false || confirmCancelRes?.code !== 'ORDER_CANCELLED') {
      throw new Error(`Expected ORDER_CANCELLED, got: ${JSON.stringify(confirmCancelRes)}`);
    }
    console.log('- キャンセル済み注文への決済確定 -> ORDER_CANCELLED で厨房復活を遮断 ✅');

    // 金額不一致の拒否確認
    const { data: badAmountDiscRes } = await supabase.rpc('record_cancelled_payment_discrepancy_tx', {
      p_order_id: orderIdCancel,
      p_stripe_session_id: sessionCancel,
      p_payment_intent_id: 'pi_test_cancel_1',
      p_amount: 9999,
      p_currency: 'jpy',
    });
    if (badAmountDiscRes?.ok !== false || badAmountDiscRes?.code !== 'AMOUNT_MISMATCH') {
      throw new Error(`Expected AMOUNT_MISMATCH, got: ${JSON.stringify(badAmountDiscRes)}`);
    }
    console.log('- 注文金額と異なる返金案件登録 -> AMOUNT_MISMATCH で拒否 ✅');

    // 正規の返金案件登録
    const { data: validDiscRes } = await supabase.rpc('record_cancelled_payment_discrepancy_tx', {
      p_order_id: orderIdCancel,
      p_stripe_session_id: sessionCancel,
      p_payment_intent_id: 'pi_test_cancel_1',
      p_amount: 600,
      p_currency: 'jpy',
      p_webhook_event_id: evtCancelDisc,
      p_reason: 'initial_cancelled_payment_received',
    });
    if (
      validDiscRes?.ok !== true ||
      validDiscRes?.already_recorded !== false ||
      validDiscRes?.refund_request?.refund_status !== 'pending' ||
      validDiscRes?.refund_request?.requires_manual_attention !== true
    ) {
      throw new Error(`Valid discrepancy registration failed: ${JSON.stringify(validDiscRes)}`);
    }
    console.log('- 正規のキャンセル後決済不整合 -> order_refund_requests に pending / requires_manual_attention=true で登録 ✅');

    // 返金完了 (succeeded) に更新後、遅延Webhookや重複イベントが来ても全フィールドが不変であること
    const { data: refundSuccRes } = await supabase.rpc('update_refund_request_status_tx', {
      p_order_id: orderIdCancel,
      p_refund_status: 'succeeded',
      p_stripe_refund_id: 're_test_staging_immutable',
      p_last_error: 'audit_completed_note',
      p_requires_manual_attention: false,
      p_increment_attempt: true,
    });
    if (refundSuccRes?.ok !== true || refundSuccRes?.refund_request?.refund_status !== 'succeeded') {
      throw new Error(`Failed to mark refund succeeded: ${JSON.stringify(refundSuccRes)}`);
    }

    const { data: reqSnapBefore } = await supabase
      .from('order_refund_requests')
      .select('*')
      .eq('order_id', orderIdCancel)
      .single();
    const { data: ordSnapBefore } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderIdCancel)
      .single();

    // 遅延再送
    const { data: lateReplayRes } = await supabase.rpc('record_cancelled_payment_discrepancy_tx', {
      p_order_id: orderIdCancel,
      p_stripe_session_id: sessionCancel,
      p_payment_intent_id: 'pi_test_cancel_1',
      p_amount: 600,
      p_currency: 'jpy',
      p_webhook_event_id: evtLateAfterRefund,
      p_reason: 'late_webhook_attempting_to_overwrite_reason',
    });
    if (lateReplayRes?.ok !== true || lateReplayRes?.already_recorded !== true) {
      throw new Error(`Late replay on succeeded refund failed: ${JSON.stringify(lateReplayRes)}`);
    }

    const { data: reqSnapAfter } = await supabase
      .from('order_refund_requests')
      .select('*')
      .eq('order_id', orderIdCancel)
      .single();
    const { data: ordSnapAfter } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderIdCancel)
      .single();

    if (
      JSON.stringify(reqSnapBefore) !== JSON.stringify(reqSnapAfter) ||
      JSON.stringify(ordSnapBefore) !== JSON.stringify(ordSnapAfter)
    ) {
      throw new Error(
        `Immutability violated on succeeded refund!\nBefore: ${JSON.stringify(reqSnapBefore)}\nAfter: ${JSON.stringify(reqSnapAfter)}`
      );
    }
    console.log('- 返金完了 (succeeded) 案件への遅延Webhook再送 -> 全カラム・updated_at・注文返金状態が1ビットも変化せず完全不変 ✅');

    // 異なる PaymentIntent ID での上書き試行が PAYMENT_INTENT_MISMATCH で拒否されること
    const { data: diffPiRes } = await supabase.rpc('record_cancelled_payment_discrepancy_tx', {
      p_order_id: orderIdCancel,
      p_stripe_session_id: sessionCancel,
      p_payment_intent_id: 'pi_tampered_other',
      p_amount: 600,
      p_currency: 'jpy',
    });
    if (diffPiRes?.ok !== false || diffPiRes?.code !== 'PAYMENT_INTENT_MISMATCH') {
      throw new Error(`Expected PAYMENT_INTENT_MISMATCH, got: ${JSON.stringify(diffPiRes)}`);
    }
    console.log('- 返金完了案件に対する異なるPaymentIntent ID指定 -> PAYMENT_INTENT_MISMATCH で拒否 ✅\n');
  } finally {
    // テストデータの完全クリーンアップ
    console.log('=== [クリーンアップ実行] ===');
    await supabase
      .from('stripe_webhook_events')
      .delete()
      .like('event_id', `evt_${prefix}%`);
    await supabase
      .from('order_refund_requests')
      .delete()
      .in('order_id', [orderIdA, orderIdB, orderIdCancel]);
    await supabase
      .from('orders')
      .delete()
      .in('id', [orderIdA, orderIdB, orderIdCancel]);
  }

  // 9. 既存注文・店舗状態・採番・イベント履歴の保全検証
  console.log('=== [9. 既存注文・店舗状態・採番・イベント履歴の事前事後完全一致検証] ===');
  const { data: ordersAfter } = await supabase
    .from('orders')
    .select('id, status, payment_status, customer_avatar, updated_at')
    .order('id');
  const { data: refundsAfter } = await supabase
    .from('order_refund_requests')
    .select('id, order_id, refund_status')
    .order('id');
  const { data: eventsAfter } = await supabase
    .from('stripe_webhook_events')
    .select('event_id, order_id, session_id, status')
    .order('event_id');
  const { data: seqAfter } = await supabase
    .from('order_number_sequences')
    .select('store_id, order_date, last_number')
    .order('order_date');

  if (JSON.stringify(ordersBefore) !== JSON.stringify(ordersAfter)) {
    throw new Error(`Orders table diff detected!\nBefore: ${JSON.stringify(ordersBefore)}\nAfter: ${JSON.stringify(ordersAfter)}`);
  }
  if (JSON.stringify(refundsBefore) !== JSON.stringify(refundsAfter)) {
    throw new Error(`Refund requests diff detected!`);
  }
  if (JSON.stringify(eventsBefore) !== JSON.stringify(eventsAfter)) {
    throw new Error(`Webhook events diff detected!`);
  }
  if (JSON.stringify(seqBefore) !== JSON.stringify(seqAfter)) {
    throw new Error(`Sequences diff detected!`);
  }
  console.log('- orders (STORE_STATE_001含む): 事前・事後で完全一致 (残存テストデータ 0件) ✅');
  console.log('- order_refund_requests: 事前・事後で完全一致 (残存テストデータ 0件) ✅');
  console.log('- stripe_webhook_events: 事前・事後で完全一致 (残存テストデータ 0件) ✅');
  console.log('- order_number_sequences: 事前・事後で完全一致 ✅\n');

  console.log('🎉 0002 ステージングDB適用後検証: 全項目 PASS！');
}

if (process.argv[1]?.endsWith('apply-and-verify-0002-staging.ts')) {
  runStagingPostMigrationVerification().catch((e) => {
    console.error('ステージング検証エラー:', e);
    process.exit(1);
  });
}
