import { type NextRequest } from 'next/server';
import {
  buildClearSessionCookieHeader,
  extractSessionCookie,
  getAuthEnvConfig,
  verifyCsrfProtection,
  verifySessionToken,
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
    const token = extractSessionCookie(request);
    const { sessionSecret } = getAuthEnvConfig();
    const payload = verifySessionToken(token, sessionSecret);

    if (payload) {
      // サーバー側の永続セッションを無効化 (revoke)
      await supabaseAuthPersistenceStore.revokeSession(payload.sid);
    }

    return Response.json(
      { authenticated: false },
      {
        status: 200,
        headers: {
          'Set-Cookie': buildClearSessionCookieHeader(),
        },
      }
    );
  } catch (err) {
    console.error('Staff logout error:', err);
    return Response.json(
      { authenticated: false },
      {
        status: 200,
        headers: {
          'Set-Cookie': buildClearSessionCookieHeader(),
        },
      }
    );
  }
}
