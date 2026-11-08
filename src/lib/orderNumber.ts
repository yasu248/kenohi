/**
 * Phase 0-E: 注文番号の原子的採番モジュール
 *
 * 要件:
 * 1. プロセス内ミューテックスによるフォールバックは採用しない（Vercel の複数インスタンス間で一意性が保証されないため）
 * 2. PostgreSQL 側の原子的採番 RPC `next_order_number(p_store_id, p_order_date)` を使用する
 * 3. 必要な DB マイグレーション（RPC）が未適用の場合、新方式の機能は安全に停止（エラー送出）させる
 * 4. 店舗単位 (`store_id`) および JST 日付単位 (`YYYY-MM-DD`) での採番に対応する
 * 5. `STORE_STATE_001` の開店状態や欠品管理を一切書き換えず、破壊しない
 */

export class MigrationRequiredError extends Error {
  public readonly code = 'MIGRATION_REQUIRED';
  public readonly migrationFile = 'supabase/migrations/0001_phase0_foundation.sql';

  constructor(detail: string) {
    super(
      `[Phase 0 Migration Required] PostgreSQLの原子的採番機能が未適用であるため、重複採番防止のため処理を安全に停止しました。` +
        ` (${detail}) — マイグレーション ${'supabase/migrations/0001_phase0_foundation.sql'} の適用が必要です。`
    );
    this.name = 'MigrationRequiredError';
  }
}

export interface IOrderNumberGenerator {
  nextOrderNumber(storeId: string, jstDateStr: string): Promise<string>;
}

/**
 * JST (Asia/Tokyo) の日付文字列 'YYYY-MM-DD' を返す
 */
export function getJSTDateString(date: Date = new Date()): string {
  const jstString = date.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' });
  const jstDate = new Date(jstString);
  const year = jstDate.getFullYear();
  const month = String(jstDate.getMonth() + 1).padStart(2, '0');
  const day = String(jstDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * PostgreSQL RPC (`next_order_number`) を呼び出して原子的に注文番号を採番する。
 * マイグレーション未適用時は不安全なクライアント側加算にフォールバックせず、`MigrationRequiredError` で安全に停止させる。
 */
export async function allocateAtomicOrderNumber(params: {
  rpcCaller: (
    fnName: string,
    args: { p_store_id: string; p_order_date: string }
  ) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>;
  storeId?: string;
  date?: Date;
}): Promise<string> {
  const storeId = params.storeId || 'kenocha_main';
  const orderDate = getJSTDateString(params.date ?? new Date());

  const { data, error } = await params.rpcCaller('next_order_number', {
    p_store_id: storeId,
    p_order_date: orderDate,
  });

  if (error) {
    // 関数未定義 (PGRST202 / 42883) 等はマイグレーション未適用として安全停止
    if (
      error.code === 'PGRST202' ||
      error.code === '42883' ||
      error.message.includes('next_order_number') ||
      error.message.includes('schema cache')
    ) {
      throw new MigrationRequiredError(error.message);
    }
    throw new Error(`allocateAtomicOrderNumber failed: ${error.message}`);
  }

  const numStr = String(data ?? '').trim();
  if (!numStr || !/^\d+$/.test(numStr)) {
    throw new MigrationRequiredError('RPC next_order_number returned an invalid value');
  }

  return numStr;
}
