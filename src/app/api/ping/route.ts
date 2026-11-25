/**
 * Supabase DB の一時停止を防ぐためのヘルスチェックエンドポイント
 * Vercel Cron Job から毎日自動で呼ばれます
 */
import { executeGuardedPing } from '../../../lib/previewRuntimeDiagnostic';

export async function GET() {
  const result = await executeGuardedPing(process.env, async () => {
    const { getOrders } = await import('../../../lib/store');
    await getOrders(); // Supabase に1回アクセスして一時停止を防ぐ
  });
  return Response.json(result.body, { status: result.status });
}
