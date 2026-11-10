import { isBusinessHours, isStoreCurrentlyOpen } from './businessHours.ts';
import type { Order, OrderItem, StoreState } from './store.ts';

/**
 * Phase 0: モバイル注文 Checkout サーバーサイドガード & 商品・価格・欠品検証モジュール
 *
 * 要件:
 * 1. 手動受付停止 (`isManualOpen: false`) および営業時間外 (`isStoreCurrentlyOpen === false`) の注文をサーバー側で確実に拒否する
 * 2. 店舗状態が取得できない場合（DBエラー・null・未初期化）は安全側（フェイルクローズ）に倒して新規受付を拒否する
 * 3. 商品ID (`s1`〜`s5`, `m1`〜`m6`)・商品名・オプション（ゼリー・甘さ・氷）・単価・合計金額をサーバー側マスターで厳格に検証する
 * 4. 欠品商品 (`soldOutItems`) を商品ID (`s1`〜`m6`) で厳密に照合して拒否する
 * 5. 受付状態確認直後にスタッフが受付停止した場合の競合（TOCTOU）に対し、注文レコード作成直後・Stripeセッション発行前にも
 *    店舗状態を再確認し、停止されていた場合は注文を即座に取消して Stripe Checkout セッションを発行しない
 */

export interface MenuCatalogEntry {
  id: string;
  name: string;
  price: number;
  category: 'straight' | 'milk' | 'soda';
  allowZeroSweetness: boolean;
}

export const MENU_CATALOG: readonly MenuCatalogEntry[] = [
  { id: 's1', name: '本日のお茶', price: 250, category: 'straight', allowZeroSweetness: true },
  { id: 's2', name: '緑茶', price: 250, category: 'straight', allowZeroSweetness: true },
  { id: 's3', name: '釜炒り緑茶', price: 250, category: 'straight', allowZeroSweetness: true },
  { id: 's4', name: '青茶', price: 250, category: 'straight', allowZeroSweetness: true },
  { id: 's5', name: 'ほうじ茶', price: 250, category: 'straight', allowZeroSweetness: true },
  { id: 'm1', name: '緑茶ミルクティー', price: 400, category: 'milk', allowZeroSweetness: true },
  { id: 'm2', name: '釜炒り緑茶ミルクティー', price: 400, category: 'milk', allowZeroSweetness: true },
  { id: 'm3', name: '青茶ミルクティー', price: 400, category: 'milk', allowZeroSweetness: true },
  { id: 'm4', name: 'ほうじ茶ミルクティー', price: 400, category: 'milk', allowZeroSweetness: true },
  { id: 'm5', name: '金木犀青茶ミルクティー', price: 400, category: 'milk', allowZeroSweetness: false },
  { id: 'm6', name: '薔薇ほうじ茶ミルクティー', price: 400, category: 'milk', allowZeroSweetness: false },
] as const;

const CATALOG_BY_ID = new Map<string, MenuCatalogEntry>(
  MENU_CATALOG.map((item) => [item.id, item])
);

const CATALOG_BY_NAME = new Map<string, MenuCatalogEntry>(
  MENU_CATALOG.map((item) => [item.name, item])
);

const VALID_JELLY_OPTIONS = new Set(['あり', 'なし']);
const VALID_SWEETNESS_OPTIONS = new Set(['普通', '控えめ', 'なし']);
const VALID_ICE_OPTIONS = new Set(['氷あり', '氷なし']);

export interface CheckoutItemInput {
  id?: string;
  name?: unknown;
  price?: unknown;
  quantity?: unknown;
  sweetness?: unknown;
  ice?: unknown;
  jelly?: unknown;
}

export interface ValidatedCheckoutItem extends OrderItem {
  id: string;
  baseName: string;
}

export type CheckoutRejectionCode =
  | 'STORE_STATE_UNAVAILABLE'
  | 'STORE_CLOSED'
  | 'EMPTY_ITEMS'
  | 'MISSING_CUSTOMER_NAME'
  | 'INVALID_ITEM_DATA'
  | 'INVALID_ITEM_ID'
  | 'UNKNOWN_MENU_ITEM'
  | 'ITEM_ID_NAME_MISMATCH'
  | 'INVALID_ITEM_OPTIONS'
  | 'INVALID_QUANTITY'
  | 'INVALID_ITEM_PRICE'
  | 'TOTAL_PRICE_MISMATCH'
  | 'ITEM_SOLD_OUT';

export type CheckoutValidationResult =
  | {
      ok: true;
      sanitizedItems: ValidatedCheckoutItem[];
      calculatedTotalPrice: number;
      customerName: string;
      customerAvatar?: string;
    }
  | {
      ok: false;
      code: CheckoutRejectionCode;
      message: string;
      status: 400 | 409 | 503;
    };

/**
 * `商品名 (ゼリー: なし, 甘さ: 普通, 氷: 氷あり)` の形式からベース商品名とオプション文字列を分離する
 */
export function parseItemNameAndOptions(rawName: string): {
  baseName: string;
  optionsRaw: string | null;
  parsedOptions: { jelly?: string; sweetness?: string; ice?: string } | null;
} {
  const trimmed = rawName.trim();
  const openIdx = trimmed.indexOf(' (');
  if (openIdx === -1) {
    return { baseName: trimmed, optionsRaw: null, parsedOptions: null };
  }

  if (!trimmed.endsWith(')')) {
    return { baseName: trimmed, optionsRaw: null, parsedOptions: null };
  }

  const baseName = trimmed.slice(0, openIdx).trim();
  const optionsRaw = trimmed.slice(openIdx + 2, -1).trim();

  const parsedOptions: { jelly?: string; sweetness?: string; ice?: string } = {};
  const parts = optionsRaw.split(',').map((p) => p.trim());
  for (const part of parts) {
    if (part.startsWith('ゼリー:')) {
      parsedOptions.jelly = part.slice('ゼリー:'.length).trim();
    } else if (part.startsWith('甘さ:')) {
      parsedOptions.sweetness = part.slice('甘さ:'.length).trim();
    } else if (part.startsWith('氷:')) {
      parsedOptions.ice = part.slice('氷:'.length).trim();
    }
  }

  return { baseName, optionsRaw, parsedOptions };
}

/**
 * 店舗の営業状態・欠品状態・注文アイテム・価格をサーバー側で厳格に検証する
 */
export function validateCheckoutRequest(params: {
  body: {
    items?: unknown;
    customerName?: unknown;
    customerAvatar?: unknown;
    totalPrice?: unknown;
  };
  storeState: StoreState | null;
  now?: Date;
}): CheckoutValidationResult {
  const { body, storeState, now } = params;

  // 1. 店舗状態の取得確認（取得不能時は安全側に倒して拒否）
  if (!storeState) {
    return {
      ok: false,
      code: 'STORE_STATE_UNAVAILABLE',
      message: '現在、店舗の受付状態を確認できないため注文を受け付けられません。しばらくしてから再度お試しください。',
      status: 503,
    };
  }

  // 2. 営業時間・手動受付状態の判定
  if (!isBusinessHours(now) || !isStoreCurrentlyOpen(storeState, undefined, now)) {
    return {
      ok: false,
      code: 'STORE_CLOSED',
      message: '現在、注文の受付を停止しています（営業時間外または受付停止中）。',
      status: 503,
    };
  }

  // 3. リクエスト基本構造の検証
  if (!body || !Array.isArray(body.items) || body.items.length === 0) {
    return {
      ok: false,
      code: 'EMPTY_ITEMS',
      message: 'カートに商品が入っていません。',
      status: 400,
    };
  }

  if (typeof body.customerName !== 'string' || body.customerName.trim().length === 0) {
    return {
      ok: false,
      code: 'MISSING_CUSTOMER_NAME',
      message: 'お客様名（customerName）が必要です。',
      status: 400,
    };
  }

  const soldOutSet = new Set(storeState.soldOutItems ?? []);
  const sanitizedItems: ValidatedCheckoutItem[] = [];
  let calculatedTotalPrice = 0;

  for (const rawItem of body.items as CheckoutItemInput[]) {
    if (!rawItem || typeof rawItem !== 'object') {
      return {
        ok: false,
        code: 'INVALID_ITEM_DATA',
        message: '不正な商品データが含まれています。',
        status: 400,
      };
    }

    if (typeof rawItem.name !== 'string' || rawItem.name.trim().length === 0) {
      return {
        ok: false,
        code: 'INVALID_ITEM_DATA',
        message: '商品名が指定されていません。',
        status: 400,
      };
    }

    if (
      typeof rawItem.quantity !== 'number' ||
      !Number.isInteger(rawItem.quantity) ||
      rawItem.quantity < 1 ||
      rawItem.quantity > 50
    ) {
      return {
        ok: false,
        code: 'INVALID_QUANTITY',
        message: '数量が不正です（1〜50の範囲で指定してください）。',
        status: 400,
      };
    }

    const { baseName, parsedOptions } = parseItemNameAndOptions(rawItem.name);

    // 4. 商品ID (`s1`〜`s5`, `m1`〜`m6`) と商品名の厳密照合
    let catalogEntry: MenuCatalogEntry | undefined;

    if (rawItem.id !== undefined) {
      if (typeof rawItem.id !== 'string' || !CATALOG_BY_ID.has(rawItem.id)) {
        return {
          ok: false,
          code: 'INVALID_ITEM_ID',
          message: `不正な商品IDが指定されています (${String(rawItem.id)})。`,
          status: 400,
        };
      }
      catalogEntry = CATALOG_BY_ID.get(rawItem.id)!;
      if (baseName !== catalogEntry.name) {
        return {
          ok: false,
          code: 'ITEM_ID_NAME_MISMATCH',
          message: `商品ID (${rawItem.id}) と商品名 (${baseName}) が一致しません。`,
          status: 400,
        };
      }
    } else {
      catalogEntry = CATALOG_BY_NAME.get(baseName);
      if (!catalogEntry) {
        return {
          ok: false,
          code: 'UNKNOWN_MENU_ITEM',
          message: `存在しない商品が指定されています (${baseName})。`,
          status: 400,
        };
      }
    }

    // 5. オプション（ゼリー・甘さ・氷）の検証
    const jellyVal =
      typeof rawItem.jelly === 'string' ? rawItem.jelly : parsedOptions?.jelly;
    const sweetnessVal =
      typeof rawItem.sweetness === 'string' ? rawItem.sweetness : parsedOptions?.sweetness;
    const iceVal =
      typeof rawItem.ice === 'string' ? rawItem.ice : parsedOptions?.ice;

    if (jellyVal !== undefined && !VALID_JELLY_OPTIONS.has(jellyVal)) {
      return {
        ok: false,
        code: 'INVALID_ITEM_OPTIONS',
        message: `不正なゼリーオプションです (${jellyVal})。`,
        status: 400,
      };
    }
    if (sweetnessVal !== undefined && !VALID_SWEETNESS_OPTIONS.has(sweetnessVal)) {
      return {
        ok: false,
        code: 'INVALID_ITEM_OPTIONS',
        message: `不正な甘さオプションです (${sweetnessVal})。`,
        status: 400,
      };
    }
    if (!catalogEntry.allowZeroSweetness && sweetnessVal === 'なし') {
      return {
        ok: false,
        code: 'INVALID_ITEM_OPTIONS',
        message: `「${catalogEntry.name}」は甘さなしを選択できません。`,
        status: 400,
      };
    }
    if (iceVal !== undefined && !VALID_ICE_OPTIONS.has(iceVal)) {
      return {
        ok: false,
        code: 'INVALID_ITEM_OPTIONS',
        message: `不正な氷オプションです (${iceVal})。`,
        status: 400,
      };
    }

    // 6. 欠品商品のサーバー側チェック（商品ID `s1`〜`m6` および商品名で照合）
    if (soldOutSet.has(catalogEntry.id) || soldOutSet.has(catalogEntry.name)) {
      return {
        ok: false,
        code: 'ITEM_SOLD_OUT',
        message: `申し訳ございません。「${catalogEntry.name}」は現在欠品中です。`,
        status: 409,
      };
    }

    // 7. 単価の改ざん検証（クライアント申告価格がマスター価格と異なる場合は拒否）
    if (
      rawItem.price !== undefined &&
      (typeof rawItem.price !== 'number' || rawItem.price !== catalogEntry.price)
    ) {
      return {
        ok: false,
        code: 'INVALID_ITEM_PRICE',
        message: `「${catalogEntry.name}」の価格が不正です。ページを再読み込みしてください。`,
        status: 400,
      };
    }

    const unitPrice = catalogEntry.price;
    calculatedTotalPrice += unitPrice * rawItem.quantity;

    sanitizedItems.push({
      id: catalogEntry.id,
      baseName: catalogEntry.name,
      name: rawItem.name.trim(),
      price: unitPrice,
      quantity: rawItem.quantity,
      ...(jellyVal !== undefined ? { jelly: jellyVal } : {}),
      ...(sweetnessVal !== undefined ? { sweetness: sweetnessVal } : {}),
      ...(iceVal !== undefined ? { ice: iceVal } : {}),
    });
  }

  // 8. 合計金額がリクエストに含まれている場合、サーバー計算値との一致を検証
  if (
    body.totalPrice !== undefined &&
    (typeof body.totalPrice !== 'number' || body.totalPrice !== calculatedTotalPrice)
  ) {
    return {
      ok: false,
      code: 'TOTAL_PRICE_MISMATCH',
      message: `合計金額 (${String(body.totalPrice)}円) がサーバー計算値 (${calculatedTotalPrice}円) と一致しません。`,
      status: 400,
    };
  }

  return {
    ok: true,
    sanitizedItems,
    calculatedTotalPrice,
    customerName: body.customerName.trim(),
    customerAvatar:
      typeof body.customerAvatar === 'string' && body.customerAvatar.trim().length > 0
        ? body.customerAvatar.trim()
        : undefined,
  };
}

export interface ICheckoutExecutionDependencies {
  getStoreState: () => Promise<StoreState | null>;
  addOrder: (
    items: OrderItem[],
    customerName: string,
    customerAvatar?: string
  ) => Promise<Order>;
  cancelOrderOnAbort: (orderId: string) => Promise<void>;
  createStripeCheckoutSession: (params: {
    order: Order;
    items: ValidatedCheckoutItem[];
    origin: string;
  }) => Promise<{ url: string | null }>;
}

/**
 * 競合対策付き Checkout 実行関数:
 * 1. 事前検証（開店状態・欠品・商品ID・価格）をパスした場合のみ注文レコードを作成
 * 2. 注文作成直後・Stripe Checkout セッション発行前に再度 `getStoreState()` を確認し、
 *    万が一注文作成とほぼ同時にスタッフが受付停止（または対象商品を欠品化）していた場合は、
 *    作成した未決済注文を即座にキャンセル (`cancelOrderOnAbort`) し、Stripe セッションを発行せず 503/409 で停止する。
 */
export async function executeGuardedCheckout(params: {
  body: {
    items?: unknown;
    customerName?: unknown;
    customerAvatar?: unknown;
    totalPrice?: unknown;
  };
  origin: string;
  deps: ICheckoutExecutionDependencies;
  now?: Date;
}): Promise<
  | { ok: true; url: string; orderId: string; orderNumber: string }
  | { ok: false; code: CheckoutRejectionCode | 'SESSION_CREATION_FAILED'; message: string; status: 400 | 409 | 500 | 503 }
> {
  const { body, origin, deps, now } = params;

  // Step 1: 店舗状態の取得（例外発生時も安全側に倒して 503 拒否）
  let initialStoreState: StoreState | null = null;
  try {
    initialStoreState = await deps.getStoreState();
  } catch (err) {
    console.error('[CheckoutGuard] Failed to fetch store state:', err);
    return {
      ok: false,
      code: 'STORE_STATE_UNAVAILABLE',
      message: '現在、店舗の受付状態を確認できないため注文を受け付けられません。',
      status: 503,
    };
  }

  // Step 2: 受付状態・商品ID・オプション・欠品・価格の検証
  const validation = validateCheckoutRequest({
    body,
    storeState: initialStoreState,
    now,
  });

  if (!validation.ok) {
    return validation;
  }

  // Step 3: 未決済注文レコードの登録
  const orderItemsForDb: OrderItem[] = validation.sanitizedItems.map((item) => ({
    id: item.id,
    name: item.name,
    price: item.price,
    quantity: item.quantity,
    ...(item.jelly !== undefined ? { jelly: item.jelly } : {}),
    ...(item.sweetness !== undefined ? { sweetness: item.sweetness } : {}),
    ...(item.ice !== undefined ? { ice: item.ice } : {}),
  }));

  const createdOrder = await deps.addOrder(
    orderItemsForDb,
    validation.customerName,
    validation.customerAvatar
  );

  // Step 4: 競合防止（TOCTOU対策）— 注文作成中にスタッフが受付停止または欠品変更を行ったか再確認
  let postOrderStoreState: StoreState | null = null;
  try {
    postOrderStoreState = await deps.getStoreState();
  } catch (err) {
    console.error('[CheckoutGuard] Post-order store state check failed, aborting order:', err);
    await deps.cancelOrderOnAbort(createdOrder.id).catch(() => {});
    return {
      ok: false,
      code: 'STORE_STATE_UNAVAILABLE',
      message: '店舗状態の確認中にエラーが発生したため、注文を中断しました。',
      status: 503,
    };
  }

  const postValidation = validateCheckoutRequest({
    body,
    storeState: postOrderStoreState,
    now,
  });

  if (!postValidation.ok) {
    // 競合により受付停止または欠品となったため、作成した未決済注文を即座に取消し、Stripe セッションを発行しない
    await deps.cancelOrderOnAbort(createdOrder.id).catch((cancelErr) => {
      console.error('[CheckoutGuard] Failed to cancel aborted order:', cancelErr);
    });
    return postValidation;
  }

  // Step 5: Stripe Checkout Session の発行
  const session = await deps.createStripeCheckoutSession({
    order: createdOrder,
    items: validation.sanitizedItems,
    origin,
  });

  if (!session.url) {
    await deps.cancelOrderOnAbort(createdOrder.id).catch(() => {});
    return {
      ok: false,
      code: 'SESSION_CREATION_FAILED',
      message: '決済セッションURLの取得に失敗しました。',
      status: 500,
    };
  }

  return {
    ok: true,
    url: session.url,
    orderId: createdOrder.id,
    orderNumber: createdOrder.orderNumber,
  };
}
