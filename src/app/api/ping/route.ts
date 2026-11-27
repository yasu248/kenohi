/**
 * Supabase DB の一時停止を防ぐためのヘルスチェックエンドポイント
 * Vercel Cron Job から毎日自動で呼ばれます
 */
import { getOrders } from '../../../lib/store';
import { executeSafePing } from '../../../lib/pingHealthcheck';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const result = await executeSafePing(getOrders);
  return Response.json(result.body, { status: result.status });
}
