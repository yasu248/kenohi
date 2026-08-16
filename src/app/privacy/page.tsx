import React from 'react';
import Link from 'next/link';
import { ArrowLeft, KeyRound } from 'lucide-react';
import styles from './privacy.module.css';

export const metadata = {
  title: 'プライバシーポリシー | けのちゃ',
  description: 'お客様の個人情報の取り扱いに関する方針をご案内します。',
};

export default function PrivacyPage() {
  const sections = [
    {
      title: '1. 個人情報の取得について',
      content: '当サービスでは、お客様がモバイルオーダー（注文・決済）を利用される際、以下の個人情報を適切に取得いたします。\n・LINEのプロフィール情報（表示名、ユーザー識別子、プロフィール画像のURL）\n・ご注文いただいた商品の履歴、金額、日時\n・決済時の処理に関連する情報（※クレジットカード番号などの情報は決済代行会社であるStripeが直接保持し、弊社側では保持いたしません）'
    },
    {
      title: '2. 個人情報の利用目的',
      content: '取得した個人情報は、以下の目的で利用いたします。これ以外の目的で利用することはございません。\n・ご注文いただいた商品の調理および店頭でのお渡し\n・決済手続きおよび領収証等の発行処理\n・ご注文に関するご連絡やお問い合わせへの対応\n・サービス向上のための統計的な分析'
    },
    {
      title: '3. 個人情報の第三者提供について',
      content: '弊社は、以下のいずれかに該当する場合を除き、お客様の個人情報を第三者に提供または開示いたしません。\n・お客様の同意がある場合\n・決済処理を行うために、決済代行会社（Stripe等）に必要な情報を転送する場合\n・法令に基づき開示が必要と判断される場合'
    },
    {
      title: '4. 個人情報の安全管理',
      content: '弊社は、お客様の個人情報への不正アクセス、紛失、改ざん、漏洩を防ぐため、セキュリティの維持、適切な管理体制の構築など必要な措置を講じ、厳重に個人情報を管理いたします。'
    },
    {
      title: '5. 個人情報の開示・訂正・削除',
      content: 'お客様がご自身の個人情報の開示、訂正、または削除を希望される場合は、ご本人であることを確認の上、速やかに対応いたします。下記のお問い合わせ窓口までご連絡ください。'
    },
    {
      title: '6. お問い合わせ窓口',
      content: '個人情報の取り扱いに関するお問い合わせは、以下の窓口までご連絡ください。\n運営会社：株式会社けのひ\nメールアドレス：kenocha@kenohi-inc.jp'
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
            <KeyRound size={32} />
          </div>
          <h1 className={styles.title}>プライバシーポリシー</h1>
          <p className={styles.subtitle}>
            株式会社けのひ（以下「弊社」）は、当モバイルオーダーシステムの運営において、お客様の個人情報を安全かつ適切に取り扱います。
          </p>
        </header>

        {/* Content Details */}
        <section className={styles.contentList}>
          {sections.map((sec, idx) => (
            <div key={idx} className={styles.card}>
              <h2 className={styles.sectionTitle}>{sec.title}</h2>
              <div className={styles.sectionContent}>
                {sec.content.split('\n').map((line, lIdx) => (
                  <p key={lIdx}>{line}</p>
                ))}
              </div>
            </div>
          ))}
        </section>

        {/* Footer */}
        <footer className={styles.footer}>
          <p>© {new Date().getFullYear()} 株式会社けのひ All rights reserved.</p>
        </footer>
      </div>
    </main>
  );
}
