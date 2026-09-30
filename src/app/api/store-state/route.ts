import { NextRequest, NextResponse } from 'next/server';
import { getStoreState, setStoreState } from '../../../lib/store';

export async function GET() {
  try {
    const state = await getStoreState();
    return NextResponse.json(state || { isManualOpen: false, date: '' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const current = await getStoreState();

    // 開店操作（isManualOpen: true かつ openedAt が新たに設定される）のとき
    // → openHistory に今日の記録を追記する
    let openHistory = current?.openHistory ?? [];

    if (body.isManualOpen && body.openedAt) {
      // 同じ日付の既存エントリは上書き（同日に何度もON/OFFした場合の重複防止）
      openHistory = openHistory.filter((h) => h.date !== body.date);
      openHistory.push({
        date: body.date,
        openedAt: body.openedAt,
        soldOutItems: body.soldOutItems ?? current?.soldOutItems ?? [],
      });
      // 最新100件だけ保持
      if (openHistory.length > 100) {
        openHistory = openHistory.slice(openHistory.length - 100);
      }
    }

    await setStoreState({
      isManualOpen: body.isManualOpen,
      date: body.date ?? current?.date ?? '',
      openedAt: body.openedAt ?? current?.openedAt,
      soldOutItems: body.soldOutItems ?? current?.soldOutItems ?? [],
      openHistory,
    });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
