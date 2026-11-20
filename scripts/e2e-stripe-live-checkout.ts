/**
 * Stripe 実決済 E2E 準備・監視スクリプト (scripts/e2e-stripe-live-checkout.ts)
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

export async function createLiveCheckoutForTest() {
  const env = loadEnv();
  const supabase = createClient(normalizeSupabaseUrl(env.SUPABASE_URL!), env.SUPABASE_SECRET_KEY!);
  const stripe = new Stripe(env.STRIPE_SECRET_KEY!);

  // 店舗営業中化
  const jstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const todayStr = `${jstNow.getFullYear()}-${String(jstNow.getMonth() + 1).padStart(2, '0')}-${String(jstNow.getDate()).padStart(2, '0')}`;
  await supabase.rpc('update_store_state_tx', {
    p_store_id: 'kenocha_main',
    p_state_json: {
      isManualOpen: true,
      soldOutItems: [],
      date: todayStr,
      openedAt: Date.now(),
    },
  });

  // 注文作成
  const checkoutRes = await fetch(`${BASE_URL}/api/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [{ id: 'm4', name: 'ほうじ茶ミルクティー (ゼリー: なし, 甘さ: 普通, 氷: 氷あり)', price: 400, quantity: 1 }],
      customerName: '実カード決済検証客',
    }),
  });

  if (checkoutRes.status !== 200) {
    throw new Error(`Checkout creation failed: ${await checkoutRes.text()}`);
  }

  const { url } = (await checkoutRes.json()) as { url: string };

  const { data: latestOrders } = await supabase
    .from('orders')
    .select('*')
    .eq('customer_name', '実カード決済検証客')
    .order('created_at', { ascending: false })
    .limit(1);

  const order = latestOrders![0];
  const orderId = order.id;
  const sessionId = order.stripe_session_id;

  console.log('CHECKOUT_URL=' + url);
  console.log('ORDER_ID=' + orderId);
  console.log('SESSION_ID=' + sessionId);
  console.log('ORDER_NUMBER=' + order.order_number);

  return { url, orderId, sessionId, orderNumber: order.order_number };
}

if (process.argv[1]?.endsWith('e2e-stripe-live-checkout.ts')) {
  createLiveCheckoutForTest().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
