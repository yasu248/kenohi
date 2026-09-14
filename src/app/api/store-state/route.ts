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
    await setStoreState(body);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
