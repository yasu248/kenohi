import { type NextRequest } from 'next/server';
import { getOrders, addOrder } from '../../../lib/store';

// GET /api/orders — 全注文を返す（キッチン画面がポーリングで使う）
export async function GET() {
  try {
    const orders = await getOrders();
    return Response.json(orders);
  } catch (err) {
    console.error(err);
    return Response.json({ error: '注文の取得に失敗しました' }, { status: 500 });
  }
}

// POST /api/orders — 新規注文を登録する（お客さん画面が使う）
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { items, customerName, customerAvatar } = body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return Response.json({ error: 'items が空です' }, { status: 400 });
  }
  if (!customerName) {
    return Response.json({ error: 'customerName が必要です' }, { status: 400 });
  }

  try {
    const order = await addOrder(items, customerName, customerAvatar);
    return Response.json(order, { status: 201 });
  } catch (err) {
    console.error(err);
    return Response.json({ error: '注文の登録に失敗しました' }, { status: 500 });
  }
}
