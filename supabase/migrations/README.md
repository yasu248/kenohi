# Phase 0 データベースマイグレーション検証手順書

本手順書は、`supabase/migrations/0001_phase0_foundation.sql` を本番環境へ適用する前に、
ローカルの Supabase CLI または隔離された検証用 Supabase プロジェクトで安全にテストするための手順です。

> **警告:** 本番環境の Supabase に対して事前の承認なく実行しないでください。

---

## 1. 事前準備 (ローカル環境または検証用 Supabase)

### A. ローカル Supabase を使用する場合
```bash
# Supabase CLI の起動 (Docker 必須)
npx supabase start

# マイグレーションのドライラン適用
npx supabase db reset
```

### B. 隔離された検証用 Supabase プロジェクトを使用する場合
Supabase Dashboard の「SQL Editor」を開き、検証用プロジェクトが選択されていることを確認します。

---

## 2. マイグレーションの適用テスト

1. `supabase/migrations/0001_phase0_foundation.sql` の内容をコピーし、SQL Editor に貼り付けて実行（Run）します。
2. 以下の確認クエリを実行し、テーブル・カラム・RPC関数が正常に作成されたことを確認します。

```sql
-- 1. カラムの存在確認
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'orders'
  AND column_name IN (
    'store_id', 'source', 'external_order_id', 'payment_status',
    'production_status', 'fulfillment_status', 'cancellation_status',
    'refunded_amount', 'stripe_session_id', 'updated_at'
  );

-- 2. 新設テーブルの存在確認
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'order_number_sequences',
    'stripe_webhook_events',
    'auth_sessions',
    'auth_login_rate_limits'
  );

-- 3. 原子的採番 RPC 関数の動作確認
SELECT public.next_order_number('kenocha_main', '2026-11-08');
SELECT public.next_order_number('kenocha_main', '2026-11-08'); -- 1つ加算されることを確認

-- 4. 採番シーケンステーブルの確認
SELECT * FROM public.order_number_sequences WHERE store_id = 'kenocha_main';
```

---

## 3. バックフィル結果の検証

過去データのステータスが正しく保たれているか確認します。

```sql
-- 進行中の注文が安全にバックフィルされていることの確認
SELECT status, payment_status, production_status, fulfillment_status, cancellation_status, COUNT(*)
FROM public.orders
WHERE id <> 'STORE_STATE_001'
GROUP BY status, payment_status, production_status, fulfillment_status, cancellation_status;

-- 過去の status = 'cancelled' のレコードが NULL (未判定) のまま維持されていることの確認
SELECT COUNT(*) AS legacy_undetermined_count
FROM public.orders
WHERE status = 'cancelled'
  AND payment_status IS NULL
  AND id <> 'STORE_STATE_001';
```

---

## 4. ロールバックの検証

万が一問題が発生した場合の切り戻しを検証します。

1. `supabase/migrations/0001_phase0_foundation_rollback.sql` を実行します。
2. テーブルおよび RPC 関数が正常に削除されたことを確認します。
