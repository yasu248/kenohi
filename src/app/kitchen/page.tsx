'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Play, Check, Trash2, ArrowLeft, Coffee, Users, CheckSquare, Trash, Lock, BarChart, Power } from 'lucide-react';
import styles from './kitchen.module.css';
import type { Order } from '../../lib/store';
import { isStoreCurrentlyOpen } from '../../lib/businessHours';

// キッチン画面へのアクセスパスワード
// 本番環境では環境変数や認証サービスに差し替えてください
const KITCHEN_PASSWORD = 'kenohi2026';
const POLL_INTERVAL_MS = 2000; // 2秒ごとにポーリング

export default function KitchenMonitor() {
  const [authed, setAuthed] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [storeState, setStoreState] = useState<{ isManualOpen: boolean, date: string } | null>(null);

  // 注文データと店舗状態をAPIから取得
  const fetchOrders = useCallback(async (isInitial = false) => {
    try {
      const res = await fetch('/api/orders');
      if (!res.ok) throw new Error('fetch error');
      const data: Order[] = await res.json();

      if (!isInitial) {
        setOrders((prevOrders) => {
          const prevPendingIds = new Set(prevOrders.filter((o) => o.status === 'pending').map((o) => o.id));
          const hasNewPending = data.some((o) => o.status === 'pending' && !prevPendingIds.has(o.id));

          if (hasNewPending) {
            const audio = new Audio('/chime.mp3');
            audio.play().catch((err) => console.log('音声再生エラー:', err));
          }
          return data;
        });
      } else {
        setOrders(data);
      }
      setLastUpdated(new Date());

      // 店舗状態の取得
      const stateRes = await fetch('/api/store-state');
      if (stateRes.ok) {
        const state = await stateRes.json();
        setStoreState(state);
      }
    } catch (err) {
      console.error('注文の取得に失敗しました', err);
    }
  }, []);

  // セッションストレージから認証状態を復元
  useEffect(() => {
    const auth = sessionStorage.getItem('kitchen_auth');
    if (auth === 'true') {
      setAuthed(true);
    }
  }, []);

  // 認証後にポーリング開始
  useEffect(() => {
    if (!authed) return;
    fetchOrders(true); // 初回は音を鳴らさないようにする
    const timer = setInterval(() => fetchOrders(false), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [authed, fetchOrders]);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordInput === KITCHEN_PASSWORD) {
      sessionStorage.setItem('kitchen_auth', 'true');
      setAuthed(true);
      setPasswordError(false);
    } else {
      setPasswordError(true);
      setPasswordInput('');
    }
  };

  const handleStatusChange = async (orderId: string, nextStatus: Order['status']) => {
    try {
      const res = await fetch(`/api/orders/${orderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) throw new Error('update error');
      // 即座に画面を更新（次のポーリングを待たない）
      await fetchOrders();
    } catch (err) {
      console.error('ステータス更新に失敗しました', err);
      alert('ステータスの更新に失敗しました。');
    }
  };

  const handleClearOrders = async () => {
    if (!confirm('すべてのご注文データをクリアして初期化しますか？')) return;
    try {
      await fetch('/api/orders/all', { method: 'DELETE' });
      await fetchOrders();
    } catch (err) {
      console.error('クリアに失敗しました', err);
    }
  };

  const handleToggleStoreOpen = async () => {
    const today = new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' });
    const todayJst = new Date(today);
    const dateStr = `${todayJst.getFullYear()}-${String(todayJst.getMonth() + 1).padStart(2, '0')}-${String(todayJst.getDate()).padStart(2, '0')}`;

    const isCurrentlyOpen = isStoreCurrentlyOpen(storeState);
    const nextState = !isCurrentlyOpen;

    if (nextState) {
      const currentHour = todayJst.getHours();
      const currentMinute = todayJst.getMinutes();

      // 9:30〜10:00の間はアラートを出さない（自然に除外されるが要件として明記）
      const isMorningRoutine = currentHour === 9 && currentMinute >= 30;

      if (currentHour >= 15 && !isMorningRoutine) {
        if (!confirm('今は閉店時間を過ぎています。営業延長でオーダー受付開始しますか？\n開始する場合閉店時に手動でオフにしてください')) {
          return;
        }
      } else {
        if (!confirm('注文の受付を開始しますか？')) return;
      }
    } else {
      if (!confirm('注文の受付を停止しますか？')) return;
    }

    try {
      await fetch('/api/store-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isManualOpen: nextState, date: dateStr, openedAt: nextState ? Date.now() : undefined })
      });
      await fetchOrders();
    } catch (err) {
      console.error('店舗状態の更新に失敗しました', err);
      alert('更新に失敗しました');
    }
  };

  const formatTime = (isoString: string) => {
    try {
      return new Date(isoString).toLocaleTimeString('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return '';
    }
  };

  // --- パスワード画面 ---
  if (!authed) {
    return (
      <main className={styles.kitchenContainer}>
        <div className={styles.loginWrapper}>
          <div className={styles.loginCard}>
            <div className={styles.loginIcon}>
              <Lock size={40} />
            </div>
            <h1 className={styles.loginTitle}>スタッフ専用</h1>
            <p className={styles.loginSubtitle}>
              キッチンモニターにアクセスするには<br />スタッフパスワードを入力してください
            </p>
            <form onSubmit={handleLogin} className={styles.loginForm}>
              <input
                type="password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder="パスワードを入力"
                className={`${styles.passwordInput} ${passwordError ? styles.passwordInputError : ''}`}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
              />
              {passwordError && (
                <p className={styles.errorMsg}>パスワードが正しくありません</p>
              )}
              <button type="submit" className={styles.loginButton}>
                ログイン
              </button>
            </form>
          </div>
        </div>
      </main>
    );
  }

  // --- キッチンモニター画面 ---
  const pendingOrders = orders.filter((o) => o.status === 'pending');
  const preparingOrders = orders.filter((o) => o.status === 'preparing');
  const completedOrders = orders.filter((o) => o.status === 'completed');

  return (
    <main className={styles.kitchenContainer}>
      {/* Kitchen Header */}
      <header className={styles.kitchenHeader}>
        <div>
          <h1 className={styles.kitchenTitle}>
            <Coffee size={28} />
            店舗用キッチンモニター
            {storeState && (() => {
              const isCurrentlyOpen = isStoreCurrentlyOpen(storeState);
              return (
                <span style={{
                  marginLeft: '12px',
                  fontSize: '0.8rem',
                  padding: '4px 12px',
                  borderRadius: '20px',
                  backgroundColor: isCurrentlyOpen ? '#dcfce7' : '#fee2e2',
                  color: isCurrentlyOpen ? '#166534' : '#b91c1c',
                  border: `1px solid ${isCurrentlyOpen ? '#bbf7d0' : '#fecaca'}`,
                  verticalAlign: 'middle'
                }}>
                  {isCurrentlyOpen ? '● 注文受付中' : '■ 受付停止中'}
                </span>
              );
            })()}
          </h1>
          <span className={styles.kitchenSub}>
            {lastUpdated
              ? `最終更新: ${lastUpdated.toLocaleTimeString('ja-JP')} — ${POLL_INTERVAL_MS / 1000}秒ごとに自動更新`
              : '接続中...'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          {storeState && (() => {
            const isCurrentlyOpen = isStoreCurrentlyOpen(storeState);
            return (
              <button
                className={styles.navLink}
                style={{ backgroundColor: isCurrentlyOpen ? '#fee2e2' : 'var(--primary-green)', color: isCurrentlyOpen ? '#b91c1c' : '#fff' }}
                onClick={handleToggleStoreOpen}
                title={isCurrentlyOpen ? "受付を停止する" : "受付を開始する"}
              >
                <Power size={16} />
                {isCurrentlyOpen ? '受付停止にする' : '受付を開始する'}
              </button>
            );
          })()}
          <button
            className={styles.navLink}
            onClick={() => {
              const audio = new Audio('/chime.mp3');
              audio.play().catch(() => alert('ブラウザの保護機能により再生できませんでした。画面内を1度クリックしてから再度お試しください。'));
            }}
            title="音テスト"
          >
            音テスト 🔊
          </button>
          <button className={styles.navLink} onClick={() => window.location.href = '/kitchen/history'} title="売上・履歴">
            <BarChart size={16} />
            売上・履歴
          </button>
          <button className={styles.navLink} onClick={handleClearOrders} title="注文クリア">
            <Trash2 size={16} />
            全注文クリア
          </button>
          <button
            className={styles.navLink}
            onClick={() => {
              sessionStorage.removeItem('kitchen_auth');
              setAuthed(false);
            }}
            title="ログアウト"
          >
            <Lock size={16} />
            ログアウト
          </button>
        </div>
      </header>

      {/* 停止中のみ表示される赤色で目立つバナー */}
      {storeState && (() => {
        const isCurrentlyOpen = isStoreCurrentlyOpen(storeState);
        if (!isCurrentlyOpen) {
          return (
            <div style={{
              backgroundColor: '#ef4444',
              color: '#ffffff',
              padding: '16px',
              textAlign: 'center',
              fontWeight: 'bold',
              fontSize: '1.2rem',
              margin: '0 20px 20px 20px',
              borderRadius: '8px',
              boxShadow: '0 4px 6px rgba(239, 68, 68, 0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px'
            }}>
              <Power size={24} />
              現在、注文受付システムは【オフ】になっています。お客様は注文できません。
            </div>
          );
        }
        return null;
      })()}

      {/* Kanban Board Grid */}
      <div className={styles.kanbanGrid}>
        {/* Column 1: Pending */}
        <div className={styles.kanbanColumn}>
          <div className={styles.columnHeader}>
            <h2 className={styles.columnTitle}>
              <Users size={18} style={{ color: 'var(--accent-pink)' }} />
              新規注文 (受付待ち)
            </h2>
            <span className={styles.columnCount}>{pendingOrders.length}件</span>
          </div>

          <div className={styles.orderList}>
            {pendingOrders.length === 0 ? (
              <div className={styles.emptyState}>
                <span className={styles.emptyText}>現在、新規注文はありません</span>
              </div>
            ) : (
              pendingOrders.map((order) => (
                <div key={order.id} className={`${styles.orderCard} ${styles.pendingCard}`}>
                  <div className={styles.cardHeader}>
                    <span className={styles.orderNo}>#{order.orderNumber}</span>
                    <span className={styles.orderTime}>{formatTime(order.createdAt)}</span>
                  </div>

                  <div className={styles.customerInfo}>
                    {order.customerAvatar && (
                      <img
                        src={order.customerAvatar}
                        alt={order.customerName}
                        className={styles.avatar}
                      />
                    )}
                    <span className={styles.customerName}>{order.customerName}</span>
                  </div>

                  <div className={styles.itemDetails}>
                    {order.items.map((item, idx) => (
                      <div key={idx} className={styles.drinkItem}>
                        <span className={styles.drinkName}>
                          {item.name.split(' (')[0]}
                          <span className={styles.drinkQty}> × {item.quantity}</span>
                        </span>
                        <span className={styles.drinkOpts}>
                          {item.name.includes('(')
                            ? item.name.substring(item.name.indexOf('(') + 1, item.name.length - 1)
                            : ''}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className={styles.cardActions}>
                    <button
                      className={styles.btnPrimary}
                      onClick={() => handleStatusChange(order.id, 'preparing')}
                    >
                      <Play size={14} />
                      調理を開始する
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Column 2: Preparing */}
        <div className={styles.kanbanColumn}>
          <div className={styles.columnHeader}>
            <h2 className={styles.columnTitle}>
              <Coffee size={18} style={{ color: '#3b82f6' }} />
              調理中 (作成中)
            </h2>
            <span className={styles.columnCount}>{preparingOrders.length}件</span>
          </div>

          <div className={styles.orderList}>
            {preparingOrders.length === 0 ? (
              <div className={styles.emptyState}>
                <span className={styles.emptyText}>調理中の注文はありません</span>
              </div>
            ) : (
              preparingOrders.map((order) => (
                <div key={order.id} className={`${styles.orderCard} ${styles.preparingCard}`}>
                  <div className={styles.cardHeader}>
                    <span className={styles.orderNo}>#{order.orderNumber}</span>
                    <span className={styles.orderTime}>{formatTime(order.createdAt)}</span>
                  </div>

                  <div className={styles.customerInfo}>
                    {order.customerAvatar && (
                      <img
                        src={order.customerAvatar}
                        alt={order.customerName}
                        className={styles.avatar}
                      />
                    )}
                    <span className={styles.customerName}>{order.customerName}</span>
                  </div>

                  <div className={styles.itemDetails}>
                    {order.items.map((item, idx) => (
                      <div key={idx} className={styles.drinkItem}>
                        <span className={styles.drinkName}>
                          {item.name.split(' (')[0]}
                          <span className={styles.drinkQty}> × {item.quantity}</span>
                        </span>
                        <span className={styles.drinkOpts}>
                          {item.name.includes('(')
                            ? item.name.substring(item.name.indexOf('(') + 1, item.name.length - 1)
                            : ''}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className={styles.cardActions}>
                    <button
                      className={styles.btnPrimary}
                      style={{ backgroundColor: '#3b82f6' }}
                      onClick={() => handleStatusChange(order.id, 'completed')}
                    >
                      <Check size={14} />
                      調理完了・呼出
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Column 3: Completed */}
        <div className={styles.kanbanColumn}>
          <div className={styles.columnHeader}>
            <h2 className={styles.columnTitle}>
              <CheckSquare size={18} style={{ color: 'var(--primary-green)' }} />
              受渡可能 (呼出中)
            </h2>
            <span className={styles.columnCount}>{completedOrders.length}件</span>
          </div>

          <div className={styles.orderList}>
            {completedOrders.length === 0 ? (
              <div className={styles.emptyState}>
                <span className={styles.emptyText}>受渡待ちの注文はありません</span>
              </div>
            ) : (
              completedOrders.map((order) => (
                <div key={order.id} className={`${styles.orderCard} ${styles.completedCard}`}>
                  <div className={styles.cardHeader}>
                    <span className={styles.orderNo}>#{order.orderNumber}</span>
                    <span className={styles.orderTime}>{formatTime(order.createdAt)}</span>
                  </div>

                  <div className={styles.customerInfo}>
                    {order.customerAvatar && (
                      <img
                        src={order.customerAvatar}
                        alt={order.customerName}
                        className={styles.avatar}
                      />
                    )}
                    <span className={styles.customerName}>{order.customerName}</span>
                  </div>

                  <div className={styles.itemDetails}>
                    {order.items.map((item, idx) => (
                      <div key={idx} className={styles.drinkItem}>
                        <span className={styles.drinkName}>
                          {item.name.split(' (')[0]}
                          <span className={styles.drinkQty}> × {item.quantity}</span>
                        </span>
                        <span className={styles.drinkOpts}>
                          {item.name.includes('(')
                            ? item.name.substring(item.name.indexOf('(') + 1, item.name.length - 1)
                            : ''}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className={styles.cardActions}>
                    <button
                      className={styles.btnPrimary}
                      style={{ backgroundColor: 'var(--primary-green)' }}
                      onClick={() => handleStatusChange(order.id, 'cancelled')}
                    >
                      <Trash size={14} />
                      受渡完了 (閉じる)
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
