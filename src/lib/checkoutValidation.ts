import { isBusinessHours, isStoreCurrentlyOpen } from './businessHours.ts';
import {
  MENU_CATALOG,
  MENU_NAME_BY_ID,
  VALID_ICE_OPTIONS,
  VALID_JELLY_OPTIONS,
  VALID_SWEETNESS_OPTIONS,
  type MenuCatalogItem,
} from './menuCatalog.ts';
import type {
  AtomicMobileOrderCreationResult,
  FinalizeMobileOrderCheckoutResult,
  Order,
  OrderItem,
  StoreState,
} from './store.ts';

export { MENU_CATALOG, MENU_NAME_BY_ID };
export type MenuCatalogEntry = MenuCatalogItem;

/**
 * Phase 0: モバイル注文 Checkout サーバーサイドガード & 商品・価格・欠品・競合制御モジュール
 *
 * 要件:
 * 1. 手動受付停止 (`isManualOpen: false`) および営業時間外 (`isStoreCurrentlyOpen === false`) の注文をサーバー側・DB側の双方で確実に拒否する
 * 2. 店舗状態が取得できない場合（DBエラー・null・未初期化）は安全側（フェイルクローズ）に倒して新規受付を拒否する
 * 3. 商品ID (`s1`〜`s5`, `m1`〜`m6`)・商品名・オプション（ゼリー・甘さ・氷）・単価・合計金額をサーバー側共通マスター (`MENU_CATALOG`) で厳格に検証する
 * 4. 欠品商品 (`soldOutItems`) を商品ID (`s1`〜`m6`) で厳密に照合して拒否する
 * 5. DBトランザクション (`create_mobile_order_tx`) により、受付確認・注文番号採番・注文INSERTを `store_state` 排他制御下で直列化する
 * 6. Stripe API 呼び出し中は DB ロックを保持せず、Stripe Checkout セッション発行直後に再度 `finalize_mobile_order_checkout_tx`（または店舗状態再確認）を実行し、
 *    セッション発行中に受付停止された場合は未決済注文を中断キャンセルしたうえで `stripe.checkout.sessions.expire` をリトライ付きで実行する
 */

const CATALOG_BY_ID = new Map<string, MenuCatalogEntry>(
  MENU_CATALOG.map((item) => [item.id, item])
);

const CATALOG_BY_NAME = new Map<string, MenuCatalogEntry>(
  MENU_CATALOG.map((item) => [item.name, item])
);

const VALID_JELLY_SET = new Set<string>(VALID_JELLY_OPTIONS);
const VALID_SWEETNESS_SET = new Set<string>(VALID_SWEETNESS_OPTIONS);
const VALID_ICE_SET = new Set<string>(VALID_ICE_OPTIONS);

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
      message:
        '現在、店舗の受付状態を確認できないため注文を受け付けられません。しばらくしてから再度お試しください。',
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

    if (jellyVal !== undefined && !VALID_JELLY_SET.has(jellyVal)) {
      return {
        ok: false,
        code: 'INVALID_ITEM_OPTIONS',
        message: `不正なゼリーオプションです (${jellyVal})。`,
        status: 400,
      };
    }
    if (sweetnessVal !== undefined && !VALID_SWEETNESS_SET.has(sweetnessVal)) {
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
    if (iceVal !== undefined && !VALID_ICE_SET.has(iceVal)) {
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
  /**
   * DBトランザクション内で `store_state` ロック取得・開店/営業時間/欠品検証・注文番号採番・注文INSERTを
   * 原子的に実行するオプション関数 (`create_mobile_order_tx` RPC)
   */
  createMobileOrderAtomically?: (params: {
    items: OrderItem[];
    customerName: string;
    customerAvatar?: string;
    itemIds: string[];
    now?: Date;
  }) => Promise<AtomicMobileOrderCreationResult>;
  /**
   * Stripe セッション発行直後に `store_state` ロック下で受付状態を再確認し、
   * 営業中なら `stripe_session_id` を記録、停止中なら未決済注文を中断キャンセルするオプション関数 (`finalize_mobile_order_checkout_tx` RPC)
   */
  finalizeCheckoutSession?: (params: {
    orderId: string;
    stripeSessionId: string;
    itemIds: string[];
    now?: Date;
  }) => Promise<FinalizeMobileOrderCheckoutResult>;
  cancelOrderOnAbort: (
    orderId: string,
    stripeSessionId?: string,
    reason?: string
  ) => Promise<void>;
  createStripeCheckoutSession: (params: {
    order: Order;
    items: ValidatedCheckoutItem[];
    origin: string;
  }) => Promise<{ id?: string; url: string | null }>;
  /**
   * Stripe Checkout セッション発行後に受付停止等が判明した場合、Stripe側のセッションを即座に失効 (`expire`) する関数
   */
  expireStripeCheckoutSession?: (sessionId: string) => Promise<void>;
  /**
   * キャンセル処理または Stripe セッション失効処理が失敗した際の最大試行回数（デフォルト: 3）
   */
  maxRetryAttempts?: number;
}

async function cancelOrderWithRetry(
  deps: ICheckoutExecutionDependencies,
  orderId: string,
  stripeSessionId?: string,
  reason: string = 'checkout_aborted'
): Promise<{ cancelled: boolean; attempts: number; errorMessage?: string }> {
  const maxAttempts = Math.max(1, deps.maxRetryAttempts ?? 3);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await deps.cancelOrderOnAbort(orderId, stripeSessionId, reason);
      return { cancelled: true, attempts: attempt };
    } catch (err) {
      lastErr = err;
    }
  }
  const errorMessage = lastErr instanceof Error ? lastErr.message : String(lastErr);
  console.error(
    `[CheckoutGuard][CRITICAL][CANCEL_ORDER_FAILED] orderId=${orderId} sessionId=${stripeSessionId ?? 'none'} reason=${reason} attempts=${maxAttempts} error=${errorMessage}`
  );
  return { cancelled: false, attempts: maxAttempts, errorMessage };
}

async function expireSessionWithRetry(
  deps: ICheckoutExecutionDependencies,
  orderId: string,
  sessionId: string | undefined,
  reason: string
): Promise<{ expired: boolean; attempts: number; errorMessage?: string }> {
  if (!sessionId || !deps.expireStripeCheckoutSession) {
    return { expired: false, attempts: 0 };
  }
  const maxAttempts = Math.max(1, deps.maxRetryAttempts ?? 3);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await deps.expireStripeCheckoutSession(sessionId);
      return { expired: true, attempts: attempt };
    } catch (err) {
      lastErr = err;
    }
  }
  const errorMessage = lastErr instanceof Error ? lastErr.message : String(lastErr);
  console.error(
    `[CheckoutGuard][CRITICAL][STRIPE_SESSION_EXPIRE_FAILED] orderId=${orderId} sessionId=${sessionId} reason=${reason} attempts=${maxAttempts} error=${errorMessage}`
  );
  return { expired: false, attempts: maxAttempts, errorMessage };
}

/**
 * 競合対策付き Checkout 実行関数:
 * - Step 1/2: 事前検証（店舗状態・営業時間・欠品・商品ID・オプション・価格）
 * - Step 3: DBトランザクション #1 (`createMobileOrderAtomically` または `addOrder` + 再検証) による未決済注文作成（DBロックはここで一旦解放）
 * - Step 4: Stripe Checkout セッションの発行（外部API通信中、DBロックは保持しない）
 * - Step 5: DBトランザクション #2 (`finalizeCheckoutSession` および店舗状態再確認) により、
 *   Stripe通信中にスタッフが受付停止または欠品更新を行っていないか確認。
 *   停止・欠品化されていた場合は、未決済注文をキャンセルし、作成した Stripe セッションを `expire`（リトライ・記録付き）して 503/409 で遮断する。
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
  | {
      ok: true;
      url: string;
      sessionId?: string;
      orderId: string;
      orderNumber: string;
    }
  | {
      ok: false;
      code: CheckoutRejectionCode | 'SESSION_CREATION_FAILED';
      message: string;
      status: 400 | 409 | 500 | 503;
      sessionExpired?: boolean;
      orderCancelled?: boolean;
    }
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

  const orderItemsForDb: OrderItem[] = validation.sanitizedItems.map((item) => ({
    id: item.id,
    name: item.name,
    price: item.price,
    quantity: item.quantity,
    ...(item.jelly !== undefined ? { jelly: item.jelly } : {}),
    ...(item.sweetness !== undefined ? { sweetness: item.sweetness } : {}),
    ...(item.ice !== undefined ? { ice: item.ice } : {}),
  }));
  const itemIds = validation.sanitizedItems.map((item) => item.id);

  // Step 3: 未決済注文レコードの登録
  let createdOrder: Order;

  if (deps.createMobileOrderAtomically) {
    let atomicResult: AtomicMobileOrderCreationResult;
    try {
      atomicResult = await deps.createMobileOrderAtomically({
        items: orderItemsForDb,
        customerName: validation.customerName,
        customerAvatar: validation.customerAvatar,
        itemIds,
        now,
      });
    } catch (err) {
      console.error('[CheckoutGuard] createMobileOrderAtomically failed:', err);
      return {
        ok: false,
        code: 'STORE_STATE_UNAVAILABLE',
        message: '現在、店舗の受付状態を確認できないため注文を受け付けられません。',
        status: 503,
      };
    }

    if (!atomicResult.ok) {
      return {
        ok: false,
        code: atomicResult.code,
        message: atomicResult.message,
        status: atomicResult.code === 'ITEM_SOLD_OUT' ? 409 : 503,
      };
    }
    createdOrder = atomicResult.order;
  } else {
    createdOrder = await deps.addOrder(
      orderItemsForDb,
      validation.customerName,
      validation.customerAvatar
    );

    // Step 3B: addOrder 使用時の注文作成直後チェック（Stripe API 呼び出し前）
    let postOrderStoreState: StoreState | null = null;
    try {
      postOrderStoreState = await deps.getStoreState();
    } catch (err) {
      console.error('[CheckoutGuard] Post-order store state check failed, aborting order:', err);
      const cancelRes = await cancelOrderWithRetry(
        deps,
        createdOrder.id,
        undefined,
        'post_order_state_check_failed'
      );
      return {
        ok: false,
        code: 'STORE_STATE_UNAVAILABLE',
        message: '店舗状態の確認中にエラーが発生したため、注文を中断しました。',
        status: 503,
        orderCancelled: cancelRes.cancelled,
      };
    }

    const postValidation = validateCheckoutRequest({
      body,
      storeState: postOrderStoreState,
      now,
    });

    if (!postValidation.ok) {
      const cancelRes = await cancelOrderWithRetry(
        deps,
        createdOrder.id,
        undefined,
        `aborted_before_stripe_${postValidation.code}`
      );
      return {
        ...postValidation,
        orderCancelled: cancelRes.cancelled,
      };
    }
  }

  // Step 4: Stripe Checkout Session の発行（外部通信中は DB ロックを保持しない）
  let session: { id?: string; url: string | null };
  try {
    session = await deps.createStripeCheckoutSession({
      order: createdOrder,
      items: validation.sanitizedItems,
      origin,
    });
  } catch (err) {
    console.error('[CheckoutGuard] Stripe session creation threw an error:', err);
    const cancelRes = await cancelOrderWithRetry(
      deps,
      createdOrder.id,
      undefined,
      'stripe_session_creation_exception'
    );
    return {
      ok: false,
      code: 'SESSION_CREATION_FAILED',
      message: '決済セッションの作成に失敗しました。',
      status: 500,
      orderCancelled: cancelRes.cancelled,
    };
  }

  if (!session.url) {
    const expireRes = await expireSessionWithRetry(
      deps,
      createdOrder.id,
      session.id,
      'session_url_missing'
    );
    const cancelRes = await cancelOrderWithRetry(
      deps,
      createdOrder.id,
      session.id,
      'session_url_missing'
    );
    return {
      ok: false,
      code: 'SESSION_CREATION_FAILED',
      message: '決済セッションURLの取得に失敗しました。',
      status: 500,
      sessionExpired: expireRes.expired,
      orderCancelled: cancelRes.cancelled,
    };
  }

  // Step 5: Stripe セッション作成完了直後の受付状態再確認（2回目チェック後〜Stripe通信完了までの競合窓を遮断）
  if (deps.finalizeCheckoutSession) {
    let finalizeResult: FinalizeMobileOrderCheckoutResult;
    try {
      finalizeResult = await deps.finalizeCheckoutSession({
        orderId: createdOrder.id,
        stripeSessionId: session.id || '',
        itemIds,
        now,
      });
    } catch (err) {
      console.error('[CheckoutGuard] finalizeCheckoutSession failed, aborting:', err);
      const expireRes = await expireSessionWithRetry(
        deps,
        createdOrder.id,
        session.id,
        'finalize_checkout_exception'
      );
      const cancelRes = await cancelOrderWithRetry(
        deps,
        createdOrder.id,
        session.id,
        'finalize_checkout_exception'
      );
      return {
        ok: false,
        code: 'STORE_STATE_UNAVAILABLE',
        message: '店舗状態の確認中にエラーが発生したため、注文を中断しました。',
        status: 503,
        sessionExpired: expireRes.expired,
        orderCancelled: cancelRes.cancelled,
      };
    }

    if (!finalizeResult.ok) {
      const expireRes = await expireSessionWithRetry(
        deps,
        createdOrder.id,
        session.id,
        `aborted_during_stripe_${finalizeResult.code}`
      );
      if (!finalizeResult.orderCancelled) {
        await cancelOrderWithRetry(
          deps,
          createdOrder.id,
          session.id,
          `aborted_during_stripe_${finalizeResult.code}`
        );
      }
      const mappedCode: CheckoutRejectionCode =
        finalizeResult.code === 'ITEM_SOLD_OUT'
          ? 'ITEM_SOLD_OUT'
          : finalizeResult.code === 'STORE_CLOSED'
            ? 'STORE_CLOSED'
            : 'STORE_STATE_UNAVAILABLE';
      return {
        ok: false,
        code: mappedCode,
        message: finalizeResult.message,
        status: mappedCode === 'ITEM_SOLD_OUT' ? 409 : 503,
        sessionExpired: expireRes.expired,
        orderCancelled: true,
      };
    }
  } else {
    let postSessionStoreState: StoreState | null = null;
    try {
      postSessionStoreState = await deps.getStoreState();
    } catch (err) {
      console.error('[CheckoutGuard] Post-Stripe-session store state check failed:', err);
      const expireRes = await expireSessionWithRetry(
        deps,
        createdOrder.id,
        session.id,
        'post_session_state_check_failed'
      );
      const cancelRes = await cancelOrderWithRetry(
        deps,
        createdOrder.id,
        session.id,
        'post_session_state_check_failed'
      );
      return {
        ok: false,
        code: 'STORE_STATE_UNAVAILABLE',
        message: '店舗状態の確認中にエラーが発生したため、注文を中断しました。',
        status: 503,
        sessionExpired: expireRes.expired,
        orderCancelled: cancelRes.cancelled,
      };
    }

    const postSessionValidation = validateCheckoutRequest({
      body,
      storeState: postSessionStoreState,
      now,
    });

    if (!postSessionValidation.ok) {
      const expireRes = await expireSessionWithRetry(
        deps,
        createdOrder.id,
        session.id,
        `aborted_after_stripe_${postSessionValidation.code}`
      );
      const cancelRes = await cancelOrderWithRetry(
        deps,
        createdOrder.id,
        session.id,
        `aborted_after_stripe_${postSessionValidation.code}`
      );
      return {
        ...postSessionValidation,
        sessionExpired: expireRes.expired,
        orderCancelled: cancelRes.cancelled,
      };
    }
  }

  return {
    ok: true,
    url: session.url,
    sessionId: session.id,
    orderId: createdOrder.id,
    orderNumber: createdOrder.orderNumber,
  };
}
