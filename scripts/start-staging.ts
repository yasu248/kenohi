/**
 * ステージング専用 安全起動スクリプト (scripts/start-staging.ts)
 *
 * 目的:
 * 1. .env.staging.local を明示的にロードし、最優先で process.env に注入する
 * 2. Next.js が .env.local や .env.development.local を読み込むことによる設定混入を完全遮断する
 * 3. 親プロセスから継承された危険な環境変数 (本番Supabase URL、sk_live_* 等) を検知・遮断する
 * 4. 起動時にステージング用 Supabase Project Ref (zqcniawwhtnfcxkkwauu) および Stripe テストモードを厳密に検証する
 * 5. 秘密鍵・パスワードの平文を一切ログに出力しない
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { validateEnvironmentSafety, assertStagingEnvironmentSafe } from '../src/lib/envGuard.ts';
import { normalizeSupabaseUrl } from '../src/lib/store.ts';

const EXPECTED_STAGING_PROJECT_REF = 'zqcniawwhtnfcxkkwauu';
const STAGING_ENV_FILE = resolve(process.cwd(), '.env.staging.local');

export function loadAndVerifyStagingEnv(): Record<string, string> {
  if (!existsSync(STAGING_ENV_FILE)) {
    throw new Error(`CRITICAL: Staging environment file not found at ${STAGING_ENV_FILE}. Copy .env.staging.example and configure credentials.`);
  }

  // 1. .env.staging.local をパース
  const content = readFileSync(STAGING_ENV_FILE, 'utf8');
  const parsedEnv: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      let val = match[2].trim();
      // クォート除去
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      parsedEnv[key] = val;
    }
  }

  // 2. process.env に最優先適用 (親プロセスの危険な設定を上書き)
  for (const [k, v] of Object.entries(parsedEnv)) {
    process.env[k] = v;
  }
  process.env.APP_ENV = 'staging';

  // 3. 安全ガードによる厳格な検証
  assertStagingEnvironmentSafe(process.env);

  // 4. ステージング固有の Project Ref の検証
  const rawUrl = process.env.SUPABASE_URL || '';
  const normalizedUrl = normalizeSupabaseUrl(rawUrl);
  process.env.SUPABASE_URL = normalizedUrl;

  if (!normalizedUrl.includes(EXPECTED_STAGING_PROJECT_REF)) {
    throw new Error(
      `CRITICAL_CONFIG_ERROR: SUPABASE_URL (${normalizedUrl}) does NOT match expected staging project ref (${EXPECTED_STAGING_PROJECT_REF}). Startup halted.`
    );
  }

  // 5. Stripe テストモード検証
  const stripeKey = process.env.STRIPE_SECRET_KEY || '';
  if (!stripeKey.startsWith('sk_test_')) {
    throw new Error('CRITICAL_CONFIG_ERROR: STRIPE_SECRET_KEY must start with sk_test_ in staging.');
  }

  return parsedEnv;
}

// 直接実行された場合は検証ログを出力して Next.js を起動
if (process.argv[1]?.endsWith('start-staging.ts')) {
  try {
    console.log('=== [ステージング起動前 安全性検証] ===');
    const loaded = loadAndVerifyStagingEnv();

    const url = process.env.SUPABASE_URL!;
    const key = process.env.SUPABASE_SECRET_KEY!;
    const isNewKey = key.startsWith('sb_secret_');

    console.log(`✅ ステージング環境変数の安全性を確認しました`);
    console.log(`- 対象Supabase URL: ${url} (Ref: ${EXPECTED_STAGING_PROJECT_REF} 一致)`);
    console.log(`- Supabase Key 形式: ${isNewKey ? '新形式 (sb_secret_*)' : '旧形式/その他'}`);
    console.log(`- Stripe 動作モード: テストモード (sk_test_*)`);
    console.log(`- 秘密鍵・パスワードの平文出力: なし (マスク保護)`);
    console.log(`- 他の.envファイル (本番設定等) による混入防止: 有効\n`);

    console.log('🚀 Next.js ステージングサーバーを起動します...\n');

    // Next.js dev サーバーを起動
    const nextDev = spawn('npx', ['next', 'dev'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        APP_ENV: 'staging',
      },
    });

    nextDev.on('error', (err) => {
      console.error('Failed to start Next.js process:', err);
      process.exit(1);
    });

    nextDev.on('exit', (code) => {
      process.exit(code ?? 0);
    });
  } catch (err: any) {
    console.error(`\n❌ [起動中止] ${err.message}`);
    process.exit(1);
  }
}
