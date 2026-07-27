import { type NextRequest } from 'next/server';
import Stripe from 'stripe';
import { addOrder } from '../../../lib/store';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
const stripe = new Stripe(stripeSecretKey, {
  // Use a fallback or auto-select version
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { items, customerName, customerAvatar } = body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'items が空です' }, { status: 400 });
    }
    if (!customerName) {
      return Response.json({ error: 'customerName が必要です' }, { status: 400 });
    }

    // 1. Supabaseに未決済 (unpaid) として注文を登録
    const order = await addOrder(items, customerName, customerAvatar);

    // 2. Stripe Checkout Session の作成
    const origin = request.nextUrl.origin;
    
    // Line items mapping
    const lineItems = items.map((item: any) => ({
      price_data: {
        currency: 'jpy',
        product_data: {
          name: item.name,
        },
        unit_amount: item.price,
      },
      quantity: item.quantity,
    }));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'paypay'] as any,
      line_items: lineItems,
      mode: 'payment',
      metadata: {
        orderId: order.id,
        orderNumber: order.orderNumber,
      },
      success_url: `${origin}/?success=true&order_no=${order.orderNumber}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?cancelled=true`,
    });

    return Response.json({ url: session.url });
  } catch (err: any) {
    console.error('Checkout session creation failed:', err);
    return Response.json(
      { error: err.message || 'チェックアウトセッションの作成に失敗しました' },
      { status: 500 }
    );
  }
}
