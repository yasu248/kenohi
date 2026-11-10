import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeGuardedCheckout,
  validateCheckoutRequest,
  type ICheckoutExecutionDependencies,
} from '../src/lib/checkoutValidation.ts';
import {
  verifyAndConfirmStripePayment,
  type IPaymentConfirmationRepository,
  type OrderRecordForPayment,
  type StripeWebhookEventRecord,
  type WebhookEventAcquisitionResult,
} from '../src/lib/stripeConfirmation.ts';
import type { Order, OrderItem, StoreState } from '../src/lib/store.ts';

// 2026-11-11 11:30:00 JST (02:30:00 UTC)
const OPEN_TIME_JST = new Date('2026-11-11T02:30:00.000Z');
// 2026-11-11 10:00:00 JST (01:00:00 UTC)
const OPENED_AT_MORNING_MS = new Date('2026-11-11T01:00:00.000Z').getTime();
// 2026-11-11 16:00:00 JST (07:00:00 UTC) — 15時以降の自動クローズ時間帯
const AFTER_HOURS_JST = new Date('2026-11-11T07:00:00.000Z');

function createOpenStoreState(overrides: Partial<StoreState> = {}): StoreState {
  return {
    isManualOpen: true,
    date: '2026-11-11',
    openedAt: OPENED_AT_MORNING_MS,
    soldOutItems: [],
    ...overrides,
  };
}

function createMockCheckoutDeps(params: {
  initialState: StoreState | null;
  postOrderState?: StoreState | null;
  throwOnGetStoreState?: boolean;
}) {
  let getStoreStateCallCount = 0;
  const createdOrders: Order[] = [];
  const cancelledOrderIds: string[] = [];
  const createdStripeSessions: Array<{ orderId: string; orderNumber: string }> = [];

  const deps: ICheckoutExecutionDependencies = {
    getStoreState: async () => {
      getStoreStateCallCount += 1;
      if (params.throwOnGetStoreState) {
        throw new Error('Supabase connection error');
      }
      if (getStoreStateCallCount === 1) {
        return params.initialState;
      }
      return params.postOrderState !== undefined
        ? params.postOrderState
        : params.initialState;
    },
    addOrder: async (
      items: OrderItem[],
      customerName: string,
      customerAvatar?: string
    ): Promise<Order> => {
      const totalPrice = items.reduce((s, i) => s + i.price * i.quantity, 0);
      const order: Order = {
        id: `ORD-${createdOrders.length + 1}`,
        items,
        totalPrice,
        customerName,
        customerAvatar,
        status: 'unpaid',
        createdAt: OPEN_TIME_JST.toISOString(),
        orderNumber: String(1001 + createdOrders.length),
        paymentStatus: 'unpaid',
        productionStatus: 'pending',
        fulfillmentStatus: 'not_handed_over',
        cancellationStatus: 'active',
      };
      createdOrders.push(order);
      return order;
    },
    cancelOrderOnAbort: async (orderId: string) => {
      cancelledOrderIds.push(orderId);
      const target = createdOrders.find((o) => o.id === orderId);
      if (target) {
        target.status = 'cancelled';
        target.cancellationStatus = 'cancelled';
      }
    },
    createStripeCheckoutSession: async ({ order }) => {
      createdStripeSessions.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
      });
      return {
        url: `https://checkout.stripe.com/c/pay/cs_test_${order.id}`,
      };
    },
  };

  return {
    deps,
    createdOrders,
    cancelledOrderIds,
    createdStripeSessions,
    getStoreStateCallCount: () => getStoreStateCallCount,
  };
}

describe('Phase 0 Checkout Server-Side Guard & Item/Price Validation', () => {
  it('1. 通常営業中の注文成功: 営業中・在庫あり・正規商品ID/価格の注文で未決済注文作成とStripeセッション発行が成功する', async () => {
    const storeState = createOpenStoreState();
    const mock = createMockCheckoutDeps({ initialState: storeState });

    const res = await executeGuardedCheckout({
      body: {
        items: [
          {
            id: 'm4',
            name: 'ほうじ茶ミルクティー (ゼリー: あり, 甘さ: 普通, 氷: 氷あり)',
            price: 400,
            quantity: 2,
            jelly: 'あり',
            sweetness: '普通',
            ice: '氷あり',
          },
          {
            id: 's1',
            name: '本日のお茶 (ゼリー: なし, 甘さ: なし, 氷: 氷なし)',
            price: 250,
            quantity: 1,
            jelly: 'なし',
            sweetness: 'なし',
            ice: '氷なし',
          },
        ],
        customerName: '山田 太郎',
        customerAvatar: 'https://example.com/avatar.png',
        totalPrice: 1050,
      },
      origin: 'https://kenocha.example.com',
      deps: mock.deps,
      now: OPEN_TIME_JST,
    });

    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.orderId, 'ORD-1');
      assert.equal(res.orderNumber, '1001');
      assert.equal(res.url, 'https://checkout.stripe.com/c/pay/cs_test_ORD-1');
    }
    assert.equal(mock.createdOrders.length, 1);
    assert.equal(mock.createdOrders[0].totalPrice, 1050);
    assert.equal(mock.createdStripeSessions.length, 1);
    assert.equal(mock.cancelledOrderIds.length, 0);
  });

  it('2. 手動受付停止中 (isManualOpen: false) の注文拒否: 新規注文レコードもStripeセッションも一切作成しない', async () => {
    const closedStoreState = createOpenStoreState({ isManualOpen: false });
    const mock = createMockCheckoutDeps({ initialState: closedStoreState });

    const res = await executeGuardedCheckout({
      body: {
        items: [
          {
            id: 's2',
            name: '緑茶 (ゼリー: なし, 甘さ: 普通, 氷: 氷あり)',
            price: 250,
            quantity: 1,
          },
        ],
        customerName: 'テスト顧客',
        totalPrice: 250,
      },
      origin: 'https://kenocha.example.com',
      deps: mock.deps,
      now: OPEN_TIME_JST,
    });

    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, 'STORE_CLOSED');
      assert.equal(res.status, 503);
      assert.match(res.message, /受付を停止/);
    }
    assert.equal(mock.createdOrders.length, 0);
    assert.equal(mock.createdStripeSessions.length, 0);
  });

  it('3. 営業時間外の注文拒否: 15時以降の自動クローズ時間帯や前日日付のままの店舗状態では注文を拒否する', async () => {
    // ケースA: 午前中に開けて16時を過ぎた状態
    const storeStateMorningOpen = createOpenStoreState();
    const mockAfterHours = createMockCheckoutDeps({ initialState: storeStateMorningOpen });

    const resAfterHours = await executeGuardedCheckout({
      body: {
        items: [
          {
            id: 'm1',
            name: '緑茶ミルクティー (ゼリー: なし, 甘さ: 普通, 氷: 氷あり)',
            price: 400,
            quantity: 1,
          },
        ],
        customerName: 'テスト顧客',
      },
      origin: 'https://kenocha.example.com',
      deps: mockAfterHours.deps,
      now: AFTER_HOURS_JST,
    });

    assert.equal(resAfterHours.ok, false);
    if (!resAfterHours.ok) {
      assert.equal(resAfterHours.code, 'STORE_CLOSED');
      assert.equal(resAfterHours.status, 503);
    }
    assert.equal(mockAfterHours.createdOrders.length, 0);
    assert.equal(mockAfterHours.createdStripeSessions.length, 0);

    // ケースB: 店舗状態の日付が前日のまま
    const staleDateState = createOpenStoreState({ date: '2026-11-10' });
    const mockStaleDate = createMockCheckoutDeps({ initialState: staleDateState });

    const resStaleDate = await executeGuardedCheckout({
      body: {
        items: [
          {
            id: 'm1',
            name: '緑茶ミルクティー (ゼリー: なし, 甘さ: 普通, 氷: 氷あり)',
            price: 400,
            quantity: 1,
          },
        ],
        customerName: 'テスト顧客',
      },
      origin: 'https://kenocha.example.com',
      deps: mockStaleDate.deps,
      now: OPEN_TIME_JST,
    });

    assert.equal(resStaleDate.ok, false);
    if (!resStaleDate.ok) {
      assert.equal(resStaleDate.code, 'STORE_CLOSED');
      assert.equal(resStaleDate.status, 503);
    }
    assert.equal(mockStaleDate.createdOrders.length, 0);
  });

  it('4. 店舗状態取得失敗時の注文拒否: null または DBエラー時は安全側（フェイルクローズ）に倒して注文を受け付けない', async () => {
    // ケースA: null 返却
    const mockNull = createMockCheckoutDeps({ initialState: null });
    const resNull = await executeGuardedCheckout({
      body: {
        items: [{ id: 's1', name: '本日のお茶', price: 250, quantity: 1 }],
        customerName: 'テスト顧客',
      },
      origin: 'https://kenocha.example.com',
      deps: mockNull.deps,
      now: OPEN_TIME_JST,
    });

    assert.equal(resNull.ok, false);
    if (!resNull.ok) {
      assert.equal(resNull.code, 'STORE_STATE_UNAVAILABLE');
      assert.equal(resNull.status, 503);
    }
    assert.equal(mockNull.createdOrders.length, 0);
    assert.equal(mockNull.createdStripeSessions.length, 0);

    // ケースB: 例外スロー
    const mockThrow = createMockCheckoutDeps({
      initialState: null,
      throwOnGetStoreState: true,
    });
    const resThrow = await executeGuardedCheckout({
      body: {
        items: [{ id: 's1', name: '本日のお茶', price: 250, quantity: 1 }],
        customerName: 'テスト顧客',
      },
      origin: 'https://kenocha.example.com',
      deps: mockThrow.deps,
      now: OPEN_TIME_JST,
    });

    assert.equal(resThrow.ok, false);
    if (!resThrow.ok) {
      assert.equal(resThrow.code, 'STORE_STATE_UNAVAILABLE');
      assert.equal(resThrow.status, 503);
    }
    assert.equal(mockThrow.createdOrders.length, 0);
  });

  it('5. 欠品商品の注文拒否: soldOutItems に登録された商品ID (s1〜m6) の注文をサーバー側で確実に拒否し、類似名商品を誤判定しない', async () => {
    // s2 ('緑茶') が欠品中でも m1 ('緑茶ミルクティー') は注文可能であり、s2 は 409 で拒否されることを確認
    const storeState = createOpenStoreState({ soldOutItems: ['s2', 'm4'] });
    const mock = createMockCheckoutDeps({ initialState: storeState });

    // 欠品中の m4 を注文 -> 409 ITEM_SOLD_OUT
    const resSoldOut = await executeGuardedCheckout({
      body: {
        items: [
          {
            id: 'm4',
            name: 'ほうじ茶ミルクティー (ゼリー: なし, 甘さ: 普通, 氷: 氷あり)',
            price: 400,
            quantity: 1,
          },
        ],
        customerName: 'テスト顧客',
      },
      origin: 'https://kenocha.example.com',
      deps: mock.deps,
      now: OPEN_TIME_JST,
    });

    assert.equal(resSoldOut.ok, false);
    if (!resSoldOut.ok) {
      assert.equal(resSoldOut.code, 'ITEM_SOLD_OUT');
      assert.equal(resSoldOut.status, 409);
      assert.match(resSoldOut.message, /ほうじ茶ミルクティー/);
    }
    assert.equal(mock.createdOrders.length, 0);

    // s2 ('緑茶') が欠品中でも m1 ('緑茶ミルクティー') は部分一致誤判定されず正常に注文可能
    const resAvailableMilkTea = await executeGuardedCheckout({
      body: {
        items: [
          {
            id: 'm1',
            name: '緑茶ミルクティー (ゼリー: なし, 甘さ: 普通, 氷: 氷あり)',
            price: 400,
            quantity: 1,
          },
        ],
        customerName: 'テスト顧客',
      },
      origin: 'https://kenocha.example.com',
      deps: mock.deps,
      now: OPEN_TIME_JST,
    });

    assert.equal(resAvailableMilkTea.ok, true);
  });

  it('6. 不正な商品ID・存在しない商品・IDと商品名の不一致・禁止オプションの拒否', () => {
    const storeState = createOpenStoreState();

    // 6-A: 存在しない商品ID
    const resInvalidId = validateCheckoutRequest({
      body: {
        items: [{ id: 'x99', name: '緑茶', price: 250, quantity: 1 }],
        customerName: 'テスト顧客',
      },
      storeState,
      now: OPEN_TIME_JST,
    });
    assert.equal(resInvalidId.ok, false);
    if (!resInvalidId.ok) {
      assert.equal(resInvalidId.code, 'INVALID_ITEM_ID');
      assert.equal(resInvalidId.status, 400);
    }

    // 6-B: 商品IDとベース商品名の不一致 (s1='本日のお茶' に対して '緑茶ミルクティー' を指定)
    const resMismatch = validateCheckoutRequest({
      body: {
        items: [
          {
            id: 's1',
            name: '緑茶ミルクティー (ゼリー: なし, 甘さ: 普通, 氷: 氷あり)',
            price: 250,
            quantity: 1,
          },
        ],
        customerName: 'テスト顧客',
      },
      storeState,
      now: OPEN_TIME_JST,
    });
    assert.equal(resMismatch.ok, false);
    if (!resMismatch.ok) {
      assert.equal(resMismatch.code, 'ITEM_ID_NAME_MISMATCH');
      assert.equal(resMismatch.status, 400);
    }

    // 6-C: 存在しない商品名（ID未指定時）
    const resUnknownName = validateCheckoutRequest({
      body: {
        items: [{ name: 'タピオカ黒糖ラテ (ゼリー: なし, 甘さ: 普通, 氷: 氷あり)', price: 400, quantity: 1 }],
        customerName: 'テスト顧客',
      },
      storeState,
      now: OPEN_TIME_JST,
    });
    assert.equal(resUnknownName.ok, false);
    if (!resUnknownName.ok) {
      assert.equal(resUnknownName.code, 'UNKNOWN_MENU_ITEM');
      assert.equal(resUnknownName.status, 400);
    }

    // 6-D: 金木犀青茶ミルクティー (m5) / 薔薇ほうじ茶ミルクティー (m6) で禁止されている「甘さ: なし」を指定
    const resDisallowedSweetness = validateCheckoutRequest({
      body: {
        items: [
          {
            id: 'm5',
            name: '金木犀青茶ミルクティー (ゼリー: なし, 甘さ: なし, 氷: 氷あり)',
            price: 400,
            quantity: 1,
          },
        ],
        customerName: 'テスト顧客',
      },
      storeState,
      now: OPEN_TIME_JST,
    });
    assert.equal(resDisallowedSweetness.ok, false);
    if (!resDisallowedSweetness.ok) {
      assert.equal(resDisallowedSweetness.code, 'INVALID_ITEM_OPTIONS');
      assert.equal(resDisallowedSweetness.status, 400);
    }
  });

  it('7. 価格または合計金額を改ざんした注文の拒否: クライアント申告単価・合計金額の不一致を400で拒否する', () => {
    const storeState = createOpenStoreState();

    // 7-A: 400円のミルクティーを price: 100 として送信
    const resPriceTampered = validateCheckoutRequest({
      body: {
        items: [
          {
            id: 'm2',
            name: '釜炒り緑茶ミルクティー (ゼリー: なし, 甘さ: 普通, 氷: 氷あり)',
            price: 100,
            quantity: 1,
          },
        ],
        customerName: 'テスト顧客',
      },
      storeState,
      now: OPEN_TIME_JST,
    });
    assert.equal(resPriceTampered.ok, false);
    if (!resPriceTampered.ok) {
      assert.equal(resPriceTampered.code, 'INVALID_ITEM_PRICE');
      assert.equal(resPriceTampered.status, 400);
    }

    // 7-B: 単価は正しいが totalPrice を 400円（本来 800円）に改ざん
    const resTotalTampered = validateCheckoutRequest({
      body: {
        items: [
          {
            id: 'm2',
            name: '釜炒り緑茶ミルクティー (ゼリー: なし, 甘さ: 普通, 氷: 氷あり)',
            price: 400,
            quantity: 2,
          },
        ],
        customerName: 'テスト顧客',
        totalPrice: 400,
      },
      storeState,
      now: OPEN_TIME_JST,
    });
    assert.equal(resTotalTampered.ok, false);
    if (!resTotalTampered.ok) {
      assert.equal(resTotalTampered.code, 'TOTAL_PRICE_MISMATCH');
      assert.equal(resTotalTampered.status, 400);
    }
  });

  it('8. 注文と同時に受付停止された場合の競合テスト (TOCTOU): addOrder直後に受付停止を検知して注文を自動取消し、Stripeセッションを発行しない', async () => {
    // 1回目の getStoreState() では営業中、addOrder 実行中のタイミングでスタッフが isManualOpen: false に変更したケース
    const openState = createOpenStoreState({ isManualOpen: true });
    const closedState = createOpenStoreState({ isManualOpen: false });
    const mock = createMockCheckoutDeps({
      initialState: openState,
      postOrderState: closedState,
    });

    const res = await executeGuardedCheckout({
      body: {
        items: [
          {
            id: 'm3',
            name: '青茶ミルクティー (ゼリー: なし, 甘さ: 普通, 氷: 氷あり)',
            price: 400,
            quantity: 1,
          },
        ],
        customerName: '競合テスト顧客',
        totalPrice: 400,
      },
      origin: 'https://kenocha.example.com',
      deps: mock.deps,
      now: OPEN_TIME_JST,
    });

    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, 'STORE_CLOSED');
      assert.equal(res.status, 503);
    }
    // 注文作成直後の再検証でキャンセルされ、Stripe Checkout セッションは発行されない
    assert.equal(mock.getStoreStateCallCount(), 2);
    assert.equal(mock.createdOrders.length, 1);
    assert.equal(mock.cancelledOrderIds.length, 1);
    assert.equal(mock.cancelledOrderIds[0], 'ORD-1');
    assert.equal(mock.createdOrders[0].status, 'cancelled');
    assert.equal(mock.createdStripeSessions.length, 0);
  });

  it('9. 受付停止前に開始された決済のWebhook処理成功テスト: 受付停止後でも既に発行済みの正規Stripe決済完了Webhookは正常に注文を確定する', async () => {
    // 受付停止前に作成された unpaid 注文
    const existingOrder: OrderRecordForPayment = {
      id: 'ORD-BEFORE-CLOSE',
      orderNumber: '1009',
      totalPrice: 400,
      status: 'unpaid',
      paymentStatus: 'unpaid',
      productionStatus: 'unstarted',
      fulfillmentStatus: 'not_handed_over',
      cancellationStatus: 'active',
    };

    const events = new Map<string, StripeWebhookEventRecord>();
    const repo: IPaymentConfirmationRepository = {
      beginStripeWebhookEvent: async ({ eventId, sessionId, orderId }): Promise<WebhookEventAcquisitionResult> => {
        events.set(eventId, {
          eventId,
          sessionId,
          orderId,
          status: 'processing',
          attemptCount: 1,
          startedAt: Date.now(),
          updatedAt: Date.now(),
        });
        return { state: 'acquired', attemptCount: 1 };
      },
      releaseStripeWebhookEventOnTransientError: async (eventId: string) => {
        events.delete(eventId);
      },
      markStripeWebhookEventPermanentFailure: async (params) => {
        events.set(params.eventId, {
          ...params,
          status: 'failed_permanent',
          attemptCount: 1,
          startedAt: Date.now(),
          updatedAt: Date.now(),
        });
      },
      getOrderById: async (orderId: string) =>
        orderId === existingOrder.id ? existingOrder : null,
      atomicConfirmOrderPayment: async ({ stripeSessionId, webhookEventId }) => {
        existingOrder.status = 'pending';
        existingOrder.paymentStatus = 'paid';
        existingOrder.productionStatus = 'pending';
        existingOrder.stripeSessionId = stripeSessionId;
        if (webhookEventId) {
          const ev = events.get(webhookEventId);
          if (ev) ev.status = 'succeeded';
        }
        return { updatedOrder: existingOrder, transitionedFromUnpaid: true };
      },
    };

    // 店舗が isManualOpen: false（受付停止中）であっても verifyAndConfirmStripePayment は店舗開閉状態に依存せず決済確定を完了する
    const confirmResult = await verifyAndConfirmStripePayment({
      session: {
        id: 'cs_live_before_close_001',
        payment_status: 'paid',
        amount_total: 400,
        currency: 'jpy',
        metadata: {
          orderId: 'ORD-BEFORE-CLOSE',
          orderNumber: '1009',
        },
      },
      webhookEventId: 'evt_live_001',
      repo,
    });

    assert.equal(confirmResult.ok, true);
    if (confirmResult.ok) {
      assert.equal(confirmResult.transitionedToPending, true);
      assert.equal(confirmResult.currentStatus, 'pending');
    }
    assert.equal(existingOrder.status, 'pending');
    assert.equal(existingOrder.paymentStatus, 'paid');
    assert.equal(existingOrder.productionStatus, 'pending');
  });

  it('10. 既存のLINE LIFF注文フォーマット回帰テスト: キッチンモニターおよびQRラベル印刷が参照する商品名・オプション文字列・価格が完全に維持される', () => {
    const storeState = createOpenStoreState();
    const liffFormattedName = '釜炒り緑茶ミルクティー (ゼリー: あり, 甘さ: 控えめ, 氷: 氷なし)';

    const validation = validateCheckoutRequest({
      body: {
        items: [
          {
            id: 'm2',
            name: liffFormattedName,
            price: 400,
            quantity: 2,
            jelly: 'あり',
            sweetness: '控えめ',
            ice: '氷なし',
          },
        ],
        customerName: 'LINE LIFF ユーザー',
        customerAvatar: 'https://profile.line-scdn.net/test',
        totalPrice: 800,
      },
      storeState,
      now: OPEN_TIME_JST,
    });

    assert.equal(validation.ok, true);
    if (validation.ok) {
      assert.equal(validation.calculatedTotalPrice, 800);
      assert.equal(validation.sanitizedItems.length, 1);
      const item = validation.sanitizedItems[0];
      assert.equal(item.id, 'm2');
      assert.equal(item.baseName, '釜炒り緑茶ミルクティー');
      // キッチンモニターの正規表現 `/^(.+?)\s*\((.+)\)$/` とラベル印字が期待する完全な文字列フォーマットが保持されること
      assert.equal(item.name, liffFormattedName);
      assert.equal(item.price, 400);
      assert.equal(item.quantity, 2);
      assert.equal(item.jelly, 'あり');
      assert.equal(item.sweetness, '控えめ');
      assert.equal(item.ice, '氷なし');
    }
  });
});
