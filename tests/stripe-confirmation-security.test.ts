/**
 * [Phase 0 - セキュリティ強化] 決済確定・Webhook偽装防止・セッション突合 10項目セキュリティ回帰テスト
 * (tests/stripe-confirmation-security.test.ts)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyAndConfirmStripePayment,
  type StripeCheckoutSessionLike,
  type IPaymentConfirmationRepository,
  type OrderRecordForPayment,
  type StripeWebhookEventRecord,
  type WebhookEventAcquisitionResult,
} from '../src/lib/stripeConfirmation.ts';

class SecurityMockPaymentRepo implements IPaymentConfirmationRepository {
  orders = new Map<string, OrderRecordForPayment>();
  events = new Map<string, StripeWebhookEventRecord>();
  confirmCallCount = 0;
  discrepancyCallCount = 0;

  async beginStripeWebhookEvent(params: {
    eventId: string;
    sessionId: string;
    orderId: string;
    staleLockTimeoutMs?: number;
  }): Promise<WebhookEventAcquisitionResult> {
    const existing = this.events.get(params.eventId);
    if (existing?.status === 'succeeded') {
      return { state: 'already_succeeded' };
    }
    if (existing?.status === 'failed_permanent') {
      return {
        state: 'already_failed_permanent',
        errorCode: existing.errorCode ?? 'PAYMENT_NOT_PAID',
        errorMessage: existing.errorMessage ?? 'Failed permanently',
      };
    }
    this.events.set(params.eventId, {
      eventId: params.eventId,
      sessionId: params.sessionId,
      orderId: params.orderId,
      status: 'processing',
      attemptCount: (existing?.attemptCount ?? 0) + 1,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { state: 'acquired', attemptCount: 1 };
  }

  async releaseStripeWebhookEventOnTransientError(eventId: string): Promise<void> {
    this.events.delete(eventId);
  }

  async markStripeWebhookEventPermanentFailure(params: {
    eventId: string;
    sessionId: string;
    orderId: string;
    errorCode: any;
    errorMessage: string;
  }): Promise<void> {
    this.events.set(params.eventId, {
      eventId: params.eventId,
      sessionId: params.sessionId,
      orderId: params.orderId,
      status: 'failed_permanent',
      errorCode: params.errorCode,
      errorMessage: params.errorMessage,
      attemptCount: 1,
      startedAt: Date.now(),
      processedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  async getOrderById(orderId: string): Promise<OrderRecordForPayment | null> {
    const o = this.orders.get(orderId);
    return o ? { ...o } : null;
  }

  async atomicConfirmOrderPayment(params: {
    orderId: string;
    stripeSessionId: string;
    paidAmount: number;
    webhookEventId?: string;
  }): Promise<{ updatedOrder: OrderRecordForPayment | null; transitionedFromUnpaid: boolean }> {
    this.confirmCallCount++;
    const o = this.orders.get(params.orderId);
    if (!o) return { updatedOrder: null, transitionedFromUnpaid: false };

    // DB側の防御: orders.stripe_session_id と params.stripeSessionId の一致検証
    if (!o.stripeSessionId || o.stripeSessionId !== params.stripeSessionId) {
      return { updatedOrder: null, transitionedFromUnpaid: false };
    }

    // キャンセル済みは復活させない
    if (o.status === 'cancelled' || o.cancellationStatus === 'cancelled') {
      return { updatedOrder: null, transitionedFromUnpaid: false };
    }

    const transitioned = o.status === 'unpaid';
    if (transitioned) {
      o.status = 'pending';
      o.paymentStatus = 'paid';
      o.productionStatus = 'pending';
    } else {
      o.paymentStatus = 'paid';
    }

    if (params.webhookEventId) {
      this.events.set(params.webhookEventId, {
        eventId: params.webhookEventId,
        sessionId: params.stripeSessionId,
        orderId: params.orderId,
        status: 'succeeded',
        attemptCount: 1,
        startedAt: Date.now(),
        processedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    return { updatedOrder: o, transitionedFromUnpaid: transitioned };
  }

  async recordCancelledPaymentDiscrepancy(params: {
    orderId: string;
    stripeSessionId: string;
    paymentIntentId?: string | null;
    amount: number;
    currency: string;
    webhookEventId?: string;
    reason?: string;
  }): Promise<{ ok: boolean; refundRequestId?: string }> {
    this.discrepancyCallCount++;
    const o = this.orders.get(params.orderId);
    if (o) {
      o.requiresManualAttention = true;
      o.refundStatus = 'pending';
    }
    if (params.webhookEventId) {
      this.events.set(params.webhookEventId, {
        eventId: params.webhookEventId,
        sessionId: params.stripeSessionId,
        orderId: params.orderId,
        status: 'succeeded',
        attemptCount: 1,
        startedAt: Date.now(),
        processedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return { ok: true, refundRequestId: `ref_${Date.now()}` };
  }
}

describe('[Phase 0 セキュリティ強化] 10項目セキュリティ回帰テスト', () => {
  let repo: SecurityMockPaymentRepo;

  beforeEach(() => {
    repo = new SecurityMockPaymentRepo();
    // 正常な未払い注文
    repo.orders.set('ord_sec_01', {
      id: 'ord_sec_01',
      orderNumber: '5001',
      totalPrice: 400,
      status: 'unpaid',
      paymentStatus: 'unpaid',
      productionStatus: 'pending',
      cancellationStatus: 'active',
      stripeSessionId: 'cs_sec_valid_01',
    });
  });

  // 1. 未払いSessionの偽装paidイベントで決済確定されない
  it('1. 未払いSession (payment_status !== paid) のイベントで注文が確定されないこと', async () => {
    const session: StripeCheckoutSessionLike = {
      id: 'cs_sec_valid_01',
      payment_status: 'unpaid', // 未払い！
      amount_total: 400,
      currency: 'jpy',
      metadata: { orderId: 'ord_sec_01' },
    };

    const res = await verifyAndConfirmStripePayment({ session, repo, webhookEventId: 'evt_sec_1' });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, 'PAYMENT_NOT_PAID');
      assert.equal(res.status, 400);
    }
    assert.equal(repo.orders.get('ord_sec_01')?.status, 'unpaid', '注文はunpaidのまま維持されること');
    assert.equal(repo.confirmCallCount, 0, 'atomicConfirmOrderPayment は呼ばれないこと');
  });

  // 2. 別注文の支払済みSessionを流用しても確定されない (Cross-Session スプーフィング遮断)
  it('2. 別注文の支払済みSessionを流用した場合、SESSION_ID_MISMATCH で安全に拒絶されること', async () => {
    const stolenSession: StripeCheckoutSessionLike = {
      id: 'cs_sec_stolen_session_999', // 別注文のセッション！
      payment_status: 'paid',
      amount_total: 400,
      currency: 'jpy',
      metadata: { orderId: 'ord_sec_01' },
    };

    const res = await verifyAndConfirmStripePayment({ session: stolenSession, repo, webhookEventId: 'evt_sec_2' });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, 'SESSION_ID_MISMATCH');
      assert.equal(res.status, 400);
    }
    assert.equal(repo.orders.get('ord_sec_01')?.status, 'unpaid', '注文はunpaidのまま維持されること');
    assert.equal(repo.confirmCallCount, 0);
  });

  // 3. DBのSession IDが空の場合に確定されない (未初期化注文の保護)
  it('3. 注文側の stripeSessionId が空または未設定の場合、SESSION_ID_NOT_CONFIGURED で拒絶されること', async () => {
    repo.orders.get('ord_sec_01')!.stripeSessionId = null;

    const session: StripeCheckoutSessionLike = {
      id: 'cs_sec_valid_01',
      payment_status: 'paid',
      amount_total: 400,
      currency: 'jpy',
      metadata: { orderId: 'ord_sec_01' },
    };

    const res = await verifyAndConfirmStripePayment({ session, repo, webhookEventId: 'evt_sec_3' });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, 'SESSION_ID_NOT_CONFIGURED');
      assert.equal(res.status, 400);
    }
    assert.equal(repo.orders.get('ord_sec_01')?.status, 'unpaid');
    assert.equal(repo.confirmCallCount, 0);
  });

  // 4. metadata.orderId 不一致を拒否する
  it('4. metadata.orderId が存在しないか、存在しない注文IDの場合に確実に拒絶されること', async () => {
    // 4-A: orderId 未設定
    const noOrderIdSession: StripeCheckoutSessionLike = {
      id: 'cs_sec_valid_01',
      payment_status: 'paid',
      amount_total: 400,
      currency: 'jpy',
      metadata: {},
    };
    const resA = await verifyAndConfirmStripePayment({ session: noOrderIdSession, repo });
    assert.equal(resA.ok, false);
    if (!resA.ok) assert.equal(resA.code, 'MISSING_ORDER_ID');

    // 4-B: 存在しない orderId
    const notFoundSession: StripeCheckoutSessionLike = {
      id: 'cs_sec_valid_01',
      payment_status: 'paid',
      amount_total: 400,
      currency: 'jpy',
      metadata: { orderId: 'ord_nonexistent_999' },
    };
    const resB = await verifyAndConfirmStripePayment({ session: notFoundSession, repo });
    assert.equal(resB.ok, false);
    if (!resB.ok) assert.equal(resB.code, 'ORDER_NOT_FOUND');
  });

  // 5. 金額不一致・通貨不一致を拒否する
  it('5. 金額不一致 (AMOUNT_MISMATCH) および通貨不一致 (CURRENCY_MISMATCH) を拒絶すること', async () => {
    // 金額改ざん
    const amountTamperedSession: StripeCheckoutSessionLike = {
      id: 'cs_sec_valid_01',
      payment_status: 'paid',
      amount_total: 200, // 注文は400円！
      currency: 'jpy',
      metadata: { orderId: 'ord_sec_01' },
    };
    const resAmount = await verifyAndConfirmStripePayment({ session: amountTamperedSession, repo });
    assert.equal(resAmount.ok, false);
    if (!resAmount.ok) assert.equal(resAmount.code, 'AMOUNT_MISMATCH');

    // 通貨不正
    const currencyTamperedSession: StripeCheckoutSessionLike = {
      id: 'cs_sec_valid_01',
      payment_status: 'paid',
      amount_total: 400,
      currency: 'usd',
      metadata: { orderId: 'ord_sec_01' },
    };
    const resCurrency = await verifyAndConfirmStripePayment({ session: currencyTamperedSession, repo });
    assert.equal(resCurrency.ok, false);
    if (!resCurrency.ok) assert.equal(resCurrency.code, 'CURRENCY_MISMATCH');
  });

  // 6. 正常な支払済みSessionは一度だけ確定する
  it('6. 正常な支払済みSessionで注文が pending/paid に確定すること', async () => {
    const validSession: StripeCheckoutSessionLike = {
      id: 'cs_sec_valid_01',
      payment_status: 'paid',
      mode: 'payment',
      status: 'complete',
      amount_total: 400,
      currency: 'jpy',
      metadata: { orderId: 'ord_sec_01' },
    };

    const res = await verifyAndConfirmStripePayment({ session: validSession, repo, webhookEventId: 'evt_sec_6' });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.transitionedToPending, true);
      assert.equal(res.idempotentReplay, false);
    }
    const updated = repo.orders.get('ord_sec_01')!;
    assert.equal(updated.status, 'pending');
    assert.equal(updated.paymentStatus, 'paid');
    assert.equal(repo.confirmCallCount, 1);
  });

  // 7. Webhook再送で状態が変化しない (冪等性)
  it('7. Webhook再送時に状態が巻き戻らず、二重更新なしで 200 OK 応答すること', async () => {
    const validSession: StripeCheckoutSessionLike = {
      id: 'cs_sec_valid_01',
      payment_status: 'paid',
      amount_total: 400,
      currency: 'jpy',
      metadata: { orderId: 'ord_sec_01' },
    };

    // 1回目
    await verifyAndConfirmStripePayment({ session: validSession, repo, webhookEventId: 'evt_sec_replay' });
    // 調理中に進む
    repo.orders.get('ord_sec_01')!.status = 'preparing';

    // 2回目再送
    const replayRes = await verifyAndConfirmStripePayment({
      session: validSession,
      repo,
      webhookEventId: 'evt_sec_replay',
    });
    assert.equal(replayRes.ok, true);
    if (replayRes.ok) {
      assert.equal(replayRes.idempotentReplay, true);
      assert.equal(replayRes.transitionedToPending, false);
      assert.equal(replayRes.currentStatus, 'preparing', '調理中ステータスが巻き戻らないこと');
    }
    assert.equal(repo.confirmCallCount, 1, '二重実行されないこと');
  });

  // 8. キャンセル済み注文は厨房に復活しない (返金案件永続化)
  it('8. キャンセル済み注文に決済成功が到着した場合、厨房に復活せず返金案件として永続化すること', async () => {
    repo.orders.get('ord_sec_01')!.status = 'cancelled';
    repo.orders.get('ord_sec_01')!.cancellationStatus = 'cancelled';

    const session: StripeCheckoutSessionLike = {
      id: 'cs_sec_valid_01',
      payment_status: 'paid',
      amount_total: 400,
      currency: 'jpy',
      metadata: { orderId: 'ord_sec_01' },
      payment_intent: 'pi_cancelled_test',
    };

    const res = await verifyAndConfirmStripePayment({ session, repo, webhookEventId: 'evt_sec_cancelled' });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, 'CANCELLED_PAYMENT_DISCREPANCY');
      assert.equal(res.status, 409);
    }
    const order = repo.orders.get('ord_sec_01')!;
    assert.equal(order.status, 'cancelled', 'cancelledのまま維持されること');
    assert.equal(order.requiresManualAttention, true);
    assert.equal(repo.discrepancyCallCount, 1, '返金案件が永続化されること');
  });

  // 9. Stripe API障害時に誤確定しない (セッション未完了時のガード)
  it('9. セッション状態が complete でない場合 (SESSION_NOT_COMPLETED) は決済確定しないこと', async () => {
    const incompleteSession: StripeCheckoutSessionLike = {
      id: 'cs_sec_valid_01',
      payment_status: 'paid',
      status: 'open', // まだ open 状態！
      amount_total: 400,
      currency: 'jpy',
      metadata: { orderId: 'ord_sec_01' },
    };

    const res = await verifyAndConfirmStripePayment({ session: incompleteSession, repo });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, 'SESSION_NOT_COMPLETED');
    }
    assert.equal(repo.orders.get('ord_sec_01')?.status, 'unpaid');
  });

  // 10. 正当な非同期決済のイベント処理を妨げない (Stripe API実機照合連携)
  it('10. payment_intent が成功していない場合 (PAYMENT_INTENT_NOT_SUCCEEDED) は安全に拒絶すること', async () => {
    const pendingPiSession: StripeCheckoutSessionLike = {
      id: 'cs_sec_valid_01',
      payment_status: 'paid',
      status: 'complete',
      payment_intent: { id: 'pi_test_123', status: 'requires_action' }, // まだ succeeded でない！
      amount_total: 400,
      currency: 'jpy',
      metadata: { orderId: 'ord_sec_01' },
    };

    const res = await verifyAndConfirmStripePayment({ session: pendingPiSession, repo });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, 'PAYMENT_INTENT_NOT_SUCCEEDED');
    }
    assert.equal(repo.orders.get('ord_sec_01')?.status, 'unpaid');
  });
});
