/**
 * Phase 0-G / 恒久EnvGuard: ステージング・Preview・検証環境の安全ガード機構
 *
 * 目的:
 * 1. VERCEL_ENV=preview の場合、APP_ENV=staging を必須とする（欠落・矛盾時は Fail-Closed）
 * 2. Vercel ランタイム上で VERCEL_ENV が欠落・不正な場合や、VERCEL_ENV=production と APP_ENV=staging の矛盾を遮断する
 * 3. 対象 Preview ブランチ (phase0-safe-foundation) で環境識別情報が欠落・矛盾している場合に Fail-Closed で遮断する
 * 4. テスト環境・ステージング環境実行時に、本番Stripeキー (sk_live_) が誤設定された場合に即時ブロックし、ステージングでは sk_test_ を必須とする
 * 5. 本番Supabase接続情報 (liyjwvgtavfjiohwryox) への誤接続を検知・遮断する
 * 6. ステージング環境の SUPABASE_URL は https://zqcniawwhtnfcxkkwauu.supabase.co を厳密に許可し、
 *    別ホスト・HTTP・ユーザー情報・クエリ・フラグメント・不正なパス・placeholder を遮断する
 * 7. ステージング環境の SUPABASE_SECRET_KEY の未設定・placeholder・空白/引用符混入・非 sb_secret_* 形式を遮断する
 * 8. スタッフ・管理者パスワードおよびセッション秘密鍵に固定サンプル値や脆弱な値が設定されている場合に遮断する
 * 9. 機密情報（キー、パスワード、ハッシュ、環境変数の実値）をログやエラーメッセージに絶対に出力しない
 */

export const EXPECTED_STAGING_SUPABASE_ORIGIN = 'https://zqcniawwhtnfcxkkwauu.supabase.co';
export const EXPECTED_PREVIEW_BRANCH = 'phase0-safe-foundation';

export interface EnvironmentSafetyCheckResult {
  safe: boolean;
  environment: string;
  errors: string[];
}

const INSECURE_CREDENTIAL_SAMPLES = new Set([
  'staging_staff_pass_2026',
  'staging_admin_pass_2026',
  'staging_session_secret_32bytes_min_length_xxxx',
  'password',
  'admin',
  '123456',
  'secret',
  'change_me',
  'changeme',
]);

const VALID_VERCEL_ENVS = new Set(['production', 'preview', 'development']);

/**
 * store.ts の normalizeSupabaseUrl と整合する URL 正規化。
 * 前後空白、末尾スラッシュ、末尾の /rest/v1 を除去する。
 */
export function normalizeSupabaseUrlForGuard(url: string): string {
  let normalized = url.trim();
  normalized = normalized.replace(/\/+$/, '');
  normalized = normalized.replace(/\/rest\/v1\/?$/, '');
  return normalized.replace(/\/+$/, '');
}

/**
 * ステージング環境の Supabase URL が https://zqcniawwhtnfcxkkwauu.supabase.co と厳密に一致するか検証する。
 * 別ホスト、HTTP、ユーザー情報、クエリ、フラグメント、/rest/v1 以外のパスを拒否する。
 */
export function isStrictStagingSupabaseUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl || rawUrl.trim() === '') {
    return false;
  }
  try {
    const normalized = normalizeSupabaseUrlForGuard(rawUrl);
    const parsed = new URL(normalized);
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      parsed.pathname === '/' &&
      parsed.origin === EXPECTED_STAGING_SUPABASE_ORIGIN &&
      normalized === EXPECTED_STAGING_SUPABASE_ORIGIN
    );
  } catch {
    return false;
  }
}

export function validateEnvironmentSafety(
  env: Record<string, string | undefined> = process.env
): EnvironmentSafetyCheckResult {
  const errors: string[] = [];
  const rawAppEnv = env.APP_ENV;
  const vercelFlag = env.VERCEL;
  const vercelEnv = env.VERCEL_ENV;
  const gitRef = env.VERCEL_GIT_COMMIT_REF;
  const appEnv = rawAppEnv || env.NODE_ENV || 'development';

  // 0. 環境識別情報の整合性検証 (Fail-Closed)
  if (vercelFlag === '1' && (!vercelEnv || !VALID_VERCEL_ENVS.has(vercelEnv))) {
    errors.push(
      'CRITICAL_CONFIG_ERROR: VERCEL_ENV is missing or invalid in Vercel runtime. Execution halted (fail-closed).'
    );
  }

  if (vercelEnv === 'production' && rawAppEnv === 'staging') {
    errors.push(
      'CRITICAL_CONFIG_ERROR: Conflicting environment identifiers (VERCEL_ENV=production with APP_ENV=staging). Execution halted.'
    );
  }

  if (vercelEnv === 'preview' && rawAppEnv !== 'staging') {
    errors.push(
      'CRITICAL_CONFIG_ERROR: APP_ENV must be set to "staging" when VERCEL_ENV is "preview". Execution halted (fail-closed).'
    );
  }

  if (vercelEnv === 'preview' && (!gitRef || gitRef.trim() === '')) {
    errors.push(
      'CRITICAL_CONFIG_ERROR: VERCEL_GIT_COMMIT_REF is required when VERCEL_ENV is "preview". Execution halted (fail-closed).'
    );
  }

  if (
    gitRef === EXPECTED_PREVIEW_BRANCH &&
    (vercelEnv !== 'preview' || rawAppEnv !== 'staging')
  ) {
    errors.push(
      'CRITICAL_CONFIG_ERROR: Target preview branch requires VERCEL_ENV="preview" and APP_ENV="staging". Execution halted (fail-closed).'
    );
  }

  const isPreview = vercelEnv === 'preview';
  const isStaging =
    rawAppEnv === 'staging' || isPreview || gitRef === EXPECTED_PREVIEW_BRANCH;
  const isStagingOrTest = isStaging || rawAppEnv === 'test' || env.NODE_ENV === 'test';

  const stripeKey = env.STRIPE_SECRET_KEY || '';
  const supabaseUrl = env.SUPABASE_URL || '';
  const supabaseSecretKey = env.SUPABASE_SECRET_KEY || '';

  // 1. 本番Stripeキー (sk_live_) 誤用遮断
  if (isStagingOrTest && stripeKey.startsWith('sk_live_')) {
    errors.push(
      'CRITICAL_CONFIG_ERROR: Production Stripe key (sk_live_*) detected in staging/test environment. Execution halted.'
    );
  }

  // 2. ステージング環境下での Stripe キー必須確認 (sk_test_ で始まっていること)
  if (isStaging) {
    if (!stripeKey) {
      errors.push('CRITICAL_CONFIG_ERROR: STRIPE_SECRET_KEY is required in staging environment.');
    } else if (!stripeKey.startsWith('sk_test_')) {
      errors.push(
        'CRITICAL_CONFIG_ERROR: STRIPE_SECRET_KEY must start with sk_test_ in staging environment. Production or invalid key rejected.'
      );
    }
  }

  // 3. 本番Supabase URLが指定された環境下でテスト/ステージングが起動されるのを遮断
  const knownProductionProjectRefs = ['liyjwvgtavfjiohwryox'];
  const prodSupabaseRef = env.PRODUCTION_SUPABASE_PROJECT_REF;
  if (prodSupabaseRef) {
    knownProductionProjectRefs.push(prodSupabaseRef);
  }

  if (isStagingOrTest) {
    for (const ref of knownProductionProjectRefs) {
      if (supabaseUrl.includes(ref)) {
        errors.push(
          `CRITICAL_CONFIG_ERROR: Production Supabase project (${ref}) detected in staging/test environment. Access blocked to protect production data.`
        );
        break;
      }
    }
  }

  // 4. ステージング環境での Supabase 接続情報の厳密性検証 (許可オリジン固定・placeholder 禁止・キー形式検証)
  if (isStaging) {
    if (!supabaseUrl || supabaseUrl.trim() === '' || supabaseUrl.includes('placeholder')) {
      errors.push(
        'CRITICAL_CONFIG_ERROR: SUPABASE_URL is missing, empty, or using placeholder in staging environment. A valid staging Supabase URL is required.'
      );
    } else if (!isStrictStagingSupabaseUrl(supabaseUrl)) {
      errors.push(
        'CRITICAL_CONFIG_ERROR: SUPABASE_URL must strictly match the dedicated staging Supabase origin (https://zqcniawwhtnfcxkkwauu.supabase.co) without invalid scheme, userinfo, query, fragment, or path.'
      );
    }

    const trimmedSecretKey = supabaseSecretKey.trim();
    if (!supabaseSecretKey || trimmedSecretKey === '' || supabaseSecretKey.includes('placeholder')) {
      errors.push(
        'CRITICAL_CONFIG_ERROR: SUPABASE_SECRET_KEY is missing, empty, or using placeholder in staging environment. A valid staging secret key (sb_secret_*) is required.'
      );
    } else {
      if (supabaseSecretKey !== trimmedSecretKey) {
        errors.push(
          'CRITICAL_CONFIG_ERROR: SUPABASE_SECRET_KEY contains leading or trailing whitespace in staging environment.'
        );
      }
      if (/^["']|["']$/.test(trimmedSecretKey)) {
        errors.push(
          'CRITICAL_CONFIG_ERROR: SUPABASE_SECRET_KEY contains surrounding quotes in staging environment.'
        );
      }
      if (!trimmedSecretKey.startsWith('sb_secret_')) {
        errors.push(
          'CRITICAL_CONFIG_ERROR: SUPABASE_SECRET_KEY must use the sb_secret_* format in staging environment.'
        );
      }
    }
  }

  // 5. ステージング環境での認証資格情報の検証 (固定サンプル値・脆弱な値の禁止)
  if (isStaging) {
    const staffPass = env.STAFF_PASSWORD;
    const adminPass = env.ADMIN_PASSWORD;
    const sessionSecret = env.AUTH_SESSION_SECRET;

    if (!staffPass || INSECURE_CREDENTIAL_SAMPLES.has(staffPass)) {
      errors.push(
        'CRITICAL_CONFIG_ERROR: STAFF_PASSWORD is missing or set to an insecure sample value in staging. Generate a secure random password.'
      );
    }

    if (!adminPass || INSECURE_CREDENTIAL_SAMPLES.has(adminPass)) {
      errors.push(
        'CRITICAL_CONFIG_ERROR: ADMIN_PASSWORD is missing or set to an insecure sample value in staging. Generate a secure random password.'
      );
    }

    if (!sessionSecret || INSECURE_CREDENTIAL_SAMPLES.has(sessionSecret) || sessionSecret.length < 32) {
      errors.push(
        'CRITICAL_CONFIG_ERROR: AUTH_SESSION_SECRET is missing, set to an insecure sample value, or shorter than 32 characters in staging. Generate a secure random 32+ byte string.'
      );
    }
  }

  return {
    safe: errors.length === 0,
    environment: appEnv,
    errors,
  };
}

export function assertStagingEnvironmentSafe(
  env: Record<string, string | undefined> = process.env
): void {
  const result = validateEnvironmentSafety(env);
  if (!result.safe) {
    throw new Error(`[EnvGuard] ${result.errors.join(' | ')}`);
  }
}
