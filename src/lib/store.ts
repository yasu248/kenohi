/**
 * Supabase を使ったサーバーサイドのデータ層
 *
 * このファイルはサーバーサイド（Next.js API Route）からのみ呼ばれます。
 * SUPABASE_SECRET_KEY は .env.local に格納され、ブラウザには絶対に渡しません。
 */

import { createClient } from '@supabase/supabase-js';

// サーバーサイド専用クライアント（Secret Key 使用）
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!
);

// ─── 型定義 ──────────────────────────────────────────────────────────────────

export interface OrderItem {
  name: string;
  price: number;
  quantity: number;
}

export interface Order {
  id: string;
  items: OrderItem[];
  totalPrice: number;
  customerName: string;
  customerAvatar?: string;
  status: 'unpaid' | 'pending' | 'preparing' | 'completed' | 'cancelled';
  createdAt: string;
  orderNumber: string;
}

// DB（snake_case）→ アプリ（camelCase）変換
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toOrder(row: any): Order {
  return {
    id: row.id,
    items: row.items,
    totalPrice: row.total_price,
    customerName: row.customer_name,
    customerAvatar: row.customer_avatar ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    orderNumber: row.order_number,
  };
}

function getJSTDateString(date: Date = new Date()): string {
  const jstString = date.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' });
  const jstDate = new Date(jstString);
  const year = jstDate.getFullYear();
  const month = String(jstDate.getMonth() + 1).padStart(2, '0');
  const day = String(jstDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getRandomStartOrderNumber(): number {
  const min = 3000;
  const max = 5000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function generateNextOrderNumber(): Promise<string> {
  const todayStr = getJSTDateString();
  const startOfDay = new Date(`${todayStr}T00:00:00+09:00`).toISOString();
  const endOfDay = new Date(`${todayStr}T23:59:59.999+09:00`).toISOString();

  // 1. 店舗の最新保存状態を取得
  const state = await getStoreState();

  // 2. 本日の既存注文を取得
  const { data: todayOrders } = await supabase
    .from('orders')
    .select('order_number, created_at')
    .neq('id', STORE_STATE_ID)
    .gte('created_at', startOfDay)
    .lte('created_at', endOfDay)
    .order('created_at', { ascending: false });

  let nextOrderNumber: number;

  // 本日すでに注文が発行されている場合は前回の番号から+1（昇順）
  if (
    state &&
    state.currentOrderDate === todayStr &&
    typeof state.lastOrderNumber === 'number' &&
    state.lastOrderNumber >= 3000
  ) {
    let maxNum = state.lastOrderNumber;
    if (todayOrders && todayOrders.length > 0) {
      for (const order of todayOrders) {
        const num = parseInt(order.order_number, 10);
        if (!isNaN(num) && num >= maxNum && num <= maxNum + 20) {
          maxNum = Math.max(maxNum, num);
        }
      }
    }
    nextOrderNumber = maxNum + 1;
  } else {
    // その日の最初の注文番号: 3000〜5000 のランダムな整数
    nextOrderNumber = getRandomStartOrderNumber();
  }

  // StoreState を更新して次回以降に備える
  const updatedState: StoreState = {
    isManualOpen: state?.isManualOpen ?? false,
    date: state?.date ?? todayStr,
    openedAt: state?.openedAt,
    soldOutItems: state?.soldOutItems ?? [],
    openHistory: state?.openHistory ?? [],
    currentOrderDate: todayStr,
    lastOrderNumber: nextOrderNumber,
  };

  try {
    await setStoreState(updatedState);
  } catch (err) {
    console.error('Failed to update StoreState with new order number:', err);
  }

  return nextOrderNumber.toString();
}

// ─── 公開関数 ────────────────────────────────────────────────────────────────

/** 全注文を取得する（キッチン画面のポーリングで使用） */
export async function getOrders(): Promise<Order[]> {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .not('status', 'eq', 'cancelled')   // キャンセル済みは除外
    .not('status', 'eq', 'unpaid')      // 未決済は除外
    .order('created_at', { ascending: true });

  if (error) throw new Error(`getOrders: ${error.message}`);
  return (data ?? []).map(toOrder);
}

/** 新規注文を登録する（お客さんが注文確定時に使用） */
export async function addOrder(
  items: OrderItem[],
  customerName: string,
  customerAvatar?: string
): Promise<Order> {
  const totalPrice = items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0
  );

  const orderNumber = await generateNextOrderNumber();

  const row = {
    id: Math.random().toString(36).substring(2, 11),
    items,
    total_price: totalPrice,
    customer_name: customerName,
    customer_avatar: customerAvatar ?? null,
    status: 'unpaid',
    order_number: orderNumber,
  };

  const { data, error } = await supabase
    .from('orders')
    .insert(row)
    .select()
    .single();

  if (error) throw new Error(`addOrder: ${error.message}`);
  return toOrder(data);
}

/** 注文のステータスを更新する（キッチン画面のボタン操作） */
export async function updateOrderStatus(
  orderId: string,
  status: Order['status']
): Promise<Order | null> {
  const { data, error } = await supabase
    .from('orders')
    .update({ status })
    .eq('id', orderId)
    .select()
    .single();

  if (error) {
    // 見つからない場合は null を返す
    if (error.code === 'PGRST116') return null;
    throw new Error(`updateOrderStatus: ${error.message}`);
  }
  return toOrder(data);
}

export async function clearOrders(): Promise<void> {
  const { error } = await supabase
    .from('orders')
    .delete()
    .neq('id', STORE_STATE_ID); // STORE_STATE_001 を保持

  if (error) throw new Error(`clearOrders: ${error.message}`);

  const state = await getStoreState();
  if (state) {
    delete state.lastOrderNumber;
    delete state.currentOrderDate;
    await setStoreState(state);
  }
}

// ─── 店舗状態管理 (ハック: ordersテーブルの特定レコードに状態を保存) ──────────

const STORE_STATE_ID = 'STORE_STATE_001';

export interface StoreState {
  isManualOpen: boolean;
  date: string;
  openedAt?: number;
  soldOutItems?: string[];
  openHistory?: Array<{
    date: string;       // 'YYYY-MM-DD'
    openedAt: number;   // Unix ms
    soldOutItems?: string[];
  }>;
  currentOrderDate?: string;
  lastOrderNumber?: number;
}

export async function getStoreState(): Promise<StoreState | null> {
  const { data, error } = await supabase
    .from('orders')
    .select('customer_avatar')
    .eq('id', STORE_STATE_ID)
    .single();

  if (error || !data || !data.customer_avatar) {
    return null;
  }
  try {
    return JSON.parse(data.customer_avatar);
  } catch {
    return null;
  }
}

export async function setStoreState(state: StoreState): Promise<void> {
  const row = {
    id: STORE_STATE_ID,
    items: [],
    total_price: 0,
    customer_name: 'STORE_STATE',
    customer_avatar: JSON.stringify(state),
    status: 'cancelled', // 通常の注文に混ざらないようにcancelledにする
    order_number: '0000',
  };

  const { error } = await supabase
    .from('orders')
    .upsert(row);

  if (error) throw new Error(`setStoreState: ${error.message}`);
}
