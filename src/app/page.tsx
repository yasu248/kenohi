'use client';

import React, { useState, useEffect } from 'react';
import { ShoppingBag, X, Plus, Minus, Check, CreditCard, ChevronRight } from 'lucide-react';
import styles from './page.module.css';
import { liffManager, LiffUserProfile } from '../lib/liffHelper';
import type { OrderItem } from '../lib/store';

type MenuCategory = 'straight' | 'milk';

interface MenuItem {
  id: string;
  name: string;
  desc: string;
  price: number;
  image: string;
  category: MenuCategory;
  options: {
    temperature?: string[]; // ストレートティー用
    sweetness?: string[];   // ミルクティー用
  };
}

// ── ストレートティー（¥250） ────────────────────────────────
const STRAIGHT_OPTIONS = { temperature: ['ホット', 'アイス'] };

// ── ミルクティー（¥400） ─────────────────────────────────────
const MILK_OPTIONS = { sweetness: ['ふつう', 'ひかえめ', 'なし'] };

const MENU_ITEMS: MenuItem[] = [
  // ストレートティー 3種
  {
    id: 's1',
    name: '緑茶ストレートティー',
    desc: '丁寧に摘まれた国産茶葉を使用。清涼感あふれる青みと、ほのかな甘みが口に広がるシンプルな一杯。',
    price: 250,
    image: 'https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=300',
    category: 'straight',
    options: STRAIGHT_OPTIONS,
  },
  {
    id: 's2',
    name: 'ほうじ茶ストレートティー',
    desc: '深く焙煎した茶葉の香ばしさとまろやかな口当たり。ほっと落ち着く、和の温かみを感じる一杯。',
    price: 250,
    image: 'https://images.unsplash.com/photo-1576092768241-dec231879fc3?w=300',
    category: 'straight',
    options: STRAIGHT_OPTIONS,
  },
  {
    id: 's3',
    name: '和青茶ストレートティー',
    desc: '国産烏龍茶ならではの花のような香りと、発酵の深みが調和した上品な風味をストレートで。',
    price: 250,
    image: 'https://images.unsplash.com/photo-1523906834658-6e24ef2386f9?w=300',
    category: 'straight',
    options: STRAIGHT_OPTIONS,
  },
  // ミルクティー 3種
  {
    id: 'm1',
    name: '緑茶ミルクティー',
    desc: '国産緑茶のすっきりした渋みと、なめらかなミルクが溶け合う爽やかなミルクティー。',
    price: 400,
    image: 'https://images.unsplash.com/photo-1541658016709-82535e94bc69?w=300',
    category: 'milk',
    options: MILK_OPTIONS,
  },
  {
    id: 'm2',
    name: 'ほうじ茶ミルクティー',
    desc: '香ばしく煎り上げたほうじ茶の豊かな香りと、コクのあるミルクが絶妙に調和した人気の一杯。',
    price: 400,
    image: 'https://images.unsplash.com/photo-1597838812864-411a2f65a25e?w=300',
    category: 'milk',
    options: MILK_OPTIONS,
  },
  {
    id: 'm3',
    name: '和青茶ミルクティー',
    desc: '国産烏龍茶の華やかな香りとフレッシュミルクが出会う、個性的でリッチなミルクティー。',
    price: 400,
    image: 'https://images.unsplash.com/photo-1536256263959-770b48d82b0a?w=300',
    category: 'milk',
    options: MILK_OPTIONS,
  },
];

export default function Home() {
  const [profile, setProfile] = useState<LiffUserProfile | null>(null);
  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null);
  const [sweetness, setSweetness] = useState('ふつう');   // ミルクティー用
  const [temperature, setTemperature] = useState('ホット'); // ストレートティー用
  const [quantity, setQuantity] = useState(1);
  const [cart, setCart] = useState<OrderItem[]>([]);
  const [showCartDetail, setShowCartDetail] = useState(false);
  const [orderCompleteNo, setOrderCompleteNo] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [calledOrders, setCalledOrders] = useState<string[]>([]);
  const [myActiveOrderNo, setMyActiveOrderNo] = useState<string | null>(null);

  // Initialize LIFF
  useEffect(() => {
    async function init() {
      const ok = await liffManager.init();
      if (ok) {
        try {
          const prof = await liffManager.getProfile();
          setProfile(prof);
        } catch (e) {
          console.log('Using browser session');
        }
      }
    }
    init();
    
    // 過去の自分の注文番号を復元
    const savedOrderNo = localStorage.getItem('kenohi_my_order_no');
    if (savedOrderNo) {
      setMyActiveOrderNo(savedOrderNo);
    }
  }, []);

  // 呼び出し中の注文を取得（5秒ごと）
  useEffect(() => {
    const fetchCalledOrders = async () => {
      try {
        const res = await fetch('/api/orders');
        if (!res.ok) return;
        const all = await res.json();
        const called = all
          .filter((o: any) => o.status === 'completed')
          .map((o: any) => o.orderNumber);
        setCalledOrders(called);
      } catch (err) {}
    };
    fetchCalledOrders();
    const id = setInterval(fetchCalledOrders, 5000);
    return () => clearInterval(id);
  }, []);

  const openOptionModal = (item: MenuItem) => {
    setSelectedItem(item);
    setSweetness('ふつう');
    setTemperature('ホット');
    setQuantity(1);
  };

  const closeOptionModal = () => {
    setSelectedItem(null);
  };

  const handleQtyChange = (delta: number) => {
    setQuantity((prev) => Math.max(1, prev + delta));
  };

  const handleAddToCart = () => {
    if (!selectedItem) return;

    const optionDesc =
      selectedItem.category === 'straight'
        ? `温度: ${temperature}`
        : `甘さ: ${sweetness}`;

    const newCartItem: OrderItem = {
      name: `${selectedItem.name} (${optionDesc})`,
      price: selectedItem.price,
      quantity,
    };

    setCart((prev) => [...prev, newCartItem]);
    closeOptionModal();
  };

  const handleRemoveFromCart = (indexToRemove: number) => {
    setCart((prev) => prev.filter((_, index) => index !== indexToRemove));
    if (cart.length <= 1) {
      setShowCartDetail(false);
    }
  };

  const handleCheckout = async () => {
    if (cart.length === 0) return;
    setIsSubmitting(true);

    const customerName = profile?.displayName || 'ゲスト顧客';
    const customerAvatar = profile?.pictureUrl || undefined;

    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: cart, customerName, customerAvatar }),
      });

      if (!res.ok) throw new Error('注文の送信に失敗しました');

      const order = await res.json();
      setOrderCompleteNo(order.orderNumber);
      setMyActiveOrderNo(order.orderNumber);
      localStorage.setItem('kenohi_my_order_no', order.orderNumber);
      
      setCart([]);
      setShowCartDetail(false);
    } catch (err) {
      console.error(err);
      alert('注文の送信に失敗しました。もう一度お試しください。');
    } finally {
      setIsSubmitting(false);
    }
  };

  const cartTotalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
  const cartTotalPrice = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  if (orderCompleteNo) {
    return (
      <main className={styles.container}>
        {/* Called Orders Banner */}
        {calledOrders.length > 0 && (
          <div className={styles.callBanner}>
            <div className={styles.callBannerTitle}>現在のお呼び出し番号</div>
            <div className={styles.callBannerNumbers}>
              {calledOrders.join(' , ')}
            </div>
          </div>
        )}
        <div className={styles.successContainer}>
          <div className={styles.successIcon}>
            <Check size={80} strokeWidth={3} />
          </div>
          <h1 className={styles.successTitle}>ご注文ありがとうございます！</h1>
          <p className={styles.successDesc}>
            決済が完了しました。日本茶を煎じ、幸せの香りとともにお作りします。画面の番号札をキッチンにお見せください。
          </p>

          <div className={styles.orderNoBox}>
            <span className={styles.orderNoLabel}>注文呼出番号</span>
            <div className={styles.orderNoValue}>{orderCompleteNo}</div>
          </div>

          <button className={styles.actionButton} onClick={() => setOrderCompleteNo(null)}>
            メニューに戻る
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.container}>
      {/* Brand Header */}
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandName}>茶庵 和 - KANADE</span>
          <span className={styles.brandSub}>Japanese Tea Milk Tea Specialist</span>
        </div>
        {profile && (
          <div className={styles.userProfile}>
            {profile.pictureUrl && (
              <img
                src={profile.pictureUrl}
                alt={profile.displayName}
                className={styles.avatar}
              />
            )}
            <span className={styles.userName}>{profile.displayName}</span>
          </div>
        )}
      </header>

      {/* Called Orders Banner */}
      {(calledOrders.length > 0 || myActiveOrderNo) && (
        <div className={styles.callBanner}>
          {calledOrders.length > 0 && (
            <div className={styles.calledSection}>
              <div className={styles.callBannerTitle}>現在のお呼び出し番号</div>
              <div className={styles.callBannerNumbers}>
                {calledOrders.join(' , ')}
              </div>
            </div>
          )}
          
          {myActiveOrderNo && (
            <div className={styles.myOrderSection}>
              <div className={styles.myOrderLabel}>あなたの待ち番号</div>
              <div className={styles.myOrderBox}>
                <span className={styles.myOrderNumber}>{myActiveOrderNo}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Hero Welcome */}
      <section className={styles.hero}>
        <span className={styles.heroTag}>Mobile Order</span>
        <h1 className={styles.heroTitle}>
          淹れたてのお茶と<br />優しいミルクの出会い
        </h1>
      </section>

      {/* Drink Menu */}
      <section className={styles.menuList}>
        {MENU_ITEMS.map((item) => (
          <div key={item.id} className={styles.menuItem} onClick={() => openOptionModal(item)}>
            <img src={item.image} alt={item.name} className={styles.menuItemImage} />
            <div className={styles.menuItemContent}>
              <div>
                <h3 className={styles.menuItemName}>{item.name}</h3>
                <p className={styles.menuItemDesc}>{item.desc}</p>
              </div>
              <span className={styles.menuItemPrice}>¥{item.price}</span>
            </div>
          </div>
        ))}
      </section>

      {/* Drink Options Modal Sheet */}
      {selectedItem && (
        <div className={styles.modalOverlay} onClick={closeOptionModal}>
          <div className={styles.modalSheet} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div>
                <h2 className={styles.modalTitle}>{selectedItem.name}</h2>
                <div className={styles.modalPrice}>¥{selectedItem.price}</div>
              </div>
              <button className={styles.closeButton} onClick={closeOptionModal}>
                <X size={24} />
              </button>
            </div>

            {/* ストレートティー：温度選択 */}
            {selectedItem.category === 'straight' && selectedItem.options.temperature && (
              <div className={styles.optionSection}>
                <span className={styles.optionTitle}>温度</span>
                <div className={styles.optionsGrid}>
                  {selectedItem.options.temperature.map((t) => (
                    <React.Fragment key={t}>
                      <input
                        type="radio"
                        id={`temp-${t}`}
                        name="temperature"
                        value={t}
                        checked={temperature === t}
                        onChange={() => setTemperature(t)}
                        className={styles.optionChip}
                      />
                      <label htmlFor={`temp-${t}`} className={styles.optionLabel}>
                        {t}
                      </label>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            )}

            {/* ミルクティー：甘さ選択 */}
            {selectedItem.category === 'milk' && selectedItem.options.sweetness && (
              <div className={styles.optionSection}>
                <span className={styles.optionTitle}>甘さの調節</span>
                <div className={styles.optionsGrid}>
                  {selectedItem.options.sweetness.map((s) => (
                    <React.Fragment key={s}>
                      <input
                        type="radio"
                        id={`sweet-${s}`}
                        name="sweetness"
                        value={s}
                        checked={sweetness === s}
                        onChange={() => setSweetness(s)}
                        className={styles.optionChip}
                      />
                      <label htmlFor={`sweet-${s}`} className={styles.optionLabel}>
                        {s}
                      </label>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            )}

            {/* 数量 */}
            <div className={styles.optionSection}>
              <span className={styles.optionTitle}>数量</span>
              <div className={styles.qtyContainer}>
                <button className={styles.qtyButton} onClick={() => handleQtyChange(-1)}>
                  <Minus size={16} />
                </button>
                <span className={styles.qtyValue}>{quantity}</span>
                <button className={styles.qtyButton} onClick={() => handleQtyChange(1)}>
                  <Plus size={16} />
                </button>
              </div>
            </div>

            <button className={styles.addToCartBtn} onClick={handleAddToCart}>
              カートに入れる
            </button>
          </div>
        </div>
      )}

      {/* Floating Bottom Cart Bar */}
      {cart.length > 0 && !showCartDetail && (
        <div className={styles.cartBar} onClick={() => setShowCartDetail(true)}>
          <div className={styles.cartBarLeft}>
            <ShoppingBag size={20} />
            <span className={styles.cartBadge}>{cartTotalItems}点</span>
            <span className={styles.cartTotal}>¥{cartTotalPrice}</span>
          </div>
          <div className={styles.cartBarRight}>
            <span>カートを見る</span>
            <ChevronRight size={16} />
          </div>
        </div>
      )}

      {/* Cart Detail Modal Sheet */}
      {showCartDetail && (
        <div className={styles.modalOverlay} onClick={() => setShowCartDetail(false)}>
          <div className={styles.modalSheet} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h2 className={styles.modalTitle}>ショッピングカート</h2>
              <button className={styles.closeButton} onClick={() => setShowCartDetail(false)}>
                <X size={24} />
              </button>
            </div>

            <div className={styles.cartItemList}>
              {cart.map((item, idx) => (
                <div key={idx} className={styles.cartItem}>
                  <div className={styles.cartItemInfo}>
                    <span className={styles.cartItemName}>
                      {item.name.split(' (')[0]}
                    </span>
                    <span className={styles.cartItemOptions}>
                      {item.name.substring(item.name.indexOf('(') + 1, item.name.length - 1)}
                    </span>
                    <span className={styles.cartItemOptions}>数量: {item.quantity}</span>
                  </div>
                  <div className={styles.cartItemRight}>
                    <span className={styles.cartItemPrice}>¥{item.price * item.quantity}</span>
                    <button 
                      className={styles.removeCartItemBtn} 
                      onClick={() => handleRemoveFromCart(idx)}
                      title="この商品をキャンセル"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className={styles.cartSummary}>
              <span>合計金額</span>
              <span>¥{cartTotalPrice}</span>
            </div>

            {/* Stripe simulation branding */}
            <div className={styles.stripeInfo}>
              <CreditCard size={14} />
              <span>Stripeで安全に決済されます</span>
            </div>

            <button
              className={styles.addToCartBtn}
              onClick={handleCheckout}
              disabled={isSubmitting}
            >
              {isSubmitting ? '決済手続き中...' : `注文を確定する (¥${cartTotalPrice})`}
            </button>
          </div>
        </div>
      )}


    </main>
  );
}
