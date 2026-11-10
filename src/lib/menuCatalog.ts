export type MenuCategory = 'straight' | 'milk' | 'soda';

export interface MenuCatalogItem {
  id: string;
  name: string;
  desc: string;
  price: number;
  image: string;
  category: MenuCategory;
  allowZeroSweetness: boolean;
}

/**
 * 全画面・サーバーAPI共通の商品マスター定義 (Single Source of Truth)
 * - 顧客注文画面 (`src/app/page.tsx`)
 * - 欠品管理画面 (`src/app/kitchen/sold-out/page.tsx`)
 * - 管理者画面 (`src/app/kitchen/admin/page.tsx`)
 * - Checkout サーバーサイド検証 (`src/lib/checkoutValidation.ts`)
 * から共通参照する。
 */
export const MENU_CATALOG: readonly MenuCatalogItem[] = [
  // ストレートティー
  {
    id: 's1',
    name: '本日のお茶',
    desc: '日替わりのお茶、本日の茶葉はスタッフまでお尋ねください',
    price: 250,
    image: '/daily_special_tea.jpg',
    category: 'straight',
    allowZeroSweetness: true,
  },
  {
    id: 's2',
    name: '緑茶',
    desc: '清涼感あふれる青みと、ほのかな甘みが口に広がるシンプルな一杯。\n神奈川県丹沢の茶葉を使用。',
    price: 250,
    image: '/ryokucha_sq.jpg',
    category: 'straight',
    allowZeroSweetness: true,
  },
  {
    id: 's3',
    name: '釜炒り緑茶',
    desc: '日本伝統の釜炒り製法による、独特の香ばしい「釜香」と、すっきりとした上品な後味が楽しめる一杯。\n宮崎県五ヶ瀬の茶葉を使用。',
    price: 250,
    image: '/kamairicha_sq.jpg',
    category: 'straight',
    allowZeroSweetness: true,
  },
  {
    id: 's4',
    name: '青茶',
    desc: '烏龍茶ならではの花のような香りと、発酵の深みが調和した上品な風味をストレートで。\n純国産の茶葉を使用。',
    price: 250,
    image: '/aocha_sq.jpg',
    category: 'straight',
    allowZeroSweetness: true,
  },
  {
    id: 's5',
    name: 'ほうじ茶',
    desc: '深く焙煎した茶葉の香ばしさとまろやかな口当たり。ほっと落ち着く、和の温かみを感じる一杯。\n滋賀県近江の茶葉を使用。',
    price: 250,
    image: '/hojicha_sq.jpg',
    category: 'straight',
    allowZeroSweetness: true,
  },
  // ミルクティー
  {
    id: 'm1',
    name: '緑茶ミルクティー',
    desc: '緑茶のすっきりした渋みと、なめらかなミルクが溶け合う爽やかなミルクティー。\n神奈川県丹沢の茶葉を使用。',
    price: 400,
    image: '/ryokucha_milk_sq.jpg',
    category: 'milk',
    allowZeroSweetness: true,
  },
  {
    id: 'm2',
    name: '釜炒り緑茶ミルクティー',
    desc: '日本伝統の釜炒り製法による「釜香」の香ばしさと、ミルクのコクが引き立つ一杯。\n宮崎県五ヶ瀬の茶葉を使用。',
    price: 400,
    image: '/kamairicha_milk_sq.jpg',
    category: 'milk',
    allowZeroSweetness: true,
  },
  {
    id: 'm3',
    name: '青茶ミルクティー',
    desc: '烏龍茶の華やかな香りとフレッシュミルクが出会う、個性的でリッチなミルクティー。\n純国産の茶葉を使用。',
    price: 400,
    image: '/aocha_milk_sq.jpg',
    category: 'milk',
    allowZeroSweetness: true,
  },
  {
    id: 'm4',
    name: 'ほうじ茶ミルクティー',
    desc: '香ばしく煎り上げたほうじ茶の豊かな香りと、コクのあるミルクが絶妙に調和した人気の一杯。\n滋賀県近江の茶葉を使用。',
    price: 400,
    image: '/hojicha_milk_sq.jpg',
    category: 'milk',
    allowZeroSweetness: true,
  },
  {
    id: 'm5',
    name: '金木犀青茶ミルクティー',
    desc: '爽やかな金木犀の香りを纏わせた華やかでリッチなミルクティー。\n※甘さなしにできません',
    price: 400,
    image: '/aocha_milk_sq.jpg',
    category: 'milk',
    allowZeroSweetness: false,
  },
  {
    id: 'm6',
    name: '薔薇ほうじ茶ミルクティー',
    desc: 'ローズの豊かな香りと香ばしさが絶妙に調和した上品なミルクティー。\n※甘さなしにできません',
    price: 400,
    image: '/hojicha_milk_sq.jpg',
    category: 'milk',
    allowZeroSweetness: false,
  },
] as const;

export const MENU_NAME_BY_ID: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(MENU_CATALOG.map((item) => [item.id, item.name]))
);

export const VALID_JELLY_OPTIONS = ['あり', 'なし'] as const;
export const VALID_SWEETNESS_OPTIONS = ['普通', '控えめ', 'なし'] as const;
export const VALID_ICE_OPTIONS = ['氷あり', '氷なし'] as const;
