import { resolveOrderDomainState, type OrderDomainState } from './orderStatus.ts';

/**
 * Phase 0-D: Stripe 決済確認処理の共通化・冪等性・状態遷移ガード
 *
 * 要件:
 * 1. `POST /api/orders/confirm` と `POST /api/webhooks/stripe` の確認ロジックを1つに共通化
 * 2. Stripe Session と内部注文 (orderId) の対応・支払済み金額 (`amount_total`)・通貨 (`jpy`)・支払いステータス (`paid`) を厳格に検証
 * 3. 決済状態を冪等に更新する
 * 4. すでに `preparing`（調理中）や `completed`（呼出中）、`handed_over`（受渡完了）に進んでいる注文を決して `pending` に巻き戻さない
 * 5. Webhook イベントID (`event.id`) の重複受信を記録・排除する
 * 6. 決済失敗・未完了 (`payment_status !== 'paid'`) の場合は製造画面へ表示しない (`unpaid` または `failed` のまま維持)
 */

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
  stripeSessionId?: string | null;
}

export interface IPaymentConfirmationRepository {
  /** Webhook イベントID が既に処理済みか確認し、未処理なら記録する (原子的 INSERT ON CONFLICT DO NOTHING) */
  claimStripeWebhookEvent(eventId: string, sessionId: string, orderId: string): Promise<boolean>;

  /** 注文を取得する */
  getOrderById(orderId: string): Promise<OrderRecordForPayment | null>;

  /**
   * 条件付き原子的更新:
   * - 注文が `status = 'unpaid'` の場合のみ `status = 'pending'`, `production_status = 'pending'`, `payment_status = 'paid'` に進める
   * - すでに `status IN ('pending', 'preparing', 'completed', 'cancelled')` に進んでいる場合は、
   *   製造状態 (`status`, `production_status`) を一切巻き戻さず、`payment_status = 'paid'` と `stripe_session_id` のみを冪等に保証する
   */
  atomicConfirmOrderPayment(params: {
    orderId: string;
    stripeSessionId: string;
    paidAmount: number;
  }): Promise<{
    updatedOrder: OrderRecordForPayment | null;
    transitionedFromUnpaid: boolean;
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
      code:
        | 'MISSING_ORDER_ID'
        | 'PAYMENT_NOT_PAID'
        | 'ORDER_NOT_FOUND'
        | 'CURRENCY_MISMATCH'
        | 'AMOUNT_MISMATCH'
        | 'ORDER_CANCELLED';
      message: string;
      status: 400 | 404 | 409;
    };

/**
 * Stripe Checkout Session の検証と注文決済状態の冪等・原子的確定処理
 */
export async function verifyAndConfirmStripePayment(params: {
  session: StripeCheckoutSessionLike;
  repo: IPaymentConfirmationRepository;
  webhookEventId?: string;
}): Promise<PaymentConfirmationResult> {
  const { session, repo, webhookEventId } = params;

  // 1. 注文IDの対応検証
  const orderId = session.metadata?.orderId;
  if (!orderId) {
    return {
      ok: false,
      code: 'MISSING_ORDER_ID',
      message: 'Stripeセッションに関連付けられた注文ID (metadata.orderId) が見つかりません',
      status: 400,
    };
  }

  // 2. 支払い完了ステータスの検証 (未決済・失敗時はキッチンに表示しない)
  if (session.payment_status !== 'paid') {
    return {
      ok: false,
      code: 'PAYMENT_NOT_PAID',
      message: `決済が完了していません (payment_status: ${session.payment_status})`,
      status: 400,
    };
  }

  // 3. 通貨の検証 (日本円 JPY 必須)
  if (!session.currency || session.currency.toLowerCase() !== 'jpy') {
    return {
      ok: false,
      code: 'CURRENCY_MISMATCH',
      message: `不正な通貨が指定されています (currency: ${session.currency ?? 'null'})`,
      status: 400,
    };
  }

  // 4. Webhook イベントID が指定されている場合、重複イベントを冪等にスキップ
  if (webhookEventId) {
    const isFirstDelivery = await repo.claimStripeWebhookEvent(webhookEventId, session.id, orderId);
    if (!isFirstDelivery) {
      const existingOrder = await repo.getOrderById(orderId);
      return {
        ok: true,
        idempotentReplay: true,
        transitionedToPending: false,
        orderId,
        currentStatus: existingOrder?.status ?? 'pending',
      };
    }
  }

  // 5. 内部注文の存在と金額一致の検証
  const order = await repo.getOrderById(orderId);
  if (!order) {
    return {
      ok: false,
      code: 'ORDER_NOT_FOUND',
      message: `対応する注文が見つかりません (orderId: ${orderId})`,
      status: 404,
    };
  }

  if (session.amount_total !== null && session.amount_total !== order.totalPrice) {
    return {
      ok: false,
      code: 'AMOUNT_MISMATCH',
      message: `決済金額 (${session.amount_total}円) が注文金額 (${order.totalPrice}円) と一致しません`,
      status: 400,
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
    return {
      ok: false,
      code: 'ORDER_CANCELLED',
      message: 'すでに取消済みの注文であるため決済確定できません',
      status: 409,
    };
  }

  // 6. 条件付き原子的更新 (status === 'unpaid' のときだけ 'pending' に進め、preparing/completed は絶対に巻き戻さない)
  const { updatedOrder, transitionedFromUnpaid } = await repo.atomicConfirmOrderPayment({
    orderId,
    stripeSessionId: session.id,
    paidAmount: order.totalPrice,
  });

  if (!updatedOrder) {
    return {
      ok: false,
      code: 'ORDER_NOT_FOUND',
      message: '注文の更新対象が見つかりませんでした',
      status: 404,
    };
  }

  return {
    ok: true,
    idempotentReplay: !transitionedFromUnpaid,
    transitionedToPending: transitionedFromUnpaid,
    orderId,
    currentStatus: updatedOrder.status,
  };
}
