import { type NextRequest } from 'next/server';
import { authorizeStaffRequest } from '@/lib/auth';
import { supabaseAuthPersistenceStore } from '@/lib/store';

export async function GET(request: NextRequest) {
  try {
    const authResult = await authorizeStaffRequest(
      request,
      supabaseAuthPersistenceStore,
      { enforceCsrf: false }
    );

    if (!authResult.authorized) {
      return Response.json(
        { authenticated: false },
        { status: 401 }
      );
    }

    return Response.json({
      authenticated: true,
      role: authResult.session.role,
      expiresAt: authResult.session.exp,
    });
  } catch (err) {
    console.error('Session check error:', err);
    return Response.json({ authenticated: false }, { status: 401 });
  }
}
