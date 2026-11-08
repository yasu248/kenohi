import crypto from 'node:crypto';
import type { NextRequest } from 'next/server';

/**
 * Phase 0-B: スタッフ・管理者認証および認可モジュール
 *
 * 要件:
 * 1. パスワードとセッション秘密鍵は環境変数で管理 (クライアント側に固定パスワードを残さない)
 * 2. ログイン試行回数制限は Vercel の複数インスタンス間で共有される永続ストア (Supabase DB) 方式
 * 3. セッションには有効期限 (exp)、ロール (role)、発行時刻 (iat)、セッションID (sid) を含める
 * 4. ログアウトとサーバー側セッション無効化 (Revocation) に対応する
 * 5. HttpOnly / Secure / SameSite 属性付きの署名付きセッションCookie
 * 6. 状態変更リクエストに対する CSRF 対策 (Origin / Referer / X-Requested-With 検証)
 * 7. 認証失敗時に個人情報を返さない
 */

export type StaffRole = 'staff' | 'admin';

export interface SessionPayload {
  sid: string;
  role: StaffRole;
  iat: number; // Unix timestamp (ms)
  exp: number; // Unix timestamp (ms)
}

export interface PersistentSessionRecord {
  sessionId: string;
  role: StaffRole;
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface RateLimitRecord {
  identifier: string;
  attempts: number;
  firstAttemptAt: number;
  lockedUntil: number | null;
}

/**
 * Vercel マルチインスタンス間で共有される永続認証ストアのインターフェース
 * 本番/開発では Supabase PostgreSQL (`auth_sessions`, `auth_login_rate_limits`) または `STORE_STATE_001` 拡張を使用し、
 * 自動テストでは InMemoryAuthStore に差し替え可能。
 */
export interface IAuthPersistenceStore {
  getRateLimit(identifier: string): Promise<RateLimitRecord | null>;
  saveRateLimit(record: RateLimitRecord): Promise<void>;
  clearRateLimit(identifier: string): Promise<void>;
  saveSession(record: PersistentSessionRecord): Promise<void>;
  getSession(sessionId: string): Promise<PersistentSessionRecord | null>;
  revokeSession(sessionId: string): Promise<void>;
}

export const SESSION_COOKIE_NAME = 'kenocha_staff_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12時間
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15分ウィンドウ
export const RATE_LIMIT_MAX_ATTEMPTS = 5; // 5回連続失敗でロック
export const RATE_LIMIT_LOCKOUT_MS = 15 * 60 * 1000; // 15分間ロック

/**
 * タイミング攻撃耐性のある文字列比較 (SHA-256 ハッシュ長を揃えて timingSafeEqual を実行)
 */
export function safeCompareSecret(input: string, expected: string): boolean {
  if (!input || !expected) return false;
  const inputHash = crypto.createHash('sha256').update(input, 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(inputHash, expectedHash);
}

/**
 * 環境変数から認証設定を取得する。
 * パスワードおよび秘密鍵はコードにハードコードせず環境変数から読み取る。
 */
export function getAuthEnvConfig(): {
  staffPassword: string | undefined;
  adminPassword: string | undefined;
  sessionSecret: string | undefined;
  isConfigured: boolean;
} {
  const staffPassword = process.env.STAFF_PASSWORD;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const sessionSecret = process.env.AUTH_SESSION_SECRET;

  const isConfigured = Boolean(
    sessionSecret &&
      sessionSecret.length >= 16 &&
      (staffPassword || adminPassword)
  );

  return {
    staffPassword,
    adminPassword,
    sessionSecret,
    isConfigured,
  };
}

/**
 * パスワードを検証し、対応するロール ('admin' | 'staff' | null) を返す
 */
export function verifyPasswordAndGetRole(password: string): StaffRole | null {
  const { staffPassword, adminPassword, isConfigured } = getAuthEnvConfig();
  if (!isConfigured || !password) return null;

  if (adminPassword && safeCompareSecret(password, adminPassword)) {
    return 'admin';
  }
  if (staffPassword && safeCompareSecret(password, staffPassword)) {
    return 'staff';
  }
  return null;
}

/**
 * HMAC-SHA256 署名付きセッショントークンの生成
 */
export function signSessionToken(payload: SessionPayload, secret: string): string {
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(data, 'utf8')
    .digest('base64url');
  return `${data}.${signature}`;
}

/**
 * HMAC-SHA256 署名付きセッショントークンの検証・デコード
 */
export function verifySessionToken(
  token: string | undefined | null,
  secret: string | undefined,
  nowMs: number = Date.now()
): SessionPayload | null {
  if (!token || !secret || secret.length < 16) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [data, sig] = parts;
  if (!data || !sig) return null;

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(data, 'utf8')
    .digest('base64url');

  if (!safeCompareSecret(sig, expectedSig)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as SessionPayload;
    if (
      !decoded ||
      typeof decoded.sid !== 'string' ||
      (decoded.role !== 'staff' && decoded.role !== 'admin') ||
      typeof decoded.iat !== 'number' ||
      typeof decoded.exp !== 'number'
    ) {
      return null;
    }
    if (nowMs >= decoded.exp) {
      return null; // 期限切れ
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * HttpOnly・Secure・SameSite=Lax 属性付き Set-Cookie ヘッダー文字列を生成
 */
export function buildSessionCookieHeader(token: string, maxAgeSeconds: number = SESSION_TTL_MS / 1000): string {
  const isProd = process.env.NODE_ENV === 'production';
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
  ];
  if (isProd) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/**
 * ログアウト用の Cookie 削除ヘッダー文字列を生成
 */
export function buildClearSessionCookieHeader(): string {
  const isProd = process.env.NODE_ENV === 'production';
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isProd) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/**
 * リクエストから Cookie 値を抽出
 */
export function extractSessionCookie(request: Request | NextRequest): string | null {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';');
  for (const raw of cookies) {
    const [name, ...rest] = raw.trim().split('=');
    if (name === SESSION_COOKIE_NAME) {
      return rest.join('=').trim();
    }
  }
  return null;
}

/**
 * リクエスト元のクライアント識別子 (IP) を取得
 */
export function getClientIdentifier(request: Request | NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return realIp.trim();
  }
  return 'unknown_ip';
}

/**
 * CSRF 検証 (POST / PATCH / DELETE 等の状態変更リクエスト用)
 * - Origin ヘッダーが存在する場合は request.url の origin と一致することを確認
 * - またはカスタムヘッダー `x-requested-with: kenocha-staff` または Same-Origin Referer を検証
 */
export function verifyCsrfProtection(request: Request | NextRequest): boolean {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return true;
  }

  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(request.url).origin;
  } catch {
    return false;
  }

  const originHeader = request.headers.get('origin');
  if (originHeader) {
    return originHeader === expectedOrigin;
  }

  const refererHeader = request.headers.get('referer');
  if (refererHeader) {
    try {
      return new URL(refererHeader).origin === expectedOrigin;
    } catch {
      return false;
    }
  }

  // Origin/Referer がブラウザから付与されない環境ではカスタムヘッダーを要求
  const customHeader = request.headers.get('x-requested-with');
  if (customHeader === 'kenocha-staff' || customHeader === 'XMLHttpRequest') {
    return true;
  }

  return false;
}

/**
 * 永続レートリミットの確認と失敗カウント記録
 */
export async function checkLoginRateLimit(
  store: IAuthPersistenceStore,
  identifier: string,
  nowMs: number = Date.now()
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const record = await store.getRateLimit(identifier);
  if (!record) {
    return { allowed: true };
  }

  if (record.lockedUntil && nowMs < record.lockedUntil) {
    const retryAfterSeconds = Math.ceil((record.lockedUntil - nowMs) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  // ウィンドウ期限切れならリセット可能
  if (nowMs - record.firstAttemptAt > RATE_LIMIT_WINDOW_MS) {
    return { allowed: true };
  }

  return { allowed: true };
}

export async function recordFailedLoginAttempt(
  store: IAuthPersistenceStore,
  identifier: string,
  nowMs: number = Date.now()
): Promise<{ locked: boolean; attemptsRemaining: number }> {
  const existing = await store.getRateLimit(identifier);
  let attempts = 1;
  let firstAttemptAt = nowMs;

  if (existing && nowMs - existing.firstAttemptAt <= RATE_LIMIT_WINDOW_MS && (!existing.lockedUntil || nowMs >= existing.lockedUntil)) {
    attempts = existing.attempts + 1;
    firstAttemptAt = existing.firstAttemptAt;
  }

  const locked = attempts >= RATE_LIMIT_MAX_ATTEMPTS;
  const lockedUntil = locked ? nowMs + RATE_LIMIT_LOCKOUT_MS : null;

  await store.saveRateLimit({
    identifier,
    attempts,
    firstAttemptAt,
    lockedUntil,
  });

  return {
    locked,
    attemptsRemaining: Math.max(0, RATE_LIMIT_MAX_ATTEMPTS - attempts),
  };
}

/**
 * ログイン処理の実行（パスワード検証・レートリミット・永続セッション保存・署名トークン発行）
 */
export async function authenticateStaffLogin(
  store: IAuthPersistenceStore,
  password: string,
  identifier: string,
  nowMs: number = Date.now()
): Promise<
  | { ok: true; role: StaffRole; token: string; cookieHeader: string; expiresAt: number }
  | { ok: false; status: 401 | 429 | 503; error: string; retryAfterSeconds?: number }
> {
  const { sessionSecret, isConfigured } = getAuthEnvConfig();
  if (!isConfigured || !sessionSecret) {
    return {
      ok: false,
      status: 503,
      error: 'サーバー側の認証設定（STAFF_PASSWORD / AUTH_SESSION_SECRET）が未完了です',
    };
  }

  const rateCheck = await checkLoginRateLimit(store, identifier, nowMs);
  if (!rateCheck.allowed) {
    return {
      ok: false,
      status: 429,
      error: 'ログイン試行回数が上限に達しました。しばらく待ってから再試行してください。',
      retryAfterSeconds: rateCheck.retryAfterSeconds,
    };
  }

  const role = verifyPasswordAndGetRole(password);
  if (!role) {
    await recordFailedLoginAttempt(store, identifier, nowMs);
    return {
      ok: false,
      status: 401,
      error: 'パスワードが正しくありません',
    };
  }

  // ログイン成功時は失敗カウントをクリア
  await store.clearRateLimit(identifier);

  const sid = crypto.randomBytes(16).toString('hex');
  const expiresAt = nowMs + SESSION_TTL_MS;
  const payload: SessionPayload = {
    sid,
    role,
    iat: nowMs,
    exp: expiresAt,
  };

  await store.saveSession({
    sessionId: sid,
    role,
    issuedAt: nowMs,
    expiresAt,
    revoked: false,
  });

  const token = signSessionToken(payload, sessionSecret);
  const cookieHeader = buildSessionCookieHeader(token);

  return {
    ok: true,
    role,
    token,
    cookieHeader,
    expiresAt,
  };
}

/**
 * スタッフ/管理者リクエストの検証（署名検証 + 永続セッション無効化チェック + ロール認可 + CSRF検証）
 */
export async function authorizeStaffRequest(
  request: Request | NextRequest,
  store: IAuthPersistenceStore,
  options?: { requireRole?: StaffRole; enforceCsrf?: boolean; nowMs?: number }
): Promise<
  | { authorized: true; session: SessionPayload }
  | { authorized: false; status: 401 | 403; error: string }
> {
  const nowMs = options?.nowMs ?? Date.now();
  const enforceCsrf = options?.enforceCsrf ?? true;

  if (enforceCsrf && !verifyCsrfProtection(request)) {
    return {
      authorized: false,
      status: 403,
      error: '不正なリクエスト元です (CSRF check failed)',
    };
  }

  const { sessionSecret } = getAuthEnvConfig();
  const token = extractSessionCookie(request);
  const payload = verifySessionToken(token, sessionSecret, nowMs);

  if (!payload) {
    return {
      authorized: false,
      status: 401,
      error: '認証が必要です。再度ログインしてください。',
    };
  }

  // 永続ストア上でセッションが存在し、無効化(revoke)されていないことを確認
  const persisted = await store.getSession(payload.sid);
  if (!persisted || persisted.revoked || nowMs >= persisted.expiresAt) {
    return {
      authorized: false,
      status: 401,
      error: 'セッションが無効または期限切れです。再度ログインしてください。',
    };
  }

  if (options?.requireRole === 'admin' && payload.role !== 'admin') {
    return {
      authorized: false,
      status: 403,
      error: 'この操作には管理者（admin）権限が必要です。',
    };
  }

  return {
    authorized: true,
    session: payload,
  };
}
