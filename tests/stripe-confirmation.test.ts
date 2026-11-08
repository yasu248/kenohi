import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyAndConfirmStripePayment,
  type IPaymentConfirmationRepository,
  type OrderRecordForPayment,
  type StripeCheckoutSessionLike,
} from '../src/lib/stripeConfirmation.ts';

class MockPaymentRepository implements IPaymentConfirmationRepository {
  public claimedEvents: Set<string> = new Set();
  public orders: Map<string, OrderRecordForPayment> = new Map();

  async claimStripeWebhookEvent(eventId: string): Promise<boolean> {
    if (this.claimedEvents.has(eventId)) return false;
    this.claimedEvents.add(eventId);
    return true;
  }

  async getOrderById(orderId: string): Promise<OrderRecordForPayment | null> {
    return this.orders.get(orderId) || null;
  }

  async atomicConfirmOrderPayment(params: {
    orderId: string;
    stripeSessionId: string;
    paidAmount: number;
  }): Promise<{ updatedOrder: OrderRecordForPayment | null; transitionedFromUnpaid: boolean }> {
    const o = this.orders.get(params.orderId);
    if (!o) return { updatedOrder: null, transitionedFromUnpaid: false };

    if (o.status === 'unpaid') {
      o.status = 'pending';
      o.paymentStatus = 'paid';
      o.productionStatus = 'pending';
      o.fulfillmentStatus = 'not_handed_over';
      o.cancellationStatus = 'active';
      o.stripeSessionId = params.stripeSessionId;
      return { updatedOrder: o, transitionedFromUnpaid: true };
    }

    // すでに preparing / completed の場合は製造状態を巻き戻さない
    o.paymentStatus = 'paid';
    o.stripeSessionId = params.stripeSessionId;
    return { updatedOrder: o, transitionedFromUnpaid: false };
  }
}

describe('[Phase 0-D] Stripe 決済確認処理の安全化テスト', () => {
  let repo: MockPaymentRepository;

  beforeEach(() => {
    repo = new MockPaymentRepository();
    repo.orders.set('ord_unpaid_1', {
      id: 'ord_unpaid_1',
      orderNumber: '3201',
      totalPrice: 1050,
      status: 'unpaid',
      paymentStatus: 'unpaid',
      productionStatus: 'pending',
    });
    repo.orders.set('ord_cooking_2', {
      id: 'ord_cooking_2',
      orderNumber: '3202',
      totalPrice: 800,
      status: 'preparing',
      paymentStatus: 'paid',
      productionStatus: 'preparing',
    });
  });

  it('1. 正常な未決済注文の確定: status=unpaid から pending へ正しく遷移すること', async () => {
    const session: StripeCheckoutSessionLike = {
      id: 'cs_test_123',
      payment_status: 'paid',
      amount_total: 1050,
      currency: 'jpy',
      metadata: { orderId: 'ord_unpaid_1', orderNumber: '3201' },
    };

    const res = await verifyAndConfirmStripePayment({ session, repo });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.transitionedToPending, true);
      assert.equal(res.idempotentReplay, false);
      assert.equal(res.currentStatus, 'pending');
    }

    const saved = await repo.getOrderById('ord_unpaid_1');
    assert.equal(saved?.status, 'pending');
    assert.equal(saved?.paymentStatus, 'paid');
    assert.equal(saved?.stripeSessionId, 'cs_test_123');
  });

  it('2. 状態遷移ガード: すでに調理中(preparing)の注文に対して決済確認が再送されても pending に巻き戻らないこと', async () => {
    const session: StripeCheckoutSessionLike = {
      id: 'cs_test_delayed',
      payment_status: 'paid',
      amount_total: 800,
      currency: 'jpy',
      metadata: { orderId: 'ord_cooking_2', orderNumber: '3202' },
    };

    const res = await verifyAndConfirmStripePayment({ session, repo });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.transitionedToPending, false, 'pendingへの再遷移は発生しない');
      assert.equal(res.idempotentReplay, true);
      assert.equal(res.currentStatus, 'preparing', '調理中ステータスが維持される');
    }

    const saved = await repo.getOrderById('ord_cooking_2');
    assert.equal(saved?.status, 'preparing');
  });

  it('3. Webhook重複受信の排除: 同一 event.id の再送を冪等に処理すること', async () => {
    const session: StripeCheckoutSessionLike = {
      id: 'cs_test_webhook_1',
      payment_status: 'paid',
      amount_total: 1050,
      currency: 'jpy',
      metadata: { orderId: 'ord_unpaid_1' },
    };

    // 1回目 (初回受信)
    const firstRes = await verifyAndConfirmStripePayment({
      session,
      repo,
      webhookEventId: 'evt_stripe_duplicate_test',
    });
    assert.equal(firstRes.ok, true);
    if (firstRes.ok) assert.equal(firstRes.transitionedToPending, true);

    // 2回目 (再送・重複イベント)
    const secondRes = await verifyAndConfirmStripePayment({
      session,
      repo,
      webhookEventId: 'evt_stripe_duplicate_test',
    });
    assert.equal(secondRes.ok, true);
    if (secondRes.ok) {
      assert.equal(secondRes.idempotentReplay, true);
      assert.equal(secondRes.transitionedToPending, false);
    }
  });

  it('4. 金額不一致・通貨不一致・未決済ステータスの検出: 不正なセッションを400でブロックすること', async () => {
    // 未決済 (unpaid)
    const unpaidSession: StripeCheckoutSessionLike = {
      id: 'cs_test_unpaid',
      payment_status: 'unpaid',
      amount_total: 1050,
      currency: 'jpy',
      metadata: { orderId: 'ord_unpaid_1' },
    };
    const unpaidRes = await verifyAndConfirmStripePayment({ session: unpaidSession, repo });
    assert.equal(unpaidRes.ok, false);
    if (!unpaidRes.ok) assert.equal(unpaidRes.code, 'PAYMENT_NOT_PAID');

    // 金額不一致 (注文1050円に対しセッション500円)
    const mismatchSession: StripeCheckoutSessionLike = {
      id: 'cs_test_mismatch',
      payment_status: 'paid',
      amount_total: 500,
      currency: 'jpy',
      metadata: { orderId: 'ord_unpaid_1' },
    };
    const mismatchRes = await verifyAndConfirmStripePayment({ session: mismatchSession, repo });
    assert.equal(mismatchRes.ok, false);
    if (!mismatchRes.ok) assert.equal(mismatchRes.code, 'AMOUNT_MISMATCH');

    // 通貨不一致 (USD)
    const usdSession: StripeCheckoutSessionLike = {
      id: 'cs_test_usd',
      payment_status: 'paid',
      amount_total: 1050,
      currency: 'usd',
      metadata: { orderId: 'ord_unpaid_1' },
    };
    const usdRes = await verifyAndConfirmStripePayment({ session: usdSession, repo });
    assert.equal(usdRes.ok, false);
    if (!usdRes.ok) assert.equal(usdRes.code, 'CURRENCY_MISMATCH');
  });
});
