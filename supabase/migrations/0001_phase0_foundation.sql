-- =============================================================================
-- Phase 0 Foundation Migration: 0001_phase0_foundation.sql
--
-- 目的:
-- 1. 既存カラム・既存データを一切削除せず、4軸ステータス・外部注文ID・返金額カラムを追加
-- 2. 既存の `status = 'cancelled'` レコードは意味が曖昧（受渡完了 or 注文取消）なため、
--    推測で書き換えず 4軸カラムを NULL（未判定 `legacy_undetermined`）のまま保持
-- 3. 進行中（`unpaid` / `pending` / `preparing` / `completed`）のレコードのみ安全にバックフィル
-- 4. Vercel 複数インスタンス間で一意性が保証される PostgreSQL 原子的採番テーブルと RPC 関数を作成
-- 5. Stripe Webhook の重複排除テーブルおよびスタッフ認証・レートリミット用永続テーブルを作成
-- 6. RLS (Row Level Security) を有効化し、ブラウザからの anon キー直アクセスを遮断しつつ
--    サーバーサイド (service_role / secret key) のみ操作可能に設定
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. orders テーブルの非破壊カラム拡張
-- -----------------------------------------------------------------------------
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS store_id TEXT NOT NULL DEFAULT 'kenocha_main',
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'mobile',
  ADD COLUMN IF NOT EXISTS external_order_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_status TEXT,
  ADD COLUMN IF NOT EXISTS production_status TEXT,
  ADD COLUMN IF NOT EXISTS fulfillment_status TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_status TEXT,
  ADD COLUMN IF NOT EXISTS refunded_amount INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stripe_session_id TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 値ドメインの CHECK 制約（NULL 許容により過去データの未判定状態を保持）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_payment_status_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_payment_status_check
      CHECK (payment_status IS NULL OR payment_status IN ('unpaid', 'paid', 'partially_refunded', 'refunded', 'failed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_production_status_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_production_status_check
      CHECK (production_status IS NULL OR production_status IN ('pending', 'preparing', 'ready'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_fulfillment_status_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_fulfillment_status_check
      CHECK (fulfillment_status IS NULL OR fulfillment_status IN ('not_handed_over', 'handed_over'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_cancellation_status_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_cancellation_status_check
      CHECK (cancellation_status IS NULL OR cancellation_status IN ('active', 'cancelled'));
  END IF;
END $$;

-- 外部注文の二重登録を防止する部分一意インデックス
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_source_external_order_id
  ON public.orders (source, external_order_id)
  WHERE external_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_store_created_at
  ON public.orders (store_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 2. 既存データの安全なバックフィル（意味が確定している進行中ステータスのみ）
-- ※ status = 'cancelled' の過去レコードは受渡完了か注文取消か判別不能なため、
--   推測で変更せず NULL（legacy_undetermined）のまま保持します。
-- -----------------------------------------------------------------------------
UPDATE public.orders
SET
  payment_status = 'unpaid',
  production_status = 'pending',
  fulfillment_status = 'not_handed_over',
  cancellation_status = 'active'
WHERE id <> 'STORE_STATE_001'
  AND status = 'unpaid'
  AND payment_status IS NULL;

UPDATE public.orders
SET
  payment_status = 'paid',
  production_status = 'pending',
  fulfillment_status = 'not_handed_over',
  cancellation_status = 'active'
WHERE id <> 'STORE_STATE_001'
  AND status = 'pending'
  AND payment_status IS NULL;

UPDATE public.orders
SET
  payment_status = 'paid',
  production_status = 'preparing',
  fulfillment_status = 'not_handed_over',
  cancellation_status = 'active'
WHERE id <> 'STORE_STATE_001'
  AND status = 'preparing'
  AND payment_status IS NULL;

UPDATE public.orders
SET
  payment_status = 'paid',
  production_status = 'ready',
  fulfillment_status = 'not_handed_over',
  cancellation_status = 'active'
WHERE id <> 'STORE_STATE_001'
  AND status = 'completed'
  AND payment_status IS NULL;

-- -----------------------------------------------------------------------------
-- 3. 注文番号の原子的採番テーブルと RPC 関数 (Phase 0-E)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_number_sequences (
  store_id TEXT NOT NULL,
  order_date TEXT NOT NULL, -- JST 'YYYY-MM-DD'
  last_number INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (store_id, order_date)
);

CREATE OR REPLACE FUNCTION public.next_order_number(
  p_store_id TEXT,
  p_order_date TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_initial_number INTEGER;
  v_assigned_number INTEGER;
BEGIN
  -- その日の最初の注文番号: 3000〜5000 のランダムな整数
  v_initial_number := floor(random() * (5000 - 3000 + 1) + 3000)::INTEGER;

  -- 行ロックと ON CONFLICT により同時注文でも完全に原子的に +1 採番する
  INSERT INTO public.order_number_sequences (store_id, order_date, last_number, updated_at)
  VALUES (p_store_id, p_order_date, v_initial_number, NOW())
  ON CONFLICT (store_id, order_date)
  DO UPDATE SET
    last_number = public.order_number_sequences.last_number + 1,
    updated_at = NOW()
  RETURNING last_number INTO v_assigned_number;

  RETURN v_assigned_number::TEXT;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Stripe Webhook イベント重複排除テーブル (Phase 0-D)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 5. スタッフ認証セッション & ログイン試行回数制限テーブル (Phase 0-B)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.auth_sessions (
  session_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('staff', 'admin')),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.auth_login_rate_limits (
  identifier TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 6. Row Level Security (RLS) の有効化
--    ※ Next.js API Route は SUPABASE_SECRET_KEY (service_role) を使用するため RLS をバイパスし、
--      万が一 anon key が外部に漏洩してもブラウザから直接テーブルを読み書きできないように保護します。
-- -----------------------------------------------------------------------------
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_number_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_login_rate_limits ENABLE ROW LEVEL SECURITY;

COMMIT;
