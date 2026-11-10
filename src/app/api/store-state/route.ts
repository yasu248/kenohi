import { NextRequest, NextResponse } from 'next/server';
import {
  getStoreState,
  setStoreState,
  supabaseAuthPersistenceStore,
} from '../../../lib/store';
import { authorizeStaffRequest } from '../../../lib/auth';

export async function GET(req: NextRequest) {
  try {
    const state = await getStoreState();
    if (!state) {
      return NextResponse.json({ isManualOpen: false, date: '', soldOutItems: [] });
    }

    // スタッフ認証（Cookieセッション）の有無を判定
    const auth = await authorizeStaffRequest(req, supabaseAuthPersistenceStore, {
      enforceCsrf: false,
    });

    if (auth.authorized) {
      // スタッフ・管理者は全管理情報（openHistory, lastOrderNumber 等）を取得可能
      return NextResponse.json(state);
    }

    // 未認証（一般顧客画面等）は公開情報のみに最小化し、内部管理情報を返さない
    const publicState = {
      isManualOpen: Boolean(state.isManualOpen),
      date: state.date || '',
      openedAt: state.openedAt,
      soldOutItems: state.soldOutItems ?? [],
    };

    return NextResponse.json(publicState);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await authorizeStaffRequest(req, supabaseAuthPersistenceStore, {
    enforceCsrf: true,
  });
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

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
      currentOrderDate: current?.currentOrderDate,
      lastOrderNumber: current?.lastOrderNumber,
    });

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
