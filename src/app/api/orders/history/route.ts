import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!
);

export const dynamic = 'force-dynamic';

export async function GET() {
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
      .gte('created_at', startDateISO)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to fetch history orders:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const orders = (data ?? []).map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      customerName: row.customer_name,
      customerAvatar: row.customer_avatar,
      items: row.items,
      totalPrice: row.total_price,
      status: row.status,
      createdAt: row.created_at,
    }));

    return NextResponse.json(orders);
  } catch (error) {
    console.error('Unexpected error fetching history:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
