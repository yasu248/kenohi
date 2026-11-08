import { type NextRequest } from 'next/server';
import { getOrders, addOrder, supabaseAuthPersistenceStore } from '../../../lib/store';
import { authorizeStaffRequest } from '../../../lib/auth';

// GET /api/orders — 全注文詳細（顧客名・明細含む）を返す（キッチン画面専用・要スタッフ認証）
export async function GET(request: NextRequest) {
  const auth = await authorizeStaffRequest(request, supabaseAuthPersistenceStore, {
    enforceCsrf: false,
  });
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const orders = await getOrders();
    return Response.json(orders);
  } catch (err) {
    console.error(err);
    return Response.json({ error: '注文の取得に失敗しました' }, { status: 500 });
  }
}

// POST /api/orders — スタッフ管理用注文登録（未認証の外部不正呼び出しをブロック）
// ※一般顧客のモバイル注文は `/api/checkout` を使用します。
export async function POST(request: NextRequest) {
  const auth = await authorizeStaffRequest(request, supabaseAuthPersistenceStore, {
    enforceCsrf: true,
  });
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

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
