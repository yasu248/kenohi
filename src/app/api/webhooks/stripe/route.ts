import { type NextRequest } from 'next/server';
import Stripe from 'stripe';
import { supabasePaymentRepository } from '../../../../lib/store';
import { verifyAndConfirmStripePayment } from '../../../../lib/stripeConfirmation';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
const stripe = new Stripe(stripeSecretKey, {
  // Use fallback or auto-select
});

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const sig = request.headers.get('stripe-signature') || '';

  if (!endpointSecret) {
    console.warn('STRIPE_WEBHOOK_SECRET is not set. Webhook signature verification skipped.');
    return Response.json(
      { error: 'Webhook secret is not configured in environment variables' },
      { status: 400 }
    );
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, endpointSecret);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Invalid signature';
    console.error('Webhook signature verification failed:', message);
    return Response.json(
      { error: `Webhook Error: ${message}` },
      { status: 400 }
    );
  }

  // Handle the event
  if (event.type === 'checkout.session.completed') {
    const rawSession = event.data.object as Stripe.Checkout.Session;

    // 【安全強化 1】Stripe サーバー実機から最新のセッション状態を取得して二重照合 (Zero-Trust)
    let verifiedSession: Stripe.Checkout.Session;
    try {
      verifiedSession = await stripe.checkout.sessions.retrieve(rawSession.id, {
        expand: ['payment_intent'],
      });
    } catch (retrieveErr) {
      console.error(
        `[Webhook] Stripe API retrieval failed for session ${rawSession.id}:`,
        retrieveErr
      );
      // Stripe API の一時障害時は 500 を返し、Stripe の指数バックオフ再送に委ねる
      return Response.json(
        { error: 'Failed to verify session status with Stripe API', retryable: true },
        { status: 500 }
      );
    }

    // 【安全強化 2】Stripe 側で実際に payment_status === 'paid' でない限り、絶対に注文を確定しない
    if (verifiedSession.payment_status !== 'paid') {
      console.warn(
        `[WebhookGuard] Session ${rawSession.id} is NOT marked as paid on Stripe servers (actual: ${verifiedSession.payment_status}). Order confirmation blocked.`
      );
      // 未払いのまま届いたイベント（または偽装イベント）は注文を確定せず、かつ正当な非同期決済の再送を阻害しないよう 200 で受領完了
      return Response.json({
        received: true,
        status: 'payment_not_paid_on_stripe',
        payment_status: verifiedSession.payment_status,
      });
    }

    try {
      const confirmation = await verifyAndConfirmStripePayment({
        session: {
          id: verifiedSession.id,
          payment_status: verifiedSession.payment_status,
          status: verifiedSession.status,
          mode: verifiedSession.mode,
          livemode: verifiedSession.livemode,
          amount_total: verifiedSession.amount_total,
          currency: verifiedSession.currency,
          metadata: verifiedSession.metadata,
          payment_intent: verifiedSession.payment_intent,
        },
        repo: supabasePaymentRepository,
        webhookEventId: event.id,
      });

      if (!confirmation.ok) {
        if (confirmation.code === 'CANCELLED_PAYMENT_DISCREPANCY') {
          console.warn(
            `[Webhook][PaymentDiscrepancy] Session ${verifiedSession.id} (event=${event.id}) order ${confirmation.orderId} was cancelled but paid. Discrepancy recorded to refund queue.`
          );
          return Response.json({
            received: true,
            status: 'discrepancy_recorded_for_refund',
            orderId: confirmation.orderId,
          });
        }

        if (confirmation.retryable) {
          console.warn(
            `[Webhook][Retryable] Session ${verifiedSession.id} (event=${event.id}) not yet completed: ${confirmation.message}`
          );
          return Response.json(
            {
              error: confirmation.message,
              code: confirmation.code,
              retryable: true,
            },
            { status: confirmation.status }
          );
        }

        console.error(
          `[Webhook][PermanentValidationError] Session ${verifiedSession.id} (event=${event.id}) rejected permanently: [${confirmation.code}] ${confirmation.message}`
        );
        return Response.json(
          {
            error: confirmation.message,
            code: confirmation.code,
            retryable: false,
            permanentFailureRecorded: Boolean(confirmation.permanentFailureRecorded),
          },
          { status: confirmation.status }
        );
      }

      console.log(
        `[Webhook] Stripe payment verified for order ${confirmation.orderId} (status=${confirmation.currentStatus}, replay=${confirmation.idempotentReplay})`
      );
    } catch (err) {
      console.error('[Webhook] Failed to confirm order payment in database:', err);
      return Response.json({ error: 'Database update failed' }, { status: 500 });
    }
  }

  return Response.json({ received: true });
}
export const dynamic = 'force-dynamic';
