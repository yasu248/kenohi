'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Settings, Clock, Trash2, RefreshCw, PackageX, Package } from 'lucide-react';
import styles from './admin.module.css';

// メニューIDから商品名へのマッピング（sold-out/page.tsxと同期）
const MENU_NAME: Record<string, string> = {
  s1: '本日のお茶', s2: '緑茶', s3: '釜炒り緑茶', s4: '青茶', s5: 'ほうじ茶',
  m1: '緑茶ミルクティー', m2: '釜炒り緑茶ミルクティー', m3: '青茶ミルクティー',
  m4: 'ほうじ茶ミルクティー', m5: '金木犀青茶ミルクティー', m6: '薔薇ほうじ茶ミルクティー',
};

interface OpenHistoryEntry {
  date: string;
  openedAt: number;
  soldOutItems?: string[];
}

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
}

export default function AdminPage() {
  const [openHistory, setOpenHistory] = useState<OpenHistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isClearing, setIsClearing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/store-state');
      if (res.ok) {
        const state = await res.json();
        const history: OpenHistoryEntry[] = state.openHistory ?? [];
        // 新しい順に並べる
        setOpenHistory([...history].reverse());
      }
    } catch (err) {
      console.error('データ取得に失敗しました', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleClearOrders = async () => {
    if (!confirm('すべてのご注文データをクリアして初期化しますか？\nこの操作は元に戻せません。')) return;
    setIsClearing(true);
    try {
      await fetch('/api/orders/all', { method: 'DELETE' });
      alert('注文データをクリアしました。');
    } catch (err) {
      console.error('クリアに失敗しました', err);
      alert('クリアに失敗しました。');
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <main className={styles.container}>
      {/* ヘッダー */}
      <header className={styles.header}>
        <button className={styles.backButton} onClick={() => window.location.href = '/kitchen'}>
          <ArrowLeft size={18} />
          キッチン画面に戻る
        </button>
        <div className={styles.headerCenter}>
          <Settings size={22} className={styles.headerIcon} />
          <h1 className={styles.headerTitle}>システム管理</h1>
        </div>
        <div style={{ minWidth: 160 }} />
      </header>

      <div className={styles.content}>

        {/* ─── 開店時間の履歴 ─── */}
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <Clock size={18} className={styles.sectionIcon} />
            <h2 className={styles.sectionTitle}>開店時間の履歴</h2>
            <span className={styles.sectionCount}>{openHistory.length}件</span>
          </div>

          {isLoading ? (
            <div className={styles.loading}>
              <RefreshCw size={18} className={styles.spinning} />
              読み込み中...
            </div>
          ) : openHistory.length === 0 ? (
            <div className={styles.emptyState}>
              <Clock size={36} className={styles.emptyIcon} />
              <p>開店履歴がまだありません。</p>
              <p className={styles.emptyHint}>受付を開始すると自動的に記録されます。</p>
            </div>
          ) : (
            <div className={styles.historyList}>
              {openHistory.map((entry, i) => (
                <div key={i} className={`${styles.historyCard} ${i === 0 ? styles.historyCardLatest : ''}`}>
                  <div className={styles.historyCardLeft}>
                    <span className={styles.historyDate}>{formatDate(entry.date)}</span>
                    <span className={styles.historyTime}>
                      <Clock size={13} />
                      開店時刻：{formatTime(entry.openedAt)}
                    </span>
                  </div>
                  <div className={styles.historyCardRight}>
                    {entry.soldOutItems && entry.soldOutItems.length > 0 ? (
                      <div className={styles.soldOutList}>
                        <span className={styles.soldOutLabel}>
                          <PackageX size={12} />
                          欠品あり
                        </span>
                        <div className={styles.soldOutItems}>
                          {entry.soldOutItems.map(id => (
                            <span key={id} className={styles.soldOutChip}>
                              {MENU_NAME[id] ?? id}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <span className={styles.noSoldOut}>
                        <Package size={12} />
                        欠品なし
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ─── 危険ゾーン ─── */}
        <section className={styles.dangerSection}>
          <h2 className={styles.dangerTitle}>⚠️ データ管理</h2>
          <p className={styles.dangerDesc}>
            以下の操作は元に戻せません。実行前によくご確認ください。
          </p>
          <button
            className={styles.dangerButton}
            onClick={handleClearOrders}
            disabled={isClearing}
          >
            {isClearing ? (
              <>
                <RefreshCw size={16} className={styles.spinning} />
                クリア中...
              </>
            ) : (
              <>
                <Trash2 size={16} />
                全注文データをクリア
              </>
            )}
          </button>
        </section>

      </div>
    </main>
  );
}
