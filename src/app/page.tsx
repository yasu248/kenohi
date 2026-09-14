'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { ShoppingBag, X, Plus, Minus, Check, CreditCard, ChevronRight } from 'lucide-react';
import styles from './page.module.css';
import { liffManager, LiffUserProfile } from '../lib/liffHelper';
import type { OrderItem } from '../lib/store';

type MenuCategory = 'straight' | 'milk' | 'soda';

interface MenuItem {
  id: string;
  name: string;
  desc: string;
  price: number;
  image: string;
  category: MenuCategory;
}

const MENU_ITEMS: MenuItem[] = [
  // ストレートティー 
  {
    id: 's1',
    name: '本日のお茶',
    desc: '日替わりのお茶、本日の茶葉はスタッフまでお尋ねください',
    price: 250,
    image: '/daily_special_tea.jpg',
    category: 'straight',
  },
  {
    id: 's2',
    name: '緑茶',
    desc: '清涼感あふれる青みと、ほのかな甘みが口に広がるシンプルな一杯。\n神奈川県丹沢の茶葉を使用。',
    price: 250,
    image: '/ryokucha_sq.jpg',
    category: 'straight',
  },
  {
    id: 's3',
    name: '釜炒り緑茶',
    desc: '日本伝統の釜炒り製法による、独特の香ばしい「釜香」と、すっきりとした上品な後味が楽しめる一杯。\n宮崎県五ヶ瀬の茶葉を使用。',
    price: 250,
    image: '/kamairicha_sq.jpg',
    category: 'straight',
  },
  {
    id: 's4',
    name: '青茶',
    desc: '烏龍茶ならではの花のような香りと、発酵の深みが調和した上品な風味をストレートで。\n純国産の茶葉を使用。',
    price: 250,
    image: '/aocha_sq.jpg',
    category: 'straight',
  },
  {
    id: 's5',
    name: 'ほうじ茶',
    desc: '深く焙煎した茶葉の香ばしさとまろやかな口当たり。ほっと落ち着く、和の温かみを感じる一杯。\n滋賀県近江の茶葉を使用。',
    price: 250,
    image: '/hojicha_sq.jpg',
    category: 'straight',
  },
  // ミルクティー
  {
    id: 'm1',
    name: '緑茶ミルクティー',
    desc: '緑茶のすっきりした渋みと、なめらかなミルクが溶け合う爽やかなミルクティー。\n神奈川県丹沢の茶葉を使用。',
    price: 400,
    image: '/ryokucha_milk_sq.jpg',
    category: 'milk',
  },
  {
    id: 'm2',
    name: '釜炒り緑茶ミルクティー',
    desc: '日本伝統の釜炒り製法による「釜香」の香ばしさと、ミルクのコクが引き立つ一杯。\n宮崎県五ヶ瀬の茶葉を使用。',
    price: 400,
    image: '/kamairicha_milk_sq.jpg',
    category: 'milk',
  },
  {
    id: 'm3',
    name: '青茶ミルクティー',
    desc: '烏龍茶の華やかな香りとフレッシュミルクが出会う、個性的でリッチなミルクティー。\n純国産の茶葉を使用。',
    price: 400,
    image: '/aocha_milk_sq.jpg',
    category: 'milk',
  },
  {
    id: 'm4',
    name: 'ほうじ茶ミルクティー',
    desc: '香ばしく煎り上げたほうじ茶の豊かな香りと、コクのあるミルクが絶妙に調和した人気の一杯。\n滋賀県近江の茶葉を使用。',
    price: 400,
    image: '/hojicha_milk_sq.jpg',
    category: 'milk',
  },
  {
    id: 'm5',
    name: '金木犀青茶ミルクティー',
    desc: '爽やかな金木犀の香りを纏わせた華やかでリッチなミルクティー。\n純国産青茶を使用。',
    price: 400,
    image: '/aocha_milk_sq.jpg',
    category: 'milk',
  },
  {
    id: 'm6',
    name: '薔薇ほうじ茶ミルクティー',
    desc: 'ローズの豊かな香りと香ばしさが絶妙に調和した上品なミルクティー。\n滋賀県近江ほうじ茶を使用。',
    price: 400,
    image: '/hojicha_milk_sq.jpg',
    category: 'milk',
  },
];

export default function Home() {
  const [profile, setProfile] = useState<LiffUserProfile | null>(null);
  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null);
  const [jelly, setJelly] = useState('なし');
  const [sweetness, setSweetness] = useState('普通');
  const [ice, setIce] = useState('氷あり');
  const [quantity, setQuantity] = useState(1);
  const [cart, setCart] = useState<OrderItem[]>([]);
  const [showCartDetail, setShowCartDetail] = useState(false);
  const [orderCompleteNo, setOrderCompleteNo] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [calledOrders, setCalledOrders] = useState<string[]>([]);
  const [myActiveOrderNo, setMyActiveOrderNo] = useState<string | null>(null);
  const [myOrderStatus, setMyOrderStatus] = useState<'waiting' | 'called' | 'received' | null>(null);
  const [groupsAhead, setGroupsAhead] = useState<number | null>(null);

  const getUnitPrice = (item: MenuItem) => {
    return item.price;
  };

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

  // Stripe決済成功時のリダイレクト処理
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const success = params.get('success');
    const orderNo = params.get('order_no');
    const sessionId = params.get('session_id');

    if (success === 'true' && orderNo && sessionId) {
      const confirmPayment = async () => {
        try {
          const res = await fetch('/api/orders/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          });

          if (res.ok) {
            setOrderCompleteNo(orderNo);
            setMyActiveOrderNo(orderNo);
            localStorage.setItem('kenohi_my_order_no', orderNo);
            setCart([]);
            setShowCartDetail(false);
            window.history.replaceState({}, document.title, window.location.pathname);
          } else {
            console.error('Payment confirmation failed');
            alert('決済確認に失敗しました。注文状況をご確認ください。');
          }
        } catch (e) {
          console.error('Error confirming payment:', e);
        }
      };
      confirmPayment();
    } else if (params.get('cancelled') === 'true') {
      alert('決済がキャンセルされました。');
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  // 呼び出し中の注文を取得（5秒ごと）
  useEffect(() => {
    const fetchOrders = async () => {
      try {
        const res = await fetch('/api/orders');
        if (!res.ok) return;
        const all = await res.json();

        const called = all
          .filter((o: any) => o.status === 'completed')
          .map((o: any) => o.orderNumber);
        setCalledOrders(called);

        if (myActiveOrderNo) {
          const myOrder = all.find((o: any) => o.orderNumber === myActiveOrderNo);
          if (myOrder) {
            setMyOrderStatus(myOrder.status === 'completed' ? 'called' : 'waiting');
            if (myOrder.status === 'completed') {
              setGroupsAhead(0);
            } else {
              const queue = all.filter((o: any) => o.status === 'pending' || o.status === 'preparing');
              const index = queue.findIndex((o: any) => o.orderNumber === myActiveOrderNo);
              setGroupsAhead(index >= 0 ? index : null);
            }
          } else {
            // 一覧にない場合は受渡完了（またはキャンセル）とみなす
            setMyOrderStatus('received');
            setGroupsAhead(null);
          }
        }
      } catch (err) { }
    };
    fetchOrders();
    const id = setInterval(fetchOrders, 5000);
    return () => clearInterval(id);
  }, [myActiveOrderNo]);

  const openOptionModal = (item: MenuItem) => {
    setSelectedItem(item);
    setJelly('なし');
    setSweetness('普通');
    setIce('氷あり');
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

    const unitPrice = getUnitPrice(selectedItem);

    const optionsList = [
      `ゼリー: ${jelly}`,
      `甘さ: ${sweetness}`,
      `氷: ${ice}`,
    ];

    const optionDesc = optionsList.join(', ');

    const newCartItem: OrderItem = {
      name: `${selectedItem.name} (${optionDesc})`,
      price: unitPrice,
      quantity,
    };

    setCart((prev) => [...prev, newCartItem]);
    closeOptionModal();
  };

  const handleRemoveFromCart = (indexToRemove: number) => {
    setCart((prev) => prev.filter((_, index) => index !== indexToRemove));
  };

  const handleCheckout = async () => {
    if (cart.length === 0) return;
    setIsSubmitting(true);

    const customerName = profile?.displayName || 'ゲスト顧客';
    const customerAvatar = profile?.pictureUrl || undefined;

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: cart, customerName, customerAvatar }),
      });

      if (!res.ok) throw new Error('注文セッションの作成に失敗しました');

      const { url } = await res.json();
      if (url) {
        window.location.href = url;
      } else {
        throw new Error('決済URLが取得できませんでした');
      }
    } catch (err) {
      console.error(err);
      alert('注文の送信に失敗しました。もう一度お試しください。');
      setIsSubmitting(false);
    }
  };

  const cartTotalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
  const cartTotalPrice = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  if (orderCompleteNo) {
    return (
      <main className={styles.container}>
        {/* Called Orders Banner (Success Screen) */}
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
              <div className={`${styles.myOrderSection} ${myOrderStatus === 'received' ? styles.receivedSection : ''}`}>
                <div className={styles.myOrderLabel}>
                  {myOrderStatus === 'received' ? 'お受け取り完了 (ありがとうございました！)' : 'あなたの待ち番号'}
                </div>
                <div className={styles.myOrderBox}>
                  <span className={styles.myOrderNumber}>{myActiveOrderNo}</span>
                  {myOrderStatus === 'waiting' && groupsAhead !== null && (
                    <span className={styles.groupsAheadBadge}>
                      {groupsAhead > 0 ? `前に ${groupsAhead} 組` : 'まもなく'}
                    </span>
                  )}
                  {myOrderStatus === 'received' && (
                    <button
                      className={styles.dismissBtn}
                      onClick={() => {
                        setMyActiveOrderNo(null);
                        setMyOrderStatus(null);
                        localStorage.removeItem('kenohi_my_order_no');
                      }}
                      title="閉じる"
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
              </div>
            )}
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
            {myOrderStatus === 'waiting' && groupsAhead !== null && (
              <div className={styles.groupsAheadText}>
                {groupsAhead > 0 ? `あなたの前に ${groupsAhead} 組お待ちです` : 'まもなくお呼び出しです'}
              </div>
            )}
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
          <div className={styles.brandLogoContainer}>
            <img src="/IconLineApp.png" alt="けのちゃ" className={styles.brandLogo} />
            <img src="/kenocha_logo_text.png" alt="けのちゃ KENOCHA" className={styles.brandTextLogo} />
          </div>
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
            <div className={`${styles.myOrderSection} ${myOrderStatus === 'received' ? styles.receivedSection : ''}`}>
              <div className={styles.myOrderLabel}>
                {myOrderStatus === 'received' ? 'お受け取り完了 (ありがとうございました！)' : 'あなたの待ち番号'}
              </div>
              <div className={styles.myOrderBox}>
                <span className={styles.myOrderNumber}>{myActiveOrderNo}</span>
                {myOrderStatus === 'waiting' && groupsAhead !== null && (
                  <span className={styles.groupsAheadBadge}>
                    {groupsAhead > 0 ? `前に ${groupsAhead} 組` : 'まもなく'}
                  </span>
                )}
                {myOrderStatus === 'received' && (
                  <button
                    className={styles.dismissBtn}
                    onClick={() => {
                      setMyActiveOrderNo(null);
                      setMyOrderStatus(null);
                      localStorage.removeItem('kenohi_my_order_no');
                    }}
                    title="閉じる"
                  >
                    <X size={16} />
                  </button>
                )}
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

      {/* Main Page Footer */}
      <footer className={styles.mainFooter}>
        <Link href="/legal" className={styles.footerLink}>
          特定商取引法に基づく表記
        </Link>
        <span className={styles.footerDivider}>|</span>
        <Link href="/privacy" className={styles.footerLink}>
          プライバシーポリシー
        </Link>
      </footer>

      {/* Drink Options Modal Sheet */}
      {selectedItem && (
        <div className={styles.modalOverlay} onClick={closeOptionModal}>
          <div className={styles.modalSheet} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div>
                <h2 className={styles.modalTitle}>{selectedItem.name}</h2>
                <div className={styles.modalPrice}>¥{getUnitPrice(selectedItem)}</div>
              </div>
              <button className={styles.closeButton} onClick={closeOptionModal}>
                <X size={24} />
              </button>
            </div>

            {/* 特製お茶ゼリー */}
            <div className={styles.optionSection}>
              <span className={styles.optionTitle}>特製お茶ゼリー</span>
              <div className={styles.optionsGrid}>
                {['あり', 'なし'].map((jl) => (
                  <React.Fragment key={jl}>
                    <input
                      type="radio"
                      id={`jelly-${jl}`}
                      name="jelly"
                      value={jl}
                      checked={jelly === jl}
                      onChange={() => setJelly(jl)}
                      className={styles.optionChip}
                    />
                    <label htmlFor={`jelly-${jl}`} className={styles.optionLabel}>
                      {jl}
                    </label>
                  </React.Fragment>
                ))}
              </div>
            </div>

            {/* 甘さ */}
            <div className={styles.optionSection}>
              <span className={styles.optionTitle}>甘さ</span>
              <div className={styles.optionsGrid}>
                {['普通', '控えめ', 'なし'].map((s) => (
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

            {/* 氷 */}
            <div className={styles.optionSection}>
              <span className={styles.optionTitle}>氷</span>
              <div className={styles.optionsGrid}>
                {['氷あり', '氷なし'].map((i) => (
                  <React.Fragment key={i}>
                    <input
                      type="radio"
                      id={`ice-${i}`}
                      name="ice"
                      value={i}
                      checked={ice === i}
                      onChange={() => setIce(i)}
                      className={styles.optionChip}
                    />
                    <label htmlFor={`ice-${i}`} className={styles.optionLabel}>
                      {i}
                    </label>
                  </React.Fragment>
                ))}
              </div>
            </div>

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
            <div className={styles.legalAgreement}>
              ご注文を確定することにより、
              <Link href="/legal" className={styles.legalLink}>
                特定商取引法に基づく表記
              </Link>
              および
              <Link href="/privacy" className={styles.legalLink}>
                プライバシーポリシー
              </Link>
              に同意したものとみなされます。
            </div>
          </div>
        </div>
      )}


    </main>
  );
}
