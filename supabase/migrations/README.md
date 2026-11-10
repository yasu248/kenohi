# Phase 0 本番DBマイグレーション・切り替え・ロールバック手順書

本手順書は、`supabase/migrations/0001_phase0_foundation.sql` を安全に適用し、新旧コードが同時に注文番号を採番する競合期間を作らずに切り替え（カットオーバー）および異常時の切り戻し（ロールバック）を行うための運用手順書です。

> **重要原則:**
> - **営業時間外の計画メンテナンス時間**に実施してください。
> - 新旧の採番ロジック（旧: `STORE_STATE_001` JSON更新方式 / 新: PostgreSQL `next_order_number` RPC方式）が同時に動く期間を作らないため、**必ず店舗の注文受付を停止し、進行中の注文・決済がゼロであることを確認してから**マイグレーションとデプロイを実施します。
> - ロールバック時は、新しく作成された注文・認証・決済データを無条件に削除（DROP）しません。

---

## 事前検証環境での確認手順（本番適用前に必ず実施）

本番環境の Supabase へ適用する前に、ローカルの Supabase CLI または本番とは完全に分離された検証用（Staging）Supabase プロジェクトで以下を実施してください。

```bash
# ローカル Supabase CLI を使用する場合
npx supabase start
npx supabase db reset
```

---

## 本番移行手順（全10ステップ）

### 手順 1. 営業時間外メンテナンス開始
- 店舗の営業時間外であることを確認し、スタッフ全員にメンテナンス開始を周知します。
- キッチンモニター（`/kitchen`）および店頭ディスプレイ（`/display`）で未完了の注文がないことを目視確認します。

### 手順 2. 新規注文受付停止
- 管理画面（`/kitchen/admin`）から店舗ステータスを **「閉店（準備中）」**（`isManualOpen: false`）に切り替え、LINE モバイルオーダーからの新規注文流入を停止します。
- 以下の SQL で `STORE_STATE_001` が閉店状態（`isManualOpen = false`）になっていることを確認します。

```sql
SELECT
  customer_avatar::jsonb->>'isManualOpen' AS is_manual_open,
  customer_avatar::jsonb->>'currentOrderDate' AS current_order_date,
  customer_avatar::jsonb->>'lastOrderNumber' AS last_order_number
FROM public.orders
WHERE id = 'STORE_STATE_001';
```

### 手順 3. 処理中決済・Webhookの確認
- 直近30分以内に作成された未決済注文（`status = 'unpaid'`）や、調理中・呼出中の注文（`pending` / `preparing` / `completed`）が残っていないことを確認します。
- Stripe Dashboard（Developers > Webhooks）を開き、送信中（Pending / Retrying）の `checkout.session.completed` イベントが存在しないことを確認します。

```sql
-- 進行中または直近の未決済注文がないことの確認
SELECT id, order_number, status, total_price, created_at
FROM public.orders
WHERE id <> 'STORE_STATE_001'
  AND (
    status IN ('pending', 'preparing', 'completed')
    OR (status = 'unpaid' AND created_at >= NOW() - INTERVAL '30 minutes')
  )
ORDER BY created_at DESC;
```

### 手順 4. DBバックアップ取得
- Supabase Dashboard の Database Backups（または `pg_dump`）を用いて、マイグレーション直前の完全バックアップを取得します。
- 合わせて、`public.orders` テーブルの全件スナップショットを退避テーブルおよびローカルダンプとして保存します。

```sql
-- DB内への即時退避バックアップテーブル作成
CREATE TABLE IF NOT EXISTS public.orders_backup_phase0_pre_migration AS
SELECT * FROM public.orders;
```

```bash
# pg_dump による外部ファイルバックアップ（接続文字列は環境に合わせて指定）
pg_dump --clean --if-exists --no-owner --no-privileges \
  --table=public.orders \
  "$SUPABASE_DB_URL" > backup_orders_pre_phase0_$(date +%Y%m%d_%H%M%S).sql
```

### 手順 5. バックアップのリストア可能性確認
- 取得したバックアップ（および退避テーブル）のレコード件数と合計金額が `public.orders` 本表と完全一致することを検証します。
- 外部ダンプファイル（`.sql`）を検証用DBへ試験リストアし、エラーなく復元できることを確認します。

```sql
SELECT
  (SELECT COUNT(*) FROM public.orders) AS live_count,
  (SELECT COUNT(*) FROM public.orders_backup_phase0_pre_migration) AS backup_count,
  (SELECT COALESCE(SUM(total_price), 0) FROM public.orders WHERE id <> 'STORE_STATE_001') AS live_total_amount,
  (SELECT COALESCE(SUM(total_price), 0) FROM public.orders_backup_phase0_pre_migration WHERE id <> 'STORE_STATE_001') AS backup_total_amount;
```

### 手順 6. マイグレーション適用
- Supabase SQL Editor で `supabase/migrations/0001_phase0_foundation.sql` を実行します。
- カラム追加、CHECK制約、新設4テーブル（`order_number_sequences`, `stripe_webhook_events`, `auth_sessions`, `auth_login_rate_limits`）、および2つのRPC関数（`next_order_number`, `confirm_stripe_order_payment_tx`）が正常に作成されたことを確認します。

```sql
-- 1. 拡張カラムの確認
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'orders'
  AND column_name IN (
    'store_id', 'source', 'external_order_id', 'payment_status',
    'production_status', 'fulfillment_status', 'cancellation_status',
    'refunded_amount', 'stripe_session_id', 'updated_at'
  );

-- 2. 過去の cancelled レコードが推測で書き換えられず NULL (legacy_undetermined) で保持されていることの確認
SELECT status, payment_status, production_status, fulfillment_status, cancellation_status, COUNT(*)
FROM public.orders
WHERE id <> 'STORE_STATE_001'
GROUP BY status, payment_status, production_status, fulfillment_status, cancellation_status;
```

### 手順 7. 既存注文番号の引き継ぎ確認
- 当日の既存注文がある場合に、`public.order_number_sequences` の `last_number` が当日の `orders` 最大番号および `STORE_STATE_001.lastOrderNumber` の最大値（`GREATEST`）を正しく引き継いでいることを確認します。

```sql
WITH today_jst AS (
  SELECT to_char(NOW() AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS d
)
SELECT
  t.d AS today_jst,
  (
    SELECT COALESCE(MAX(order_number::INTEGER), 0)
    FROM public.orders, today_jst
    WHERE id <> 'STORE_STATE_001'
      AND created_at >= (today_jst.d || 'T00:00:00+09:00')::TIMESTAMPTZ
      AND created_at <= (today_jst.d || 'T23:59:59.999999+09:00')::TIMESTAMPTZ
      AND order_number ~ '^\d+$'
  ) AS max_in_orders,
  (
    SELECT CASE
      WHEN (customer_avatar::jsonb->>'currentOrderDate') = t.d
      THEN COALESCE((customer_avatar::jsonb->>'lastOrderNumber')::INTEGER, 0)
      ELSE 0
    END
    FROM public.orders
    WHERE id = 'STORE_STATE_001'
  ) AS last_in_store_state,
  (
    SELECT last_number
    FROM public.order_number_sequences
    WHERE store_id = 'kenocha_main' AND order_date = t.d
  ) AS seeded_sequence_last_number
FROM today_jst t;
```

### 手順 8. 新コードのデプロイ
- Vercel の本番環境変数に以下が設定されていることを確認します：
  - `KITCHEN_STAFF_PASSWORD`（スタッフ用パスワード）
  - `KITCHEN_ADMIN_PASSWORD`（管理者用パスワード）
  - `AUTH_SESSION_SECRET`（32文字以上のランダム秘密鍵）
  - `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `phase0-safe-foundation` ブランチをデプロイします。

### 手順 9. スタッフログイン・注文受付の動作確認
1. **スタッフ・管理者認証確認:**
   - `/kitchen` にアクセスし、パスワードログイン・ログアウトが正常に動作することを確認します。
   - `/kitchen/admin` にアクセスし、管理者権限で開店状態・欠品設定が参照できることを確認します。
2. **公開APIの個人情報保護確認:**
   - `/api/orders/public` のレスポンスに `customerName` や `customerAvatar` が含まれず、`id`, `orderNumber`, `status`, `createdAt` のみが返ることを確認します。
   - 未認証状態で `/api/orders` や `/api/orders/history` にアクセスすると `401 Unauthorized` が返ることを確認します。
3. **売上履歴の互換表示確認:**
   - `/kitchen/history` を開き、「過去データ互換集計（未判定含む）」と「確定売上（Phase 0以降・受渡完了のみ）」が区別して表示され、既存データが消えていないことを確認します。
4. **注文受付再開:**
   - 問題がなければ、営業開始時に `/kitchen/admin` から開店（`isManualOpen: true`）に切り替えます。

### 手順 10. 異常時の切り戻し（ロールバック）手順

万が一、新コードのデプロイ後に重大な問題が発生した場合は、以下の手順でデータを一切失わずに安全に切り戻します。

#### 旧コードとの互換性について
- `0001_phase0_foundation.sql` で `public.orders` に追加したカラムはすべて `DEFAULT` 値または `NULL` 許容であるため、**テーブルやカラムを DROP しなくても旧コードはそのまま動作します**。
- 新設テーブル（`order_number_sequences`, `stripe_webhook_events`, `auth_sessions`, `auth_login_rate_limits`）を残しておくことで、新コード稼働中に発生した決済・注文・認証記録を一切失いません。

#### 安全な切り戻し実行ステップ
1. **新規注文受付の一時停止:**
   - 管理画面または SQL で `STORE_STATE_001` の `isManualOpen` を `false` に設定します。
2. **注文番号の逆同期 SQL 実行 (`0001_phase0_foundation_rollback.sql`):**
   - `supabase/migrations/0001_phase0_foundation_rollback.sql` を実行します。
   - これにより、新コード稼働中に `order_number_sequences` で採番された最新の注文番号が `STORE_STATE_001.lastOrderNumber` に書き戻され、旧コードに戻した直後も注文番号が重複・逆行しません（注文・認証・決済データは削除されません）。
3. **Vercel デプロイメントのロールバック:**
   - Vercel Dashboard > Deployments から、直前の安定稼働デプロイメントを「Instant Rollback（Promote to Production）」します。
4. **切り戻し後の動作確認:**
   - `/kitchen`、`/display`、および顧客画面 `/` が正常に表示されることを確認したうえで、注文受付を再開します。
