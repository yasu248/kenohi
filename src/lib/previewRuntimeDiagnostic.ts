import crypto from 'node:crypto';

export const EXPECTED_STAGING_SUPABASE_ORIGIN = 'https://zqcniawwhtnfcxkkwauu.supabase.co';
export const EXPECTED_DIAGNOSTIC_BRANCH = 'phase0-safe-foundation';

export type SecretKeyType =
  | 'sb_secret_*'
  | 'sb_publishable_*'
  | 'jwt_eyJ*'
  | 'empty'
  | 'other';

export type DiagnosticReasonCode =
  | 'APP_ENV_MISSING'
  | 'APP_ENV_MISMATCH'
  | 'VERCEL_ENV_MISSING'
  | 'VERCEL_ENV_MISMATCH'
  | 'GIT_REF_MISSING'
  | 'GIT_REF_MISMATCH'
  | 'DIAGNOSTIC_FLAG_MISSING'
  | 'DIAGNOSTIC_FLAG_MISMATCH'
  | 'SUPABASE_ORIGIN_MISMATCH'
  | 'EXPECTED_HASH_MISSING'
  | 'EXPECTED_HASH_INVALID'
  | 'SUPABASE_KEY_TYPE_INVALID'
  | 'SUPABASE_KEY_WHITESPACE'
  | 'SUPABASE_KEY_QUOTES'
  | 'SUPABASE_KEY_MISMATCH';

export interface PreviewPreconditionChecks {
  appEnvOk: boolean;
  vercelEnvOk: boolean;
  gitRefOk: boolean;
  diagFlagOk: boolean;
}

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

export interface PreviewHaltLog {
  event: 'PREVIEW_DIAGNOSTIC_HALT';
  reasons: DiagnosticReasonCode[];
  checks: PreviewPreconditionChecks;
}

export interface PreviewRuntimeDiagnosticResult {
  enabled: boolean;
  shouldHaltBeforeSupabaseConnect: boolean;
  haltReason: string | null;
  reasons: DiagnosticReasonCode[];
  checks: PreviewPreconditionChecks;
  logPayload: PreviewRuntimeDiagnosticLog | null;
  haltLogPayload: PreviewHaltLog | null;
}

export interface DiagnosticLoggers {
  info: (message: string) => void;
  warn: (message: string) => void;
}

const DEFAULT_LOGGERS: DiagnosticLoggers = {
  info: (msg) => console.info(msg),
  warn: (msg) => console.warn(msg),
};

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

function collectPreconditionReasons(
  env: Record<string, string | undefined>
): { checks: PreviewPreconditionChecks; reasons: DiagnosticReasonCode[] } {
  const reasons: DiagnosticReasonCode[] = [];

  const appEnvOk = env.APP_ENV === 'staging';
  if (!env.APP_ENV || env.APP_ENV.trim() === '') {
    reasons.push('APP_ENV_MISSING');
  } else if (!appEnvOk) {
    reasons.push('APP_ENV_MISMATCH');
  }

  const vercelEnvOk = env.VERCEL_ENV === 'preview';
  if (!env.VERCEL_ENV || env.VERCEL_ENV.trim() === '') {
    reasons.push('VERCEL_ENV_MISSING');
  } else if (!vercelEnvOk) {
    reasons.push('VERCEL_ENV_MISMATCH');
  }

  const gitRefOk = env.VERCEL_GIT_COMMIT_REF === EXPECTED_DIAGNOSTIC_BRANCH;
  if (!env.VERCEL_GIT_COMMIT_REF || env.VERCEL_GIT_COMMIT_REF.trim() === '') {
    reasons.push('GIT_REF_MISSING');
  } else if (!gitRefOk) {
    reasons.push('GIT_REF_MISMATCH');
  }

  const diagFlagOk = env.PREVIEW_SUPABASE_DIAG_ENABLED === 'true';
  if (!env.PREVIEW_SUPABASE_DIAG_ENABLED || env.PREVIEW_SUPABASE_DIAG_ENABLED.trim() === '') {
    reasons.push('DIAGNOSTIC_FLAG_MISSING');
  } else if (!diagFlagOk) {
    reasons.push('DIAGNOSTIC_FLAG_MISMATCH');
  }

  return {
    checks: { appEnvOk, vercelEnvOk, gitRefOk, diagFlagOk },
    reasons,
  };
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

function validateExpectedSha256Format(expectedSha256Hex: string | undefined): 'missing' | 'invalid' | 'valid' {
  if (!expectedSha256Hex || expectedSha256Hex.trim() === '') {
    return 'missing';
  }
  const normalized = expectedSha256Hex.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? 'valid' : 'invalid';
}

function timingSafeCompareSha256Hex(candidateValue: string, expectedSha256Hex: string | undefined): boolean | null {
  const format = validateExpectedSha256Format(expectedSha256Hex);
  if (format === 'missing') {
    return null;
  }
  if (format === 'invalid' || candidateValue.length === 0) {
    return false;
  }
  const normalizedExpected = expectedSha256Hex!.trim().toLowerCase();
  const actualHex = crypto.createHash('sha256').update(candidateValue, 'utf8').digest('hex');
  return crypto.timingSafeEqual(Buffer.from(actualHex, 'utf8'), Buffer.from(normalizedExpected, 'utf8'));
}

/**
 * Preview 限定 Runtime 診断を評価し、Fail-Closed 方針で Supabase 接続可否と固定理由コードを判定する。
 * - Production (VERCEL_ENV === 'production') および非診断ローカル環境では通常動作を維持し、ログを出さない
 * - 診断対象コンテキストで前提条件不成立の場合、秘密情報を含まない固定理由コード一覧 (reasons) と checks のみを生成し停止
 * - 4条件成立時は非機密診断ログを構築し、URL・照合基準・キー検証のいずれかに不備があれば固定理由コードを添えて停止
 */
export function evaluatePreviewRuntimeDiagnostic(
  env: Record<string, string | undefined> = process.env
): PreviewRuntimeDiagnosticResult {
  const { checks, reasons: preconditionReasons } = collectPreconditionReasons(env);

  if (!isFailClosedPreviewContext(env)) {
    return {
      enabled: false,
      shouldHaltBeforeSupabaseConnect: false,
      haltReason: null,
      reasons: [],
      checks,
      logPayload: null,
      haltLogPayload: null,
    };
  }

  if (preconditionReasons.length > 0) {
    return {
      enabled: false,
      shouldHaltBeforeSupabaseConnect: true,
      haltReason: preconditionReasons[0],
      reasons: preconditionReasons,
      checks,
      logPayload: null,
      haltLogPayload: {
        event: 'PREVIEW_DIAGNOSTIC_HALT',
        reasons: preconditionReasons,
        checks,
      },
    };
  }

  const rawKey = env.SUPABASE_SECRET_KEY ?? '';
  const trimmedKey = rawKey.trim();
  const expectedSha256 = env.PREVIEW_SUPABASE_KEY_SHA256;
  const originMatches = doesSupabaseOriginMatchStaging(env.SUPABASE_URL);
  const secretKeyType = classifySecretKeyType(rawKey, trimmedKey);
  const hasWhitespace = rawKey !== trimmedKey;
  const hasQuotes = /^["']|["']$/.test(trimmedKey);
  const expectedHashFormat = validateExpectedSha256Format(expectedSha256);
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
    hasLeadingOrTrailingWhitespace: hasWhitespace,
    hasSurroundingQuotes: hasQuotes,
    matchesExpectedLocalKey,
    passedValueMatchesExpectedLocalKey,
  };

  const runtimeReasons: DiagnosticReasonCode[] = [];
  if (!originMatches) {
    runtimeReasons.push('SUPABASE_ORIGIN_MISMATCH');
  }
  if (expectedHashFormat === 'missing') {
    runtimeReasons.push('EXPECTED_HASH_MISSING');
  } else if (expectedHashFormat === 'invalid') {
    runtimeReasons.push('EXPECTED_HASH_INVALID');
  }
  if (secretKeyType !== 'sb_secret_*') {
    runtimeReasons.push('SUPABASE_KEY_TYPE_INVALID');
  }
  if (hasWhitespace) {
    runtimeReasons.push('SUPABASE_KEY_WHITESPACE');
  }
  if (hasQuotes) {
    runtimeReasons.push('SUPABASE_KEY_QUOTES');
  }
  if (
    expectedHashFormat === 'valid' &&
    (matchesExpectedLocalKey !== true || passedValueMatchesExpectedLocalKey !== true)
  ) {
    runtimeReasons.push('SUPABASE_KEY_MISMATCH');
  }

  const shouldHalt = runtimeReasons.length > 0;
  return {
    enabled: true,
    shouldHaltBeforeSupabaseConnect: shouldHalt,
    haltReason: shouldHalt ? runtimeReasons[0] : null,
    reasons: runtimeReasons,
    checks,
    logPayload,
    haltLogPayload: shouldHalt
      ? {
          event: 'PREVIEW_DIAGNOSTIC_HALT',
          reasons: runtimeReasons,
          checks,
        }
      : null,
  };
}

/**
 * 診断ログおよび安全停止理由コードをサーバー側ログのみに出力する。
 * - 4条件成立時: console.info で [PreviewRuntimeDiagnostic] を出力
 * - 安全停止時 (前提不成立・ランタイム検証不成立の双方): console.warn で [PreviewRuntimeDiagnostic][HALT] を必ず出力
 * - Production 正常経路: 一切出力しない
 */
export function emitPreviewRuntimeDiagnostic(
  env: Record<string, string | undefined> = process.env,
  loggers: DiagnosticLoggers = DEFAULT_LOGGERS
): PreviewRuntimeDiagnosticResult {
  const result = evaluatePreviewRuntimeDiagnostic(env);
  if (result.enabled && result.logPayload) {
    loggers.info(`[PreviewRuntimeDiagnostic] ${JSON.stringify(result.logPayload)}`);
  }
  if (result.shouldHaltBeforeSupabaseConnect && result.haltLogPayload) {
    loggers.warn(`[PreviewRuntimeDiagnostic][HALT] ${JSON.stringify(result.haltLogPayload)}`);
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
  loggers: DiagnosticLoggers = DEFAULT_LOGGERS
): Promise<{ status: number; body: Record<string, string> }> {
  const diag = emitPreviewRuntimeDiagnostic(env, loggers);
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
