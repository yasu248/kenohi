import { type NextRequest } from 'next/server';
import { authorizeStaffRequest } from '../../../../lib/auth';
import { supabaseAuthPersistenceStore, getUnresolvedRefundRequests } from '../../../../lib/store';

export async function GET(request: NextRequest) {
  // スタッフまたは管理者セッションを要求
  const auth = await authorizeStaffRequest(request, supabaseAuthPersistenceStore, {
    enforceCsrf: false, // GET リクエスト
  });
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const requests = await getUnresolvedRefundRequests();
    return Response.json({
      success: true,
      refundRequests: requests,
    });
  } catch (err: unknown) {
    console.error('Failed to get unresolved refund requests:', err);
    return Response.json(
      { error: '返金案件一覧の取得に失敗しました' },
      { status: 500 }
    );
  }
}

export const dynamic = 'force-dynamic';
