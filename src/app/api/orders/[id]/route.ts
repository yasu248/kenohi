import { type NextRequest } from 'next/server';
import {
  updateOrderStatus,
  clearOrders,
  supabaseAuthPersistenceStore,
} from '../../../../lib/store';
import { authorizeStaffRequest } from '../../../../lib/auth';
import type { OrderStatusAction } from '../../../../lib/orderStatus';

// PATCH /api/orders/[id] — ステータスを更新する（キッチン画面専用・要スタッフ認証）
export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<'/api/orders/[id]'>
) {
  const auth = await authorizeStaffRequest(request, supabaseAuthPersistenceStore, {
    enforceCsrf: true,
  });
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const { id } = await ctx.params;
  const body = await request.json();
  const { status, action } = body as {
    status: 'pending' | 'preparing' | 'completed' | 'cancelled';
    action?: OrderStatusAction;
  };

  const validStatuses = ['pending', 'preparing', 'completed', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return Response.json(
      { error: `無効なステータスです: ${status}` },
      { status: 400 }
    );
  }

  const validActions: OrderStatusAction[] = [
    'start_preparing',
    'mark_ready',
    'revert_to_pending',
    'revert_to_preparing',
    'hand_over',
    'cancel_order',
  ];
  if (action && !validActions.includes(action)) {
    return Response.json(
      { error: `無効なアクションです: ${action}` },
      { status: 400 }
    );
  }

  try {
    const updated = await updateOrderStatus(id, status, action);
    if (!updated) {
      return Response.json({ error: `注文が見つかりません: ${id}` }, { status: 404 });
    }
    return Response.json(updated);
  } catch (err) {
    console.error(err);
    return Response.json({ error: 'ステータス更新に失敗しました' }, { status: 500 });
  }
}

// DELETE /api/orders/all — 全注文クリア（管理者 admin ロール限定）
export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<'/api/orders/[id]'>
) {
  const auth = await authorizeStaffRequest(request, supabaseAuthPersistenceStore, {
    requireRole: 'admin',
    enforceCsrf: true,
  });
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

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
