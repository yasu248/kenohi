import { type NextRequest } from 'next/server';
import Stripe from 'stripe';
import { updateOrderStatus } from '../../../../lib/store';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
const stripe = new Stripe(stripeSecretKey, {
  // Use fallback or auto-select
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionId } = body;

    if (!sessionId) {
      return Response.json({ error: 'sessionId が必要です' }, { status: 400 });
    }

    // Stripeからセッション情報を取得して支払い状態を確認
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    if (session.payment_status !== 'paid') {
      return Response.json({ error: '決済が完了していません' }, { status: 400 });
    }

    const orderId = session.metadata?.orderId;
    if (!orderId) {
      return Response.json(
        { error: 'セッションに関連付けられた注文IDが見つかりません' },
        { status: 400 }
      );
    }

    // 注文ステータスを 'unpaid' ➔ 'pending' に更新して、キッチンモニターに表示されるようにする
    const updatedOrder = await updateOrderStatus(orderId, 'pending');

    return Response.json({ success: true, order: updatedOrder });
  } catch (err: any) {
    console.error('Order confirmation failed:', err);
    return Response.json(
      { error: err.message || '注文の確定処理に失敗しました' },
      { status: 500 }
    );
  }
}
