import { type NextRequest } from 'next/server';
import Stripe from 'stripe';
import { supabasePaymentRepository } from '../../../../lib/store';
import { verifyAndConfirmStripePayment } from '../../../../lib/stripeConfirmation';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
const stripe = new Stripe(stripeSecretKey, {
  // Use fallback or auto-select
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionId } = body;

    if (!sessionId || typeof sessionId !== 'string') {
      return Response.json({ error: 'sessionId が必要です' }, { status: 400 });
    }

    // Stripeからセッション情報を取得して支払い状態・金額・通貨・注文IDを検証
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const confirmation = await verifyAndConfirmStripePayment({
      session: {
        id: session.id,
        payment_status: session.payment_status,
        amount_total: session.amount_total,
        currency: session.currency,
        metadata: session.metadata,
      },
      repo: supabasePaymentRepository,
    });

    if (!confirmation.ok) {
      return Response.json(
        { error: confirmation.message, code: confirmation.code },
        { status: confirmation.status }
      );
    }

    return Response.json({
      success: true,
      orderId: confirmation.orderId,
      status: confirmation.currentStatus,
      idempotentReplay: confirmation.idempotentReplay,
    });
  } catch (err: unknown) {
    console.error('Order confirmation failed:', err);
    const message = err instanceof Error ? err.message : '注文の確定処理に失敗しました';
    return Response.json({ error: message }, { status: 500 });
  }
}
