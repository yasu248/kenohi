/**
 * Phase 0-G: 返金処理の分離・管理モジュール
 *
 * 目的:
 * 1. Webhook 受信ハンドラから Stripe Refund API の直接実行を分離する
 * 2. 永続化された返金案件 (order_refund_requests) に対し、案件ごとに固定された Idempotency Key で安全に返金を実行する
 * 3. 返金実行前に Stripe 側の最新状態を再照合し、二重返金を確実に防止する
 * 4. タイムアウト時は Stripe 側の結果を再照合し、成功していれば DB を succeeded に更新する
 * 5. 永続的な失敗時は管理者対応 (requires_manual_attention = true) に切り替えて DB に記録する
 */

import type Stripe from 'stripe';
import { updateRefundRequestStatus, type OrderRefundRequestRecord } from './store.ts';

export interface RefundExecutionResult {
  ok: boolean;
  code:
    | 'SUCCESS'
    | 'ALREADY_REFUNDED'
    | 'MISSING_PAYMENT_INTENT'
    | 'STRIPE_TIMEOUT_RECOVERED'
    | 'FAILED'
    | 'RATE_LIMITED';
  message: string;
  stripeRefundId?: string;
  requiresManualAttention?: boolean;
}

export interface IRefundStripeClient {
  paymentIntents: {
    retrieve(
      id: string,
      params?: any
    ): Promise<any>;
  };
  refunds: {
    create(
      params: Stripe.RefundCreateParams,
      options?: Stripe.RequestOptions
    ): Promise<Stripe.Refund>;
  };
}

export type UpdateRefundStatusFn = (params: {
  orderId: string;
  refundStatus: 'pending' | 'processing' | 'succeeded' | 'failed';
  stripeRefundId?: string | null;
  lastError?: string | null;
  requiresManualAttention?: boolean;
  incrementAttempt?: boolean;
}) => Promise<{ ok: boolean; code?: string }>;

export async function executeOrderRefund(params: {
  refundCase: OrderRefundRequestRecord;
  stripeClient: IRefundStripeClient;
  statusUpdater?: UpdateRefundStatusFn;
  orderNumber?: string;
}): Promise<RefundExecutionResult> {
  const { refundCase, stripeClient, statusUpdater = updateRefundRequestStatus } = params;

  // 1. すでに成功している場合は二重実行をスキップ
  if (refundCase.refundStatus === 'succeeded') {
    return {
      ok: true,
      code: 'ALREADY_REFUNDED',
      message: '返金は既に完了しています',
      stripeRefundId: refundCase.stripeRefundId ?? undefined,
      requiresManualAttention: false,
    };
  }

  const paymentIntentId = refundCase.paymentIntentId;
  if (!paymentIntentId) {
    await updateRefundRequestStatus({
      orderId: refundCase.orderId,
      refundStatus: 'failed',
      lastError: 'MISSING_PAYMENT_INTENT: payment_intent_id が記録されていません',
      requiresManualAttention: true,
      incrementAttempt: true,
    });
    return {
      ok: false,
      code: 'MISSING_PAYMENT_INTENT',
      message: 'payment_intent_id が存在しないため返金できません',
      requiresManualAttention: true,
    };
  }

  // 2. 返金実行前に Stripe 側の最新決済・返金状況を確認（二重返金の完全防止）
  try {
    const pi = await stripeClient.paymentIntents.retrieve(paymentIntentId);
    if (pi.amount_refunded && pi.amount_refunded >= refundCase.targetRefundAmount) {
      // すでに Stripe 側で返金完了済みだった場合
      const existingRefundId = pi.refunds?.data?.[0]?.id;
      await updateRefundRequestStatus({
        orderId: refundCase.orderId,
        refundStatus: 'succeeded',
        stripeRefundId: existingRefundId,
        lastError: null,
        requiresManualAttention: false,
      });
      return {
        ok: true,
        code: 'ALREADY_REFUNDED',
        message: 'Stripe 側で既に返金が完了していることを確認しました',
        stripeRefundId: existingRefundId,
        requiresManualAttention: false,
      };
    }
  } catch (checkErr) {
    console.warn(
      `[RefundManager] Warning: Failed to pre-check PaymentIntent ${paymentIntentId}:`,
      checkErr
    );
  }

  // 3. 案件ごとに固定された Idempotency Key で Stripe Refund API を実行
  const idempotencyKey = `kenocha_refund_${refundCase.orderId}`;

  // 実行中状態 (processing) に更新
  await updateRefundRequestStatus({
    orderId: refundCase.orderId,
    refundStatus: 'processing',
    incrementAttempt: true,
  });

  try {
    const refund = await stripeClient.refunds.create(
      {
        payment_intent: paymentIntentId,
        amount: refundCase.targetRefundAmount,
        reason: 'requested_by_customer',
      },
      { idempotencyKey }
    );

    // 成功記録
    await updateRefundRequestStatus({
      orderId: refundCase.orderId,
      refundStatus: 'succeeded',
      stripeRefundId: refund.id,
      lastError: null,
      requiresManualAttention: false,
    });

    return {
      ok: true,
      code: 'SUCCESS',
      message: '返金が正常に完了しました',
      stripeRefundId: refund.id,
      requiresManualAttention: false,
    };
  } catch (err: any) {
    const isTimeout =
      err?.code === 'ETIMEDOUT' ||
      err?.type === 'StripeConnectionError' ||
      err?.message?.includes('timeout');

    // 4. タイムアウト時は Stripe 側を再照合して成否を確認
    if (isTimeout) {
      try {
        const recheckPi = await stripeClient.paymentIntents.retrieve(paymentIntentId);
        if (recheckPi.amount_refunded && recheckPi.amount_refunded >= refundCase.targetRefundAmount) {
          const recoveredRefundId = recheckPi.refunds?.data?.[0]?.id;
          await updateRefundRequestStatus({
            orderId: refundCase.orderId,
            refundStatus: 'succeeded',
            stripeRefundId: recoveredRefundId,
            lastError: null,
            requiresManualAttention: false,
          });
          return {
            ok: true,
            code: 'STRIPE_TIMEOUT_RECOVERED',
            message: 'タイムアウト後に再照合し、返金完了を確認しました',
            stripeRefundId: recoveredRefundId,
            requiresManualAttention: false,
          };
        }
      } catch (recheckErr) {
        console.error('[RefundManager] Recheck after timeout failed:', recheckErr);
      }
    }

    // 5. 永続的な失敗時は管理者対応 (requires_manual_attention = true) に切り替えて記録
    const errMsg = err instanceof Error ? err.message : 'Unknown refund error';
    await updateRefundRequestStatus({
      orderId: refundCase.orderId,
      refundStatus: 'failed',
      lastError: errMsg,
      requiresManualAttention: true,
    });

    return {
      ok: false,
      code: 'FAILED',
      message: `返金API呼び出しに失敗しました: ${errMsg}`,
      requiresManualAttention: true,
    };
  }
}
