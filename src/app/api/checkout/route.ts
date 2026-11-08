import { type NextRequest } from 'next/server';
import Stripe from 'stripe';
import { addOrder, type OrderItem } from '../../../lib/store';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
const stripe = new Stripe(stripeSecretKey, {
  // Use a fallback or auto-select version
});

/**
 * サーバー側マスター価格表（クライアントからの不正な価格改ざんを防止する）
 */
const MASTER_ITEM_PRICES: Record<string, number> = {
  '本日のお茶': 250,
  '緑茶': 250,
  '釜炒り緑茶': 250,
  '青茶': 250,
  'ほうじ茶': 250,
  '緑茶ミルクティー': 400,
  '釜炒り緑茶ミルクティー': 400,
  '青茶ミルクティー': 400,
  'ほうじ茶ミルクティー': 400,
  '金木犀青茶ミルクティー': 400,
  '薔薇ほうじ茶ミルクティー': 400,
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { items, customerName, customerAvatar } = body as {
      items?: OrderItem[];
      customerName?: string;
      customerAvatar?: string;
    };

    if (!items || !Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'items が空です' }, { status: 400 });
    }
    if (!customerName || typeof customerName !== 'string') {
      return Response.json({ error: 'customerName が必要です' }, { status: 400 });
    }

    // アイテムと価格・数量のサーバー側バリデーション
    const sanitizedItems: OrderItem[] = [];
    for (const item of items) {
      if (!item || typeof item.name !== 'string' || typeof item.quantity !== 'number') {
        return Response.json({ error: '不正な商品データが含まれています' }, { status: 400 });
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 50) {
        return Response.json({ error: '数量が不正です' }, { status: 400 });
      }
      const baseName = item.name.split(' (')[0].trim();
      const masterPrice = MASTER_ITEM_PRICES[baseName];
      const unitPrice = masterPrice !== undefined ? masterPrice : item.price;
      if (typeof unitPrice !== 'number' || unitPrice <= 0) {
        return Response.json({ error: '商品価格が不正です' }, { status: 400 });
      }
      sanitizedItems.push({
        name: item.name,
        price: unitPrice,
        quantity: item.quantity,
      });
    }

    // 1. Supabaseに未決済 (unpaid) として注文を登録
    const order = await addOrder(sanitizedItems, customerName, customerAvatar);

    // 2. Stripe Checkout Session の作成
    const origin = request.nextUrl.origin;

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = sanitizedItems.map(
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
      success_url: `${origin}/?success=true&order_no=${order.orderNumber}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?cancelled=true`,
    });

    return Response.json({ url: session.url });
  } catch (err: unknown) {
    console.error('Checkout session creation failed:', err);
    const message =
      err instanceof Error ? err.message : 'チェックアウトセッションの作成に失敗しました';
    return Response.json({ error: message }, { status: 500 });
  }
}
