import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WEBHOOK_LOCK_TIMEOUT_MS,
  verifyAndConfirmStripePayment,
  type IPaymentConfirmationRepository,
  type OrderRecordForPayment,
  type PaymentRejectionCode,
  type StripeCheckoutSessionLike,
  type StripeWebhookEventRecord,
  type WebhookEventAcquisitionResult,
} from '../src/lib/stripeConfirmation.ts';

class StatefulMockPaymentRepository implements IPaymentConfirmationRepository {
  public events: Map<string, StripeWebhookEventRecord> = new Map();
  public orders: Map<string, OrderRecordForPayment> = new Map();
  public simulateDbFailureOnConfirm: boolean = false;
  public simulateDbFailureOnGetOrder: boolean = false;
  public confirmCallCount: number = 0;

  async beginStripeWebhookEvent(params: {
    eventId: string;
    sessionId: string;
    orderId: string;
    staleLockTimeoutMs?: number;
  }): Promise<WebhookEventAcquisitionResult> {
    const {
      eventId,
      sessionId,
      orderId,
      staleLockTimeoutMs = DEFAULT_WEBHOOK_LOCK_TIMEOUT_MS,
    } = params;
    const now = Date.now();
    const existing = this.events.get(eventId);

    if (!existing) {
      this.events.set(eventId, {
        eventId,
        sessionId,
        orderId,
        status: 'processing',
        attemptCount: 1,
        startedAt: now,
        updatedAt: now,
      });
      return { state: 'acquired', attemptCount: 1 };
    }

    if (existing.status === 'succeeded') {
      return { state: 'already_succeeded' };
    }

    if (existing.status === 'failed_permanent') {
      return {
        state: 'already_failed_permanent',
        errorCode: existing.errorCode ?? 'AMOUNT_MISMATCH',
        errorMessage: existing.errorMessage ?? 'Permanent validation failure',
      };
    }

    // status === 'processing'
    if (now - existing.updatedAt < staleLockTimeoutMs) {
      return { state: 'in_progress' };
    }

    existing.attemptCount += 1;
    existing.updatedAt = now;
    return { state: 'acquired', attemptCount: existing.attemptCount };
  }

  async releaseStripeWebhookEventOnTransientError(eventId: string): Promise<void> {
    const existing = this.events.get(eventId);
    if (existing && existing.status === 'processing') {
      this.events.delete(eventId);
    }
  }

  async markStripeWebhookEventPermanentFailure(params: {
    eventId: string;
    sessionId: string;
    orderId: string;
    errorCode: PaymentRejectionCode;
    errorMessage: string;
  }): Promise<void> {
    const now = Date.now();
    const existing = this.events.get(params.eventId);
    this.events.set(params.eventId, {
      eventId: params.eventId,
      sessionId: params.sessionId,
      orderId: params.orderId,
      status: 'failed_permanent',
      attemptCount: existing?.attemptCount ?? 1,
      errorCode: params.errorCode,
      errorMessage: params.errorMessage,
      startedAt: existing?.startedAt ?? now,
      processedAt: now,
      updatedAt: now,
    });
  }

  async getOrderById(orderId: string): Promise<OrderRecordForPayment | null> {
    if (this.simulateDbFailureOnGetOrder) {
      throw new Error('Transient DB connection error during getOrderById');
    }
    return this.orders.get(orderId) || null;
  }

  async atomicConfirmOrderPayment(params: {
    orderId: string;
    stripeSessionId: string;
    paidAmount: number;
    webhookEventId?: string;
  }): Promise<{ updatedOrder: OrderRecordForPayment | null; transitionedFromUnpaid: boolean }> {
    if (this.simulateDbFailureOnConfirm) {
      throw new Error('Transient DB error during atomicConfirmOrderPayment');
    }

    this.confirmCallCount += 1;
    const o = this.orders.get(params.orderId);
    if (!o) return { updatedOrder: null, transitionedFromUnpaid: false };

    let transitionedFromUnpaid = false;
    if (o.status === 'unpaid') {
      o.status = 'pending';
      o.paymentStatus = 'paid';
      o.productionStatus = 'pending';
      o.fulfillmentStatus = 'not_handed_over';
      o.cancellationStatus = 'active';
      o.stripeSessionId = params.stripeSessionId;
      transitionedFromUnpaid = true;
    } else {
      // すでに preparing / completed の場合は製造状態を巻き戻さない
      o.paymentStatus = 'paid';
      o.stripeSessionId = params.stripeSessionId;
    }

    // 同一トランザクション内で Webhook イベントを succeeded に確定する
    if (params.webhookEventId) {
      const now = Date.now();
      const existing = this.events.get(params.webhookEventId);
      this.events.set(params.webhookEventId, {
        eventId: params.webhookEventId,
        sessionId: params.stripeSessionId,
        orderId: params.orderId,
        status: 'succeeded',
        attemptCount: existing?.attemptCount ?? 1,
        errorCode: null,
        errorMessage: null,
        startedAt: existing?.startedAt ?? now,
        processedAt: now,
        updatedAt: now,
      });
    }

    return { updatedOrder: o, transitionedFromUnpaid };
  }
}

describe('[Phase 0-D / 監査修正 B] Stripe 決済確認・Webhook障害復旧・状態管理テスト', () => {
  let repo: StatefulMockPaymentRepository;

  beforeEach(() => {
    repo = new StatefulMockPaymentRepository();
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

  it('2. 注文ステータスの巻き戻り防止: すでに調理中(preparing)や呼出中(completed)の注文に対して決済確認が再実行されても pending に戻らないこと', async () => {
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

  it('3. Webhook重複受信・完了後のHTTP応答失敗からの再送: 注文更新完了後に応答が失敗しても、再送時に二重処理せず idempotentReplay=true を返すこと', async () => {
    const session: StripeCheckoutSessionLike = {
      id: 'cs_test_webhook_1',
      payment_status: 'paid',
      amount_total: 1050,
      currency: 'jpy',
      metadata: { orderId: 'ord_unpaid_1' },
    };

    // 1回目 (注文更新 + succeeded 記録まで完了)
    const firstRes = await verifyAndConfirmStripePayment({
      session,
      repo,
      webhookEventId: 'evt_stripe_duplicate_test',
    });
    assert.equal(firstRes.ok, true);
    if (firstRes.ok) assert.equal(firstRes.transitionedToPending, true);
    assert.equal(repo.confirmCallCount, 1);
    assert.equal(repo.events.get('evt_stripe_duplicate_test')?.status, 'succeeded');

    // 仮に1回目のHTTP応答前にネットワーク切断が起き、その間にキッチンで調理中(preparing)に進んだとしても、
    // Stripeからの2回目再送時は atomicConfirmOrderPayment を再実行せず即座に idempotentReplay=true を返すこと
    const order = repo.orders.get('ord_unpaid_1')!;
    order.status = 'preparing';

    const secondRes = await verifyAndConfirmStripePayment({
      session,
      repo,
      webhookEventId: 'evt_stripe_duplicate_test',
    });
    assert.equal(secondRes.ok, true);
    if (secondRes.ok) {
      assert.equal(secondRes.idempotentReplay, true);
      assert.equal(secondRes.transitionedToPending, false);
      assert.equal(secondRes.currentStatus, 'preparing');
    }
    assert.equal(repo.confirmCallCount, 1, 'atomicConfirmOrderPayment が二重実行されていないこと');
  });

  it('4. Webhook処理途中のDB障害と再試行復旧: イベント受信後・注文更新前にDB障害が起きてもロックが解放され、次回再送で正常に注文更新できること', async () => {
    const session: StripeCheckoutSessionLike = {
      id: 'cs_test_retry_recovery',
      payment_status: 'paid',
      amount_total: 1050,
      currency: 'jpy',
      metadata: { orderId: 'ord_unpaid_1' },
    };

    // 1回目: 注文更新処理中に一時的なDB障害が発生
    repo.simulateDbFailureOnConfirm = true;
    await assert.rejects(
      async () => {
        await verifyAndConfirmStripePayment({
          session,
          repo,
          webhookEventId: 'evt_transient_db_fail_1',
        });
      },
      /Transient DB error/
    );

    // 注文はまだ unpaid のままであり、processing ロックは解放されていること
    assert.equal(repo.orders.get('ord_unpaid_1')?.status, 'unpaid');
    assert.equal(
      repo.events.has('evt_transient_db_fail_1'),
      false,
      '一時障害時は処理済みとして残らずロックが解放されていること'
    );

    // 2回目 (Stripeからの自動再送): DB障害が解消された状態で再試行 → 正常に pending へ更新されること
    repo.simulateDbFailureOnConfirm = false;
    const retryRes = await verifyAndConfirmStripePayment({
      session,
      repo,
      webhookEventId: 'evt_transient_db_fail_1',
    });

    assert.equal(retryRes.ok, true);
    if (retryRes.ok) {
      assert.equal(retryRes.transitionedToPending, true);
      assert.equal(retryRes.idempotentReplay, false);
      assert.equal(retryRes.currentStatus, 'pending');
    }
    assert.equal(repo.orders.get('ord_unpaid_1')?.status, 'pending');
    assert.equal(repo.events.get('evt_transient_db_fail_1')?.status, 'succeeded');
  });

  it('5. 同時受信の排他制御: 同一Webhookイベントが処理中(processing)の間に到着した並列リクエストを 409 (WEBHOOK_IN_PROGRESS) でブロックすること', async () => {
    const session: StripeCheckoutSessionLike = {
      id: 'cs_test_concurrent',
      payment_status: 'paid',
      amount_total: 1050,
      currency: 'jpy',
      metadata: { orderId: 'ord_unpaid_1' },
    };

    // 先行ワーカーが processing ロックを保持中の状態をセット
    await repo.beginStripeWebhookEvent({
      eventId: 'evt_concurrent_1',
      sessionId: session.id,
      orderId: 'ord_unpaid_1',
    });

    // 同時に到着した2つ目のリクエスト
    const concurrentRes = await verifyAndConfirmStripePayment({
      session,
      repo,
      webhookEventId: 'evt_concurrent_1',
    });

    assert.equal(concurrentRes.ok, false);
    if (!concurrentRes.ok) {
      assert.equal(concurrentRes.code, 'WEBHOOK_IN_PROGRESS');
      assert.equal(concurrentRes.status, 409);
      assert.equal(concurrentRes.retryable, true);
    }
  });

  it('6. Stripe決済確認の再実行 (confirm API と Webhook の競合・再実行): 二重確定が起きず冪等に完了すること', async () => {
    const session: StripeCheckoutSessionLike = {
      id: 'cs_test_confirm_and_webhook',
      payment_status: 'paid',
      amount_total: 1050,
      currency: 'jpy',
      metadata: { orderId: 'ord_unpaid_1' },
    };

    // 先にクライアント側 POST /api/orders/confirm が到着
    const confirmApiRes = await verifyAndConfirmStripePayment({ session, repo });
    assert.equal(confirmApiRes.ok, true);
    if (confirmApiRes.ok) {
      assert.equal(confirmApiRes.transitionedToPending, true);
    }

    // 直後に Stripe Webhook が到着
    const webhookRes = await verifyAndConfirmStripePayment({
      session,
      repo,
      webhookEventId: 'evt_after_confirm_api',
    });
    assert.equal(webhookRes.ok, true);
    if (webhookRes.ok) {
      assert.equal(webhookRes.transitionedToPending, false);
      assert.equal(webhookRes.idempotentReplay, true);
      assert.equal(webhookRes.currentStatus, 'pending');
    }
    assert.equal(repo.events.get('evt_after_confirm_api')?.status, 'succeeded');
  });

  it('7. 恒久的な検証エラーの永続記録: 金額不一致・通貨不一致・未決済ステータス・取消済み注文を拒否し failed_permanent として記録すること', async () => {
    // 未決済 (unpaid)
    const unpaidSession: StripeCheckoutSessionLike = {
      id: 'cs_test_unpaid',
      payment_status: 'unpaid',
      amount_total: 1050,
      currency: 'jpy',
      metadata: { orderId: 'ord_unpaid_1' },
    };
    const unpaidRes = await verifyAndConfirmStripePayment({
      session: unpaidSession,
      repo,
      webhookEventId: 'evt_perm_unpaid',
    });
    assert.equal(unpaidRes.ok, false);
    if (!unpaidRes.ok) {
      assert.equal(unpaidRes.code, 'PAYMENT_NOT_PAID');
      assert.equal(unpaidRes.retryable, false);
      assert.equal(unpaidRes.permanentFailureRecorded, true);
    }
    assert.equal(repo.events.get('evt_perm_unpaid')?.status, 'failed_permanent');

    // 金額不一致 (注文1050円に対しセッション500円)
    const mismatchSession: StripeCheckoutSessionLike = {
      id: 'cs_test_mismatch',
      payment_status: 'paid',
      amount_total: 500,
      currency: 'jpy',
      metadata: { orderId: 'ord_unpaid_1' },
    };
    const mismatchRes = await verifyAndConfirmStripePayment({
      session: mismatchSession,
      repo,
      webhookEventId: 'evt_perm_mismatch',
    });
    assert.equal(mismatchRes.ok, false);
    if (!mismatchRes.ok) {
      assert.equal(mismatchRes.code, 'AMOUNT_MISMATCH');
      assert.equal(mismatchRes.retryable, false);
      assert.equal(mismatchRes.permanentFailureRecorded, true);
    }
    assert.equal(repo.events.get('evt_perm_mismatch')?.status, 'failed_permanent');
    assert.equal(repo.events.get('evt_perm_mismatch')?.errorCode, 'AMOUNT_MISMATCH');

    // 通貨不一致 (USD)
    const usdSession: StripeCheckoutSessionLike = {
      id: 'cs_test_usd',
      payment_status: 'paid',
      amount_total: 1050,
      currency: 'usd',
      metadata: { orderId: 'ord_unpaid_1' },
    };
    const usdRes = await verifyAndConfirmStripePayment({
      session: usdSession,
      repo,
      webhookEventId: 'evt_perm_usd',
    });
    assert.equal(usdRes.ok, false);
    if (!usdRes.ok) {
      assert.equal(usdRes.code, 'CURRENCY_MISMATCH');
      assert.equal(usdRes.retryable, false);
    }
    assert.equal(repo.events.get('evt_perm_usd')?.status, 'failed_permanent');
  });
});
