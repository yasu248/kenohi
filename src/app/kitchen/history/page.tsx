'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Package,
  Users,
  DollarSign,
  Clock,
  ShoppingBag,
  ListOrdered,
  RefreshCw,
  Calendar,
  CheckCircle2,
  Hourglass,
  Flame,
  CheckCheck,
  CalendarDays
} from 'lucide-react';
import styles from './history.module.css';

// 注文商品の型
interface OrderItem {
  name: string;
  price: number;
  quantity: number;
  sweetness?: string;
  ice?: string;
}

// 注文履歴の型
interface OrderHistory {
  id: string;
  orderNumber: string;
  customerName: string;
  customerAvatar?: string;
  status: 'pending' | 'preparing' | 'completed' | 'cancelled';
  items: OrderItem[];
  totalPrice: number;
  createdAt: string;
}

// 日別集計データの型
interface DayData {
  dateKey: string;      // 'YYYY-MM-DD'
  fullDateStr: string;  // 'YYYY年MM月DD日 (曜)'
  shortLabel: string;   // 'M/D(曜)'
  isToday: boolean;
  orderCount: number;
  customerCount: number;
  totalRevenue: number;
  totalCups: number;
  itemCounts: Record<string, { count: number; revenue: number }>;
  orders: OrderHistory[];
}

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** 過去7日分の日付情報（古い順 -> 今日が一番右）を生成 */
function generatePast7Days(): { dateKey: string; fullDateStr: string; shortLabel: string; isToday: boolean }[] {
  const days: { dateKey: string; fullDateStr: string; shortLabel: string; isToday: boolean }[] = [];
  const nowJST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));

  // i = 6 (6日前: 一番左) から i = 0 (今日: 一番右)
  for (let i = 6; i >= 0; i--) {
    const d = new Date(nowJST);
    d.setDate(nowJST.getDate() - i);

    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const weekday = WEEKDAY_JA[d.getDay()];

    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const fullDateStr = `${year}年${month}月${day}日 (${weekday})`;
    const shortLabel = `${month}/${day}(${weekday})`;
    const isToday = i === 0;

    days.push({
      dateKey,
      fullDateStr,
      shortLabel,
      isToday,
    });
  }

  return days;
}

export default function HistoryPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [rawOrders, setRawOrders] = useState<OrderHistory[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<'orders' | 'items'>('orders');

  // 過去7日分の日付枠（左: 6日前 〜 右: 本日）
  const past7Days = useMemo(() => generatePast7Days(), []);
  const todayKey = past7Days[past7Days.length - 1].dateKey;

  // デフォルトで本日の日付を選択
  const [selectedDateKey, setSelectedDateKey] = useState<string>(todayKey);

  useEffect(() => {
    fetchHistory();
  }, []);

  const fetchHistory = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/orders/history');
      if (!res.ok) throw new Error('履歴の取得に失敗しました');
      const data: OrderHistory[] = await res.json();
      setRawOrders(data);
    } catch (error) {
      console.error(error);
      alert('履歴の取得に失敗しました');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setIsRefreshing(true);
    fetchHistory();
  };

  // 過去7日分それぞれに対応する集計データを構築
  const daysDataMap = useMemo(() => {
    const map = new Map<string, DayData>();

    // 7日分の空枠を初期化
    past7Days.forEach((day) => {
      map.set(day.dateKey, {
        dateKey: day.dateKey,
        fullDateStr: day.fullDateStr,
        shortLabel: day.shortLabel,
        isToday: day.isToday,
        orderCount: 0,
        customerCount: 0,
        totalRevenue: 0,
        totalCups: 0,
        itemCounts: {},
        orders: [],
      });
    });

    // 取得した注文データを各日付に割り当て
    rawOrders.forEach((order) => {
      const orderDate = new Date(order.createdAt);
      const dJST = new Date(orderDate.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      const dateKey = `${dJST.getFullYear()}-${String(dJST.getMonth() + 1).padStart(2, '0')}-${String(dJST.getDate()).padStart(2, '0')}`;

      // 7日以内のデータのみ集計（それ以上前は対象外）
      if (map.has(dateKey)) {
        const dayData = map.get(dateKey)!;
        dayData.orderCount += 1;
        dayData.totalRevenue += (order.totalPrice || 0);
        dayData.orders.push(order);

        (order.items || []).forEach((item) => {
          const qty = item.quantity || 1;
          const price = item.price || 0;
          dayData.totalCups += qty;

          if (!dayData.itemCounts[item.name]) {
            dayData.itemCounts[item.name] = { count: 0, revenue: 0 };
          }
          dayData.itemCounts[item.name].count += qty;
          dayData.itemCounts[item.name].revenue += price * qty;
        });
      }
    });

    // 各日の客数（ユニーク名）と注文ソート（昇順）
    map.forEach((dayData) => {
      const uniqueCustomers = new Set(dayData.orders.map((o) => o.customerName || 'ゲスト'));
      dayData.customerCount = uniqueCustomers.size;

      // 注文番号（昇順）または時間（昇順）で並び替え
      dayData.orders.sort((a, b) => {
        const numA = parseInt(a.orderNumber, 10);
        const numB = parseInt(b.orderNumber, 10);
        if (!isNaN(numA) && !isNaN(numB)) {
          return numA - numB;
        }
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
    });

    return map;
  }, [past7Days, rawOrders]);

  // 現在選択中の日のデータ
  const selectedDayData = daysDataMap.get(selectedDateKey) || {
    dateKey: selectedDateKey,
    fullDateStr: '',
    shortLabel: '',
    isToday: false,
    orderCount: 0,
    customerCount: 0,
    totalRevenue: 0,
    totalCups: 0,
    itemCounts: {},
    orders: [],
  };

  const formatTime = (isoString: string) => {
    try {
      return new Date(isoString).toLocaleTimeString('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'Asia/Tokyo',
      });
    } catch {
      return '--:--:--';
    }
  };

  const getStatusBadge = (status: OrderHistory['status']) => {
    switch (status) {
      case 'pending':
        return (
          <span className={`${styles.orderStatusBadge} ${styles.statusPending}`}>
            <Hourglass size={12} /> 受付中
          </span>
        );
      case 'preparing':
        return (
          <span className={`${styles.orderStatusBadge} ${styles.statusPreparing}`}>
            <Flame size={12} /> 調理中
          </span>
        );
      case 'completed':
        return (
          <span className={`${styles.orderStatusBadge} ${styles.statusCompleted}`}>
            <CheckCircle2 size={12} /> 提供準備完了
          </span>
        );
      case 'cancelled':
      default:
        return (
          <span className={`${styles.orderStatusBadge} ${styles.statusHandedOver}`}>
            <CheckCheck size={12} /> 受渡完了
          </span>
        );
    }
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <button onClick={() => router.push('/kitchen')} className={styles.backBtn}>
            <ArrowLeft size={16} />
            キッチンに戻る
          </button>
          <h1 className={styles.brandTitle}>売上・注文履歴</h1>
        </div>

        <div className={styles.headerRight}>
          <button onClick={handleRefresh} className={styles.refreshBtn} disabled={isRefreshing}>
            <RefreshCw size={16} className={isRefreshing ? styles.spin : ''} />
            {isRefreshing ? '更新中...' : '最新の情報に更新'}
          </button>
        </div>
      </header>

      <main className={styles.content}>
        {/* 日付切り替えバー（古い順: 左 〜 本日: 一番右） */}
        <div className={styles.dateSelectorSection}>
          <div className={styles.dateSelectorLabel}>
            <CalendarDays size={16} />
            <span>表示する日付を選択（直近1週間）</span>
          </div>

          <div className={styles.dateNavContainer}>
            {past7Days.map((day) => {
              const daySummary = daysDataMap.get(day.dateKey);
              const isSelected = selectedDateKey === day.dateKey;
              const hasOrders = (daySummary?.orderCount || 0) > 0;

              return (
                <button
                  key={day.dateKey}
                  onClick={() => setSelectedDateKey(day.dateKey)}
                  className={`${styles.dateTabBtn} ${isSelected ? styles.dateTabActive : ''} ${
                    day.isToday ? styles.dateTabToday : ''
                  }`}
                >
                  <div className={styles.dateTabTop}>
                    {day.isToday && <span className={styles.todayPill}>本日</span>}
                    <span className={styles.dateTabLabel}>
                      （{day.shortLabel}）
                    </span>
                  </div>

                  <div className={styles.dateTabSub}>
                    {hasOrders ? (
                      <span className={styles.dateTabBadge}>
                        {daySummary?.orderCount}件 / ¥{(daySummary?.totalRevenue || 0).toLocaleString()}
                      </span>
                    ) : (
                      <span className={styles.dateTabEmpty}>注文なし</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 選択日のレポートメイン */}
        {isLoading ? (
          <div className={styles.loadingState}>
            <div className={styles.spinner}>⏳</div>
            <p>注文履歴を読み込み中...</p>
          </div>
        ) : (
          <div className={styles.reportMainCard}>
            {/* 選択された日のヘッダー */}
            <div className={styles.reportHeader}>
              <div className={styles.reportDateTitleGroup}>
                <h2 className={styles.reportDateTitle}>
                  <Calendar size={22} className={styles.reportDateIcon} />
                  {selectedDayData.fullDateStr}
                </h2>
                {selectedDayData.isToday && (
                  <span className={styles.reportTodayBadge}>本日</span>
                )}
              </div>

              <div className={styles.reportMetricsRow}>
                <div className={styles.metricCard}>
                  <span className={styles.metricLabel}>注文数</span>
                  <span className={styles.metricValue}>
                    <ListOrdered size={16} className={styles.metricIcon} />
                    {selectedDayData.orderCount} <span className={styles.metricUnit}>件</span>
                  </span>
                </div>

                <div className={styles.metricCard}>
                  <span className={styles.metricLabel}>販売杯数</span>
                  <span className={styles.metricValue}>
                    <ShoppingBag size={16} className={styles.metricIcon} />
                    {selectedDayData.totalCups} <span className={styles.metricUnit}>杯</span>
                  </span>
                </div>

                <div className={styles.metricCard}>
                  <span className={styles.metricLabel}>客数</span>
                  <span className={styles.metricValue}>
                    <Users size={16} className={styles.metricIcon} />
                    {selectedDayData.customerCount} <span className={styles.metricUnit}>名</span>
                  </span>
                </div>

                <div className={`${styles.metricCard} ${styles.metricRevenue}`}>
                  <span className={styles.metricLabel}>売上合計</span>
                  <span className={`${styles.metricValue} ${styles.revenueText}`}>
                    <DollarSign size={16} style={{ display: 'inline', marginRight: 1, color: '#059669' }} />
                    ¥{selectedDayData.totalRevenue.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>

            {/* タブ切り替え（注文一覧 / 商品別集計） */}
            <div className={styles.tabContainer}>
              <button
                className={`${styles.tabButton} ${activeTab === 'orders' ? styles.tabActive : ''}`}
                onClick={() => setActiveTab('orders')}
              >
                <ListOrdered size={16} />
                個別注文一覧 ({selectedDayData.orders.length}件)
              </button>
              <button
                className={`${styles.tabButton} ${activeTab === 'items' ? styles.tabActive : ''}`}
                onClick={() => setActiveTab('items')}
              >
                <Package size={16} />
                商品別販売内訳 ({Object.keys(selectedDayData.itemCounts).length}品)
              </button>
            </div>

            {/* 注文なしの場合のメッセージ */}
            {selectedDayData.orders.length === 0 ? (
              <div className={styles.emptyDayState}>
                <Package size={44} className={styles.emptyIcon} />
                <p className={styles.emptyTitle}>この日の注文はありませんでした</p>
                <p className={styles.emptyDesc}>
                  {selectedDayData.isToday
                    ? '本日の注文が入ると自動的に反映されます'
                    : 'この日に注文履歴データは記録されていません'}
                </p>
              </div>
            ) : (
              <>
                {/* タブ1: 個別注文一覧（1行に1注文ずつの縦リスト） */}
                {activeTab === 'orders' && (
                  <div className={styles.ordersList}>
                    {selectedDayData.orders.map((order, idx) => (
                      <div key={order.id || idx} className={styles.orderListItem}>
                        {/* 左: 注文番号・時間・ステータス */}
                        <div className={styles.orderListLeft}>
                          <div className={styles.orderNumberAndStatus}>
                            <span className={styles.orderNoBadge}>
                              #{order.orderNumber || '----'}
                            </span>
                            {getStatusBadge(order.status)}
                          </div>
                          <span className={styles.orderTime}>
                            <Clock size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                            {formatTime(order.createdAt)}
                          </span>
                        </div>

                        {/* 中央: 注文商品明細 */}
                        <div className={styles.orderListItems}>
                          {(order.items || []).map((item, itemIdx) => (
                            <div key={itemIdx} className={styles.orderItemRow}>
                              <div className={styles.orderItemDetails}>
                                <span className={styles.orderItemName}>{item.name}</span>
                                {(item.sweetness || item.ice) && (
                                  <span className={styles.orderItemOptions}>
                                    {[
                                      item.sweetness ? `甘さ: ${item.sweetness}` : '',
                                      item.ice ? `氷: ${item.ice}` : '',
                                    ]
                                      .filter(Boolean)
                                      .join(' / ')}
                                  </span>
                                )}
                              </div>
                              <div className={styles.orderItemPriceQty}>
                                <span className={styles.orderItemQty}>× {item.quantity || 1}</span>
                                <span className={styles.orderItemSubtotal}>
                                  ¥{((item.price || 0) * (item.quantity || 1)).toLocaleString()}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>

                        {/* 右: 合計金額 */}
                        <div className={styles.orderListRight}>
                          <span className={styles.orderTotalLabel}>合計</span>
                          <span className={styles.orderTotalPrice}>
                            ¥{(order.totalPrice || 0).toLocaleString()}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* タブ2: 商品別販売内訳 */}
                {activeTab === 'items' && (
                  <div className={styles.itemsGrid}>
                    {Object.entries(selectedDayData.itemCounts)
                      .sort(([, a], [, b]) => b.count - a.count)
                      .map(([itemName, data]) => (
                        <div key={itemName} className={styles.itemCard}>
                          <div className={styles.itemCardLeft}>
                            <span className={styles.itemName}>{itemName}</span>
                            <span className={styles.itemRevenue}>
                              ¥{data.revenue.toLocaleString()}
                            </span>
                          </div>
                          <span className={styles.itemQty}>{data.count} 杯</span>
                        </div>
                      ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
