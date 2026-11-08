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
   * INSERT ... ON CONFLICT (store_id, order_date) DO UPDATE SET last_number = ... RETURNING last_number
   */
  public rpcNextOrderNumber(storeId: string, orderDate: string): string {
    if (!this.migrationApplied) {
      throw new Error('PGRST202: Could not find the function public.next_order_number in the schema cache');
    }
    const key = `${storeId}:${orderDate}`;
    const current = this.sequences.get(key);
    let next: number;
    if (current === undefined) {
      next =
        this.deterministicStartNumber !== null
          ? this.deterministicStartNumber
          : Math.floor(Math.random() * 2001) + 3000;
    } else {
      next = current + 1;
    }
    this.sequences.set(key, next);
    return String(next);
  }
}
