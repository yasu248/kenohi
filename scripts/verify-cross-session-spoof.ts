/**
 * 実機検証: 別注文のセッションID流用 (Cross-Session スプーフィング) 遮断テスト
 * (scripts/verify-cross-session-spoof.ts)
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { normalizeSupabaseUrl } from '../src/lib/store.ts';

const STAGING_ENV_FILE = resolve(process.cwd(), '.env.staging.local');
const BASE_URL = 'http://localhost:3000';

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

export async function verifyCrossSessionSpoof() {
  console.log('=== [Cross-Session スプーフィング遮断 実機検証] ===\n');

  const env = loadEnv();
  const supabase = createClient(normalizeSupabaseUrl(env.SUPABASE_URL!), env.SUPABASE_SECRET_KEY!);
  const stripe = new Stripe(env.STRIPE_SECRET_KEY!);

  // 注文を作成 (Session A が紐づく)
  const checkoutRes = await fetch(`${BASE_URL}/api/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [{ id: 'm4', name: 'ほうじ茶ミルクティー (ゼリー: なし, 甘さ: 普通, 氷: 氷あり)', price: 400, quantity: 1 }],
      customerName: 'セッション突合検証客',
    }),
  });
  if (checkoutRes.status !== 200) throw new Error('Checkout failed');

  const { data: latestOrders } = await supabase
    .from('orders')
    .select('*')
    .eq('customer_name', 'セッション突合検証客')
    .order('created_at', { ascending: false })
    .limit(1);

  const order = latestOrders![0];
  const orderId = order.id;
  const legitimateSessionId = order.stripe_session_id;

  console.log(`- 注文ID: ${orderId}`);
  console.log(`- 注文に記録された正規セッション: ${legitimateSessionId}`);

  // 攻撃シナリオ: 別のダミーセッションID (cs_test_attacker_stolen_12345) を渡して POST /api/orders/confirm を実行
  console.log('\n- 別のセッションIDで決済確定を試みる攻撃を実行...');
  const spoofConfirmRes = await fetch(`${BASE_URL}/api/orders/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'cs_test_attacker_stolen_12345' }),
  });

  console.log(`- /api/orders/confirm レスポンス: status=${spoofConfirmRes.status}`);
  const confirmJson = await spoofConfirmRes.json();
  console.log(`- エラー応答:`, confirmJson);

  // DB 注文ステータスを確認
  const { data: postOrder } = await supabase.from('orders').select('*').eq('id', orderId).single();
  console.log(`- DB 注文ステータス: status=${postOrder.status}, payment_status=${postOrder.payment_status}`);

  // クリーンアップ
  await supabase.from('orders').delete().eq('id', orderId);

  if (postOrder.status === 'unpaid' && postOrder.payment_status === 'unpaid') {
    console.log('\n✅ 安全: セッションID不一致によるスプーフィング攻撃は完全に遮断されました！');
  } else {
    throw new Error('CRITICAL: Cross-session spoofing succeeded!');
  }
}

if (process.argv[1]?.endsWith('verify-cross-session-spoof.ts')) {
  verifyCrossSessionSpoof().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
