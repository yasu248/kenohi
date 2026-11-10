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
    const session = event.data.object as Stripe.Checkout.Session;

    try {
      const confirmation = await verifyAndConfirmStripePayment({
        session: {
          id: session.id,
          payment_status: session.payment_status,
          amount_total: session.amount_total,
          currency: session.currency,
          metadata: session.metadata,
          payment_intent: session.payment_intent,
        },
        repo: supabasePaymentRepository,
        webhookEventId: event.id,
      });

      if (!confirmation.ok) {
        if (confirmation.code === 'CANCELLED_PAYMENT_DISCREPANCY') {
          console.warn(
            `[Webhook][PaymentDiscrepancy] Session ${session.id} (event=${event.id}) order ${confirmation.orderId} was cancelled but paid. Discrepancy recorded to refund queue.`
          );
          return Response.json({
            received: true,
            status: 'discrepancy_recorded_for_refund',
            orderId: confirmation.orderId,
          });
        }

        if (confirmation.retryable) {
          console.warn(
            `[Webhook][Retryable] Session ${session.id} (event=${event.id}) not yet completed: ${confirmation.message}`
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
          `[Webhook][PermanentValidationError] Session ${session.id} (event=${event.id}) rejected permanently: [${confirmation.code}] ${confirmation.message}`
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
