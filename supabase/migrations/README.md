# Phase 0 本番DBマイグレーション・切り替え・ロールバック手順書

本手順書は、`supabase/migrations/0001_phase0_foundation.sql` を安全に適用し、新旧コードが同時に注文番号を採番する競合期間を作らずに切り替え（カットオーバー）および異常時の切り戻し（ロールバック）を行うための運用手順書です。

> **重要原則:**
> - **営業時間外の計画メンテナンス時間**に実施してください。
> - 新旧の採番ロジック（旧: `STORE_STATE_001` JSON更新方式 / 新: PostgreSQL `next_order_number` / `create_mobile_order_tx` RPC方式）が同時に動く期間を作らないため、**必ず店舗の注文受付を停止し、進行中の注文・Checkout・決済がゼロであることを確認してから**マイグレーションとデプロイを実施します。進行中の Checkout が残っている場合は**メンテナンス移行を保留**してください。
> - 本番DBのバックアップは `CREATE TABLE AS SELECT` のみに頼らず、**Supabase 契約プランのバックアップ機能の確認**および **`pg_dump`（`--format=custom`・`--no-privileges` なし）によるスキーマ・制約・インデックス・関数・実行権限（ACL）・データ一式の完全論理バックアップ**を取得し、**独立した検証用PostgreSQL環境で復元可能性（リストア検証＋ACL検証）を確認してから**本番マイグレーションへ進みます。
> - **リストア検証時に RPC 関数の ACL 検証（`anon`/`authenticated` の実行拒否および `service_role` の実行許可）が失敗した場合は、運用開始を厳禁（NO-GO）**とします。
> - **本番DBに対する `pg_restore --clean --if-exists` 等の自動・直接実行は厳禁**です（データ消失リスクがあるため、万が一の障害時リストアは検証環境での確認後に別途承認を得て実施します）。
> - ロールバック時は、新しく作成された注文・認証・決済データを無条件に削除（DROP）しません。また注文番号の欠番は許容し、番号の再利用は行いません。

---

## 事前検証環境での確認手順（本番適用前に必ず実施）

本番環境の Supabase へ適用する前に、ローカルの検証用 PostgreSQL（Docker コンテナまたは Supabase CLI）で単体テスト・実DB統合テスト・バックアップ復元検証を実施してください。

```bash
# 単体・回帰テストおよびローカルPostgreSQL統合テストの実行
npm test
npm run test:integration
```

---

## 本番移行手順（全10ステップ）

### 手順 1. 営業時間外メンテナンス開始・Supabaseバックアップ機能の確認
- 店舗の営業時間外であることを確認し、スタッフ全員にメンテナンス開始を周知します。
- キッチンモニター（`/kitchen`）および店頭ディスプレイ（`/display`）で未完了の注文がないことを目視確認します。
- **Supabase Dashboard > Project Settings > Billing / Database > Backups** を開き、現在の契約プラン（Free / Pro 等）で Scheduled Backups または PITR（Point-in-Time Recovery）が有効かどうかを事前確認します（Free プラン等で自動バックアップが利用できない場合に備え、手順4の `pg_dump` 論理バックアップを必須とします）。

### 手順 2. 新規注文受付停止
- 管理画面（`/kitchen/admin`）またはキッチン画面から店舗ステータスを **「閉店（準備中）」**（`isManualOpen: false`）に切り替え、LINE モバイルオーダーからの新規注文流入を停止します（Phase 0 では `update_store_state_tx` により `store_state` 排他ロック下で直列化されます）。
- 以下の SQL で `STORE_STATE_001` が閉店状態（`isManualOpen = false`）になっていることを確認します。

```sql
SELECT
  customer_avatar::jsonb->>'isManualOpen' AS is_manual_open,
  customer_avatar::jsonb->>'date' AS store_open_date,
  customer_avatar::jsonb->>'currentOrderDate' AS current_order_date,
  customer_avatar::jsonb->>'lastOrderNumber' AS last_order_number
FROM public.orders
WHERE id = 'STORE_STATE_001';
```

### 手順 3. 処理中Checkout・決済・Webhookの確認（残存時は移行保留）
- 以下の SQL を実行し、**調理中・呼出中の注文（`pending` / `preparing` / `completed`）** および **進行中の Checkout（`status = 'unpaid'` かつ未キャンセル）** が 0 件であることを確認します。
- **判定基準（移行保留条件）:**
  1. `checkout_session_creating`（`status = 'unpaid'` かつ `stripe_session_id IS NULL`）が 1 件でもある場合：現在 Stripe API と通信中のリクエストが存在するため、完了または自動中断されるまで待機し、**メンテナンス移行を保留**します。
  2. `checkout_awaiting_payment`（`status = 'unpaid'` かつ `stripe_session_id IS NOT NULL`、直近30分以内）が 1 件でもある場合：受付停止前に決済画面へ遷移した顧客が決済操作中の可能性があるため、決済完了またはセッション失効が確認できるまで**メンテナンス移行を保留**します。
- Stripe Dashboard（Developers > Webhooks）を開き、送信中（Pending / Retrying）の `checkout.session.completed` イベントが存在しないことを確認します。

```sql
-- 進行中の調理・呼出注文、および処理中 Checkout の検知クエリ（結果が 0 件であることを確認）
SELECT
  id,
  order_number,
  status,
  COALESCE(payment_status, 'unpaid') AS payment_status,
  COALESCE(cancellation_status, 'active') AS cancellation_status,
  stripe_session_id,
  CASE
    WHEN status IN ('pending', 'preparing', 'completed') THEN 'active_kitchen_order'
    WHEN status = 'unpaid' AND COALESCE(cancellation_status, 'active') = 'active' AND stripe_session_id IS NULL THEN 'checkout_session_creating'
    WHEN status = 'unpaid' AND COALESCE(cancellation_status, 'active') = 'active' AND stripe_session_id IS NOT NULL THEN 'checkout_awaiting_payment'
    ELSE 'other'
  END AS in_flight_category,
  total_price,
  created_at
FROM public.orders
WHERE id <> 'STORE_STATE_001'
  AND (
    status IN ('pending', 'preparing', 'completed')
    OR (
      status = 'unpaid'
      AND COALESCE(cancellation_status, 'active') = 'active'
      AND created_at >= NOW() - INTERVAL '30 minutes'
    )
  )
ORDER BY created_at DESC;
```

### 手順 4. 本番DBの完全論理バックアップ取得（ACL権限保持・`--no-privileges` 使用禁止）
- `CREATE TABLE AS SELECT` はインデックス・制約・RLS・関数・権限を保持できないため、正式なバックアップ手段としては使用しません。
- **重要:** `pg_dump` に `--no-privileges` を指定すると、`SECURITY DEFINER` RPC関数の `REVOKE EXECUTE FROM PUBLIC, anon, authenticated`（ACL設定）が消失し、リストア時に `PUBLIC` 実行権限が復活してしまうため、**`--no-privileges` は絶対に使用しないでください**。
- `pg_dump` を用いて、`public` スキーマのテーブル定義・制約・インデックス・RLSポリシー・RPC関数・**ACL権限**および全データをカスタムアーカイブ形式（`.dump`）とプレーンSQL形式（`.sql`）の両方でローカルの安全なディレクトリ（Git管理外）へ取得します。

```bash
# 1. カスタム形式（pg_restore による検証環境への復元・ACL検証用 ※ --no-privileges は付けない）
pg_dump \
  --format=custom \
  --blobs \
  --no-owner \
  --schema=public \
  --file="backup_prod_public_pre_phase0_$(date +%Y%m%d_%H%M%S).dump" \
  "$SUPABASE_PRODUCTION_DB_URL"

# 2. プレーンSQL形式（差分確認・監査用 ※ --no-privileges は付けない）
pg_dump \
  --format=plain \
  --no-owner \
  --schema=public \
  --file="backup_prod_public_pre_phase0_$(date +%Y%m%d_%H%M%S).sql" \
  "$SUPABASE_PRODUCTION_DB_URL"
```

### 手順 5. 独立した検証環境でのバックアップ復元可能性・ロール依存関係・ACL検証
- **重要:** `pg_restore` は**絶対に本番DB接続先に対して実行しないでください**。必ずローカルの検証用 PostgreSQL コンテナ（`127.0.0.1:54329` 等）に対してテストリストアを実行します。
- **事前確認（ロール・拡張機能の依存関係）:**
  - リストア先の検証用DBに Supabase 互換ロール（`anon`, `authenticated`, `service_role`）が存在することを事前に確認・作成してから `pg_restore`（`--no-owner` のみ指定、`--no-privileges` は指定しない）を実行します。

```sql
-- リストア先検証DBでの事前ロール準備
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END
$$;
```

```bash
# 1. アーカイブ内のオブジェクト目次確認（テーブル・制約・インデックス・ACLが含まれていること）
pg_restore --list "backup_prod_public_pre_phase0_YYYYMMDD_HHMMSS.dump"

# 2. 独立したローカル検証用 PostgreSQL への試験リストア（※接続先は必ず 127.0.0.1 の検証DBとし、--no-privileges は付けないこと）
pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --dbname="postgresql://postgres:postgres@127.0.0.1:54329/kenocha_restore_verify" \
  "backup_prod_public_pre_phase0_YYYYMMDD_HHMMSS.dump"
```

- 検証用DBへリストア後、本番DB（読み取り専用SELECT）と検証用DBの間で以下が完全一致することを確認します：
  1. `public.orders` の総レコード件数
  2. `STORE_STATE_001` を除く `SUM(total_price)`（売上合計金額）
  3. ステータス別（`unpaid`, `pending`, `preparing`, `completed`, `cancelled`）の件数内訳

```sql
-- 本番DB（SELECTのみ）およびリストア検証DBの双方で実行して結果の一致を確認
SELECT
  COUNT(*) AS total_rows,
  COALESCE(SUM(total_price) FILTER (WHERE id <> 'STORE_STATE_001'), 0) AS total_amount,
  COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
  COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_count
FROM public.orders;
```

### 手順 6. マイグレーション適用とRPC権限制御（ACL）検証
- 手順5でバックアップの復元可能性が確認できた後、Supabase SQL Editor で `supabase/migrations/0001_phase0_foundation.sql` を実行します。
- カラム追加、CHECK制約、新設4テーブル（`order_number_sequences`, `stripe_webhook_events`, `auth_sessions`, `auth_login_rate_limits`）、および全6個のRPC関数（`next_order_number`, `confirm_stripe_order_payment_tx`, `update_store_state_tx`, `create_mobile_order_tx`, `finalize_mobile_order_checkout_tx`, `abort_mobile_order_checkout_tx`）とそれらの実行権限が正常に適用されたことを確認します。
- **重要（運用開始禁止条件）:** 下記の「3. RPC関数の実行権限確認」において、1つでも `anon_can_exec = true` または `auth_can_exec = true` または `service_role_can_exec = false` となった場合は、**絶対に運用を開始せず（運用開始禁止）**、権限剥奪・付与SQLを再適用してください（バックアップからのリストア後も同じクエリで必ず検証します）。

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

-- 3. 全6個のRPC関数の実行権限・SECURITY DEFINER・search_path 確認
--    （全行で anon_can_exec = false, auth_can_exec = false, service_role_can_exec = true であること）
SELECT
  p.proname,
  p.prosecdef AS is_security_definer,
  p.proconfig AS search_path_config,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_exec,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can_exec,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_exec
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'next_order_number',
    'confirm_stripe_order_payment_tx',
    'update_store_state_tx',
    'create_mobile_order_tx',
    'finalize_mobile_order_checkout_tx',
    'abort_mobile_order_checkout_tx'
  )
ORDER BY p.proname;
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
  - `STAFF_PASSWORD`（スタッフ用パスワード）
  - `ADMIN_PASSWORD`（管理者用パスワード）
  - `AUTH_SESSION_SECRET`（32文字以上のランダム秘密鍵）
  - `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `phase0-safe-foundation` ブランチをデプロイします。

### 手順 9. スタッフログイン・注文受付ガード・公開APIの動作確認
1. **スタッフ・管理者認証確認:**
   - `/kitchen` にアクセスし、パスワードログイン・ログアウトが正常に動作することを確認します。
   - `/kitchen/admin` にアクセスし、管理者権限で開店状態・欠品設定が参照できることを確認します。
2. **受付停止中の注文作成ガード確認（実決済なし）:**
   - `isManualOpen: false`（閉店・受付停止中）の状態で `POST /api/checkout` にテストリクエストを送ると、**注文番号採番も注文レコード作成も Stripe Checkout セッション発行も行われず `503 STORE_CLOSED` が返ること**を確認します。
3. **公開APIの個人情報保護確認:**
   - `/api/orders/public` のレスポンスに `customerName` や `customerAvatar` が含まれず、`id`, `orderNumber`, `status`, `createdAt` のみが返ることを確認します。
   - `/api/store-state` のレスポンスに内部採番カウンタ（`lastOrderNumber`, `currentOrderDate`）が含まれないことを確認します。
   - 未認証状態で `/api/orders` や `/api/orders/history` にアクセスすると `401 Unauthorized` が返ることを確認します。
4. **売上履歴の互換表示・中断注文除外確認:**
   - `/kitchen/history` を開き、決済前に中断された未決済注文（`payment_status = 'unpaid'`）が表示されないこと、および「過去データ互換集計（`legacy_undetermined` 含む）」と「確定売上（Phase 0以降・決済済み）」が正しく表示され既存データが消えていないことを確認します。
5. **注文受付再開:**
   - 問題がなければ、営業開始時に `/kitchen` または `/kitchen/admin` から開店（`isManualOpen: true`）に切り替えます。

### 手順 10. 異常時の切り戻し（ロールバック）および障害時リストア方針

万が一、新コードのデプロイ後に重大な問題が発生した場合は、以下の手順でデータを一切失わずに安全に切り戻します。

#### A. アプリケーションおよび採番状態の切り戻し（データ削除なし・標準手順）
- `0001_phase0_foundation.sql` で `public.orders` に追加したカラムはすべて `DEFAULT` 値または `NULL` 許容であるため、**テーブルやカラムを DROP しなくても旧コードはそのまま動作します**。
- 新設テーブル（`order_number_sequences`, `stripe_webhook_events`, `auth_sessions`, `auth_login_rate_limits`）を残しておくことで、新コード稼働中に発生した決済・注文・認証記録を一切失いません。

1. **新規注文受付の一時停止:**
   - 管理画面または SQL で `STORE_STATE_001` の `isManualOpen` を `false` に設定し、手順3のクエリで進行中 Checkout が 0 件になるのを待ちます。
2. **注文番号の逆同期 SQL 実行 (`0001_phase0_foundation_rollback.sql`):**
   - `supabase/migrations/0001_phase0_foundation_rollback.sql` を実行します。
   - これにより、新コード稼働中に `order_number_sequences` で採番された最新の注文番号が `STORE_STATE_001.lastOrderNumber` に書き戻され、旧コードに戻した直後も注文番号が重複・逆行しません（注文・認証・決済データは削除されません）。
3. **Vercel デプロイメントのロールバック:**
   - Vercel Dashboard > Deployments から、直前の安定稼働デプロイメントを「Instant Rollback（Promote to Production）」します。
4. **切り戻し後の動作確認:**
   - `/kitchen`、`/display`、および顧客画面 `/` が正常に表示されることを確認したうえで、注文受付を再開します。

#### B. 万が一のデータ破損障害時におけるバックアップからの復旧方針（直接上書き禁止）
- **本番DBに対する `pg_restore --clean --if-exists` の直接実行は、稼働中に発生した新規データを消去する危険があるため通常手順での実行を禁止します。**
- 万が一、データベース自体の復旧が必要となった場合は以下の手順を厳守します：
  1. 直ちに注文受付を停止（`isManualOpen: false`）し、現状の本番DBの状態をさらに別ダンプとして保全する。
  2. 手順4で取得したバックアップ（または Supabase Backups）を**独立した検証用/一時DB**にリストアし、差分データおよび手順6-3の **RPC 関数 ACL（`anon=false`, `authenticated=false`, `service_role=true`）** を確認する（ACL検証に失敗した状態での運用開始は厳禁）。
  3. 責任者の**個別承認**を得たうえで、必要なテーブル・レコードのみを安全に復旧する。
