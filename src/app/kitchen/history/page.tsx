'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ChevronDown, ChevronUp, Package, Users, DollarSign } from 'lucide-react';
import styles from './history.module.css';

// 注文履歴の型
interface OrderItem {
  name: string;
  price: number;
  quantity: number;
}

interface OrderHistory {
  id: string;
  items: OrderItem[];
  totalPrice: number;
  createdAt: string;
}

// 日別集計用の型
interface DailySummary {
  date: string;
  totalRevenue: number;
  customerCount: number;
  itemCounts: Record<string, number>;
  orders: OrderHistory[];
  isExpanded: boolean;
}

export default function HistoryPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [dailySummaries, setDailySummaries] = useState<DailySummary[]>([]);

  useEffect(() => {
    fetchHistory();
  }, []);

  const fetchHistory = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/orders/history');
      if (!res.ok) throw new Error('履歴の取得に失敗しました');
      const data: OrderHistory[] = await res.json();

      // 日付ごとにグループ化
      const summariesMap = new Map<string, DailySummary>();

      data.forEach((order) => {
        // YYYY-MM-DD形式で日付を取得
        const dateStr = new Date(order.createdAt).toLocaleDateString('ja-JP', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        });

        if (!summariesMap.has(dateStr)) {
          summariesMap.set(dateStr, {
            date: dateStr,
            totalRevenue: 0,
            customerCount: 0,
            itemCounts: {},
            orders: [],
            isExpanded: false,
          });
        }

        const summary = summariesMap.get(dateStr)!;
        summary.totalRevenue += order.totalPrice;
        summary.customerCount += 1;
        summary.orders.push(order);

        // アイテムごとの集計
        order.items.forEach((item) => {
          if (!summary.itemCounts[item.name]) {
            summary.itemCounts[item.name] = 0;
          }
          summary.itemCounts[item.name] += item.quantity;
        });
      });

      // 日付の降順（新しい順）で配列にする
      const sortedSummaries = Array.from(summariesMap.values()).sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
      );

      setDailySummaries(sortedSummaries);
    } catch (error) {
      console.error(error);
      alert('エラーが発生しました');
    } finally {
      setIsLoading(false);
    }
  };

  const toggleExpand = (dateStr: string) => {
    setDailySummaries((prev) =>
      prev.map((s) => (s.date === dateStr ? { ...s, isExpanded: !s.isExpanded } : s))
    );
  };



  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <button onClick={() => router.push('/kitchen')} className={styles.backBtn}>
            <ArrowLeft size={16} />
            キッチンに戻る
          </button>
          <h1 className={styles.brandTitle}>注文履歴・売上集計</h1>
        </div>
      </header>

      <main className={styles.content}>
        <h2 className={styles.pageTitle}>日別レポート</h2>

        {isLoading ? (
          <div className={styles.loadingState}>
            <div className={styles.spinner}>⏳</div>
            <p>データを読み込み中...</p>
          </div>
        ) : dailySummaries.length === 0 ? (
          <div className={styles.emptyState}>
            <p>まだ完了した注文がありません</p>
          </div>
        ) : (
          dailySummaries.map((summary) => (
            <div key={summary.date} className={styles.dayCard}>
              <div className={styles.dayHeader} onClick={() => toggleExpand(summary.date)}>
                <div className={styles.dayDate}>{summary.date}</div>
                <div className={styles.dayStats}>
                  <div className={styles.statItem}>
                    <span className={styles.statLabel}>客数</span>
                    <span className={styles.statValue}>
                      <Users size={16} style={{ display: 'inline', marginRight: 4, color: '#64748b' }} />
                      {summary.customerCount}名
                    </span>
                  </div>
                  <div className={styles.statItem}>
                    <span className={styles.statLabel}>売上金額</span>
                    <span className={`${styles.statValue} ${styles.revenue}`}>
                      <DollarSign size={16} style={{ display: 'inline', marginRight: 2, color: '#10b981' }} />
                      ¥{summary.totalRevenue.toLocaleString()}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', marginLeft: '16px', color: '#94a3b8' }}>
                    {summary.isExpanded ? <ChevronUp size={24} /> : <ChevronDown size={24} />}
                  </div>
                </div>
              </div>

              {summary.isExpanded && (
                <div className={styles.dayDetails}>
                  <h3 className={styles.detailsTitle}>
                    <Package size={16} />
                    商品別の販売内訳
                  </h3>
                  <div className={styles.itemsGrid}>
                    {Object.entries(summary.itemCounts)
                      .sort(([, a], [, b]) => b - a) // 売れた順にソート
                      .map(([itemName, count]) => (
                        <div key={itemName} className={styles.itemCard}>
                          <span className={styles.itemName}>{itemName}</span>
                          <span className={styles.itemQty}>{count}杯</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </main>
    </div>
  );
}
