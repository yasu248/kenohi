import { NextRequest, NextResponse } from 'next/server';
import { authorizeStaffRequest } from '../../../../lib/auth';
import { supabaseAuthPersistenceStore, toOrder, supabase } from '../../../../lib/store';
import { shouldIncludeOrderInSalesHistory } from '../../../../lib/orderStatus';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await authorizeStaffRequest(request, supabaseAuthPersistenceStore, {
    enforceCsrf: false,
  });
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    // 過去7日分（今日を含む）の開始時刻をJST基準で算出（それ以上前は除外）
    const nowJST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const sevenDaysAgoJST = new Date(nowJST);
    sevenDaysAgoJST.setDate(nowJST.getDate() - 6);
    const year = sevenDaysAgoJST.getFullYear();
    const month = String(sevenDaysAgoJST.getMonth() + 1).padStart(2, '0');
    const day = String(sevenDaysAgoJST.getDate()).padStart(2, '0');
    const startDateISO = new Date(`${year}-${month}-${day}T00:00:00+09:00`).toISOString();

    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .neq('id', 'STORE_STATE_001')
      .neq('status', 'unpaid') // 未決済は除外
      .or('payment_status.is.null,payment_status.in.(paid,partially_refunded,refunded)') // 決済前に中断された注文 (payment_status=unpaid/failed) を除外しつつ過去データ (NULL) を保持
      .gte('created_at', startDateISO)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to fetch history orders:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const orders = (data ?? [])
      .map((row) => toOrder(row))
      .filter((order) => shouldIncludeOrderInSalesHistory(order));

    return NextResponse.json(orders);
  } catch (error) {
    console.error('Unexpected error fetching history:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
