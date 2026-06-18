'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Volume2 } from 'lucide-react';
import styles from './display.module.css';
import type { Order } from '../../lib/store';

// Web Audio API で「ピンポーン」というチャイム音を生成する関数
function playChime() {
  try {
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gainNode = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'sine';
    osc1.frequency.setValueAtTime(880, ctx.currentTime);     // A5
    osc2.frequency.setValueAtTime(1108.73, ctx.currentTime); // C#6

    // 音量エンベロープ（徐々に消える）
    gainNode.gain.setValueAtTime(0, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 0.05);
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.5);

    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(ctx.destination);

    osc1.start(ctx.currentTime);
    osc2.start(ctx.currentTime);
    osc1.stop(ctx.currentTime + 1.5);
    osc2.stop(ctx.currentTime + 1.5);
  } catch (err) {
    console.error('Audio playback failed', err);
  }
}

export default function DisplayPage() {
  const [isAudioEnabled, setIsAudioEnabled] = useState(false);
  const [calledOrders, setCalledOrders] = useState<Order[]>([]);
  const [newOrderIds, setNewOrderIds] = useState<Set<string>>(new Set());
  
  // 前回取得時の完了注文IDリストを保持（新規判定用）
  const prevOrderIdsRef = useRef<Set<string>>(new Set());

  // 音声の許可
  const handleStart = () => {
    setIsAudioEnabled(true);
    // 最初のタップで無音を鳴らしてAudioContextを初期化する（iOS等での制限回避）
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContext) {
      const ctx = new AudioContext();
      ctx.resume();
    }
  };

  useEffect(() => {
    if (!isAudioEnabled) return;

    const fetchOrders = async () => {
      try {
        const res = await fetch('/api/orders');
        if (!res.ok) return;
        const allOrders: Order[] = await res.json();
        
        // ステータスが「completed（呼び出し中）」のものだけを抽出
        const completed = allOrders.filter(o => o.status === 'completed');
        
        const currentIds = new Set(completed.map(o => o.id));
        const previousIds = prevOrderIdsRef.current;
        
        // 新規追加されたものを検出
        const newlyAdded = completed.filter(o => !previousIds.has(o.id));
        
        if (newlyAdded.length > 0) {
          playChime();
          
          // 新しく呼ばれた番号をハイライト状態にする
          const newIdsSet = new Set(newlyAdded.map(o => o.id));
          setNewOrderIds(newIdsSet);
          
          // 5秒後にハイライト解除
          setTimeout(() => {
            setNewOrderIds(new Set());
          }, 5000);
        }

        setCalledOrders(completed);
        prevOrderIdsRef.current = currentIds;
        
      } catch (err) {
        console.error('Failed to fetch orders:', err);
      }
    };

    // 初回取得
    fetchOrders();

    // 2秒ごとにポーリング
    const intervalId = setInterval(fetchOrders, 2000);
    return () => clearInterval(intervalId);
  }, [isAudioEnabled]);

  if (!isAudioEnabled) {
    return (
      <div className={styles.overlay}>
        <button className={styles.startButton} onClick={handleStart}>
          <Volume2 size={32} />
          <span>呼び出し画面を開始（音声ON）</span>
        </button>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.title}>お呼び出し中の番号</h1>
        <p className={styles.subTitle}>Ready for Pickup</p>
      </header>

      {calledOrders.length === 0 ? (
        <div className={styles.emptyState}>
          現在お待ちのお客様はいません
        </div>
      ) : (
        <div className={styles.numberGrid}>
          {calledOrders.map(order => {
            const isNew = newOrderIds.has(order.id);
            return (
              <div 
                key={order.id} 
                className={`${styles.numberCard} ${isNew ? styles.numberCardNew : ''}`}
              >
                {order.orderNumber}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
