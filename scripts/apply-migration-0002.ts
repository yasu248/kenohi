/**
 * ステージング環境 マイグレーション適用スクリプト (0002_phase0_stripe_session_hardening.sql)
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { normalizeSupabaseUrl } from '../src/lib/store.ts';

const STAGING_ENV_FILE = resolve(process.cwd(), '.env.staging.local');
const MIGRATION_FILE = resolve(process.cwd(), 'supabase/migrations/0002_phase0_stripe_session_hardening.sql');

async function applyMigration() {
  console.log('=== [マイグレーション 0002 適用開始] ===');

  if (!existsSync(STAGING_ENV_FILE)) throw new Error('.env.staging.local not found');
  const envContent = readFileSync(STAGING_ENV_FILE, 'utf8');
  const env: Record<string, string> = {};
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      let val = match[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[match[1].trim()] = val;
    }
  }

  const rawUrl = env.SUPABASE_URL || '';
  const supabaseUrl = normalizeSupabaseUrl(rawUrl);
  const secretKey = env.SUPABASE_SECRET_KEY || '';

  if (!supabaseUrl.includes('zqcniawwhtnfcxkkwauu')) {
    throw new Error(`CRITICAL: Target is not staging DB (${supabaseUrl})`);
  }
  if (!secretKey.startsWith('sb_secret_')) {
    throw new Error('CRITICAL: Secret key must be sb_secret_*');
  }

  console.log(`- 対象ステージングDB: ${supabaseUrl}`);

  const sql = readFileSync(MIGRATION_FILE, 'utf8');

  // Supabase の postgres 接続または RPC 実行
  // PostgREST 経由で直接 DDL は実行できない場合があるため、
  // postgres 直接接続または postgresql connection string を確認
  // または Docker ローカル PG / staging SQL
  console.log('マイグレーションSQLの読み込み完了 (' + sql.length + ' bytes)');
  return { sql, supabaseUrl };
}

applyMigration().catch((err) => {
  console.error(err);
  process.exit(1);
});
