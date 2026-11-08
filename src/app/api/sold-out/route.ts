import { NextRequest, NextResponse } from 'next/server';
import {
  getStoreState,
  setStoreState,
  supabaseAuthPersistenceStore,
} from '../../../lib/store';
import { authorizeStaffRequest } from '../../../lib/auth';

/** 現在の欠品商品IDリストを取得（公開API） */
export async function GET() {
  try {
    const state = await getStoreState();
    const soldOutItems = state?.soldOutItems ?? [];
    return NextResponse.json({ soldOutItems });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** 欠品商品IDリストを更新（全件置換・要スタッフ認証） */
export async function PATCH(req: NextRequest) {
  const auth = await authorizeStaffRequest(req, supabaseAuthPersistenceStore, {
    enforceCsrf: true,
  });
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

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
      openHistory: current?.openHistory ?? [],
      currentOrderDate: current?.currentOrderDate,
      lastOrderNumber: current?.lastOrderNumber,
    });

    return NextResponse.json({ success: true, soldOutItems });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
