import { type NextRequest } from 'next/server';
import { updateOrderStatus, clearOrders } from '../../../../lib/store';

// PATCH /api/orders/[id] — ステータスを更新する（キッチン画面が使う）
export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<'/api/orders/[id]'>
) {
  const { id } = await ctx.params;
  const body = await request.json();
  const { status } = body;

  const validStatuses = ['pending', 'preparing', 'completed', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return Response.json(
      { error: `無効なステータスです: ${status}` },
      { status: 400 }
    );
  }

  try {
    const updated = await updateOrderStatus(id, status);
    if (!updated) {
      return Response.json({ error: `注文が見つかりません: ${id}` }, { status: 404 });
    }
    return Response.json(updated);
  } catch (err) {
    console.error(err);
    return Response.json({ error: 'ステータス更新に失敗しました' }, { status: 500 });
  }
}

// DELETE /api/orders/all — 全注文クリア
export async function DELETE(
  _request: NextRequest,
  ctx: RouteContext<'/api/orders/[id]'>
) {
  const { id } = await ctx.params;
  if (id !== 'all') {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    await clearOrders();
    return Response.json({ message: '全注文をクリアしました' });
  } catch (err) {
    console.error(err);
    return Response.json({ error: 'クリアに失敗しました' }, { status: 500 });
  }
}
