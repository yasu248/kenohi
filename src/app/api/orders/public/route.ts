import { getPublicActiveOrders } from '../../../../lib/store';

export const dynamic = 'force-dynamic';

/**
 * GET /api/orders/public
 * 顧客向け注文画面 (`/`) および店頭呼び出しモニター (`/display`) 専用の公開API。
 * 個人情報（顧客名・アイコン・注文金額・明細）を一切返さず、
 * 呼出番号 (`orderNumber`) と進行ステータス (`pending` | `preparing` | `completed`) のみを返します。
 */
export async function GET() {
  try {
    const publicOrders = await getPublicActiveOrders();
    return Response.json(publicOrders);
  } catch (err) {
    console.error('Failed to fetch public orders:', err);
    return Response.json(
      { error: '呼出状況の取得に失敗しました' },
      { status: 500 }
    );
  }
}
