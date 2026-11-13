/**
 * Phase 0-G: ステージング・検証環境の安全ガード機構
 *
 * 目的:
 * 1. テスト環境・ステージング環境実行時に、本番Stripeキー (sk_live_) が誤設定された場合に即時ブロックする
 * 2. ステージング環境で Stripe キーが sk_test_ で始まっていることを強制する
 * 3. 本番Supabase接続情報への誤接続を検知・遮断する
 * 4. ステージング環境で SUPABASE_URL / SUPABASE_SECRET_KEY の未設定や placeholder フォールバックを即座に遮断する
 * 5. スタッフ・管理者パスワードおよびセッション秘密鍵に固定サンプル値や脆弱な値が設定されている場合に遮断する
 * 6. 機密情報（キー、パスワード）の値をログやエラーメッセージに絶対に出力しない
 */

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

export function validateEnvironmentSafety(env: Record<string, string | undefined> = process.env): EnvironmentSafetyCheckResult {
  const errors: string[] = [];
  const appEnv = env.APP_ENV || env.NODE_ENV || 'development';
  const isStaging = appEnv === 'staging';
  const isStagingOrTest = isStaging || appEnv === 'test' || env.NODE_ENV === 'test';

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

  // 4. ステージング環境での Supabase 接続情報の厳密性検証 (placeholder フォールバック禁止)
  if (isStaging) {
    if (!supabaseUrl || supabaseUrl.trim() === '' || supabaseUrl.includes('placeholder')) {
      errors.push(
        'CRITICAL_CONFIG_ERROR: SUPABASE_URL is missing, empty, or using placeholder in staging environment. A valid staging Supabase URL is required.'
      );
    } else if (!supabaseUrl.startsWith('https://') && !supabaseUrl.startsWith('http://')) {
      errors.push('CRITICAL_CONFIG_ERROR: SUPABASE_URL must be a valid HTTP(S) URL.');
    }

    if (!supabaseSecretKey || supabaseSecretKey.trim() === '' || supabaseSecretKey.includes('placeholder')) {
      errors.push(
        'CRITICAL_CONFIG_ERROR: SUPABASE_SECRET_KEY is missing, empty, or using placeholder in staging environment. A valid staging secret key (sb_secret_*) is required.'
      );
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

export function assertStagingEnvironmentSafe(env: Record<string, string | undefined> = process.env): void {
  const result = validateEnvironmentSafety(env);
  if (!result.safe) {
    throw new Error(`[EnvGuard] ${result.errors.join(' | ')}`);
  }
}

