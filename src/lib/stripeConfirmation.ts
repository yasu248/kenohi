import { resolveOrderDomainState, type OrderDomainState } from './orderStatus.ts';

/**
 * Phase 0-D / 監査修正 B: Stripe 決済確認処理の共通化・障害復旧・状態管理・状態遷移ガード
 *
 * 要件:
 * 1. `POST /api/orders/confirm` と `POST /api/webhooks/stripe` の確認ロジックを1つに共通化
 * 2. Stripe Session と内部注文 (orderId) の対応・支払済み金額 (`amount_total`)・通貨 (`jpy`)・支払いステータス (`paid`) を厳格に検証
 * 3. 決済状態を冪等に更新する
 * 4. すでに `preparing`（調理中）や `completed`（呼出中）、`handed_over`（受渡完了）に進んでいる注文を決して `pending` に巻き戻さない
 * 5. Webhook イベントの処理状態 (`processing` / `succeeded` / `failed_permanent`) を永続管理する:
 *    - 単にイベントIDを先に保存して「処理済み」とする方式は禁止
 *    - イベント受信後・注文更新前にDB障害が起きてもロックを解放し、Stripeの再送で再試行できる
 *    - 注文更新と処理完了 (`succeeded`) 記録を同一トランザクション（または原子的ステップ）で確定し、
 *      注文更新後・HTTP応答前に障害が起きても再送時に二重処理しない (`already_succeeded`)
 *    - 同時受信 (`in_progress`) を検出し、並列二重実行を防止する
 *    - 恒久的な検証エラー (`AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `ORDER_CANCELLED` 等) は `failed_permanent` として永続記録・通知する
 */

export const DEFAULT_WEBHOOK_LOCK_TIMEOUT_MS = 30_000;

export interface StripeCheckoutSessionLike {
  id: string;
  payment_status: string;
  amount_total: number | null;
  currency: string | null;
  metadata?: {
    orderId?: string;
    orderNumber?: string;
  } | null;
}

export interface OrderRecordForPayment {
  id: string;
  orderNumber: string;
  totalPrice: number;
  status: string;
  paymentStatus?: string | null;
  productionStatus?: string | null;
  fulfillmentStatus?: string | null;
  cancellationStatus?: string | null;
  refundedAmount?: number | null;
  refundStatus?: string | null;
  requiresManualAttention?: boolean | null;
  stripeSessionId?: string | null;
}

export type PaymentRejectionCode =
  | 'MISSING_ORDER_ID'
  | 'PAYMENT_NOT_PAID'
  | 'ORDER_NOT_FOUND'
  | 'CURRENCY_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'ORDER_CANCELLED'
  | 'CANCELLED_PAYMENT_DISCREPANCY'
  | 'WEBHOOK_IN_PROGRESS';

export type WebhookEventStatus = 'processing' | 'succeeded' | 'failed_permanent';

export interface StripeWebhookEventRecord {
  eventId: string;
  sessionId: string;
  orderId: string;
  status: WebhookEventStatus;
  attemptCount: number;
  errorCode?: PaymentRejectionCode | null;
  errorMessage?: string | null;
  startedAt: number;
  processedAt?: number | null;
  updatedAt: number;
}

export type WebhookEventAcquisitionResult =
  | { state: 'acquired'; attemptCount: number }
  | { state: 'already_succeeded' }
  | {
      state: 'already_failed_permanent';
      errorCode: PaymentRejectionCode;
      errorMessage: string;
    }
  | { state: 'in_progress' };

export interface IPaymentConfirmationRepository {
  /**
   * Webhook イベントの処理開始ロックを取得・状態確認する
   * - `succeeded`: すでに注文更新まで完了済み → `already_succeeded`
   * - `failed_permanent`: 恒久的検証エラーとして記録済み → `already_failed_permanent`
   * - `processing` (有効期限内): 別リクエストが同時処理中 → `in_progress`
   * - 未登録 または 前回 `processing` のままタイムアウト: `processing` としてロック取得 → `acquired`
   */
  beginStripeWebhookEvent(params: {
    eventId: string;
    sessionId: string;
    orderId: string;
    staleLockTimeoutMs?: number;
  }): Promise<WebhookEventAcquisitionResult>;

  /**
   * 注文更新前に一時的なDB障害等が発生した場合、`processing` ロックを解放して
   * Stripe からの次回再送で確実に再試行できるようにする
   */
  releaseStripeWebhookEventOnTransientError(
    eventId: string,
    errorMessage: string
  ): Promise<void>;

  /**
   * 恒久的な検証エラー (`AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `ORDER_CANCELLED` 等) を
   * `failed_permanent` として永続記録する
   */
  markStripeWebhookEventPermanentFailure(params: {
    eventId: string;
    sessionId: string;
    orderId: string;
    errorCode: PaymentRejectionCode;
    errorMessage: string;
  }): Promise<void>;

  /** 注文を取得する */
  getOrderById(orderId: string): Promise<OrderRecordForPayment | null>;

  /**
   * 条件付き原子的更新 + Webhook 完了 (`succeeded`) の同一トランザクション確定:
   * - 注文が `status = 'unpaid'` の場合のみ `status = 'pending'`, `production_status = 'pending'`, `payment_status = 'paid'` に進める
   * - すでに `status IN ('pending', 'preparing', 'completed', 'cancelled')` に進んでいる場合は、
   *   製造状態 (`status`, `production_status`) を一切巻き戻さず、`payment_status = 'paid'` と `stripe_session_id` のみを冪等に保証する
   * - `webhookEventId` が指定されている場合は同一トランザクション（または原子的確定処理）でイベント状態を `succeeded` に更新する
   */
  atomicConfirmOrderPayment(params: {
    orderId: string;
    stripeSessionId: string;
    paidAmount: number;
    webhookEventId?: string;
  }): Promise<{
    updatedOrder: OrderRecordForPayment | null;
    transitionedFromUnpaid: boolean;
  }>;

  /**
   * 決済成功済みだがDB上で注文がキャンセル済み（取消状態）である不整合を検知した場合に、
   * DBトランザクション内で返金案件 (order_refund_requests) を永続化し、
   * 注文の refund_status を 'pending'、requires_manual_attention を true に更新する
   */
  recordCancelledPaymentDiscrepancy?(params: {
    orderId: string;
    stripeSessionId: string;
    paymentIntentId?: string;
    amount: number;
    currency?: string;
    webhookEventId?: string;
    reason?: string;
  }): Promise<{
    ok: boolean;
    refundRequestId?: string;
    alreadyRecorded?: boolean;
  }>;
}

export type PaymentConfirmationResult =
  | {
      ok: true;
      idempotentReplay: boolean;
      transitionedToPending: boolean;
      orderId: string;
      currentStatus: string;
    }
  | {
      ok: false;
      code: 'CANCELLED_PAYMENT_DISCREPANCY';
      message: string;
      status: 409;
      retryable: false;
      discrepancyRecorded: boolean;
      orderId: string;
      stripeSessionId: string;
      paymentIntentId?: string;
    }
  | {
      ok: false;
      code: PaymentRejectionCode;
      message: string;
      status: 400 | 404 | 409;
      retryable: boolean;
      permanentFailureRecorded?: boolean;
    };

async function recordPermanentValidationFailure(params: {
  repo: IPaymentConfirmationRepository;
  webhookEventId?: string;
  sessionId: string;
  orderId: string;
  code: PaymentRejectionCode;
  message: string;
}): Promise<boolean> {
  const { repo, webhookEventId, sessionId, orderId, code, message } = params;
  console.error(
    `[StripeValidationAlert][PERMANENT_FAILURE] code=${code} sessionId=${sessionId} orderId=${orderId} eventId=${webhookEventId ?? 'none'} message=${message}`
  );
  if (!webhookEventId) return false;
  try {
    await repo.markStripeWebhookEventPermanentFailure({
      eventId: webhookEventId,
      sessionId,
      orderId,
      errorCode: code,
      errorMessage: message,
    });
    return true;
  } catch (err) {
    console.error('[StripeValidationAlert] Failed to persist permanent webhook failure:', err);
    return false;
  }
}

/**
 * Stripe Checkout Session の検証と注文決済状態の冪等・原子的確定処理
 */
export async function verifyAndConfirmStripePayment(params: {
  session: StripeCheckoutSessionLike;
  repo: IPaymentConfirmationRepository;
  webhookEventId?: string;
  staleLockTimeoutMs?: number;
}): Promise<PaymentConfirmationResult> {
  const { session, repo, webhookEventId, staleLockTimeoutMs } = params;

  // 1. 注文IDの対応検証
  const orderId = session.metadata?.orderId;
  if (!orderId) {
    const message = 'Stripeセッションに関連付けられた注文ID (metadata.orderId) が見つかりません';
    const recorded = await recordPermanentValidationFailure({
      repo,
      webhookEventId,
      sessionId: session.id,
      orderId: 'UNKNOWN_ORDER',
      code: 'MISSING_ORDER_ID',
      message,
    });
    return {
      ok: false,
      code: 'MISSING_ORDER_ID',
      message,
      status: 400,
      retryable: false,
      permanentFailureRecorded: recorded,
    };
  }

  // 2. 支払い完了ステータスの検証 (未決済・失敗時はキッチンに表示しない)
  if (session.payment_status !== 'paid') {
    const message = `決済が完了していません (payment_status: ${session.payment_status})`;
    const recorded = await recordPermanentValidationFailure({
      repo,
      webhookEventId,
      sessionId: session.id,
      orderId,
      code: 'PAYMENT_NOT_PAID',
      message,
    });
    return {
      ok: false,
      code: 'PAYMENT_NOT_PAID',
      message,
      status: 400,
      retryable: false,
      permanentFailureRecorded: recorded,
    };
  }

  // 3. 通貨の検証 (日本円 JPY 必須)
  if (!session.currency || session.currency.toLowerCase() !== 'jpy') {
    const message = `不正な通貨が指定されています (currency: ${session.currency ?? 'null'})`;
    const recorded = await recordPermanentValidationFailure({
      repo,
      webhookEventId,
      sessionId: session.id,
      orderId,
      code: 'CURRENCY_MISMATCH',
      message,
    });
    return {
      ok: false,
      code: 'CURRENCY_MISMATCH',
      message,
      status: 400,
      retryable: false,
      permanentFailureRecorded: recorded,
    };
  }

  // 4. Webhook イベントID が指定されている場合、処理状態ロックを取得・確認する
  if (webhookEventId) {
    const acquisition = await repo.beginStripeWebhookEvent({
      eventId: webhookEventId,
      sessionId: session.id,
      orderId,
      staleLockTimeoutMs,
    });

    if (acquisition.state === 'already_succeeded') {
      const existingOrder = await repo.getOrderById(orderId);
      return {
        ok: true,
        idempotentReplay: true,
        transitionedToPending: false,
        orderId,
        currentStatus: existingOrder?.status ?? 'pending',
      };
    }

    if (acquisition.state === 'already_failed_permanent') {
      const statusMap: Record<PaymentRejectionCode, 400 | 404 | 409> = {
        MISSING_ORDER_ID: 400,
        PAYMENT_NOT_PAID: 400,
        CURRENCY_MISMATCH: 400,
        AMOUNT_MISMATCH: 400,
        ORDER_NOT_FOUND: 404,
        ORDER_CANCELLED: 409,
        WEBHOOK_IN_PROGRESS: 409,
      };
      return {
        ok: false,
        code: acquisition.errorCode,
        message: acquisition.errorMessage,
        status: statusMap[acquisition.errorCode] ?? 400,
        retryable: false,
        permanentFailureRecorded: true,
      };
    }

    if (acquisition.state === 'in_progress') {
      return {
        ok: false,
        code: 'WEBHOOK_IN_PROGRESS',
        message: `Webhookイベント (${webhookEventId}) は現在別プロセスで処理中です`,
        status: 409,
        retryable: true,
      };
    }
  }

  // 5. 内部注文の取得・検証および原子的決済確定
  //    注文更新前に一時的なDB障害 (例外) が発生した場合は processing ロックを解放し、
  //    呼び出し元へ例外を再送出して HTTP 500 (Stripe 再送対象) とする。
  try {
    const order = await repo.getOrderById(orderId);
    if (!order) {
      const message = `対応する注文が見つかりません (orderId: ${orderId})`;
      if (webhookEventId) {
        await repo.releaseStripeWebhookEventOnTransientError(webhookEventId, message);
      }
      return {
        ok: false,
        code: 'ORDER_NOT_FOUND',
        message,
        status: 404,
        retryable: true,
      };
    }

    if (session.amount_total === null || session.amount_total !== order.totalPrice) {
      const message = `決済金額 (${session.amount_total ?? 'null'}円) が注文金額 (${order.totalPrice}円) と一致しません`;
      const recorded = await recordPermanentValidationFailure({
        repo,
        webhookEventId,
        sessionId: session.id,
        orderId,
        code: 'AMOUNT_MISMATCH',
        message,
      });
      return {
        ok: false,
        code: 'AMOUNT_MISMATCH',
        message,
        status: 400,
        retryable: false,
        permanentFailureRecorded: recorded,
      };
    }

    const domainState: OrderDomainState = resolveOrderDomainState({
      status: order.status,
      payment_status: order.paymentStatus,
      production_status: order.productionStatus,
      fulfillment_status: order.fulfillmentStatus,
      cancellation_status: order.cancellationStatus,
    });

    if (domainState.cancellationStatus === 'cancelled') {
      const message = 'すでに取消済みの注文であるため決済確定できません';
      const recorded = await recordPermanentValidationFailure({
        repo,
        webhookEventId,
        sessionId: session.id,
        orderId,
        code: 'ORDER_CANCELLED',
        message,
      });
      return {
        ok: false,
        code: 'ORDER_CANCELLED',
        message,
        status: 409,
        retryable: false,
        permanentFailureRecorded: recorded,
      };
    }

    // 6. 条件付き原子的更新 + Webhook イベント succeeded 確定
    //    (status === 'unpaid' のときだけ 'pending' に進め、preparing/completed は絶対に巻き戻さない)
    const { updatedOrder, transitionedFromUnpaid } = await repo.atomicConfirmOrderPayment({
      orderId,
      stripeSessionId: session.id,
      paidAmount: order.totalPrice,
      webhookEventId,
    });

    if (!updatedOrder) {
      const message = '注文の更新対象が見つかりませんでした';
      if (webhookEventId) {
        await repo.releaseStripeWebhookEventOnTransientError(webhookEventId, message);
      }
      return {
        ok: false,
        code: 'ORDER_NOT_FOUND',
        message,
        status: 404,
        retryable: true,
      };
    }

    return {
      ok: true,
      idempotentReplay: !transitionedFromUnpaid,
      transitionedToPending: transitionedFromUnpaid,
      orderId,
      currentStatus: updatedOrder.status,
    };
  } catch (err) {
    if (webhookEventId) {
      const errMsg = err instanceof Error ? err.message : 'Unknown database error';
      try {
        await repo.releaseStripeWebhookEventOnTransientError(webhookEventId, errMsg);
      } catch (releaseErr) {
        console.error('[Webhook] Failed to release processing lock after transient error:', releaseErr);
      }
    }
    throw err;
  }
}
