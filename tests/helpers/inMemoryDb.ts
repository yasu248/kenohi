/**
 * インメモリ / モック DB アダプター (本番DBへ一切接続しない隔離テスト用)
 *
 * - Supabase PostgreSQL の `orders` テーブルおよび Phase 0 新設テーブル/RPCの動作をシミュレートします。
 * - 既存のレガシー動作の再現モード (`migrationApplied: false`) と、
 *   Phase 0 マイグレーション適用後の動作モード (`migrationApplied: true`) の両方を検証可能です。
 */

import {
  getJSTDateString,
  MAX_DAILY_ORDER_NUMBER,
  resolveInheritedOrderNumber,
  type LegacyStoreStateNumberSnapshot,
} from '../../src/lib/orderNumber.ts';

export interface MockOrderRow {
  id: string;
  items: Array<{
    name: string;
    price: number;
    quantity: number;
    sweetness?: string;
    ice?: string;
    jelly?: string;
  }>;
  total_price: number;
  customer_name: string;
  customer_avatar: string | null;
  status: string;
  order_number: string;
  created_at: string;
  // Phase 0 拡張カラム
  store_id?: string;
  source?: string;
  external_order_id?: string | null;
  payment_status?: string | null;
  production_status?: string | null;
  fulfillment_status?: string | null;
  cancellation_status?: string | null;
  refunded_amount?: number;
  stripe_session_id?: string | null;
  updated_at?: string;
}

export interface MockAuthSessionRow {
  session_id: string;
  role: 'staff' | 'admin';
  issued_at: number;
  expires_at: number;
  revoked: boolean;
}

export interface MockLoginRateLimitRow {
  identifier: string;
  attempts: number;
  first_attempt_at: number;
  locked_until: number | null;
}

export class InMemoryTestDatabase {
  public orders: Map<string, MockOrderRow> = new Map();
  public sequences: Map<string, number> = new Map(); // key: `${storeId}:${orderDate}`
  public stripeEvents: Set<string> = new Set(); // 処理済み Stripe Webhook Event ID
  public authSessions: Map<string, MockAuthSessionRow> = new Map();
  public loginRateLimits: Map<string, MockLoginRateLimitRow> = new Map();
  public migrationApplied: boolean = true;
  public deterministicStartNumber: number | null = 3500;

  constructor(options?: { migrationApplied?: boolean; deterministicStartNumber?: number | null }) {
    this.migrationApplied = options?.migrationApplied ?? true;
    if (options?.deterministicStartNumber !== undefined) {
      this.deterministicStartNumber = options.deterministicStartNumber;
    }
  }

  public reset(): void {
    this.orders.clear();
    this.sequences.clear();
    this.stripeEvents.clear();
    this.authSessions.clear();
    this.loginRateLimits.clear();
  }

  /**
   * PostgreSQL の原子的採番 RPC `next_order_number(p_store_id, p_order_date)` のシミュレーション
   * - 当日の orders テーブル最大注文番号と STORE_STATE_001.lastOrderNumber の両方を確認し、
   *   GREATEST(orders最大値, STORE_STATE最終値) + 1 から引き継ぐ
   * - 4桁上限 (9999) 超過時は ORDER_NUMBER_LIMIT_EXCEEDED エラーを送出する
   */
  public rpcNextOrderNumber(storeId: string, orderDate: string): string {
    if (!this.migrationApplied) {
      throw new Error('PGRST202: Could not find the function public.next_order_number in the schema cache');
    }

    const existingOrderNumbersForDate: string[] = [];
    for (const row of this.orders.values()) {
      if (row.id === 'STORE_STATE_001') continue;
      const rowStoreId = row.store_id || 'kenocha_main';
      if (rowStoreId !== storeId) continue;
      const rowJstDate = getJSTDateString(new Date(row.created_at));
      if (rowJstDate === orderDate) {
        existingOrderNumbersForDate.push(row.order_number);
      }
    }

    let storeStateSnapshot: LegacyStoreStateNumberSnapshot | null = null;
    if (storeId === 'kenocha_main') {
      const stateRow = this.orders.get('STORE_STATE_001');
      if (stateRow?.customer_avatar) {
        try {
          storeStateSnapshot = JSON.parse(stateRow.customer_avatar) as LegacyStoreStateNumberSnapshot;
        } catch {
          storeStateSnapshot = null;
        }
      }
    }

    const handover = resolveInheritedOrderNumber({
      orderDate,
      existingOrderNumbersForDate,
      storeState: storeStateSnapshot,
    });

    const key = `${storeId}:${orderDate}`;
    const current = this.sequences.get(key);
    let next: number;

    if (current === undefined) {
      if (handover.inheritedLastNumber > 0) {
        next = handover.inheritedLastNumber + 1;
      } else {
        next =
          this.deterministicStartNumber !== null
            ? this.deterministicStartNumber
            : Math.floor(Math.random() * 2001) + 3000;
      }
    } else {
      next = Math.max(current, handover.inheritedLastNumber) + 1;
    }

    if (next > MAX_DAILY_ORDER_NUMBER) {
      throw new Error(
        `ORDER_NUMBER_LIMIT_EXCEEDED: Daily 4-digit order number limit (${MAX_DAILY_ORDER_NUMBER}) reached for store ${storeId} on ${orderDate}`
      );
    }

    this.sequences.set(key, next);
    return String(next);
  }
}
