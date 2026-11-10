import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyAndConfirmStripePayment,
  type IPaymentConfirmationRepository,
  type OrderRecordForPayment,
  type WebhookEventAcquisitionResult,
} from '../src/lib/stripeConfirmation.ts';
import {
  executeOrderRefund,
  type IRefundStripeClient,
} from '../src/lib/refundManager.ts';
import { validateEnvironmentSafety, assertStagingEnvironmentSafe } from '../src/lib/envGuard.ts';
import type { OrderRefundRequestRecord } from '../src/lib/store.ts';

class MockRefundRepo implements IPaymentConfirmationRepository {
  public orders: Map<string, OrderRecordForPayment> = new Map();
  public refundRequests: Map<string, any> = new Map();
  public webhookEvents: Map<string, any> = new Map();

  async beginStripeWebhookEvent(params: {
    eventId: string;
    sessionId: string;
    orderId: string;
  }): Promise<WebhookEventAcquisitionResult> {
    const existing = this.webhookEvents.get(params.eventId);
    if (existing?.status === 'succeeded') {
      return { state: 'already_succeeded' };
    }
    this.webhookEvents.set(params.eventId, { status: 'processing', orderId: params.orderId });
    return { state: 'acquired', attemptCount: 1 };
  }

  async releaseStripeWebhookEventOnTransientError(eventId: string): Promise<void> {
    this.webhookEvents.delete(eventId);
  }

  async markStripeWebhookEventPermanentFailure(params: {
    eventId: string;
    errorCode: any;
    errorMessage: string;
  }): Promise<void> {
    this.webhookEvents.set(params.eventId, {
      status: 'failed_permanent',
      errorCode: params.errorCode,
      errorMessage: params.errorMessage,
    });
  }

  async getOrderById(orderId: string): Promise<OrderRecordForPayment | null> {
    return this.orders.get(orderId) ?? null;
  }

  async atomicConfirmOrderPayment(params: {
    orderId: string;
    stripeSessionId: string;
  }): Promise<{ updatedOrder: OrderRecordForPayment | null; transitionedFromUnpaid: boolean }> {
    const order = this.orders.get(params.orderId);
    if (!order) return { updatedOrder: null, transitionedFromUnpaid: false };
    order.status = 'pending';
    order.paymentStatus = 'paid';
    return { updatedOrder: order, transitionedFromUnpaid: true };
  }

  async recordCancelledPaymentDiscrepancy(params: {
    orderId: string;
    stripeSessionId: string;
    paymentIntentId?: string;
    amount: number;
    currency?: string;
    webhookEventId?: string;
    reason?: string;
  }): Promise<{ ok: boolean; refundRequestId?: string; alreadyRecorded?: boolean }> {
    const existing = this.refundRequests.get(params.orderId);
    const id = existing?.id ?? `refreq_${params.orderId}`;
    this.refundRequests.set(params.orderId, {
      id,
      orderId: params.orderId,
      stripeSessionId: params.stripeSessionId,
      paymentIntentId: params.paymentIntentId,
      amount: params.amount,
      targetRefundAmount: params.amount,
      refundStatus: 'pending',
      requiresManualAttention: true,
      lastError: params.reason,
    });

    const order = this.orders.get(params.orderId);
    if (order) {
      order.refundStatus = 'pending';
      order.requiresManualAttention = true;
    }

    if (params.webhookEventId) {
      this.webhookEvents.set(params.webhookEventId, { status: 'succeeded' });
    }

    return { ok: true, refundRequestId: id, alreadyRecorded: Boolean(existing) };
  }
}

describe('[Phase 0-G] 決済成功・注文取消競合の監査・返金案件管理・安全ガードテスト', () => {
  it('1. 決済成功後・Webhook到着前のキャンセル: CANCELLED_PAYMENT_DISCREPANCY を返し返金案件を永続化すること', async () => {
    const repo = new MockRefundRepo();
    repo.orders.set('ord_cancelled_1', {
      id: 'ord_cancelled_1',
      orderNumber: '3101',
      totalPrice: 1300,
      status: 'cancelled',
      paymentStatus: 'unpaid',
      cancellationStatus: 'cancelled',
      productionStatus: 'pending',
      fulfillmentStatus: 'not_handed_over',
    });

    const result = await verifyAndConfirmStripePayment({
      session: {
        id: 'cs_test_delayed_1',
        payment_status: 'paid',
        amount_total: 1300,
        currency: 'jpy',
        metadata: { orderId: 'ord_cancelled_1' },
        payment_intent: 'pi_test_delayed_1',
      },
      repo,
      webhookEventId: 'evt_delayed_1',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'CANCELLED_PAYMENT_DISCREPANCY');
    assert.equal(result.discrepancyRecorded, true);
    assert.equal(result.orderId, 'ord_cancelled_1');

    // 返金案件が永続化され、注文状態が更新されていること
    const refundCase = repo.refundRequests.get('ord_cancelled_1');
    assert.ok(refundCase);
    assert.equal(refundCase.amount, 1300);
    assert.equal(refundCase.refundStatus, 'pending');
    assert.equal(refundCase.requiresManualAttention, true);
    assert.equal(refundCase.paymentIntentId, 'pi_test_delayed_1');

    // 注文自体は cancelled のままで、誤って pending や調理中に進んでいないこと
    const order = repo.orders.get('ord_cancelled_1');
    assert.equal(order?.status, 'cancelled');
    assert.equal(order?.refundStatus, 'pending');
    assert.equal(order?.requiresManualAttention, true);
  });

  it('2. 返金案件の重複登録防止: 同一注文で複数回Webhookが届いても案件が重複せず冪等に保たれること', async () => {
    const repo = new MockRefundRepo();
    repo.orders.set('ord_cancelled_2', {
      id: 'ord_cancelled_2',
      orderNumber: '3102',
      totalPrice: 1500,
      status: 'cancelled',
      paymentStatus: 'unpaid',
      cancellationStatus: 'cancelled',
    });

    // 1回目
    await repo.recordCancelledPaymentDiscrepancy({
      orderId: 'ord_cancelled_2',
      stripeSessionId: 'cs_test_2',
      paymentIntentId: 'pi_test_2',
      amount: 1500,
      webhookEventId: 'evt_2_first',
    });
    assert.equal(repo.refundRequests.size, 1);

    // 2回目（再送・重複）
    const res2 = await repo.recordCancelledPaymentDiscrepancy({
      orderId: 'ord_cancelled_2',
      stripeSessionId: 'cs_test_2',
      paymentIntentId: 'pi_test_2',
      amount: 1500,
      webhookEventId: 'evt_2_second',
    });

    assert.equal(res2.ok, true);
    assert.equal(res2.alreadyRecorded, true);
    assert.equal(repo.refundRequests.size, 1, '案件レコードが重複していないこと');
  });

  it('3. Stripe返金APIのタイムアウトと再照合復旧: タイムアウト後に照合して返金完了を確認できること', async () => {
    const refundCase: OrderRefundRequestRecord = {
      id: 'refreq_ord_to_1',
      orderId: 'ord_to_1',
      amount: 1200,
      currency: 'jpy',
      targetRefundAmount: 1200,
      refundStatus: 'pending',
      attemptCount: 0,
      requiresManualAttention: true,
      paymentIntentId: 'pi_timeout_1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    let createCalled = false;
    const mockStripeClient: IRefundStripeClient = {
      paymentIntents: {
        async retrieve(id: string) {
          if (!createCalled) {
            return { id, status: 'succeeded', amount_refunded: 0 } as any;
          }
          // タイムアウト後の再照合では Stripe 側で返金が反映されていたとする
          return {
            id,
            status: 'succeeded',
            amount_refunded: 1200,
            refunds: { data: [{ id: 're_recovered_123' }] },
          } as any;
        },
      },
      refunds: {
        async create() {
          createCalled = true;
          const timeoutErr: any = new Error('ETIMEDOUT: Connection to Stripe API timed out');
          timeoutErr.code = 'ETIMEDOUT';
          throw timeoutErr;
        },
      },
    };

    const execResult = await executeOrderRefund({
      refundCase,
      stripeClient: mockStripeClient,
      statusUpdater: async (params) => {
        refundCase.refundStatus = params.refundStatus;
        if (params.stripeRefundId !== undefined) refundCase.stripeRefundId = params.stripeRefundId;
        if (params.requiresManualAttention !== undefined)
          refundCase.requiresManualAttention = params.requiresManualAttention;
        return { ok: true };
      },
    });

    assert.equal(execResult.ok, true);
    assert.equal(execResult.code, 'STRIPE_TIMEOUT_RECOVERED');
    assert.equal(execResult.stripeRefundId, 're_recovered_123');
    assert.equal(execResult.requiresManualAttention, false);
  });

  it('4. 返金成功後のWebhook再送: すでに返金完了している案件に対する再実行をスキップすること (二重返金防止)', async () => {
    const refundCase: OrderRefundRequestRecord = {
      id: 'refreq_ord_done_1',
      orderId: 'ord_done_1',
      amount: 1000,
      currency: 'jpy',
      targetRefundAmount: 1000,
      refundStatus: 'succeeded',
      stripeRefundId: 're_already_done_999',
      attemptCount: 1,
      requiresManualAttention: false,
      paymentIntentId: 'pi_done_1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    let apiCalled = false;
    const mockStripeClient: IRefundStripeClient = {
      paymentIntents: {
        async retrieve() {
          return {} as any;
        },
      },
      refunds: {
        async create() {
          apiCalled = true;
          return { id: 're_new' } as any;
        },
      },
    };

    const res = await executeOrderRefund({
      refundCase,
      stripeClient: mockStripeClient,
      statusUpdater: async (params) => {
        refundCase.refundStatus = params.refundStatus;
        if (params.requiresManualAttention !== undefined)
          refundCase.requiresManualAttention = params.requiresManualAttention;
        return { ok: true };
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.code, 'ALREADY_REFUNDED');
    assert.equal(apiCalled, false, 'Stripe Refund APIが二重呼び出しされないこと');
  });

  it('5. 返金失敗時の管理者アラート: 永続的なエラー時に requires_manual_attention=true となること', async () => {
    const refundCase: OrderRefundRequestRecord = {
      id: 'refreq_ord_fail_1',
      orderId: 'ord_fail_1',
      amount: 800,
      currency: 'jpy',
      targetRefundAmount: 800,
      refundStatus: 'pending',
      attemptCount: 0,
      requiresManualAttention: false,
      paymentIntentId: 'pi_insufficient_funds',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const mockStripeClient: IRefundStripeClient = {
      paymentIntents: {
        async retrieve(id: string) {
          return { id, status: 'succeeded', amount_refunded: 0 } as any;
        },
      },
      refunds: {
        async create() {
          throw new Error('balance_insufficient: The account has insufficient funds to cover this refund.');
        },
      },
    };

    const res = await executeOrderRefund({
      refundCase,
      stripeClient: mockStripeClient,
      statusUpdater: async (params) => {
        refundCase.refundStatus = params.refundStatus;
        if (params.requiresManualAttention !== undefined)
          refundCase.requiresManualAttention = params.requiresManualAttention;
        return { ok: true };
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'FAILED');
    assert.equal(res.requiresManualAttention, true, '管理者対応要否が true に切り替わること');
  });

  it('6. 旧cancelled注文の保護: legacy_undetermined の注文に対してWebhookが届いても返金案件を作成しないこと', async () => {
    const repo = new MockRefundRepo();
    // 過去データ: status='cancelled' だが 4軸カラムが NULL
    repo.orders.set('ord_legacy_old_1', {
      id: 'ord_legacy_old_1',
      orderNumber: '1001',
      totalPrice: 1000,
      status: 'cancelled',
      paymentStatus: null,
      cancellationStatus: null,
    });

    const result = await verifyAndConfirmStripePayment({
      session: {
        id: 'cs_test_legacy_1',
        payment_status: 'paid',
        amount_total: 1000,
        currency: 'jpy',
        metadata: { orderId: 'ord_legacy_old_1' },
      },
      repo,
      webhookEventId: 'evt_legacy_1',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'ORDER_CANCELLED');
    assert.equal(repo.refundRequests.size, 0, '過去注文に対して返金案件は一切作成されないこと');
  });

  it('7. 環境変数ガード: 本番キー (sk_live_) および本番Supabase URLがステージング/テスト環境で検出された場合に遮断すること', () => {
    // 正常なテスト環境
    const valid = validateEnvironmentSafety({
      APP_ENV: 'staging',
      STRIPE_SECRET_KEY: 'sk_test_valid_key',
      SUPABASE_URL: 'https://staging-project.supabase.co',
    });
    assert.equal(valid.safe, true);

    // 本番Stripeキーが設定されている場合は遮断
    const prodStripe = validateEnvironmentSafety({
      APP_ENV: 'staging',
      STRIPE_SECRET_KEY: 'sk_live_dangerous_prod_key',
      SUPABASE_URL: 'https://staging-project.supabase.co',
    });
    assert.equal(prodStripe.safe, false);
    assert.match(prodStripe.errors[0], /sk_live_/);

    // assertStagingEnvironmentSafe が例外を投げること
    assert.throws(
      () =>
        assertStagingEnvironmentSafe({
          APP_ENV: 'staging',
          STRIPE_SECRET_KEY: 'sk_live_123',
        }),
      /Production Stripe key/
    );
  });
});
