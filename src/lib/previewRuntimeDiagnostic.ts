import crypto from 'node:crypto';

export const EXPECTED_STAGING_SUPABASE_ORIGIN = 'https://zqcniawwhtnfcxkkwauu.supabase.co';
export const EXPECTED_DIAGNOSTIC_BRANCH = 'phase0-safe-foundation';

export type SecretKeyType =
  | 'sb_secret_*'
  | 'sb_publishable_*'
  | 'jwt_eyJ*'
  | 'empty'
  | 'other';

export interface PreviewRuntimeDiagnosticLog {
  vercelEnv: string;
  gitRef: string;
  gitSha: string;
  appEnv: string;
  supabaseOriginMatchesStaging: boolean;
  secretKeyType: SecretKeyType;
  secretKeyRawLength: number;
  secretKeyTrimmedLength: number;
  hasLeadingOrTrailingWhitespace: boolean;
  hasSurroundingQuotes: boolean;
  matchesExpectedLocalKey: boolean | null;
  passedValueMatchesExpectedLocalKey: boolean | null;
}

export interface PreviewRuntimeDiagnosticResult {
  enabled: boolean;
  shouldHaltBeforeSupabaseConnect: boolean;
  haltReason: string | null;
  logPayload: PreviewRuntimeDiagnosticLog | null;
}

/**
 * 4条件すべてを満たす場合のみ Preview 限定 Runtime 診断を有効化する。
 * - APP_ENV === 'staging'
 * - VERCEL_ENV === 'preview'
 * - VERCEL_GIT_COMMIT_REF === 'phase0-safe-foundation'
 * - PREVIEW_SUPABASE_DIAG_ENABLED === 'true' (非 NEXT_PUBLIC_ のサーバー専用フラグ)
 */
export function isPreviewRuntimeDiagnosticEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return (
    env.APP_ENV === 'staging' &&
    env.VERCEL_ENV === 'preview' &&
    env.VERCEL_GIT_COMMIT_REF === EXPECTED_DIAGNOSTIC_BRANCH &&
    env.PREVIEW_SUPABASE_DIAG_ENABLED === 'true'
  );
}

/**
 * 診断対象コンテキスト (Preview 環境 / 対象ブランチ / 診断フラグ有効のいずれか) かを判定する。
 * Production (VERCEL_ENV === 'production') では常に false を返し、通常動作を変更しない。
 */
function isFailClosedPreviewContext(env: Record<string, string | undefined>): boolean {
  if (env.VERCEL_ENV === 'production') {
    return false;
  }
  return (
    env.VERCEL_ENV === 'preview' ||
    env.VERCEL_GIT_COMMIT_REF === EXPECTED_DIAGNOSTIC_BRANCH ||
    env.PREVIEW_SUPABASE_DIAG_ENABLED === 'true'
  );
}

function classifySecretKeyType(rawKey: string, trimmedKey: string): SecretKeyType {
  if (rawKey.length === 0 || trimmedKey.length === 0) {
    return 'empty';
  }
  const unquoted = trimmedKey.replace(/^["']|["']$/g, '');
  if (unquoted.startsWith('sb_secret_')) {
    return 'sb_secret_*';
  }
  if (unquoted.startsWith('sb_publishable_')) {
    return 'sb_publishable_*';
  }
  if (unquoted.startsWith('eyJ')) {
    return 'jwt_eyJ*';
  }
  return 'other';
}

/**
 * store.ts の normalizeSupabaseUrl と整合する形で末尾スラッシュおよび /rest/v1 のみ正規化し、
 * 指定ステージング origin と完全一致するかを厳格に判定する。
 * HTTP、ユーザー情報付きURL、クエリ/フラグメント付きURL、別ホストはすべて拒否する。
 */
function doesSupabaseOriginMatchStaging(rawUrl: string | undefined): boolean {
  if (!rawUrl || rawUrl.trim() === '') {
    return false;
  }
  try {
    const normalized = rawUrl
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/rest\/v1\/?$/, '')
      .replace(/\/+$/, '');
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

function timingSafeCompareSha256Hex(candidateValue: string, expectedSha256Hex: string | undefined): boolean | null {
  if (!expectedSha256Hex || expectedSha256Hex.trim() === '') {
    return null;
  }
  const normalizedExpected = expectedSha256Hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedExpected)) {
    return false;
  }
  if (candidateValue.length === 0) {
    return false;
  }
  const actualHex = crypto.createHash('sha256').update(candidateValue, 'utf8').digest('hex');
  return crypto.timingSafeEqual(Buffer.from(actualHex, 'utf8'), Buffer.from(normalizedExpected, 'utf8'));
}

/**
 * Preview 限定 Runtime 診断を評価し、Fail-Closed 方針で Supabase 接続可否を判定する。
 * - Production (VERCEL_ENV === 'production') および非診断ローカル環境では通常動作を維持
 * - Preview / 対象ブランチ / 診断フラグ有効のいずれかに該当する場合:
 *   - 4条件が不成立なら Supabase へ接続せず停止 (shouldHaltBeforeSupabaseConnect = true)
 *   - 4条件成立時は非機密診断ログを構築し、URL・キー種別・照合基準・生値一致がすべて正常な場合のみ接続許可
 * - 秘密鍵実値・ハッシュ値本体・Authorizationヘッダー・環境変数全体は一切出力しない
 */
export function evaluatePreviewRuntimeDiagnostic(
  env: Record<string, string | undefined> = process.env
): PreviewRuntimeDiagnosticResult {
  if (!isFailClosedPreviewContext(env)) {
    return {
      enabled: false,
      shouldHaltBeforeSupabaseConnect: false,
      haltReason: null,
      logPayload: null,
    };
  }

  if (!isPreviewRuntimeDiagnosticEnabled(env)) {
    return {
      enabled: false,
      shouldHaltBeforeSupabaseConnect: true,
      haltReason: 'PREVIEW_DIAGNOSTIC_PRECONDITION_UNMET',
      logPayload: null,
    };
  }

  const rawKey = env.SUPABASE_SECRET_KEY ?? '';
  const trimmedKey = rawKey.trim();
  const expectedSha256 = env.PREVIEW_SUPABASE_KEY_SHA256;
  const originMatches = doesSupabaseOriginMatchStaging(env.SUPABASE_URL);
  const secretKeyType = classifySecretKeyType(rawKey, trimmedKey);
  const matchesExpectedLocalKey = timingSafeCompareSha256Hex(trimmedKey, expectedSha256);
  const passedValueMatchesExpectedLocalKey = timingSafeCompareSha256Hex(rawKey, expectedSha256);

  const logPayload: PreviewRuntimeDiagnosticLog = {
    vercelEnv: env.VERCEL_ENV || '',
    gitRef: env.VERCEL_GIT_COMMIT_REF || '',
    gitSha: (env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'unknown',
    appEnv: env.APP_ENV || '',
    supabaseOriginMatchesStaging: originMatches,
    secretKeyType,
    secretKeyRawLength: rawKey.length,
    secretKeyTrimmedLength: trimmedKey.length,
    hasLeadingOrTrailingWhitespace: rawKey !== trimmedKey,
    hasSurroundingQuotes: /^["']|["']$/.test(trimmedKey),
    matchesExpectedLocalKey,
    passedValueMatchesExpectedLocalKey,
  };

  let haltReason: string | null = null;
  if (!originMatches) {
    haltReason = 'STAGING_ORIGIN_MISMATCH';
  } else if (matchesExpectedLocalKey === null || passedValueMatchesExpectedLocalKey === null) {
    haltReason = 'EXPECTED_KEY_DIGEST_MISSING';
  } else if (secretKeyType !== 'sb_secret_*' || !matchesExpectedLocalKey || !passedValueMatchesExpectedLocalKey) {
    haltReason = 'SECRET_KEY_VERIFICATION_FAILED';
  }

  return {
    enabled: true,
    shouldHaltBeforeSupabaseConnect: haltReason !== null,
    haltReason,
    logPayload,
  };
}

/**
 * 診断ログをサーバー側の Runtime Logs (console.info) のみに出力する。
 */
export function emitPreviewRuntimeDiagnostic(
  env: Record<string, string | undefined> = process.env,
  logger: (message: string) => void = (msg) => console.info(msg)
): PreviewRuntimeDiagnosticResult {
  const result = evaluatePreviewRuntimeDiagnostic(env);
  if (result.enabled && result.logPayload) {
    logger(`[PreviewRuntimeDiagnostic] ${JSON.stringify(result.logPayload)}`);
  }
  return result;
}

/**
 * GET /api/ping 用のサーバー側実行ラッパー。
 * 停止条件成立時は loadAndPingStore (store.ts の動的ロードおよび Supabase 接続) を一切実行しない。
 * HTTP レスポンスには診断情報を一切含めない。
 */
export async function executeGuardedPing(
  env: Record<string, string | undefined>,
  loadAndPingStore: () => Promise<void>,
  logger: (message: string) => void = (msg) => console.info(msg)
): Promise<{ status: number; body: Record<string, string> }> {
  const diag = emitPreviewRuntimeDiagnostic(env, logger);
  if (diag.shouldHaltBeforeSupabaseConnect) {
    return {
      status: 500,
      body: {
        status: 'error',
        message: 'Preview diagnostic precondition halted Supabase connection',
      },
    };
  }

  try {
    await loadAndPingStore();
    return {
      status: 200,
      body: {
        status: 'ok',
        message: 'Supabase is alive',
        timestamp: new Date().toISOString(),
      },
    };
  } catch (err) {
    console.error('ping failed:', err);
    return {
      status: 500,
      body: {
        status: 'error',
        message: String(err),
      },
    };
  }
}
