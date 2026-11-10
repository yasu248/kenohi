/**
 * Phase 0-C / 0-F: 注文ステータス・注文元・売上集計のドメインモデルと整合性ロジック
 *
 * 1. 4軸ステータス:
 *    - PaymentStatus: 'unpaid' | 'paid' | 'partially_refunded' | 'refunded' | 'failed'
 *    - ProductionStatus: 'pending' | 'preparing' | 'ready'
 *    - FulfillmentStatus: 'not_handed_over' | 'handed_over'
 *    - CancellationStatus: 'active' | 'cancelled'
 * 2. 過去データ (status = 'cancelled' かつ 4軸カラムが NULL) の保護:
 *    - 一律に「受渡完了」や「本当のキャンセル」と決めつけず、`legacyStatusClassification = 'legacy_undetermined'` として保持する。
 *    - 既存売上集計との「互換売上表示 (legacyCompatibleRevenue)」と、
 *      4軸ステータスが確定している注文の「確定純売上 (confirmedNetRevenue)」を明確に分離して算出する。
 */

export type OrderSource =
  | 'mobile'
  | 'square'
  | 'ubereats'
  | 'demaecan'
  | 'rocketnow';

export type LegacyOrderStatus =
  | 'unpaid'
  | 'pending'
  | 'preparing'
  | 'completed'
  | 'cancelled';

export type PaymentStatus =
  | 'unpaid'
  | 'paid'
  | 'partially_refunded'
  | 'refunded'
  | 'failed';

export type ProductionStatus =
  | 'pending'
  | 'preparing'
  | 'ready';

export type FulfillmentStatus =
  | 'not_handed_over'
  | 'handed_over';

export type CancellationStatus =
  | 'active'
  | 'cancelled';

export type RefundStatus =
  | 'none'
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed';

/**
 * 過去データの判定区分
 * - 'four_axis_explicit': Phase 0 以降の4軸ステータスが明示的に記録されている注文
 * - 'legacy_in_progress': 過去データだが status が unpaid / pending / preparing / completed で意味が一意に定まるもの
 * - 'legacy_undetermined': 過去データで status = 'cancelled' かつ 4軸カラムが未設定（受渡完了か注文取消か未判定）
 */
export type LegacyStatusClassification =
  | 'four_axis_explicit'
  | 'legacy_in_progress'
  | 'legacy_undetermined';

export interface OrderDomainState {
  status: LegacyOrderStatus;
  paymentStatus: PaymentStatus;
  productionStatus: ProductionStatus;
  fulfillmentStatus: FulfillmentStatus;
  cancellationStatus: CancellationStatus;
  legacyClassification: LegacyStatusClassification;
  refundedAmount: number;
  refundStatus: RefundStatus;
  requiresManualAttention: boolean;
  source: OrderSource;
  externalOrderId?: string;
}

/**
 * DBレコードから4軸ステータスを復元する（過去データの誤判定を防ぐ）
 */
export function resolveOrderDomainState(row: {
  status: string;
  payment_status?: string | null;
  production_status?: string | null;
  fulfillment_status?: string | null;
  cancellation_status?: string | null;
  refunded_amount?: number | null;
  refund_status?: string | null;
  requires_manual_attention?: boolean | null;
  source?: string | null;
  external_order_id?: string | null;
}): OrderDomainState {
  const legacyStatus = (row.status || 'unpaid') as LegacyOrderStatus;
  const source = ((row.source as OrderSource) || 'mobile');
  const refundedAmount = typeof row.refunded_amount === 'number' ? Math.max(0, row.refunded_amount) : 0;
  const refundStatus: RefundStatus =
    row.refund_status === 'pending' ||
    row.refund_status === 'processing' ||
    row.refund_status === 'succeeded' ||
    row.refund_status === 'failed'
      ? row.refund_status
      : 'none';
  const requiresManualAttention = Boolean(row.requires_manual_attention);

  const hasExplicitFourAxis = Boolean(
    row.payment_status ||
      row.production_status ||
      row.fulfillment_status ||
      row.cancellation_status
  );

  if (hasExplicitFourAxis) {
    return {
      status: legacyStatus,
      paymentStatus: (row.payment_status as PaymentStatus) || (legacyStatus === 'unpaid' ? 'unpaid' : 'paid'),
      productionStatus:
        (row.production_status as ProductionStatus) ||
        (legacyStatus === 'preparing'
          ? 'preparing'
          : legacyStatus === 'completed' || legacyStatus === 'cancelled'
            ? 'ready'
            : 'pending'),
      fulfillmentStatus:
        (row.fulfillment_status as FulfillmentStatus) || 'not_handed_over',
      cancellationStatus:
        (row.cancellation_status as CancellationStatus) || 'active',
      legacyClassification: 'four_axis_explicit',
      refundedAmount,
      refundStatus,
      requiresManualAttention,
      source,
      externalOrderId: row.external_order_id ?? undefined,
    };
  }

  // 4軸カラムが未設定（過去データ）の場合
  if (legacyStatus === 'unpaid') {
    return {
      status: 'unpaid',
      paymentStatus: 'unpaid',
      productionStatus: 'pending',
      fulfillmentStatus: 'not_handed_over',
      cancellationStatus: 'active',
      legacyClassification: 'legacy_in_progress',
      refundedAmount: 0,
      refundStatus: 'none',
      requiresManualAttention: false,
      source,
      externalOrderId: row.external_order_id ?? undefined,
    };
  }

  if (legacyStatus === 'pending') {
    return {
      status: 'pending',
      paymentStatus: 'paid',
      productionStatus: 'pending',
      fulfillmentStatus: 'not_handed_over',
      cancellationStatus: 'active',
      legacyClassification: 'legacy_in_progress',
      refundedAmount: 0,
      refundStatus: 'none',
      requiresManualAttention: false,
      source,
      externalOrderId: row.external_order_id ?? undefined,
    };
  }

  if (legacyStatus === 'preparing') {
    return {
      status: 'preparing',
      paymentStatus: 'paid',
      productionStatus: 'preparing',
      fulfillmentStatus: 'not_handed_over',
      cancellationStatus: 'active',
      legacyClassification: 'legacy_in_progress',
      refundedAmount: 0,
      refundStatus: 'none',
      requiresManualAttention: false,
      source,
      externalOrderId: row.external_order_id ?? undefined,
    };
  }

  if (legacyStatus === 'completed') {
    return {
      status: 'completed',
      paymentStatus: 'paid',
      productionStatus: 'ready',
      fulfillmentStatus: 'not_handed_over',
      cancellationStatus: 'active',
      legacyClassification: 'legacy_in_progress',
      refundedAmount: 0,
      refundStatus: 'none',
      requiresManualAttention: false,
      source,
      externalOrderId: row.external_order_id ?? undefined,
    };
  }

  // legacyStatus === 'cancelled' かつ 4軸カラムが未設定の過去データ:
  // 一律に受渡完了とも本当のキャンセルとも断定せず `legacy_undetermined` として保持する
  return {
    status: 'cancelled',
    paymentStatus: 'paid',
    productionStatus: 'ready',
    fulfillmentStatus: 'not_handed_over',
    cancellationStatus: 'active',
    legacyClassification: 'legacy_undetermined',
    refundedAmount: 0,
    refundStatus: 'none',
    requiresManualAttention: false,
    source,
    externalOrderId: row.external_order_id ?? undefined,
  };
}

/**
 * キッチン操作や注文取消操作に対する4軸ステータスの遷移計算
 * - 'start_preparing' (調理開始)
 * - 'mark_ready' (調理完了・呼出)
 * - 'revert_to_pending' (調理中 -> 新規注文へ戻す)
 * - 'revert_to_preparing' (呼出中 -> 調理中へ戻す)
 * - 'hand_over' (受渡完了・キッチン画面から閉じる)
 * - 'cancel_order' (本当の注文キャンセル)
 */
export type OrderStatusAction =
  | 'start_preparing'
  | 'mark_ready'
  | 'revert_to_pending'
  | 'revert_to_preparing'
  | 'hand_over'
  | 'cancel_order';

export function computeNextOrderStatuses(
  current: OrderDomainState,
  action: OrderStatusAction
): {
  status: LegacyOrderStatus;
  payment_status: PaymentStatus;
  production_status: ProductionStatus;
  fulfillment_status: FulfillmentStatus;
  cancellation_status: CancellationStatus;
} {
  if (current.cancellationStatus === 'cancelled' && action !== 'cancel_order') {
    throw new Error('すでにキャンセル（注文取消）された注文のステータスは変更できません');
  }

  switch (action) {
    case 'start_preparing':
      return {
        status: 'preparing',
        payment_status: current.paymentStatus === 'unpaid' ? 'paid' : current.paymentStatus,
        production_status: 'preparing',
        fulfillment_status: 'not_handed_over',
        cancellation_status: 'active',
      };

    case 'mark_ready':
      return {
        status: 'completed',
        payment_status: current.paymentStatus === 'unpaid' ? 'paid' : current.paymentStatus,
        production_status: 'ready',
        fulfillment_status: 'not_handed_over',
        cancellation_status: 'active',
      };

    case 'revert_to_pending':
      return {
        status: 'pending',
        payment_status: current.paymentStatus === 'unpaid' ? 'paid' : current.paymentStatus,
        production_status: 'pending',
        fulfillment_status: 'not_handed_over',
        cancellation_status: 'active',
      };

    case 'revert_to_preparing':
      return {
        status: 'preparing',
        payment_status: current.paymentStatus === 'unpaid' ? 'paid' : current.paymentStatus,
        production_status: 'preparing',
        fulfillment_status: 'not_handed_over',
        cancellation_status: 'active',
      };

    case 'hand_over':
      // 受渡完了: 既存のキッチン画面のフィルタ互換のため status='cancelled' としつつ、
      // 4軸では fulfillment_status='handed_over', cancellation_status='active' を明示記録する
      return {
        status: 'cancelled',
        payment_status: current.paymentStatus === 'unpaid' ? 'paid' : current.paymentStatus,
        production_status: 'ready',
        fulfillment_status: 'handed_over',
        cancellation_status: 'active',
      };

    case 'cancel_order':
      // 本当の注文キャンセル: cancellation_status='cancelled' を明示記録する
      return {
        status: 'cancelled',
        payment_status: current.paymentStatus,
        production_status: current.productionStatus,
        fulfillment_status: 'not_handed_over',
        cancellation_status: 'cancelled',
      };
  }
}

/**
 * Phase 0-F: 売上・注文集計メトリクス
 * 「注文売上」「決済済み金額」「返金後の確定純売上」「未判定の過去データ（互換表示用）」を明確に分離する
 */
export interface SalesMetricsSummary {
  /** 決済前の注文数 (unpaid / failed) */
  unpaidOrderCount: number;
  /** 有効な決済済み注文数 (新基準でキャンセル・全額返金を除く) */
  confirmedOrderCount: number;
  /** 受渡完了の注文数 */
  handedOverOrderCount: number;
  /** 本当にキャンセルされた注文数 (cancellationStatus === 'cancelled') */
  cancelledOrderCount: number;
  /** 一部返金された注文数 */
  partiallyRefundedOrderCount: number;
  /** 全額返金された注文数 */
  fullyRefundedOrderCount: number;
  /** 未判定の過去データ件数 (status === 'cancelled' かつ 4軸カラム未設定) */
  legacyUndeterminedCount: number;

  /** 1. 注文売上 (キャンセルを除く有効注文の総額) */
  grossOrderRevenue: number;
  /** 2. 決済済み金額 (実際に決済完了した金額合計・返金控除前) */
  paidGrossAmount: number;
  /** 3. 返金額合計 */
  totalRefundedAmount: number;
  /** 4. 返金後の確定純売上 (4軸または進行中が確定している注文の 決済済み金額 - 返金額) */
  confirmedNetRevenue: number;
  /** 5. 未判定の過去データ金額合計 (legacy_undetermined の金額) */
  legacyUndeterminedAmount: number;
  /** 6. 既存互換売上合計 (confirmedNetRevenue + legacyUndeterminedAmount: 過去の履歴表示と一致させつつ新しいキャンセル・返金は除外) */
  legacyCompatibleRevenue: number;
}

export function calculateSalesMetrics(
  orders: Array<{
    totalPrice: number;
    status: LegacyOrderStatus;
    paymentStatus?: PaymentStatus;
    productionStatus?: ProductionStatus;
    fulfillmentStatus?: FulfillmentStatus;
    cancellationStatus?: CancellationStatus;
    legacyClassification?: LegacyStatusClassification;
    refundedAmount?: number;
  }>
): SalesMetricsSummary {
  const summary: SalesMetricsSummary = {
    unpaidOrderCount: 0,
    confirmedOrderCount: 0,
    handedOverOrderCount: 0,
    cancelledOrderCount: 0,
    partiallyRefundedOrderCount: 0,
    fullyRefundedOrderCount: 0,
    legacyUndeterminedCount: 0,
    grossOrderRevenue: 0,
    paidGrossAmount: 0,
    totalRefundedAmount: 0,
    confirmedNetRevenue: 0,
    legacyUndeterminedAmount: 0,
    legacyCompatibleRevenue: 0,
  };

  for (const raw of orders) {
    const domain = resolveOrderDomainState({
      status: raw.status,
      payment_status: raw.paymentStatus,
      production_status: raw.productionStatus,
      fulfillment_status: raw.fulfillmentStatus,
      cancellation_status: raw.cancellationStatus,
      refunded_amount: raw.refundedAmount,
    });

    const price = Math.max(0, raw.totalPrice || 0);
    const refunded = Math.min(price, Math.max(0, domain.refundedAmount || 0));

    // 1. 決済前または決済失敗
    if (domain.paymentStatus === 'unpaid' || domain.paymentStatus === 'failed') {
      summary.unpaidOrderCount += 1;
      continue;
    }

    // 2. 過去データで未判定 (status='cancelled' かつ 4軸未設定)
    if (domain.legacyClassification === 'legacy_undetermined') {
      summary.legacyUndeterminedCount += 1;
      summary.legacyUndeterminedAmount += price;
      summary.legacyCompatibleRevenue += price;
      continue;
    }

    // 3. 本当にキャンセルされた注文
    if (domain.cancellationStatus === 'cancelled') {
      summary.cancelledOrderCount += 1;
      if (domain.paymentStatus === 'refunded') {
        summary.fullyRefundedOrderCount += 1;
        summary.totalRefundedAmount += refunded || price;
      } else if (refunded > 0) {
        summary.totalRefundedAmount += refunded;
      }
      // キャンセル注文は売上 (grossOrderRevenue / confirmedNetRevenue / legacyCompatibleRevenue) には含めない
      continue;
    }

    // 4. 全額返金された注文
    if (domain.paymentStatus === 'refunded') {
      summary.fullyRefundedOrderCount += 1;
      summary.paidGrossAmount += price;
      summary.totalRefundedAmount += price;
      continue;
    }

    // 5. 一部返金された注文
    if (domain.paymentStatus === 'partially_refunded') {
      summary.partiallyRefundedOrderCount += 1;
    }

    // 6. 有効な決済済み注文
    summary.confirmedOrderCount += 1;
    if (domain.fulfillmentStatus === 'handed_over') {
      summary.handedOverOrderCount += 1;
    }

    const net = Math.max(0, price - refunded);
    summary.grossOrderRevenue += price;
    summary.paidGrossAmount += price;
    summary.totalRefundedAmount += refunded;
    summary.confirmedNetRevenue += net;
    summary.legacyCompatibleRevenue += net;
  }

  return summary;
}

/**
 * 売上履歴画面 (`/kitchen/history`) および `GET /api/orders/history` に含めるべき注文かを判定する。
 * - `status !== 'unpaid'` のみに依存せず、4軸の `paymentStatus` と過去データ互換性 (`legacy_undetermined`) を用いて判定する。
 * - 決済完了前に中断・キャンセルされた注文 (`paymentStatus === 'unpaid'` または `'failed'`) は売上履歴から除外する。
 * - 過去データ (`status === 'cancelled'` かつ `payment_status IS NULL`) は `resolveOrderDomainState` により
 *   `legacyClassification === 'legacy_undetermined'`, `paymentStatus === 'paid'` として解決されるため、誤って未決済扱いされず保持される。
 */
export function shouldIncludeOrderInSalesHistory(raw: {
  status: LegacyOrderStatus | string;
  paymentStatus?: PaymentStatus | string | null;
  productionStatus?: ProductionStatus | string | null;
  fulfillmentStatus?: FulfillmentStatus | string | null;
  cancellationStatus?: CancellationStatus | string | null;
  refundedAmount?: number | null;
}): boolean {
  if (raw.status === 'unpaid') {
    return false;
  }

  const domain = resolveOrderDomainState({
    status: raw.status,
    payment_status: raw.paymentStatus,
    production_status: raw.productionStatus,
    fulfillment_status: raw.fulfillmentStatus,
    cancellation_status: raw.cancellationStatus,
    refunded_amount: raw.refundedAmount,
  });

  if (domain.paymentStatus === 'unpaid' || domain.paymentStatus === 'failed') {
    return false;
  }

  return true;
}
