import { NextRequest, NextResponse } from 'next/server';
import { getStoreState, setStoreState } from '../../../lib/store';

/** 現在の欠品商品IDリストを取得 */
export async function GET() {
  try {
    const state = await getStoreState();
    const soldOutItems = state?.soldOutItems ?? [];
    return NextResponse.json({ soldOutItems });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** 欠品商品IDリストを更新（全件置換） */
export async function PATCH(req: NextRequest) {
  try {
    const { soldOutItems } = await req.json();
    if (!Array.isArray(soldOutItems)) {
      return NextResponse.json({ error: 'soldOutItems must be an array' }, { status: 400 });
    }

    const current = await getStoreState();
    await setStoreState({
      isManualOpen: current?.isManualOpen ?? false,
      date: current?.date ?? '',
      openedAt: current?.openedAt,
      soldOutItems,
    });

    return NextResponse.json({ success: true, soldOutItems });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
