import { type NextRequest } from 'next/server';
import Stripe from 'stripe';
import {
  abortMobileOrderCheckout,
  addOrder,
  createMobileOrderAtomically,
  finalizeMobileOrderCheckout,
  getStoreState,
} from '../../../lib/store';
import { executeGuardedCheckout } from '../../../lib/checkoutValidation';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
const stripe = new Stripe(stripeSecretKey, {
  // Use a fallback or auto-select version
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const origin = request.nextUrl.origin;

    const result = await executeGuardedCheckout({
      body,
      origin,
      deps: {
        getStoreState,
        addOrder,
        createMobileOrderAtomically,
        finalizeCheckoutSession: finalizeMobileOrderCheckout,
        cancelOrderOnAbort: async (
          orderId: string,
          stripeSessionId?: string,
          reason?: string
        ) => {
          await abortMobileOrderCheckout({ orderId, stripeSessionId, reason });
        },
        createStripeCheckoutSession: async ({ order, items, origin: reqOrigin }) => {
          const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = items.map(
            (item) => ({
              price_data: {
                currency: 'jpy',
                product_data: {
                  name: item.name,
                },
                unit_amount: item.price,
              },
              quantity: item.quantity,
            })
          );

          const session = await stripe.checkout.sessions.create({
            payment_method_types: [
              'card',
              'paypay',
            ] as Stripe.Checkout.SessionCreateParams.PaymentMethodType[],
            line_items: lineItems,
            mode: 'payment',
            metadata: {
              orderId: order.id,
              orderNumber: order.orderNumber,
            },
            success_url: `${reqOrigin}/?success=true&order_no=${order.orderNumber}&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${reqOrigin}/?cancelled=true`,
          });

          return { id: session.id, url: session.url };
        },
        expireStripeCheckoutSession: async (sessionId: string) => {
          await stripe.checkout.sessions.expire(sessionId);
        },
      },
    });

    if (!result.ok) {
      return Response.json(
        { error: result.message, code: result.code },
        { status: result.status }
      );
    }

    return Response.json({ url: result.url });
  } catch (err: unknown) {
    console.error('Checkout session creation failed:', err);
    const message =
      err instanceof Error ? err.message : 'チェックアウトセッションの作成に失敗しました';
    return Response.json({ error: message }, { status: 500 });
  }
}
