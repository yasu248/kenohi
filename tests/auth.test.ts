import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  safeCompareSecret,
  signSessionToken,
  verifySessionToken,
  authenticateStaffLogin,
  authorizeStaffRequest,
  type IAuthPersistenceStore,
  type PersistentSessionRecord,
  type RateLimitRecord,
  type SessionPayload,
} from '../src/lib/auth.ts';
import { sanitizeStoreStateForResponse, type StoreState } from '../src/lib/store.ts';

class InMemoryAuthStore implements IAuthPersistenceStore {
  public sessions: Map<string, PersistentSessionRecord> = new Map();
  public rateLimits: Map<string, RateLimitRecord> = new Map();

  async getRateLimit(identifier: string): Promise<RateLimitRecord | null> {
    return this.rateLimits.get(identifier) || null;
  }
  async saveRateLimit(record: RateLimitRecord): Promise<void> {
    this.rateLimits.set(record.identifier, record);
  }
  async clearRateLimit(identifier: string): Promise<void> {
    this.rateLimits.delete(identifier);
  }
  async saveSession(record: PersistentSessionRecord): Promise<void> {
    this.sessions.set(record.sessionId, record);
  }
  async getSession(sessionId: string): Promise<PersistentSessionRecord | null> {
    return this.sessions.get(sessionId) || null;
  }
  async revokeSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) s.revoked = true;
  }
}

describe('[Phase 0-B] スタッフ・管理者認証および認可テスト', () => {
  let store: InMemoryAuthStore;
  const SECRET = 'test_session_secret_32bytes_long_12345';

  beforeEach(() => {
    store = new InMemoryAuthStore();
    process.env.STAFF_PASSWORD = 'staff_test_pass_2026';
    process.env.ADMIN_PASSWORD = 'admin_test_pass_2026';
    process.env.AUTH_SESSION_SECRET = SECRET;
  });

  it('1. タイミング攻撃耐性のある文字列比較: 正しいパスワードのみ true を返すこと', () => {
    assert.equal(safeCompareSecret('correct_secret', 'correct_secret'), true);
    assert.equal(safeCompareSecret('wrong_secret', 'correct_secret'), false);
    assert.equal(safeCompareSecret('', 'correct_secret'), false);
  });

  it('2. 署名付きセッショントークンの検証: 改ざんや期限切れを正しく検出すること', () => {
    const now = 1000000;
    const payload: SessionPayload = {
      sid: 'sess_1',
      role: 'staff',
      iat: now,
      exp: now + 3600000,
    };
    const token = signSessionToken(payload, SECRET);
    const verified = verifySessionToken(token, SECRET, now);
    assert.ok(verified);
    assert.equal(verified?.sid, 'sess_1');
    assert.equal(verified?.role, 'staff');

    // 改ざんトークン
    const tampered = token.slice(0, -3) + 'xyz';
    assert.equal(verifySessionToken(tampered, SECRET, now), null);

    // 期限切れ
    assert.equal(verifySessionToken(token, SECRET, now + 4000000), null);
  });

  it('3. ログインとロール判別: staff と admin で適切なロールが割り当てられること', async () => {
    const staffRes = await authenticateStaffLogin(store, 'staff_test_pass_2026', 'ip_1');
    assert.ok(staffRes.ok);
    if (staffRes.ok) {
      assert.equal(staffRes.role, 'staff');
      assert.ok(staffRes.cookieHeader.includes('HttpOnly'));
    }

    const adminRes = await authenticateStaffLogin(store, 'admin_test_pass_2026', 'ip_2');
    assert.ok(adminRes.ok);
    if (adminRes.ok) {
      assert.equal(adminRes.role, 'admin');
    }
  });

  it('4. レートリミット: 5回連続失敗でアカウントがロックされ、429 を返すこと', async () => {
    const ip = '192.168.1.10';
    for (let i = 0; i < 4; i++) {
      const res = await authenticateStaffLogin(store, 'wrong_pass', ip);
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.status, 401);
    }

    // 5回目失敗でロック
    const fifthRes = await authenticateStaffLogin(store, 'wrong_pass', ip);
    assert.equal(fifthRes.ok, false);

    // 6回目: 正しいパスワードでもロック期間中は 429
    const lockedRes = await authenticateStaffLogin(store, 'staff_test_pass_2026', ip);
    assert.equal(lockedRes.ok, false);
    if (!lockedRes.ok) {
      assert.equal(lockedRes.status, 429);
      assert.ok((lockedRes.retryAfterSeconds ?? 0) > 0);
    }
  });

  it('5. 認可とCSRF防御: 未認証アクセスおよび不正なOriginを401/403で拒否すること', async () => {
    // 認証なしリクエスト
    const unauthReq = new Request('https://example.com/api/orders', {
      method: 'GET',
    });
    const unauthRes = await authorizeStaffRequest(unauthReq, store, { enforceCsrf: false });
    assert.equal(unauthRes.authorized, false);
    if (!unauthRes.authorized) assert.equal(unauthRes.status, 401);

    // ログインして有効なCookieを取得
    const login = await authenticateStaffLogin(store, 'staff_test_pass_2026', 'ip_staff');
    assert.ok(login.ok);
    const token = login.ok ? login.token : '';

    // 不正な Origin からの PATCH リクエスト (CSRF攻撃)
    const csrfReq = new Request('https://example.com/api/orders/o_1', {
      method: 'PATCH',
      headers: {
        cookie: `kenocha_staff_session=${token}`,
        origin: 'https://malicious-site.com',
      },
    });
    const csrfRes = await authorizeStaffRequest(csrfReq, store, { enforceCsrf: true });
    assert.equal(csrfRes.authorized, false);
    if (!csrfRes.authorized) assert.equal(csrfRes.status, 403);

    // 正しい Origin からのリクエスト (成功)
    const validReq = new Request('https://example.com/api/orders/o_1', {
      method: 'PATCH',
      headers: {
        cookie: `kenocha_staff_session=${token}`,
        origin: 'https://example.com',
      },
    });
    const validRes = await authorizeStaffRequest(validReq, store, { enforceCsrf: true });
    assert.equal(validRes.authorized, true);
  });

  it('6. 管理者権限チェック: staff ロールは admin 限定操作 (全注文クリア等) を実行できないこと', async () => {
    const login = await authenticateStaffLogin(store, 'staff_test_pass_2026', 'ip_staff');
    assert.ok(login.ok);
    const token = login.ok ? login.token : '';

    const req = new Request('https://example.com/api/orders/all', {
      method: 'DELETE',
      headers: {
        cookie: `kenocha_staff_session=${token}`,
        origin: 'https://example.com',
      },
    });

    const check = await authorizeStaffRequest(req, store, { requireRole: 'admin', enforceCsrf: true });
    assert.equal(check.authorized, false);
    if (!check.authorized) assert.equal(check.status, 403);
  });

  it('7. ログアウトとセッション無効化: サーバー側で revoke されたセッションは再利用できないこと', async () => {
    const login = await authenticateStaffLogin(store, 'staff_test_pass_2026', 'ip_staff');
    assert.ok(login.ok);
    const token = login.ok ? login.token : '';

    const req = new Request('https://example.com/api/orders', {
      method: 'GET',
      headers: { cookie: `kenocha_staff_session=${token}` },
    });

    // ログアウト前は有効
    const res1 = await authorizeStaffRequest(req, store, { enforceCsrf: false });
    assert.equal(res1.authorized, true);

    // ログアウト実行 (revokeSession)
    const payload = verifySessionToken(token, SECRET)!;
    await store.revokeSession(payload.sid);

    // ログアウト後は無効 (401)
    const res2 = await authorizeStaffRequest(req, store, { enforceCsrf: false });
    assert.equal(res2.authorized, false);
    if (!res2.authorized) assert.equal(res2.status, 401);
  });

  it('8. 環境変数名の厳格チェック: STAFF_PASSWORD / ADMIN_PASSWORD 未設定時は自動フォールバックせず 503 で設定ミスを検出すること', async () => {
    delete process.env.STAFF_PASSWORD;
    delete process.env.ADMIN_PASSWORD;
    process.env.KITCHEN_STAFF_PASSWORD = 'legacy_wrong_env_name';

    const res = await authenticateStaffLogin(store, 'legacy_wrong_env_name', 'ip_misconfig');
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.status, 503);
    }

    delete process.env.KITCHEN_STAFF_PASSWORD;
  });

  it('9. store-state 公開レスポンス最小化: 未認証時は openHistory や lastOrderNumber を一切含めないこと', () => {
    const rawState: StoreState = {
      isManualOpen: true,
      date: '2026-11-10',
      openedAt: 1762736400000,
      soldOutItems: ['m1', 's3'],
      openHistory: [{ date: '2026-11-10', openedAt: 1762736400000, soldOutItems: ['m1'] }],
      currentOrderDate: '2026-11-10',
      lastOrderNumber: 3456,
    };

    // 未認証（一般顧客画面向け）
    const publicResp = sanitizeStoreStateForResponse(rawState, false) as Record<string, unknown>;
    assert.deepEqual(Object.keys(publicResp).sort(), ['date', 'isManualOpen', 'openedAt']);
    assert.equal(publicResp.isManualOpen, true);
    assert.equal(publicResp.date, '2026-11-10');
    assert.equal(publicResp.openedAt, 1762736400000);
    assert.equal('openHistory' in publicResp, false);
    assert.equal('lastOrderNumber' in publicResp, false);
    assert.equal('currentOrderDate' in publicResp, false);
    assert.equal('soldOutItems' in publicResp, false);

    // スタッフ認証済み（管理画面向け: openHistory, soldOutItems は返し、lastOrderNumber は返さない）
    const staffResp = sanitizeStoreStateForResponse(rawState, true) as Record<string, unknown>;
    assert.equal(Array.isArray(staffResp.openHistory), true);
    assert.equal(Array.isArray(staffResp.soldOutItems), true);
    assert.equal('lastOrderNumber' in staffResp, false);
    assert.equal('currentOrderDate' in staffResp, false);
  });
});
