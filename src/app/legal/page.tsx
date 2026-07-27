import React from 'react';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import styles from './legal.module.css';

export const metadata = {
  title: '特定商取引法に基づく表記 | けのちゃ',
  description: '特定商取引法に基づく表記についてご案内します。',
};

export default function LegalPage() {
  const info = [
    { label: '販売業者', value: '株式会社けのひ' },
    { label: '運営責任者', value: '神部駿維' },
    { label: '所在地', value: '〒101-0031 東京都千代田区東神田1-17-5 東神田イチオクビル2D' },
    { label: '電話番号', value: '070-2677-7244\n※お問い合わせは恐れ入りますが、下記のメールアドレスまでお願いいたします。' },
    { label: 'メールアドレス', value: 'kenohi2026@gmail.com\n※ご連絡の際は「モバイルオーダーについて」とご記載ください。' },
    { label: '販売価格', value: '各商品購入ページに表示（表示価格は消費税を含みます）' },
    { label: '商品代金以外の必要料金', value: 'なし（テイクアウト注文のため配送料等はかかりません）' },
    { label: 'お支払方法', value: 'クレジットカード決済（Visa, Mastercard, JCB, Amex, Diners, Discover）\nPayPay決済（オンライン決済）' },
    { label: 'お支払時期', value: 'ご注文確定時（Stripe決済プラットフォーム経由）' },
    { label: '商品の引渡時期', value: 'ご注文確定後、店舗にてご指定いただいた時間、または即時に調理を完了し店頭にてお渡しいたします。' },
    {
      label: '返品・交換・キャンセル',
      value: '商品の性質上（食品・飲料）、ご注文確定後のお客様都合によるキャンセル・変更・返品・返金は承っておりません。\n万が一、お受け取りになった商品に品違いや不備があった場合は、店頭スタッフへ直接お申し出いただくか、上記連絡先（メールアドレス）までご連絡ください。直ちに作り直し等の対応をさせていただきます。'
    }
  ];

  return (
    <main className={styles.container}>
      <div className={styles.wrapper}>
        {/* Navigation */}
        <div className={styles.nav}>
          <Link href="/" className={styles.backBtn}>
            <ArrowLeft size={18} />
            <span>メニューに戻る</span>
          </Link>
        </div>

        {/* Header */}
        <header className={styles.header}>
          <div className={styles.iconWrapper}>
            <ShieldCheck size={32} />
          </div>
          <h1 className={styles.title}>特定商取引法に基づく表記</h1>
          <p className={styles.subtitle}>
            当モバイルオーダーシステムをご利用いただくにあたり、法律に基づく表示事項を公開しています。
          </p>
        </header>

        {/* Content Table */}
        <section className={styles.tableCard}>
          {info.map((item, idx) => (
            <div key={idx} className={styles.row}>
              <div className={styles.label}>{item.label}</div>
              <div className={styles.value}>
                {item.value.split('\n').map((line, lIdx) => (
                  <p key={lIdx}>{line}</p>
                ))}
              </div>
            </div>
          ))}
        </section>

        {/* Footer info */}
        <footer className={styles.footer}>
          <p>© {new Date().getFullYear()} 株式会社けのひ All rights reserved.</p>
        </footer>
      </div>
    </main>
  );
}
