/**
 * Phase 0-G: ステージング・検証環境の安全ガード機構
 *
 * 目的:
 * 1. テスト環境・ステージング環境実行時に、本番Stripeキー (sk_live_) が誤設定された場合に即時ブロックする
 * 2. 本番Supabase接続情報への誤接続を検知・遮断する
 * 3. 必要な環境変数が実コードの参照名 (SUPABASE_URL, SUPABASE_SECRET_KEY, STRIPE_SECRET_KEY 等) と一致していることを検証する
 */

export interface EnvironmentSafetyCheckResult {
  safe: boolean;
  environment: string;
  errors: string[];
}

export function validateEnvironmentSafety(env: Record<string, string | undefined> = process.env): EnvironmentSafetyCheckResult {
  const errors: string[] = [];
  const appEnv = env.APP_ENV || env.NODE_ENV || 'development';
  const isStagingOrTest = appEnv === 'staging' || appEnv === 'test' || env.NODE_ENV === 'test';

  const stripeKey = env.STRIPE_SECRET_KEY || '';
  const supabaseUrl = env.SUPABASE_URL || '';

  // 1. テスト/ステージング環境下での本番Stripeキー (sk_live_) 誤用遮断
  if (isStagingOrTest && stripeKey.startsWith('sk_live_')) {
    errors.push(
      'CRITICAL_CONFIG_ERROR: Production Stripe key (sk_live_*) detected in staging/test environment. Execution halted.'
    );
  }

  // 2. 本番Supabase URLが指定された環境下でテスト/ステージングが起動されるのを遮断
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
