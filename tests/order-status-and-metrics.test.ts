import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveOrderDomainState,
  computeNextOrderStatuses,
  calculateSalesMetrics,
  type OrderDomainState,
} from '../src/lib/orderStatus.ts';

describe('[Phase 0-C / 0-F] 4軸注文ステータス・過去データ保護・売上集計テスト', () => {
  it('1. 過去データの安全な保護: status=cancelled かつ 4軸未設定のレコードは legacy_undetermined として保持されること', () => {
    const legacyCancelledRow = {
      status: 'cancelled',
      payment_status: null,
      production_status: null,
      fulfillment_status: null,
      cancellation_status: null,
    };

    const state = resolveOrderDomainState(legacyCancelledRow);
    assert.equal(state.legacyClassification, 'legacy_undetermined');
    assert.equal(state.status, 'cancelled');
    assert.equal(state.cancellationStatus, 'active', '一律に注文取消とは決めつけない');
  });

  it('2. 新ステータス遷移: キッチンでの「受渡完了」は handed_over / active として記録され、売上対象となること', () => {
    const initial: OrderDomainState = {
      status: 'completed',
      paymentStatus: 'paid',
      productionStatus: 'ready',
      fulfillmentStatus: 'not_handed_over',
      cancellationStatus: 'active',
      legacyClassification: 'four_axis_explicit',
      refundedAmount: 0,
      refundStatus: 'none',
      requiresManualAttention: false,
      source: 'mobile',
    };

    const next = computeNextOrderStatuses(initial, 'hand_over');
    assert.equal(next.status, 'cancelled', 'キッチン画面から除外するため status=cancelled');
    assert.equal(next.fulfillment_status, 'handed_over');
    assert.equal(next.cancellation_status, 'active');
  });

  it('3. 新ステータス遷移: 本当の「注文取消」は cancellation_status=cancelled として記録されること', () => {
    const initial: OrderDomainState = {
      status: 'pending',
      paymentStatus: 'paid',
      productionStatus: 'pending',
      fulfillmentStatus: 'not_handed_over',
      cancellationStatus: 'active',
      legacyClassification: 'four_axis_explicit',
      refundedAmount: 0,
      refundStatus: 'none',
      requiresManualAttention: false,
      source: 'mobile',
    };

    const next = computeNextOrderStatuses(initial, 'cancel_order');
    assert.equal(next.cancellation_status, 'cancelled');
    assert.equal(next.status, 'cancelled');

    // すでにキャンセルされた注文の再操作はブロックされること
    assert.throws(() => {
      computeNextOrderStatuses(
        { ...initial, cancellationStatus: 'cancelled' },
        'start_preparing'
      );
    });
  });

  it('4. 売上集計の厳格な分離: 確定純売上、未判定過去売上、本当のキャンセル、返金が明確に区別されること', () => {
    const testOrders = [
      // 1. 過去データの受渡完了（未判定 legacy_undetermined: 400円）
      {
        totalPrice: 400,
        status: 'cancelled' as const,
      },
      // 2. 新基準の受渡完了（確定売上: 500円）
      {
        totalPrice: 500,
        status: 'cancelled' as const,
        paymentStatus: 'paid' as const,
        productionStatus: 'ready' as const,
        fulfillmentStatus: 'handed_over' as const,
        cancellationStatus: 'active' as const,
      },
      // 3. 本当にキャンセルされた注文（売上除外: 800円）
      {
        totalPrice: 800,
        status: 'cancelled' as const,
        paymentStatus: 'paid' as const,
        productionStatus: 'pending' as const,
        fulfillmentStatus: 'not_handed_over' as const,
        cancellationStatus: 'cancelled' as const,
      },
      // 4. 一部返金された注文（800円中200円返金 -> 純売上600円）
      {
        totalPrice: 800,
        status: 'completed' as const,
        paymentStatus: 'partially_refunded' as const,
        productionStatus: 'ready' as const,
        fulfillmentStatus: 'not_handed_over' as const,
        cancellationStatus: 'active' as const,
        refundedAmount: 200,
      },
      // 5. 全額返金された注文（500円全額返金 -> 純売上0円）
      {
        totalPrice: 500,
        status: 'completed' as const,
        paymentStatus: 'refunded' as const,
        productionStatus: 'ready' as const,
        fulfillmentStatus: 'not_handed_over' as const,
        cancellationStatus: 'active' as const,
        refundedAmount: 500,
      },
    ];

    const metrics = calculateSalesMetrics(testOrders);

    // 未判定の過去データ: 400円 (1件)
    assert.equal(metrics.legacyUndeterminedCount, 1);
    assert.equal(metrics.legacyUndeterminedAmount, 400);

    // 本当にキャンセルされた注文: 1件 (売上除外)
    assert.equal(metrics.cancelledOrderCount, 1);

    // 返金額合計: 200円(一部) + 500円(全額) = 700円
    assert.equal(metrics.totalRefundedAmount, 700);

    // 確定純売上: (500円) + (800 - 200 = 600円) + (500 - 500 = 0円) = 1100円
    assert.equal(metrics.confirmedNetRevenue, 1100);

    // 既存互換売上: 確定純売上(1100円) + 過去未判定分(400円) = 1500円 (※キャンセル800円は含まれない)
    assert.equal(metrics.legacyCompatibleRevenue, 1500);
  });
});
