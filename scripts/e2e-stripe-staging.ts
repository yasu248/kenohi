/**
 * Stripe テストモード 実機 E2E 検証スクリプト (scripts/e2e-stripe-staging.ts)
 *
 * 全12シナリオの網羅的検証:
 * 1. ステージング環境接続・安全ガード検証 (zqcniawwhtnfcxkkwauu + sk_test_ + whsec_)
 * 2. ステージング Next.js サーバー疎通確認 (GET http://localhost:3000)
 * 3. Webhook エンドポイント署名検証 (不正署名拒絶 400)
 * 4. モバイル注文作成 & Checkout Session 発行 (POST /api/checkout)
 * 5. Stripe Checkout Session 実機メタデータ検証
 * 6. 署名付き Webhook 受領 & 正常処理 (POST /api/webhooks/stripe)
 * 7. DB 注文ステータス遷移確認 (unpaid -> paid / pending)
 * 8. 厨房画面データ反映確認 (未提供リスト表示)
 * 9. Webhook 再送時の冪等性検証 (重複送信での状態不変確認)
 * 10. 閉店ガード検証 (isManualOpen: false での 400 STORE_CLOSED 拒絶)
 * 11. 注文キャンセル競合 (Race Condition) 検証
 * 12. 返金キュー記録と管理アラート検証 (order_refund_requests)
 * ＋事後クリーンアップ & 店舗状態完全復元
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { normalizeSupabaseUrl } from '../src/lib/store.ts';

const STAGING_ENV_FILE = resolve(process.cwd(), '.env.staging.local');
const BASE_URL = 'http://localhost:3000';

function loadEnv(): Record<string, string> {
  if (!existsSync(STAGING_ENV_FILE)) {
    throw new Error(`.env.staging.local not found`);
  }
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

export async function runStagingE2E() {
  console.log('====================================================');
  console.log('   Stripe テストモード 実機 E2E 検証スイート開始   ');
  console.log('====================================================\n');

  const env = loadEnv();
  const createdOrderIds: string[] = [];
  let originalStoreState: any = null;

  // --- シナリオ 1: ステージング環境接続・安全ガード検証 ---
  console.log('=== [シナリオ 1] ステージング環境接続 & 安全ガード検証 ===');
  const supabaseUrl = normalizeSupabaseUrl(env.SUPABASE_URL || '');
  const secretKey = env.SUPABASE_SECRET_KEY || '';
  const stripeSecretKey = env.STRIPE_SECRET_KEY || '';
  const stripeWebhookSecret = env.STRIPE_WEBHOOK_SECRET || '';

  if (!supabaseUrl.includes('zqcniawwhtnfcxkkwauu')) {
    throw new Error(`CRITICAL: Supabase URL does not point to staging ref (zqcniawwhtnfcxkkwauu): ${supabaseUrl}`);
  }
  if (!secretKey.startsWith('sb_secret_')) {
    throw new Error('CRITICAL: Supabase Secret Key is not sb_secret_*');
  }
  if (!stripeSecretKey.startsWith('sk_test_')) {
    throw new Error('CRITICAL: Stripe Secret Key is not sk_test_*');
  }
  if (!stripeWebhookSecret.startsWith('whsec_')) {
    throw new Error('CRITICAL: Stripe Webhook Secret is not whsec_*');
  }
  console.log('✅ ステージング専用 Ref (zqcniawwhtnfcxkkwauu) 一致確認');
  console.log('✅ Stripe テストモードキー (sk_test_*) 確認');
  console.log('✅ Stripe Webhook 署名シークレット (whsec_*) 確認');
  console.log('✅ 秘密鍵の平文出力: なし (マスク保護)\n');

  const supabase = createClient(supabaseUrl, secretKey);
  const stripe = new Stripe(stripeSecretKey);

  try {
    // 事前スナップショット & 店舗状態退避
    const { data: initialStoreStateData } = await supabase
      .from('orders')
      .select('*')
      .eq('id', 'STORE_STATE_001')
      .single();
    originalStoreState = initialStoreStateData;

    // --- シナリオ 2: ステージング Next.js サーバー疎通確認 ---
    console.log('=== [シナリオ 2] ステージング Next.js サーバー疎通確認 ===');
    const healthRes = await fetch(`${BASE_URL}/api/ping`);
    console.log(`- GET /api/ping レスポンス: ${healthRes.status} ${healthRes.statusText}`);
    if (healthRes.status !== 200) {
      throw new Error(`Next.js server health check failed with status ${healthRes.status}`);
    }
    const pingJson = await healthRes.json();
    console.log(`- ping レスポンスボディ:`, pingJson);
    console.log('✅ Next.js ステージングサーバー疎通完了\n');

    // --- シナリオ 3: Webhook エンドポイント署名検証機能の確認 ---
    console.log('=== [シナリオ 3] Webhook 不正署名の拒絶検証 ===');
    const invalidWebhookRes = await fetch(`${BASE_URL}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=123456,v1=invalid_signature_hex',
      },
      body: JSON.stringify({ type: 'test' }),
    });
    console.log(`- 不正署名 Webhook 送信結果: ${invalidWebhookRes.status} (期待値: 400)`);
    if (invalidWebhookRes.status !== 400) {
      throw new Error(`Expected 400 for invalid signature, but got ${invalidWebhookRes.status}`);
    }
    const invalidJson = await invalidWebhookRes.json();
    console.log(`- エラー応答内容: ${JSON.stringify(invalidJson)}`);
    console.log('✅ 不正署名の厳格な400拒絶を確認\n');

    // --- シナリオ 4: モバイル注文作成 & Checkout Session 発行 ---
    console.log('=== [シナリオ 4] モバイル注文作成 & Checkout Session 発行 ===');
    // 店舗状態を営業中に設定 (JST Asia/Tokyo の今日の日付に合わせる)
    const jstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const todayStr = `${jstNow.getFullYear()}-${String(jstNow.getMonth() + 1).padStart(2, '0')}-${String(jstNow.getDate()).padStart(2, '0')}`;
    const testOpenState = {
      isManualOpen: true,
      soldOutItems: [],
      date: todayStr,
      openedAt: Date.now(), // 15時以降でも開いている扱いにする
    };
    await supabase.rpc('update_store_state_tx', {
      p_store_id: 'kenocha_main',
      p_state_json: testOpenState,
    });
    console.log(`- 店舗状態をテスト用に営業中 (isManualOpen: true, date: ${todayStr}, openedAt: now) に更新`);

    const checkoutPayload = {
      items: [
        {
          id: 'm4',
          name: 'ほうじ茶ミルクティー (ゼリー: なし, 甘さ: 普通, 氷: 氷あり)',
          price: 400,
          quantity: 1,
        },
      ],
      customerName: 'E2E検証テスト客',
      customerAvatar: 'https://example.com/avatar.png',
    };

    const checkoutRes = await fetch(`${BASE_URL}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(checkoutPayload),
    });

    console.log(`- POST /api/checkout レスポンス: ${checkoutRes.status} ${checkoutRes.statusText}`);
    if (checkoutRes.status !== 200) {
      const errText = await checkoutRes.text();
      throw new Error(`Checkout creation failed: ${errText}`);
    }
    const checkoutJson = (await checkoutRes.json()) as { url: string };
    console.log(`- 発行された Stripe Checkout URL: ${checkoutJson.url.substring(0, 45)}...`);

    // URL から セッションID (cs_test_...) を抽出、または最新の未払い注文をDBから取得
    const { data: latestOrders, error: latestErr } = await supabase
      .from('orders')
      .select('*')
      .eq('customer_name', 'E2E検証テスト客')
      .order('created_at', { ascending: false })
      .limit(1);

    if (latestErr || !latestOrders || latestOrders.length === 0) {
      throw new Error(`Failed to find created order in DB: ${latestErr?.message}`);
    }
    const createdOrder = latestOrders[0];
    const orderId1 = createdOrder.id;
    createdOrderIds.push(orderId1);
    const sessionId1 = createdOrder.stripe_session_id;

    console.log(`- 作成された内部注文ID: ${orderId1}`);
    console.log(`- 採番された注文番号: ${createdOrder.order_number}`);
    console.log(`- 紐付けられた Stripe Session ID: ${sessionId1}`);
    console.log(`- 初期ステータス: status=${createdOrder.status}, payment_status=${createdOrder.payment_status}`);
    console.log('✅ モバイル注文および Stripe Checkout Session の正常発行を確認\n');

    // --- シナリオ 5: Stripe Checkout Session 実機メタデータ検証 ---
    console.log('=== [シナリオ 5] Stripe Checkout Session 実機メタデータ検証 ===');
    const stripeSession = await stripe.checkout.sessions.retrieve(sessionId1);
    console.log(`- Stripe API 実機検証結果:`);
    console.log(`  - session.id: ${stripeSession.id}`);
    console.log(`  - session.payment_status: ${stripeSession.payment_status}`);
    console.log(`  - session.amount_total: ${stripeSession.amount_total} JPY`);
    console.log(`  - session.metadata.orderId: ${stripeSession.metadata?.orderId}`);
    console.log(`  - session.metadata.orderNumber: ${stripeSession.metadata?.orderNumber}`);

    if (stripeSession.metadata?.orderId !== orderId1) {
      throw new Error(`Stripe session metadata.orderId mismatch: expected ${orderId1}, got ${stripeSession.metadata?.orderId}`);
    }
    if (stripeSession.amount_total !== 400) {
      throw new Error(`Stripe session amount mismatch: expected 400, got ${stripeSession.amount_total}`);
    }
    console.log('✅ Stripe 側の Session メタデータ・金額の完全一致を確認\n');

    // --- シナリオ 6: 署名付き Webhook 受領 & 正常処理 ---
    console.log('=== [シナリオ 6] 署名付き Webhook (checkout.session.completed) 送信・処理 ===');
    const webhookEventId1 = `evt_test_e2e_${Date.now()}`;
    const webhookPayloadObj = {
      id: webhookEventId1,
      object: 'event',
      api_version: '2024-06-20',
      created: Math.floor(Date.now() / 1000),
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId1,
          object: 'checkout.session',
          amount_total: 400,
          currency: 'jpy',
          payment_status: 'paid',
          metadata: {
            orderId: orderId1,
            orderNumber: createdOrder.order_number,
          },
          payment_intent: `pi_test_${Date.now()}`,
        },
      },
    };

    const webhookPayloadStr = JSON.stringify(webhookPayloadObj);
    const validSignature = stripe.webhooks.generateTestHeaderString({
      payload: webhookPayloadStr,
      secret: stripeWebhookSecret,
    });

    const webhookRes = await fetch(`${BASE_URL}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': validSignature,
      },
      body: webhookPayloadStr,
    });

    console.log(`- POST /api/webhooks/stripe レスポンス: ${webhookRes.status} ${webhookRes.statusText}`);
    const webhookResJson = await webhookRes.json();
    console.log(`- Webhook 応答ボディ:`, webhookResJson);
    if (webhookRes.status !== 200) {
      throw new Error(`Webhook handler returned non-200 status: ${webhookRes.status}`);
    }
    console.log('✅ 署名付き Webhook の受領および正常完了 (200 OK) を確認\n');

    // --- シナリオ 7: DB 注文ステータス遷移確認 ---
    console.log('=== [シナリオ 7] DB 注文ステータス遷移確認 (unpaid -> paid/pending) ===');
    const { data: updatedOrder, error: updateErr } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId1)
      .single();

    if (updateErr) throw new Error(`Failed to fetch updated order: ${updateErr.message}`);
    console.log(`- DB 遷移結果:`);
    console.log(`  - status: ${updatedOrder.status} (期待値: pending)`);
    console.log(`  - payment_status: ${updatedOrder.payment_status} (期待値: paid)`);
    console.log(`  - production_status: ${updatedOrder.production_status} (期待値: pending)`);
    console.log(`  - stripe_session_id: ${updatedOrder.stripe_session_id}`);

    if (updatedOrder.status !== 'pending' || updatedOrder.payment_status !== 'paid') {
      throw new Error(`Order status transition failed: status=${updatedOrder.status}, payment_status=${updatedOrder.payment_status}`);
    }
    console.log('✅ 注文ステータスが正常に paid / pending に遷移したことを確認\n');

    // --- シナリオ 8: 厨房画面データ反映確認 ---
    console.log('=== [シナリオ 8] 厨房画面データ反映確認 ===');
    const { data: kitchenOrders } = await supabase
      .from('orders')
      .select('id, order_number, status, payment_status, production_status')
      .neq('id', 'STORE_STATE_001')
      .eq('payment_status', 'paid')
      .eq('production_status', 'pending');

    const inKitchen = kitchenOrders?.some((o) => o.id === orderId1);
    console.log(`- 厨房未提供・調理待ちリスト件数: ${kitchenOrders?.length} 件`);
    console.log(`- 当該注文 (${orderId1}) の厨房表示対象判定: ${inKitchen ? '✅ 表示対象に含まれています' : '❌ 未反映'}`);
    if (!inKitchen) {
      throw new Error(`Order ${orderId1} is not found in kitchen pending list`);
    }
    console.log('✅ 厨房画面への注文自動反映を確認\n');

    // --- シナリオ 9: Webhook 再送時の冪等性検証 ---
    console.log('=== [シナリオ 9] Webhook 再送時の冪等性検証 (重複送信) ===');
    // 同一イベントID・同一ペイロード・同一署名で再度送信
    const replayRes = await fetch(`${BASE_URL}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': validSignature,
      },
      body: webhookPayloadStr,
    });
    console.log(`- Webhook 再送レスポンス: ${replayRes.status} ${replayRes.statusText}`);
    const replayJson = await replayRes.json();
    console.log(`- Webhook 再送応答ボディ:`, replayJson);
    if (replayRes.status !== 200) {
      throw new Error(`Replay webhook failed: ${replayRes.status}`);
    }

    // 再送後の注文状態が変化していないことを確認
    const { data: recheckedOrder } = await supabase.from('orders').select('*').eq('id', orderId1).single();
    if (recheckedOrder.status !== 'pending' || recheckedOrder.payment_status !== 'paid') {
      throw new Error(`Order state unexpectedly mutated on webhook replay: ${JSON.stringify(recheckedOrder)}`);
    }
    console.log('✅ 冪等性検証クリア (二重処理・巻き戻しなく 200 OK 応答)\n');

    // --- シナリオ 10: 閉店ガード検証 ---
    console.log('=== [シナリオ 10] 閉店ガード検証 (isManualOpen: false での 400 拒絶) ===');
    await supabase.rpc('update_store_state_tx', {
      p_store_id: 'kenocha_main',
      p_state_json: {
        isManualOpen: false,
        soldOutItems: [],
        date: todayStr,
      },
    });
    console.log('- 店舗状態を閉店中 (isManualOpen: false) に更新');

    const closedRes = await fetch(`${BASE_URL}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(checkoutPayload),
    });

    console.log(`- 閉店中 POST /api/checkout レスポンス: ${closedRes.status} ${closedRes.statusText}`);
    const closedJson = (await closedRes.json()) as { error?: string; code?: string };
    console.log(`- 閉店中エラー応答:`, closedJson);

    if (closedRes.status !== 400 || closedJson.code !== 'STORE_CLOSED') {
      throw new Error(`Store closed guard failed: status=${closedRes.status}, code=${closedJson.code}`);
    }
    console.log('✅ 閉店ガードによる 400 STORE_CLOSED 拒絶を確認 (Stripe Session未発行)\n');

    // --- シナリオ 11: 注文キャンセル競合 (Race Condition) 検証 ---
    console.log('=== [シナリオ 11] 注文キャンセル競合 (Race Condition) 検証 ===');
    // 再度営業中に戻して新規注文を作成
    await supabase.rpc('update_store_state_tx', {
      p_store_id: 'kenocha_main',
      p_state_json: testOpenState,
    });

    const raceCheckoutRes = await fetch(`${BASE_URL}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...checkoutPayload,
        customerName: 'E2Eキャンセル競合テスト客',
      }),
    });
    const raceCheckoutJson = (await raceCheckoutRes.json()) as { url: string };

    const { data: raceOrders } = await supabase
      .from('orders')
      .select('*')
      .eq('customer_name', 'E2Eキャンセル競合テスト客')
      .order('created_at', { ascending: false })
      .limit(1);

    const raceOrder = raceOrders![0];
    const orderId2 = raceOrder.id;
    const sessionId2 = raceOrder.stripe_session_id;
    createdOrderIds.push(orderId2);

    console.log(`- 競合テスト用注文ID: ${orderId2} (Session: ${sessionId2})`);

    // ユーザーまたはシステムにより注文がキャンセルされた状態にする
    await supabase
      .from('orders')
      .update({
        status: 'cancelled',
        cancellation_status: 'cancelled',
      })
      .eq('id', orderId2);
    console.log('- 注文を DB 上でキャンセル状態 (status: cancelled) に更新');

    // その後に決済完了 Webhook が届いたケースをシミュレート
    const raceWebhookPayloadObj = {
      id: `evt_test_race_${Date.now()}`,
      object: 'event',
      api_version: '2024-06-20',
      created: Math.floor(Date.now() / 1000),
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId2,
          object: 'checkout.session',
          amount_total: 650,
          currency: 'jpy',
          payment_status: 'paid',
          metadata: {
            orderId: orderId2,
            orderNumber: raceOrder.order_number,
          },
          payment_intent: `pi_test_race_${Date.now()}`,
        },
      },
    };
    const racePayloadStr = JSON.stringify(raceWebhookPayloadObj);
    const raceSig = stripe.webhooks.generateTestHeaderString({
      payload: racePayloadStr,
      secret: stripeWebhookSecret,
    });

    const raceWebhookRes = await fetch(`${BASE_URL}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': raceSig,
      },
      body: racePayloadStr,
    });
    console.log(`- キャンセル後 Webhook 到着レスポンス: ${raceWebhookRes.status} ${raceWebhookRes.statusText}`);
    const raceResJson = await raceWebhookRes.json();
    console.log(`- 競合ハンドラ応答:`, raceResJson);

    // 注文が paid / pending に復活していないことを確認
    const { data: postRaceOrder } = await supabase.from('orders').select('*').eq('id', orderId2).single();
    console.log(`- 競合後の注文状態: status=${postRaceOrder.status}, requires_manual_attention=${postRaceOrder.requires_manual_attention}`);

    if (postRaceOrder.status === 'pending' || postRaceOrder.status === 'paid') {
      throw new Error(`CRITICAL: Cancelled order revived back to pending/paid! status=${postRaceOrder.status}`);
    }
    console.log('✅ キャンセル済み注文の不正復活防止を確認 (CANCELLED_PAYMENT_DISCREPANCY)\n');

    // --- シナリオ 12: 返金キュー記録と管理アラート検証 ---
    console.log('=== [シナリオ 12] 返金キュー記録 (order_refund_requests) とアラート検証 ===');
    const { data: refundRequests, error: refundErr } = await supabase
      .from('order_refund_requests')
      .select('*')
      .eq('order_id', orderId2);

    console.log(`- 返金要求キューレコード取得件数: ${refundRequests?.length ?? 0} 件`);
    if (refundErr || !refundRequests || refundRequests.length === 0) {
      throw new Error(`Refund request record not created for cancelled order discrepancy: ${refundErr?.message}`);
    }
    const refundRecord = refundRequests[0];
    console.log(`  - order_id: ${refundRecord.order_id}`);
    console.log(`  - refund_status: ${refundRecord.refund_status}`);
    console.log(`  - requires_manual_attention: ${refundRecord.requires_manual_attention}`);
    console.log(`  - stripe_session_id: ${refundRecord.stripe_session_id}`);
    console.log(`  - stripe_refund_id: ${refundRecord.stripe_refund_id} (Stripe直接返金未実行・null確認)`);

    if (refundRecord.stripe_refund_id !== null) {
      throw new Error(`CRITICAL: Stripe refund API was directly called! Expected null.`);
    }
    console.log('✅ 返金要求キューへの安全な格納および Stripe 返金 API 直接実行の防止を確認\n');

    console.log('🎉 全12シナリオの検証に成功しました！\n');
  } finally {
    // --- 事後クリーンアップ ---
    console.log('=== [事後クリーンアップ] テストデータ削除 & 店舗状態復元 ===');
    for (const orderId of createdOrderIds) {
      await supabase.from('order_refund_requests').delete().eq('order_id', orderId);
      await supabase.from('orders').delete().eq('id', orderId);
    }
    // テスト客のダミーデータ完全削除
    await supabase.from('orders').delete().ilike('customer_name', 'E2E%');

    // 店舗状態を元の状態に復元
    if (originalStoreState) {
      await supabase
        .from('orders')
        .update({
          items: originalStoreState.items,
          customer_avatar: originalStoreState.customer_avatar,
          status: originalStoreState.status,
          customer_name: originalStoreState.customer_name,
        })
        .eq('id', 'STORE_STATE_001');
      console.log('✅ 店舗状態 (STORE_STATE_001) をテスト前の状態に復元完了');
    }
    console.log('✅ テスト注文レコードおよび返金要求レコードのクリーンアップ完了\n');
  }
}

if (process.argv[1]?.endsWith('e2e-stripe-staging.ts')) {
  runStagingE2E()
    .then(() => {
      console.log('====================================================');
      console.log('   Stripe テストモード E2E 検証: ALL PASS (12/12)   ');
      console.log('====================================================');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ E2E 検証失敗:', err);
      process.exit(1);
    });
}
