import { type NextRequest } from 'next/server';
import Stripe from 'stripe';
import { updateOrderStatus } from '../../../../lib/store';

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
  } catch (err: any) {
    console.error(`Webhook signature verification failed:`, err.message);
    return Response.json(
      { error: `Webhook Error: ${err.message}` },
      { status: 400 }
    );
  }

  // Handle the event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const orderId = session.metadata?.orderId;

    if (orderId) {
      try {
        console.log(`[Webhook] Stripe payment succeeded. Updating order ${orderId} to 'pending'`);
        await updateOrderStatus(orderId, 'pending');
      } catch (err) {
        console.error(`[Webhook] Failed to update order status in database:`, err);
        return Response.json({ error: 'Database update failed' }, { status: 500 });
      }
    } else {
      console.warn('[Webhook] No orderId found in session metadata');
    }
  }

  return Response.json({ received: true });
}
export const dynamic = 'force-dynamic';
