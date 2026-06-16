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
  status: 'pending' | 'preparing' | 'completed' | 'cancelled';
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

function generateOrderNumber(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// ─── 公開関数 ────────────────────────────────────────────────────────────────

/** 全注文を取得する（キッチン画面のポーリングで使用） */
export async function getOrders(): Promise<Order[]> {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .not('status', 'eq', 'cancelled')   // キャンセル済みは除外
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

  const row = {
    id: Math.random().toString(36).substring(2, 11),
    items,
    total_price: totalPrice,
    customer_name: customerName,
    customer_avatar: customerAvatar ?? null,
    status: 'pending',
    order_number: generateOrderNumber(),
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

/** 全注文を削除する（キッチン画面の「全注文クリア」） */
export async function clearOrders(): Promise<void> {
  const { error } = await supabase
    .from('orders')
    .delete()
    .not('id', 'is', null); // 全行を対象

  if (error) throw new Error(`clearOrders: ${error.message}`);
}
