/**
 * GET /api/ping 用の安全なヘルスチェック実行ラッパー。
 * 例外発生時に内部例外・Supabaseエラー・接続情報・秘密値が
 * HTTPレスポンスやサーバーログへ露出することを防止する。
 */

export const PING_ERROR_CODE = 'PING_HEALTHCHECK_FAILED';
export const PING_ERROR_MESSAGE = 'Health check failed';

export async function executeSafePing(
  pingFn: () => Promise<unknown>,
  logError: (message: string) => void = (msg) => console.error(msg)
): Promise<{ status: number; body: Record<string, string> }> {
  try {
    await pingFn();
    return {
      status: 200,
      body: {
        status: 'ok',
        message: 'Supabase is alive',
        timestamp: new Date().toISOString(),
      },
    };
  } catch {
    logError(`[PingHealthcheck] code=${PING_ERROR_CODE}`);
    return {
      status: 500,
      body: {
        status: 'error',
        message: PING_ERROR_MESSAGE,
      },
    };
  }
}
