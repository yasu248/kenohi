import { type NextRequest } from 'next/server';
import {
  authenticateStaffLogin,
  getClientIdentifier,
  verifyCsrfProtection,
} from '@/lib/auth';
import { supabaseAuthPersistenceStore } from '@/lib/store';

export async function POST(request: NextRequest) {
  if (!verifyCsrfProtection(request)) {
    return Response.json(
      { error: '不正なリクエスト元です (CSRF check failed)' },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const password = typeof body?.password === 'string' ? body.password : '';
    const identifier = getClientIdentifier(request);

    const result = await authenticateStaffLogin(
      supabaseAuthPersistenceStore,
      password,
      identifier
    );

    if (!result.ok) {
      const headers: Record<string, string> = {};
      if (result.retryAfterSeconds) {
        headers['Retry-After'] = String(result.retryAfterSeconds);
      }
      return Response.json(
        { error: result.error },
        { status: result.status, headers }
      );
    }

    return Response.json(
      {
        authenticated: true,
        role: result.role,
        expiresAt: result.expiresAt,
      },
      {
        status: 200,
        headers: {
          'Set-Cookie': result.cookieHeader,
        },
      }
    );
  } catch (err) {
    console.error('Staff login error:', err);
    return Response.json(
      { error: 'ログイン処理中にエラーが発生しました' },
      { status: 500 }
    );
  }
}
