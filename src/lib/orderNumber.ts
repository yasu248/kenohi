/**
 * Phase 0-E / 監査修正 A: 注文番号の原子的採番・既存番号引き継ぎモジュール
 *
 * 要件:
 * 1. プロセス内ミューテックスによるフォールバックは採用しない（Vercel の複数インスタンス間で一意性が保証されないため）
 * 2. PostgreSQL 側の原子的採番 RPC `next_order_number(p_store_id, p_order_date)` を使用する
 * 3. 当日の既存注文番号 (`orders` テーブル) と `STORE_STATE_001` の最終番号 (`lastOrderNumber`) の整合性を確認し、
 *    既存番号が存在する場合は `GREATEST(orders最大値, STORE_STATE最終値) + 1` から重複なく引き継ぐ
 * 4. 4桁番号の上限 (`9999`) を検証し、超過時は `OrderNumberLimitExceededError` で安全に拒否する
 * 5. 日付変更時 (`YYYY-MM-DD`) は新しい日の初期値 (`3000`〜`5000`) にリセットする
 * 6. 必要な DB マイグレーション（RPC）が未適用の場合、新方式の機能は安全に停止（エラー送出）させる
 * 7. `STORE_STATE_001` の開店状態や欠品管理を一切書き換えず、破壊しない
 */

export const MIN_DAILY_START_ORDER_NUMBER = 3000;
export const MAX_DAILY_START_ORDER_NUMBER = 5000;
export const MAX_DAILY_ORDER_NUMBER = 9999;

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

export class OrderNumberLimitExceededError extends Error {
  public readonly code = 'ORDER_NUMBER_LIMIT_EXCEEDED';

  constructor(storeId: string, orderDate: string, attemptedNumber?: number) {
    super(
      `[Order Number Limit Exceeded] 店舗 (${storeId}) の当日 (${orderDate}) の4桁注文番号上限 (${MAX_DAILY_ORDER_NUMBER}) に達したため採番を停止しました` +
        (attemptedNumber !== undefined ? ` (要求値: ${attemptedNumber})` : '')
    );
    this.name = 'OrderNumberLimitExceededError';
  }
}

export interface LegacyStoreStateNumberSnapshot {
  currentOrderDate?: string;
  lastOrderNumber?: number;
}

export interface OrderNumberHandoverResolution {
  orderDate: string;
  maxFromOrders: number;
  lastFromStoreState: number;
  hasDiscrepancy: boolean;
  inheritedLastNumber: number;
}

/**
 * 当日の既存注文番号一覧 (`orders.order_number`) と `STORE_STATE_001` (`currentOrderDate`, `lastOrderNumber`) を照合し、
 * 引き継ぐべき当日最終注文番号 (`inheritedLastNumber`) と整合性状態を算出する。
 */
export function resolveInheritedOrderNumber(params: {
  orderDate: string;
  existingOrderNumbersForDate: string[];
  storeState?: LegacyStoreStateNumberSnapshot | null;
}): OrderNumberHandoverResolution {
  const { orderDate, existingOrderNumbersForDate, storeState } = params;

  let maxFromOrders = 0;
  for (const raw of existingOrderNumbersForDate) {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (parsed >= 1 && parsed <= MAX_DAILY_ORDER_NUMBER && parsed > maxFromOrders) {
        maxFromOrders = parsed;
      }
    }
  }

  let lastFromStoreState = 0;
  if (
    storeState &&
    storeState.currentOrderDate === orderDate &&
    typeof storeState.lastOrderNumber === 'number' &&
    Number.isInteger(storeState.lastOrderNumber) &&
    storeState.lastOrderNumber >= 1 &&
    storeState.lastOrderNumber <= MAX_DAILY_ORDER_NUMBER
  ) {
    lastFromStoreState = storeState.lastOrderNumber;
  }

  const hasDiscrepancy =
    maxFromOrders > 0 && lastFromStoreState > 0 && maxFromOrders !== lastFromStoreState;

  const inheritedLastNumber = Math.max(maxFromOrders, lastFromStoreState);

  return {
    orderDate,
    maxFromOrders,
    lastFromStoreState,
    hasDiscrepancy,
    inheritedLastNumber,
  };
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
 * - マイグレーション未適用時は不安全なクライアント側加算にフォールバックせず、`MigrationRequiredError` で安全に停止させる。
 * - 4桁上限 (9999) 到達時は `OrderNumberLimitExceededError` を送出する。
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
    if (error.message.includes('ORDER_NUMBER_LIMIT_EXCEEDED')) {
      throw new OrderNumberLimitExceededError(storeId, orderDate);
    }
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

  const numericValue = Number.parseInt(numStr, 10);
  if (numericValue > MAX_DAILY_ORDER_NUMBER) {
    throw new OrderNumberLimitExceededError(storeId, orderDate, numericValue);
  }

  return numStr;
}
