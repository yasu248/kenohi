/**
 * Supabase DB の一時停止を防ぐためのヘルスチェックエンドポイント
 * Vercel Cron Job から毎日自動で呼ばれます
 */
import { getOrders } from '../../../lib/store';

export async function GET() {
  try {
    await getOrders(); // Supabase に1回アクセスして一時停止を防ぐ
    return Response.json({
      status: 'ok',
      message: 'Supabase is alive',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('ping failed:', err);
    return Response.json(
      { status: 'error', message: String(err) },
      { status: 500 }
    );
  }
}
