'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Settings, Clock, Trash2, RefreshCw, PackageX, Package, Volume2, AlertTriangle, CreditCard } from 'lucide-react';
import styles from './admin.module.css';
import { MENU_NAME_BY_ID } from '../../../lib/menuCatalog';
import type { OrderRefundRequestRecord } from '../../../lib/store';

// Web Audio API による「ピロリン♪」通知音（G5 -> C6 -> E6 の澄んだベルチャイム）
function playOrderChime() {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
      const ctx = new AudioContextClass();
      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      const notes = [
        { time: 0.00, freq: 783.99, duration: 0.35, gain: 0.4 },
        { time: 0.12, freq: 1046.50, duration: 0.45, gain: 0.5 },
        { time: 0.24, freq: 1318.51, duration: 0.85, gain: 0.6 },
      ];

      notes.forEach(({ time, freq, duration, gain }) => {
        const osc = ctx.createOscillator();
        const gainNode = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + time);

        gainNode.gain.setValueAtTime(0.001, ctx.currentTime + time);
        gainNode.gain.linearRampToValueAtTime(gain, ctx.currentTime + time + 0.015);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + time + duration);

        osc.connect(gainNode);
        gainNode.connect(ctx.destination);

        osc.start(ctx.currentTime + time);
        osc.stop(ctx.currentTime + time + duration);
      });
      return;
    }
  } catch (e) {
    console.warn('Web Audio playback failed, trying HTML5 Audio fallback:', e);
  }

  try {
    const audio = new Audio('/chime.mp3');
    audio.play().catch((err) => console.log('音声再生エラー:', err));
  } catch (e) {}
}

// メニューIDから商品名へのマッピング（共通マスター menuCatalog.ts から参照）
const MENU_NAME: Readonly<Record<string, string>> = MENU_NAME_BY_ID;

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
  const [refundRequests, setRefundRequests] = useState<OrderRefundRequestRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isClearing, setIsClearing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [resState, resRefunds] = await Promise.all([
        fetch('/api/store-state'),
        fetch('/api/admin/refund-requests'),
      ]);

      if (resState.ok) {
        const state = await resState.json();
        const history: OpenHistoryEntry[] = state.openHistory ?? [];
        setOpenHistory([...history].reverse());
      }

      if (resRefunds.ok) {
        const refData = await resRefunds.json();
        setRefundRequests(refData.refundRequests ?? []);
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
      const res = await fetch('/api/orders/all', {
        method: 'DELETE',
        headers: { 'x-requested-with': 'kenocha-staff' },
      });
      if (res.status === 401 || res.status === 403) {
        const errData = await res.json().catch(() => ({}));
        alert(errData.error || 'この操作には管理者権限でのログインが必要です。');
        return;
      }
      if (!res.ok) throw new Error('delete failed');
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

        {/* ─── 決済・返金不整合アラート (Phase 0-G) ─── */}
        <section
          style={{
            backgroundColor: refundRequests.length > 0 ? '#fff1f2' : '#ffffff',
            borderRadius: '12px',
            border: `1.5px solid ${refundRequests.length > 0 ? '#f43f5e' : '#e2e8f0'}`,
            overflow: 'hidden',
            boxShadow: '0 2px 4px rgba(0, 0, 0, 0.05)',
            marginBottom: '24px',
          }}
        >
          <div
            style={{
              padding: '14px 20px',
              backgroundColor: refundRequests.length > 0 ? '#ffe4e6' : '#f8fafc',
              borderBottom: `1px solid ${refundRequests.length > 0 ? '#fecdd3' : '#e2e8f0'}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertTriangle
                size={20}
                color={refundRequests.length > 0 ? '#e11d48' : '#64748b'}
              />
              <h2
                style={{
                  margin: 0,
                  fontSize: '1rem',
                  fontWeight: 800,
                  color: refundRequests.length > 0 ? '#9f1239' : '#1e293b',
                }}
              >
                決済・返金不整合アラート（Stripe決済済み・注文取消競合）
              </h2>
            </div>
            <span
              style={{
                fontSize: '0.8rem',
                fontWeight: 700,
                padding: '2px 10px',
                borderRadius: '12px',
                backgroundColor: refundRequests.length > 0 ? '#e11d48' : '#e2e8f0',
                color: refundRequests.length > 0 ? '#ffffff' : '#64748b',
              }}
            >
              未解決 {refundRequests.length} 件
            </span>
          </div>

          <div style={{ padding: '16px 20px' }}>
            {refundRequests.length === 0 ? (
              <p style={{ margin: 0, fontSize: '0.875rem', color: '#64748b' }}>
                現在、未解決の決済・返金不整合案件はありません。
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <p style={{ margin: 0, fontSize: '0.85rem', color: '#9f1239', fontWeight: 600 }}>
                  ⚠️ Stripe上で決済完了後に注文がキャンセルされたため、返金または確認が必要です。
                </p>
                {refundRequests.map((req) => (
                  <div
                    key={req.id}
                    style={{
                      padding: '14px 16px',
                      backgroundColor: '#ffffff',
                      borderRadius: '8px',
                      border: '1px solid #fecdd3',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <span style={{ fontSize: '1.1rem', fontWeight: 900, color: '#0f172a' }}>
                          注文 #{req.orderNumber ?? req.orderId.slice(0, 8)}
                        </span>
                        <span style={{ fontSize: '1rem', fontWeight: 800, color: '#e11d48' }}>
                          ¥{req.targetRefundAmount.toLocaleString()}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <span
                          style={{
                            fontSize: '0.75rem',
                            fontWeight: 700,
                            padding: '3px 8px',
                            borderRadius: '4px',
                            backgroundColor: req.refundStatus === 'failed' ? '#fee2e2' : '#fef3c7',
                            color: req.refundStatus === 'failed' ? '#991b1b' : '#92400e',
                          }}
                        >
                          返金状態: {req.refundStatus}
                        </span>
                        {req.requiresManualAttention && (
                          <span
                            style={{
                              fontSize: '0.75rem',
                              fontWeight: 700,
                              padding: '3px 8px',
                              borderRadius: '4px',
                              backgroundColor: '#f43f5e',
                              color: '#ffffff',
                            }}
                          >
                            要管理者対応
                          </span>
                        )}
                      </div>
                    </div>

                    <div style={{ fontSize: '0.8rem', color: '#475569', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <div>
                        <strong>Stripe Session:</strong> {req.stripeSessionId ?? 'N/A'}
                      </div>
                      {req.paymentIntentId && (
                        <div>
                          <strong>PaymentIntent:</strong> {req.paymentIntentId}
                        </div>
                      )}
                      {req.lastError && (
                        <div style={{ color: '#b91c1c' }}>
                          <strong>エラー詳細:</strong> {req.lastError}
                        </div>
                      )}
                      <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                        検知日時: {new Date(req.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} (試行: {req.attemptCount}回)
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ─── 通知音テスト ─── */}
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <Volume2 size={18} className={styles.sectionIcon} />
            <h2 className={styles.sectionTitle}>通知音テスト</h2>
          </div>
          <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px' }}>
            <div>
              <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, color: '#1e293b' }}>
                新規注文通知チャイム（ピロリン♪）
              </p>
              <p style={{ margin: '4px 0 0 0', fontSize: '0.8rem', color: '#64748b' }}>
                端末のスピーカーから正しく音が鳴るか確認できます。
              </p>
            </div>
            <button
              onClick={playOrderChime}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '10px 18px',
                borderRadius: '8px',
                backgroundColor: '#2563eb',
                color: '#ffffff',
                border: 'none',
                fontWeight: 700,
                fontSize: '0.9rem',
                cursor: 'pointer',
                boxShadow: '0 2px 4px rgba(37, 99, 235, 0.25)',
                transition: 'all 0.15s ease'
              }}
            >
              <Volume2 size={18} />
              音テスト（再生）
            </button>
          </div>
        </section>

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
