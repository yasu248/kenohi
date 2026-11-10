'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ArrowLeft, PackageX, Package, AlertTriangle, Save, Check, RefreshCw, X } from 'lucide-react';
import styles from './sold-out.module.css';
import { MENU_CATALOG, type MenuCatalogItem } from '../../../lib/menuCatalog';

type MenuItem = MenuCatalogItem;

const MENU_ITEMS: readonly MenuItem[] = MENU_CATALOG;

const CATEGORY_LABELS: Record<string, string> = {
  straight: 'ストレートティー',
  milk: 'ミルクティー',
  soda: 'ソーダ',
};

// Set の内容が等しいか比較
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export default function SoldOutManager() {
  // サーバー保存済みの状態
  const [savedItems, setSavedItems] = useState<Set<string>>(new Set());
  // 編集中（未保存）の状態
  const [soldOutItems, setSoldOutItems] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [savedFeedback, setSavedFeedback] = useState(false);
  // 未保存確認モーダル
  const [showUnsavedModal, setShowUnsavedModal] = useState(false);

  // サーバーから取得
  const fetchSoldOut = useCallback(async () => {
    try {
      const res = await fetch('/api/sold-out');
      if (res.ok) {
        const data = await res.json();
        const items = new Set<string>(data.soldOutItems ?? []);
        setSavedItems(items);
        setSoldOutItems(new Set(items));
      }
    } catch (err) {
      console.error('欠品データの取得に失敗しました', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSoldOut();
  }, [fetchSoldOut]);

  // 変更があるかどうか
  const hasChanges = useMemo(() => !setsEqual(soldOutItems, savedItems), [soldOutItems, savedItems]);

  // カードをトグル（ローカル状態のみ変更・保存しない）
  const toggleSoldOut = (itemId: string) => {
    setSoldOutItems(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  // API保存
  const handleSave = async () => {
    if (!hasChanges || isSaving) return;
    setIsSaving(true);
    try {
      const res = await fetch('/api/sold-out', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-requested-with': 'kenocha-staff',
        },
        body: JSON.stringify({ soldOutItems: Array.from(soldOutItems) }),
      });
      if (res.status === 401) {
        alert('セッションが期限切れです。キッチン画面から再度ログインしてください。');
        window.location.href = '/kitchen';
        return;
      }
      if (!res.ok) throw new Error('save error');
      setSavedItems(new Set(soldOutItems));
      setSavedFeedback(true);
      setTimeout(() => setSavedFeedback(false), 2000);
    } catch (err) {
      console.error('欠品状態の保存に失敗しました', err);
      alert('保存に失敗しました。再度お試しください。');
    } finally {
      setIsSaving(false);
    }
  };

  // 「キッチン画面に戻る」タップ時の処理
  const handleBack = () => {
    if (hasChanges) {
      setShowUnsavedModal(true); // 未保存モーダルを表示
    } else {
      window.location.href = '/kitchen';
    }
  };

  // モーダル：「保存する」
  const handleModalSave = async () => {
    setShowUnsavedModal(false);
    await handleSave();
    window.location.href = '/kitchen';
  };

  // モーダル：「保存せずに戻る」
  const handleModalDiscard = () => {
    setShowUnsavedModal(false);
    window.location.href = '/kitchen';
  };

  const soldOutCount = soldOutItems.size;
  const categories = Array.from(new Set(MENU_ITEMS.map(i => i.category)));

  return (
    <>
    <main className={styles.container}>
      {/* ヘッダー */}
      <header className={styles.header}>
        <button
          className={styles.backButton}
          onClick={handleBack}
        >
          <ArrowLeft size={18} />
          キッチン画面に戻る
        </button>

        <div className={styles.headerCenter}>
          <PackageX size={24} className={styles.headerIcon} />
          <h1 className={styles.headerTitle}>商品受付管理</h1>
        </div>

        {/* 保存ボタン */}
        <div className={styles.headerRight}>
          {savedFeedback ? (
            <span className={styles.savedBadge}>
              <Check size={14} />
              保存しました
            </span>
          ) : (
            <button
              className={`${styles.saveButton} ${hasChanges ? styles.saveButtonActive : styles.saveButtonDisabled}`}
              onClick={handleSave}
              disabled={!hasChanges || isSaving}
              title={hasChanges ? '変更を保存する' : '変更はありません'}
            >
              {isSaving ? (
                <>
                  <RefreshCw size={15} className={styles.spinning} />
                  保存中...
                </>
              ) : (
                <>
                  <Save size={15} />
                  保存する
                </>
              )}
            </button>
          )}
        </div>
      </header>

      {/* 未保存バナー（テキストのみ・ボタンなし） */}
      {hasChanges && (
        <div className={styles.unsavedBanner}>
          <span>⚠️ 未保存の変更があります。右上の「保存する」を押して保存してください。</span>
        </div>
      )}

      {/* 欠品中バナー */}
      {soldOutCount > 0 && !hasChanges && (
        <div className={styles.warningBanner}>
          <AlertTriangle size={20} />
          <span>現在 <strong>{soldOutCount}商品</strong> が欠品停止中です。お客様は注文できません。</span>
        </div>
      )}

      {/* メニュー一覧 */}
      {isLoading ? (
        <div className={styles.loading}>読み込み中...</div>
      ) : (
        <div className={styles.content}>
          {categories.map(category => {
            const items = MENU_ITEMS.filter(i => i.category === category);
            return (
              <section key={category} className={styles.categorySection}>
                <h2 className={styles.categoryTitle}>{CATEGORY_LABELS[category] ?? category}</h2>
                <div className={styles.itemGrid}>
                  {items.map(item => {
                    const isSoldOut = soldOutItems.has(item.id);
                    const isChanged = savedItems.has(item.id) !== isSoldOut;
                    return (
                      <button
                        key={item.id}
                        className={`${styles.itemCard} ${isSoldOut ? styles.soldOut : styles.available} ${isChanged ? styles.changed : ''}`}
                        onClick={() => toggleSoldOut(item.id)}
                        aria-pressed={isSoldOut}
                        title={isSoldOut ? '受付を再開する' : '欠品・受付停止にする'}
                      >
                        <img
                          src={item.image}
                          alt={item.name}
                          className={`${styles.itemImage} ${isSoldOut ? styles.itemImageDim : ''}`}
                        />

                        {isSoldOut && (
                          <div className={styles.soldOutOverlay}>
                            <PackageX size={28} />
                            <span>本日欠品</span>
                          </div>
                        )}

                        {isChanged && (
                          <div className={styles.changedDot} title="未保存の変更" />
                        )}

                        <div className={styles.itemBody}>
                          <span className={styles.itemName}>{item.name}</span>
                          <span className={styles.itemPrice}>¥{item.price}</span>
                        </div>

                        <div className={`${styles.statusBadge} ${isSoldOut ? styles.badgeSoldOut : styles.badgeAvailable}`}>
                          {isSoldOut ? (
                            <>
                              <PackageX size={12} />
                              欠品中・受付停止
                            </>
                          ) : (
                            <>
                              <Package size={12} />
                              受付中
                            </>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </main>

    {/* 未保存確認モーダル */}
    {showUnsavedModal && (
      <div className={styles.modalOverlay}>
        <div className={styles.modalCard}>
          <div className={styles.modalIconWrap}>
            <X size={32} />
          </div>
          <h2 className={styles.modalTitle}>未保存の変更があります</h2>
          <p className={styles.modalDesc}>
            変更内容がまだ保存されていません。<br />
            保存してから戻りますか？
          </p>
          <div className={styles.modalActions}>
            <button
              className={styles.modalBtnSave}
              onClick={handleModalSave}
              disabled={isSaving}
            >
              {isSaving ? (
                <>
                  <RefreshCw size={16} className={styles.spinning} />
                  保存中...
                </>
              ) : (
                <>
                  <Save size={16} />
                  保存する
                </>
              )}
            </button>
            <button
              className={styles.modalBtnDiscard}
              onClick={handleModalDiscard}
            >
              <ArrowLeft size={16} />
              保存せずに戻る
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
