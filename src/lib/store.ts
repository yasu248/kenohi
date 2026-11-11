/**
 * Supabase を使ったサーバーサイドのデータ層
 *
 * このファイルはサーバーサイド（Next.js API Route）からのみ呼ばれます。
 * SUPABASE_SECRET_KEY は .env.local に格納され、ブラウザには絶対に渡しません。
 */

import { createClient } from '@supabase/supabase-js';
import {
  resolveOrderDomainState,
  computeNextOrderStatuses,
  type OrderSource,
  type PaymentStatus,
  type ProductionStatus,
  type FulfillmentStatus,
  type CancellationStatus,
  type RefundStatus,
  type LegacyStatusClassification,
  type OrderStatusAction,
} from './orderStatus.ts';
import { allocateAtomicOrderNumber } from './orderNumber.ts';
import type {
  IAuthPersistenceStore,
  PersistentSessionRecord,
  RateLimitRecord,
} from './auth.ts';
import {
  DEFAULT_WEBHOOK_LOCK_TIMEOUT_MS,
  type IPaymentConfirmationRepository,
  type OrderRecordForPayment,
  type PaymentRejectionCode,
  type WebhookEventAcquisitionResult,
} from './stripeConfirmation.ts';
import { assertStagingEnvironmentSafe } from './envGuard.ts';

// サーバーサイド専用クライアント（Secret Key 使用）
// ステージング/テスト環境で本番Supabaseや本番Stripeキーが設定されていないかを安全ガード
assertStagingEnvironmentSafe();

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SECRET_KEY || 'placeholder_secret_key'
);

// ─── 型定義 ──────────────────────────────────────────────────────────────────

export interface OrderItem {
  id?: string;
  name: string;
  price: number;
  quantity: number;
  jelly?: string;
  sweetness?: string;
  ice?: string;
}

export interface Order {
  id: string;
  items: OrderItem[];
  totalPrice: number;
  customerName: string;
  customerAvatar?: string;
  status: 'unpaid' | 'pending' | 'preparing' | 'completed' | 'cancelled';
  createdAt: string;
  orderNumber: string;
  // Phase 0 拡張フィールド（4軸ステータス・外部連携準備・返金管理）
  storeId?: string;
  source?: OrderSource;
  externalOrderId?: string;
  paymentStatus?: PaymentStatus;
  productionStatus?: ProductionStatus;
  fulfillmentStatus?: FulfillmentStatus;
  cancellationStatus?: CancellationStatus;
  legacyClassification?: LegacyStatusClassification;
  refundedAmount?: number;
  refundStatus?: RefundStatus;
  requiresManualAttention?: boolean;
  stripeSessionId?: string;
}

/** 顧客向け公開注文情報（個人情報を一切含まない） */
export interface PublicOrderSummary {
  id: string;
  orderNumber: string;
  status: 'pending' | 'preparing' | 'completed';
  createdAt: string;
}

export interface OrderRefundRequestRecord {
  id: string;
  orderId: string;
  orderNumber?: string;
  stripeSessionId?: string | null;
  paymentIntentId?: string | null;
  amount: number;
  currency: string;
  targetRefundAmount: number;
  refundStatus: 'pending' | 'processing' | 'succeeded' | 'failed';
  stripeRefundId?: string | null;
  attemptCount: number;
  lastError?: string | null;
  requiresManualAttention: boolean;
  createdAt: string;
  updatedAt: string;
}

interface OrderDbRow {
  id: string;
  items: OrderItem[];
  total_price: number;
  customer_name: string;
  customer_avatar: string | null;
  status: 'unpaid' | 'pending' | 'preparing' | 'completed' | 'cancelled';
  created_at: string;
  order_number: string;
  store_id?: string | null;
  source?: string | null;
  external_order_id?: string | null;
  payment_status?: string | null;
  production_status?: string | null;
  fulfillment_status?: string | null;
  cancellation_status?: string | null;
  refunded_amount?: number | null;
  refund_status?: string | null;
  requires_manual_attention?: boolean | null;
  stripe_session_id?: string | null;
}

// DB（snake_case）→ アプリ（camelCase）変換
export function toOrder(row: OrderDbRow): Order {
  const domain = resolveOrderDomainState(row);
  return {
    id: row.id,
    items: row.items,
    totalPrice: row.total_price,
    customerName: row.customer_name,
    customerAvatar: row.customer_avatar ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    orderNumber: row.order_number,
    storeId: row.store_id ?? 'kenocha_main',
    source: domain.source,
    externalOrderId: domain.externalOrderId,
    paymentStatus: domain.paymentStatus,
    productionStatus: domain.productionStatus,
    fulfillmentStatus: domain.fulfillmentStatus,
    cancellationStatus: domain.cancellationStatus,
    legacyClassification: domain.legacyClassification,
    refundedAmount: domain.refundedAmount,
    refundStatus: domain.refundStatus,
    requiresManualAttention: domain.requiresManualAttention,
    stripeSessionId: row.stripe_session_id ?? undefined,
  };
}

/**
 * Phase 0-E: PostgreSQL 原子的採番 RPC を使った注文番号生成
 * ※ `STORE_STATE_001` の読み書きによる旧方式は競合と状態破壊リスクがあるため廃止し、
 *   PostgreSQL 側の `next_order_number` RPC を呼び出します。
 *   マイグレーション未適用時は `MigrationRequiredError` を送出して安全に停止します。
 */
export async function generateNextOrderNumber(storeId: string = 'kenocha_main'): Promise<string> {
  return allocateAtomicOrderNumber({
    storeId,
    rpcCaller: async (fnName, args) => {
      const { data, error } = await supabase.rpc(fnName, args);
      return {
        data,
        error: error ? { code: error.code, message: error.message } : null,
      };
    },
  });
}

// ─── 公開関数 ────────────────────────────────────────────────────────────────

/** 全注文を取得する（キッチン画面のポーリングで使用 — 要スタッフ認証） */
export async function getOrders(): Promise<Order[]> {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .neq('id', STORE_STATE_ID)
    .not('status', 'eq', 'cancelled')   // 受渡完了およびキャンセル済みは除外
    .not('status', 'eq', 'unpaid')      // 未決済は除外
    .order('created_at', { ascending: true });

  if (error) throw new Error(`getOrders: ${error.message}`);
  return ((data ?? []) as OrderDbRow[])
    .map(toOrder)
    .filter((o) => o.cancellationStatus !== 'cancelled' && o.fulfillmentStatus !== 'handed_over');
}

/**
 * 顧客画面・店頭ディスプレイ用の公開注文番号一覧を取得する（個人情報を一切返さない）
 */
export async function getPublicActiveOrders(): Promise<PublicOrderSummary[]> {
  const orders = await getOrders();
  return orders
    .filter(
      (o): o is Order & { status: 'pending' | 'preparing' | 'completed' } =>
        o.status === 'pending' || o.status === 'preparing' || o.status === 'completed'
    )
    .map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      createdAt: o.createdAt,
    }));
}

/** 新規注文を登録する（お客さんが注文確定時に `/api/checkout` 経由で使用） */
export async function addOrder(
  items: OrderItem[],
  customerName: string,
  customerAvatar?: string,
  options?: {
    storeId?: string;
    source?: OrderSource;
    externalOrderId?: string;
  }
): Promise<Order> {
  const totalPrice = items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0
  );

  const storeId = options?.storeId || 'kenocha_main';
  const orderNumber = await generateNextOrderNumber(storeId);

  const row = {
    id: Math.random().toString(36).substring(2, 11),
    items,
    total_price: totalPrice,
    customer_name: customerName,
    customer_avatar: customerAvatar ?? null,
    status: 'unpaid' as const,
    order_number: orderNumber,
    store_id: storeId,
    source: options?.source || 'mobile',
    external_order_id: options?.externalOrderId ?? null,
    payment_status: 'unpaid',
    production_status: 'pending',
    fulfillment_status: 'not_handed_over',
    cancellation_status: 'active',
    refunded_amount: 0,
  };

  const { data, error } = await supabase
    .from('orders')
    .insert(row)
    .select()
    .single();

  if (error) {
    if (error.code === '42703' || error.message.includes('column')) {
      throw new Error(
        `[Phase 0 Migration Required] ordersテーブルの4軸ステータスカラムが未適用です: ${error.message}`
      );
    }
    throw new Error(`addOrder: ${error.message}`);
  }
  return toOrder(data as OrderDbRow);
}

export type AtomicMobileOrderCreationResult =
  | { ok: true; order: Order }
  | {
      ok: false;
      code: 'STORE_STATE_UNAVAILABLE' | 'STORE_CLOSED' | 'ITEM_SOLD_OUT';
      message: string;
      soldOutId?: string;
    };

/**
 * 店舗状態（開店・営業時間・欠品）の確認、注文番号採番 (`next_order_number`)、および未決済注文 INSERT を
 * 単一のDBトランザクション (`create_mobile_order_tx`) で原子的に実行する。
 */
export async function createMobileOrderAtomically(params: {
  items: OrderItem[];
  customerName: string;
  customerAvatar?: string;
  itemIds: string[];
  storeId?: string;
  now?: Date;
}): Promise<AtomicMobileOrderCreationResult> {
  const storeId = params.storeId || 'kenocha_main';
  const orderId = Math.random().toString(36).substring(2, 11);
  const totalPrice = params.items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0
  );

  const { data, error } = await supabase.rpc('create_mobile_order_tx', {
    p_store_id: storeId,
    p_order_id: orderId,
    p_items: params.items,
    p_total_price: totalPrice,
    p_customer_name: params.customerName,
    p_customer_avatar: params.customerAvatar ?? null,
    p_item_ids: params.itemIds,
    p_now: (params.now ?? new Date()).toISOString(),
  });

  if (error) {
    throw new Error(`createMobileOrderAtomically: ${error.message}`);
  }

  const rpcResult = data as {
    ok?: boolean;
    code?: 'STORE_STATE_UNAVAILABLE' | 'STORE_CLOSED' | 'ITEM_SOLD_OUT';
    message?: string;
    sold_out_id?: string;
    order?: OrderDbRow;
  } | null;

  if (!rpcResult || !rpcResult.ok || !rpcResult.order) {
    return {
      ok: false,
      code: rpcResult?.code || 'STORE_STATE_UNAVAILABLE',
      message:
        rpcResult?.message ||
        '現在、店舗の受付状態を確認できないため注文を受け付けられません。',
      soldOutId: rpcResult?.sold_out_id,
    };
  }

  return {
    ok: true,
    order: toOrder(rpcResult.order),
  };
}

export type FinalizeMobileOrderCheckoutResult =
  | { ok: true; order: Order }
  | {
      ok: false;
      code: 'STORE_STATE_UNAVAILABLE' | 'STORE_CLOSED' | 'ITEM_SOLD_OUT' | 'ORDER_NOT_FOUND';
      message: string;
      soldOutId?: string;
      orderCancelled: boolean;
    };

/**
 * Stripe Checkout セッション発行直後に、同じ排他制御 (`store_state` ロック) 下で店舗状態を再確認し、
 * 営業中であれば `stripe_session_id` を記録、受付停止・欠品化されていた場合は未決済注文を中断キャンセルする。
 */
export async function finalizeMobileOrderCheckout(params: {
  orderId: string;
  stripeSessionId: string;
  itemIds: string[];
  storeId?: string;
  now?: Date;
}): Promise<FinalizeMobileOrderCheckoutResult> {
  const storeId = params.storeId || 'kenocha_main';
  const { data, error } = await supabase.rpc('finalize_mobile_order_checkout_tx', {
    p_store_id: storeId,
    p_order_id: params.orderId,
    p_stripe_session_id: params.stripeSessionId,
    p_item_ids: params.itemIds,
    p_now: (params.now ?? new Date()).toISOString(),
  });

  if (error) {
    throw new Error(`finalizeMobileOrderCheckout: ${error.message}`);
  }

  const rpcResult = data as {
    ok?: boolean;
    code?: 'STORE_STATE_UNAVAILABLE' | 'STORE_CLOSED' | 'ITEM_SOLD_OUT' | 'ORDER_NOT_FOUND';
    message?: string;
    sold_out_id?: string;
    order_cancelled?: boolean;
    order?: OrderDbRow;
  } | null;

  if (!rpcResult || !rpcResult.ok || !rpcResult.order) {
    return {
      ok: false,
      code: rpcResult?.code || 'STORE_STATE_UNAVAILABLE',
      message:
        rpcResult?.message ||
        '店舗状態の確認中にエラーが発生したため、注文を中断しました。',
      soldOutId: rpcResult?.sold_out_id,
      orderCancelled: Boolean(rpcResult?.order_cancelled),
    };
  }

  return {
    ok: true,
    order: toOrder(rpcResult.order),
  };
}

/**
 * 未決済の Checkout 注文のみを安全に中断キャンセルする（決済済み注文は絶対にキャンセル・削除しない）
 */
export async function abortMobileOrderCheckout(params: {
  orderId: string;
  stripeSessionId?: string;
  reason?: string;
}): Promise<{ ok: boolean; code?: string; cancelled?: boolean }> {
  const { data, error } = await supabase.rpc('abort_mobile_order_checkout_tx', {
    p_order_id: params.orderId,
    p_stripe_session_id: params.stripeSessionId ?? null,
    p_reason: params.reason ?? 'checkout_aborted',
  });

  if (error) {
    throw new Error(`abortMobileOrderCheckout: ${error.message}`);
  }

  const rpcResult = data as {
    ok?: boolean;
    code?: string;
    cancelled?: boolean;
  } | null;

  return {
    ok: Boolean(rpcResult?.ok),
    code: rpcResult?.code,
    cancelled: Boolean(rpcResult?.cancelled),
  };
}

/**
 * 注文のステータスを更新する（キッチン画面のボタン操作）
 * Phase 0-C: 受渡完了 (`hand_over`) と本当の注文取消 (`cancel_order`) を明確に区別して保存する
 */
export async function updateOrderStatus(
  orderId: string,
  status: Order['status'],
  actionOverride?: OrderStatusAction
): Promise<Order | null> {
  const { data: currentRow, error: fetchError } = await supabase
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .single();

  if (fetchError) {
    if (fetchError.code === 'PGRST116') return null;
    throw new Error(`updateOrderStatus(fetch): ${fetchError.message}`);
  }

  const currentDomain = resolveOrderDomainState(currentRow as OrderDbRow);

  let action: OrderStatusAction;
  if (actionOverride) {
    action = actionOverride;
  } else if (status === 'preparing') {
    action =
      currentRow.status === 'completed' ? 'revert_to_preparing' : 'start_preparing';
  } else if (status === 'completed') {
    action = 'mark_ready';
  } else if (status === 'pending') {
    action = 'revert_to_pending';
  } else {
    // キッチン画面の既存「受渡完了 (閉じる)」ボタンは status='cancelled' を送信するため、
    // デフォルトでは受渡完了 ('hand_over') として4軸ステータスを更新する。
    // 明示的に actionOverride='cancel_order' が指定された場合は本当のキャンセルとして記録する。
    action = 'hand_over';
  }

  const nextStatuses = computeNextOrderStatuses(currentDomain, action);

  const { data, error } = await supabase
    .from('orders')
    .update({
      status: nextStatuses.status,
      payment_status: nextStatuses.payment_status,
      production_status: nextStatuses.production_status,
      fulfillment_status: nextStatuses.fulfillment_status,
      cancellation_status: nextStatuses.cancellation_status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', orderId)
    .select()
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`updateOrderStatus: ${error.message}`);
  }
  return toOrder(data as OrderDbRow);
}

export async function clearOrders(): Promise<void> {
  const { error } = await supabase
    .from('orders')
    .delete()
    .neq('id', STORE_STATE_ID); // STORE_STATE_001 を保持

  if (error) throw new Error(`clearOrders: ${error.message}`);

  const state = await getStoreState();
  if (state) {
    delete state.lastOrderNumber;
    delete state.currentOrderDate;
    await setStoreState(state);
  }
}

// ─── Phase 0-D / 監査修正 B: Stripe 決済確認リポジトリ実装 (Supabase) ────────

interface StripeWebhookEventDbRow {
  event_id: string;
  session_id: string;
  order_id: string;
  status: 'processing' | 'succeeded' | 'failed_permanent';
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  processed_at: string | null;
  updated_at: string;
}

export const supabasePaymentRepository: IPaymentConfirmationRepository = {
  async beginStripeWebhookEvent({
    eventId,
    sessionId,
    orderId,
    staleLockTimeoutMs = DEFAULT_WEBHOOK_LOCK_TIMEOUT_MS,
  }): Promise<WebhookEventAcquisitionResult> {
    const nowIso = new Date().toISOString();

    // 1. 新規イベントとして processing ロックの INSERT を試行
    const { error: insertError } = await supabase.from('stripe_webhook_events').insert({
      event_id: eventId,
      session_id: sessionId,
      order_id: orderId,
      status: 'processing',
      attempt_count: 1,
      started_at: nowIso,
      updated_at: nowIso,
    });

    if (!insertError) {
      return { state: 'acquired', attemptCount: 1 };
    }

    if (insertError.code !== '23505') {
      throw new Error(`beginStripeWebhookEvent(insert) failed: ${insertError.message}`);
    }

    // 2. 既存レコードが存在する場合は状態を確認する
    const { data: existingData, error: fetchError } = await supabase
      .from('stripe_webhook_events')
      .select('*')
      .eq('event_id', eventId)
      .maybeSingle();

    if (fetchError) {
      throw new Error(`beginStripeWebhookEvent(fetch) failed: ${fetchError.message}`);
    }

    if (!existingData) {
      // 直前に別プロセスのロールバック等で削除された場合は再試行可能とする
      return { state: 'in_progress' };
    }

    const existing = existingData as StripeWebhookEventDbRow;

    if (existing.status === 'succeeded') {
      return { state: 'already_succeeded' };
    }

    if (existing.status === 'failed_permanent') {
      return {
        state: 'already_failed_permanent',
        errorCode: (existing.error_code || 'AMOUNT_MISMATCH') as PaymentRejectionCode,
        errorMessage: existing.error_message || '恒久的な検証エラーが記録されています',
      };
    }

    // status === 'processing': ロック有効期限内であれば別リクエストが同時処理中
    const elapsedMs = Date.now() - new Date(existing.updated_at).getTime();
    if (elapsedMs < staleLockTimeoutMs) {
      return { state: 'in_progress' };
    }

    // 前回の処理がタイムアウトして残留している場合は CAS (Compare-And-Swap) でロックを再取得
    const nextAttempt = (existing.attempt_count || 1) + 1;
    const { data: reclaimed, error: reclaimError } = await supabase
      .from('stripe_webhook_events')
      .update({
        status: 'processing',
        attempt_count: nextAttempt,
        updated_at: nowIso,
      })
      .eq('event_id', eventId)
      .eq('status', 'processing')
      .eq('updated_at', existing.updated_at)
      .select()
      .maybeSingle();

    if (reclaimError) {
      throw new Error(`beginStripeWebhookEvent(reclaim) failed: ${reclaimError.message}`);
    }

    if (!reclaimed) {
      return { state: 'in_progress' };
    }

    return { state: 'acquired', attemptCount: nextAttempt };
  },

  async releaseStripeWebhookEventOnTransientError(
    eventId: string,
    errorMessage: string
  ): Promise<void> {
    console.warn(
      `[Webhook] Releasing processing lock for event ${eventId} due to transient error: ${errorMessage}`
    );
    // processing 状態のロックのみを削除し、Stripe の次回再送で確実に再試行できるようにする
    const { error } = await supabase
      .from('stripe_webhook_events')
      .delete()
      .eq('event_id', eventId)
      .eq('status', 'processing');

    if (error) {
      throw new Error(`releaseStripeWebhookEventOnTransientError failed: ${error.message}`);
    }
  },

  async markStripeWebhookEventPermanentFailure({
    eventId,
    sessionId,
    orderId,
    errorCode,
    errorMessage,
  }): Promise<void> {
    const nowIso = new Date().toISOString();
    const { error } = await supabase.from('stripe_webhook_events').upsert({
      event_id: eventId,
      session_id: sessionId,
      order_id: orderId,
      status: 'failed_permanent',
      error_code: errorCode,
      error_message: errorMessage,
      processed_at: nowIso,
      updated_at: nowIso,
    });

    if (error) {
      throw new Error(`markStripeWebhookEventPermanentFailure failed: ${error.message}`);
    }
  },

  async getOrderById(orderId: string): Promise<OrderRecordForPayment | null> {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`getOrderById failed: ${error.message}`);
    }
    const row = data as OrderDbRow;
    return {
      id: row.id,
      orderNumber: row.order_number,
      totalPrice: row.total_price,
      status: row.status,
      paymentStatus: row.payment_status,
      productionStatus: row.production_status,
      fulfillmentStatus: row.fulfillment_status,
      cancellationStatus: row.cancellation_status,
      refundedAmount: row.refunded_amount,
      refundStatus: row.refund_status,
      requiresManualAttention: row.requires_manual_attention,
      stripeSessionId: row.stripe_session_id,
    };
  },

  async atomicConfirmOrderPayment({
    orderId,
    stripeSessionId,
    webhookEventId,
  }): Promise<{
    updatedOrder: OrderRecordForPayment | null;
    transitionedFromUnpaid: boolean;
  }> {
    // PostgreSQL 側の単一トランザクション RPC (`confirm_stripe_order_payment_tx`) を呼び出し、
    // 注文ステータスの条件付き更新と Webhook イベントの succeeded 記録を同一トランザクションで確定する
    const { data, error } = await supabase.rpc('confirm_stripe_order_payment_tx', {
      p_order_id: orderId,
      p_stripe_session_id: stripeSessionId,
      p_webhook_event_id: webhookEventId ?? null,
    });

    if (error) {
      throw new Error(`atomicConfirmOrderPayment(rpc) failed: ${error.message}`);
    }

    const payload = data as {
      found?: boolean;
      transitioned_from_unpaid?: boolean;
      order?: OrderDbRow;
    } | null;

    if (!payload || !payload.found || !payload.order) {
      return { updatedOrder: null, transitionedFromUnpaid: false };
    }

    const row = payload.order;
    return {
      updatedOrder: {
        id: row.id,
        orderNumber: row.order_number,
        totalPrice: row.total_price,
        status: row.status,
        paymentStatus: row.payment_status,
        productionStatus: row.production_status,
        fulfillmentStatus: row.fulfillment_status,
        cancellationStatus: row.cancellation_status,
        refundedAmount: row.refunded_amount,
        refundStatus: row.refund_status,
        requiresManualAttention: row.requires_manual_attention,
        stripeSessionId: row.stripe_session_id,
      },
      transitionedFromUnpaid: Boolean(payload.transitioned_from_unpaid),
    };
  },

  async recordCancelledPaymentDiscrepancy({
    orderId,
    stripeSessionId,
    paymentIntentId,
    amount,
    currency = 'jpy',
    webhookEventId,
    reason = 'cancelled_order_payment_received',
  }): Promise<{ ok: boolean; refundRequestId?: string; alreadyRecorded?: boolean }> {
    const { data, error } = await supabase.rpc('record_cancelled_payment_discrepancy_tx', {
      p_order_id: orderId,
      p_stripe_session_id: stripeSessionId,
      p_payment_intent_id: paymentIntentId ?? null,
      p_amount: amount,
      p_currency: currency,
      p_webhook_event_id: webhookEventId ?? null,
      p_reason: reason,
    });

    if (error) {
      throw new Error(`recordCancelledPaymentDiscrepancy failed: ${error.message}`);
    }

    const payload = data as {
      ok?: boolean;
      order_id?: string;
      refund_request?: { id: string };
      code?: string;
      message?: string;
    } | null;

    if (!payload || !payload.ok) {
      console.warn(
        `[recordCancelledPaymentDiscrepancy] RPC returned not ok: code=${payload?.code} message=${payload?.message}`
      );
      return { ok: false };
    }

    return {
      ok: true,
      refundRequestId: payload.refund_request?.id,
    };
  },
};

/**
 * 未解決の返金案件一覧を取得する（管理画面アラート表示用）
 */
export async function getUnresolvedRefundRequests(): Promise<OrderRefundRequestRecord[]> {
  const { data, error } = await supabase
    .from('order_refund_requests')
    .select('*, orders(order_number)')
    .or('refund_status.neq.succeeded,requires_manual_attention.eq.true')
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`getUnresolvedRefundRequests failed: ${error.message}`);
  }

  return (data || []).map((row: any) => ({
    id: row.id,
    orderId: row.order_id,
    orderNumber: row.orders?.order_number,
    stripeSessionId: row.stripe_session_id,
    paymentIntentId: row.payment_intent_id,
    amount: row.amount,
    currency: row.currency,
    targetRefundAmount: row.target_refund_amount,
    refundStatus: row.refund_status,
    stripeRefundId: row.stripe_refund_id,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    requiresManualAttention: Boolean(row.requires_manual_attention),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * 返金案件の実行状態を更新する RPC ラッパー
 */
export async function updateRefundRequestStatus(params: {
  orderId: string;
  refundStatus: 'pending' | 'processing' | 'succeeded' | 'failed';
  stripeRefundId?: string | null;
  lastError?: string | null;
  requiresManualAttention?: boolean;
  incrementAttempt?: boolean;
}): Promise<{ ok: boolean; code?: string }> {
  const { data, error } = await supabase.rpc('update_refund_request_status_tx', {
    p_order_id: params.orderId,
    p_refund_status: params.refundStatus,
    p_stripe_refund_id: params.stripeRefundId ?? null,
    p_last_error: params.lastError ?? null,
    p_requires_manual_attention: params.requiresManualAttention ?? null,
    p_increment_attempt: Boolean(params.incrementAttempt),
  });

  if (error) {
    throw new Error(`updateRefundRequestStatus failed: ${error.message}`);
  }

  const payload = data as { ok?: boolean; code?: string } | null;
  return { ok: Boolean(payload?.ok), code: payload?.code };
}

// ─── Phase 0-B: 永続認証ストア (Vercel マルチインスタンス対応) ────────────────

export const supabaseAuthPersistenceStore: IAuthPersistenceStore = {
  async getRateLimit(identifier: string): Promise<RateLimitRecord | null> {
    const { data, error } = await supabase
      .from('auth_login_rate_limits')
      .select('*')
      .eq('identifier', identifier)
      .maybeSingle();

    if (error || !data) return null;
    return {
      identifier: data.identifier,
      attempts: data.attempts,
      firstAttemptAt: new Date(data.first_attempt_at).getTime(),
      lockedUntil: data.locked_until ? new Date(data.locked_until).getTime() : null,
    };
  },

  async saveRateLimit(record: RateLimitRecord): Promise<void> {
    const { error } = await supabase.from('auth_login_rate_limits').upsert({
      identifier: record.identifier,
      attempts: record.attempts,
      first_attempt_at: new Date(record.firstAttemptAt).toISOString(),
      locked_until: record.lockedUntil ? new Date(record.lockedUntil).toISOString() : null,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      throw new Error(`saveRateLimit failed: ${error.message}`);
    }
  },

  async clearRateLimit(identifier: string): Promise<void> {
    await supabase
      .from('auth_login_rate_limits')
      .delete()
      .eq('identifier', identifier);
  },

  async saveSession(record: PersistentSessionRecord): Promise<void> {
    const { error } = await supabase.from('auth_sessions').upsert({
      session_id: record.sessionId,
      role: record.role,
      issued_at: new Date(record.issuedAt).toISOString(),
      expires_at: new Date(record.expiresAt).toISOString(),
      revoked: record.revoked,
    });
    if (error) {
      throw new Error(`saveSession failed: ${error.message}`);
    }
  },

  async getSession(sessionId: string): Promise<PersistentSessionRecord | null> {
    const { data, error } = await supabase
      .from('auth_sessions')
      .select('*')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (error || !data) return null;
    return {
      sessionId: data.session_id,
      role: data.role,
      issuedAt: new Date(data.issued_at).getTime(),
      expiresAt: new Date(data.expires_at).getTime(),
      revoked: Boolean(data.revoked),
    };
  },

  async revokeSession(sessionId: string): Promise<void> {
    await supabase
      .from('auth_sessions')
      .update({ revoked: true, updated_at: new Date().toISOString() })
      .eq('session_id', sessionId);
  },
};

// ─── 店舗状態管理 (STORE_STATE_001: 開店状態・欠品管理専用として保護) ──────────

export const STORE_STATE_ID = 'STORE_STATE_001';

export interface StoreState {
  isManualOpen: boolean;
  date: string;
  openedAt?: number;
  soldOutItems?: string[];
  openHistory?: Array<{
    date: string;       // 'YYYY-MM-DD'
    openedAt: number;   // Unix ms
    soldOutItems?: string[];
  }>;
  currentOrderDate?: string;
  lastOrderNumber?: number;
}

export async function getStoreState(): Promise<StoreState | null> {
  const { data, error } = await supabase
    .from('orders')
    .select('customer_avatar')
    .eq('id', STORE_STATE_ID)
    .single();

  if (error || !data || !data.customer_avatar) {
    return null;
  }
  try {
    return JSON.parse(data.customer_avatar);
  } catch {
    return null;
  }
}

export async function setStoreState(
  state: StoreState,
  storeId: string = 'kenocha_main'
): Promise<void> {
  // Phase 0: 注文作成・Checkout確定と同じ排他制御ロック (`store_state`) に参加する RPC を優先使用
  const { error: rpcError } = await supabase.rpc('update_store_state_tx', {
    p_store_id: storeId,
    p_state_json: state,
  });

  if (!rpcError) {
    return;
  }

  // マイグレーション適用前の互換フォールバック（関数未定義時のみ）
  if (
    rpcError.code !== '42883' &&
    rpcError.code !== 'PGRST202' &&
    !rpcError.message.includes('update_store_state_tx')
  ) {
    throw new Error(`setStoreState(rpc): ${rpcError.message}`);
  }

  const row = {
    id: STORE_STATE_ID,
    items: [],
    total_price: 0,
    customer_name: 'STORE_STATE',
    customer_avatar: JSON.stringify(state),
    status: 'cancelled', // 通常の注文に混ざらないようにcancelledにする
    order_number: '0000',
  };

  const { error } = await supabase
    .from('orders')
    .upsert(row);

  if (error) throw new Error(`setStoreState: ${error.message}`);
}
