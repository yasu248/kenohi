import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  EXPECTED_STAGING_SUPABASE_ORIGIN,
  emitPreviewRuntimeDiagnostic,
  evaluatePreviewRuntimeDiagnostic,
  executeGuardedPing,
  type DiagnosticLoggers,
} from '../src/lib/previewRuntimeDiagnostic.ts';

const SAMPLE_VALID_SECRET_KEY = ['sb', 'secret', 'unit_test_dummy_key_01234567890'].join('_');
const SAMPLE_EXPECTED_SHA256 = crypto
  .createHash('sha256')
  .update(SAMPLE_VALID_SECRET_KEY, 'utf8')
  .digest('hex');

const BASE_PREVIEW_ENV: Record<string, string> = {
  APP_ENV: 'staging',
  VERCEL_ENV: 'preview',
  VERCEL_GIT_COMMIT_REF: 'phase0-safe-foundation',
  VERCEL_GIT_COMMIT_SHA: '3654dd796668719ddeb2c2d5fc051ba3b007b8fe',
  PREVIEW_SUPABASE_DIAG_ENABLED: 'true',
  SUPABASE_URL: EXPECTED_STAGING_SUPABASE_ORIGIN,
  SUPABASE_SECRET_KEY: SAMPLE_VALID_SECRET_KEY,
  PREVIEW_SUPABASE_KEY_SHA256: SAMPLE_EXPECTED_SHA256,
};

function createLogCapture() {
  const infoLogs: string[] = [];
  const warnLogs: string[] = [];
  const loggers: DiagnosticLoggers = {
    info: (m) => infoLogs.push(m),
    warn: (m) => warnLogs.push(m),
  };
  return { infoLogs, warnLogs, loggers };
}

function assertNoSecretLeak(allLogs: string[], body: Record<string, string>) {
  const combined = [...allLogs, JSON.stringify(body)].join('\n');
  assert.equal(combined.includes(SAMPLE_VALID_SECRET_KEY), false);
  assert.equal(combined.includes(SAMPLE_EXPECTED_SHA256), false);
  assert.equal(combined.includes('Authorization'), false);
}

test('[PreviewRuntimeDiagnostic] Fail-Closed安全診断・停止理由コード出力テスト', async (t) => {
  await t.test('1. 正常なURL・キー・環境条件: infoログ出力・warnログ0件・接続許可 (HTTP 200)', async () => {
    const { infoLogs, warnLogs, loggers } = createLogCapture();
    let storeLoaded = false;

    const httpRes = await executeGuardedPing(
      BASE_PREVIEW_ENV,
      async () => {
        storeLoaded = true;
      },
      loggers
    );

    assert.equal(storeLoaded, true);
    assert.equal(httpRes.status, 200);
    assert.equal(httpRes.body.status, 'ok');
    assert.equal('secretKeyType' in httpRes.body, false);
    assert.equal('reasons' in httpRes.body, false);
    assert.equal(infoLogs.length, 1);
    assert.equal(warnLogs.length, 0);
    assertNoSecretLeak([...infoLogs, ...warnLogs], httpRes.body);
  });

  await t.test('2. APP_ENV 未設定・誤設定: APP_ENV_MISSING / APP_ENV_MISMATCH を warn 出力して停止', async () => {
    const cases: Array<{ env: Record<string, string | undefined>; expectedCode: string }> = [
      { env: { ...BASE_PREVIEW_ENV, APP_ENV: undefined }, expectedCode: 'APP_ENV_MISSING' },
      { env: { ...BASE_PREVIEW_ENV, APP_ENV: 'development' }, expectedCode: 'APP_ENV_MISMATCH' },
      { env: { ...BASE_PREVIEW_ENV, APP_ENV: 'production' }, expectedCode: 'APP_ENV_MISMATCH' },
    ];
    for (const c of cases) {
      const { infoLogs, warnLogs, loggers } = createLogCapture();
      let storeLoaded = false;
      const res = await executeGuardedPing(c.env, async () => {
        storeLoaded = true;
      }, loggers);
      assert.equal(storeLoaded, false);
      assert.equal(res.status, 500);
      assert.equal(infoLogs.length, 0);
      assert.equal(warnLogs.length, 1);
      assert.ok(warnLogs[0].includes('[PreviewRuntimeDiagnostic][HALT]'));
      assert.ok(warnLogs[0].includes(c.expectedCode));
      assertNoSecretLeak(warnLogs, res.body);
    }
  });

  await t.test('3. VERCEL_ENV 未設定・誤設定: VERCEL_ENV_MISSING / VERCEL_ENV_MISMATCH を warn 出力して停止', async () => {
    const cases: Array<{ env: Record<string, string | undefined>; expectedCode: string }> = [
      { env: { ...BASE_PREVIEW_ENV, VERCEL_ENV: undefined }, expectedCode: 'VERCEL_ENV_MISSING' },
      { env: { ...BASE_PREVIEW_ENV, VERCEL_ENV: 'development' }, expectedCode: 'VERCEL_ENV_MISMATCH' },
    ];
    for (const c of cases) {
      const { warnLogs, loggers } = createLogCapture();
      let storeLoaded = false;
      const res = await executeGuardedPing(c.env, async () => {
        storeLoaded = true;
      }, loggers);
      assert.equal(storeLoaded, false);
      assert.equal(res.status, 500);
      assert.equal(warnLogs.length, 1);
      assert.ok(warnLogs[0].includes(c.expectedCode));
      assertNoSecretLeak(warnLogs, res.body);
    }
  });

  await t.test('4. ブランチ情報 未設定・不一致: GIT_REF_MISSING / GIT_REF_MISMATCH を warn 出力して停止', async () => {
    const cases: Array<{ env: Record<string, string | undefined>; expectedCode: string }> = [
      { env: { ...BASE_PREVIEW_ENV, VERCEL_GIT_COMMIT_REF: undefined }, expectedCode: 'GIT_REF_MISSING' },
      { env: { ...BASE_PREVIEW_ENV, VERCEL_GIT_COMMIT_REF: 'main' }, expectedCode: 'GIT_REF_MISMATCH' },
      { env: { ...BASE_PREVIEW_ENV, VERCEL_GIT_COMMIT_REF: 'feature/other' }, expectedCode: 'GIT_REF_MISMATCH' },
    ];
    for (const c of cases) {
      const { warnLogs, loggers } = createLogCapture();
      let storeLoaded = false;
      const res = await executeGuardedPing(c.env, async () => {
        storeLoaded = true;
      }, loggers);
      assert.equal(storeLoaded, false);
      assert.equal(res.status, 500);
      assert.equal(warnLogs.length, 1);
      assert.ok(warnLogs[0].includes(c.expectedCode));
      assertNoSecretLeak(warnLogs, res.body);
    }
  });

  await t.test('5. 診断フラグ 未設定・不一致: DIAGNOSTIC_FLAG_MISSING / DIAGNOSTIC_FLAG_MISMATCH を warn 出力して停止', async () => {
    const cases: Array<{ env: Record<string, string | undefined>; expectedCode: string }> = [
      { env: { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_DIAG_ENABLED: undefined }, expectedCode: 'DIAGNOSTIC_FLAG_MISSING' },
      { env: { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_DIAG_ENABLED: 'false' }, expectedCode: 'DIAGNOSTIC_FLAG_MISMATCH' },
      { env: { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_DIAG_ENABLED: '1' }, expectedCode: 'DIAGNOSTIC_FLAG_MISMATCH' },
    ];
    for (const c of cases) {
      const { warnLogs, loggers } = createLogCapture();
      let storeLoaded = false;
      const res = await executeGuardedPing(c.env, async () => {
        storeLoaded = true;
      }, loggers);
      assert.equal(storeLoaded, false);
      assert.equal(res.status, 500);
      assert.equal(warnLogs.length, 1);
      assert.ok(warnLogs[0].includes(c.expectedCode));
      assertNoSecretLeak(warnLogs, res.body);
    }
  });

  await t.test('6. 複数前提条件の同時不成立 (System Env Vars未公開想定): 全理由コードと checks を1回のログで出力', async () => {
    const { warnLogs, loggers } = createLogCapture();
    let storeLoaded = false;
    const res = await executeGuardedPing(
      {
        ...BASE_PREVIEW_ENV,
        VERCEL_ENV: undefined,
        VERCEL_GIT_COMMIT_REF: undefined,
      },
      async () => {
        storeLoaded = true;
      },
      loggers
    );

    assert.equal(storeLoaded, false);
    assert.equal(res.status, 500);
    assert.equal(warnLogs.length, 1);
    assert.ok(warnLogs[0].includes('VERCEL_ENV_MISSING'));
    assert.ok(warnLogs[0].includes('GIT_REF_MISSING'));
    assert.ok(warnLogs[0].includes('"appEnvOk":true'));
    assert.ok(warnLogs[0].includes('"diagFlagOk":true'));
    assertNoSecretLeak(warnLogs, res.body);
  });

  await t.test('7. 照合基準 未設定・不正形式: EXPECTED_HASH_MISSING / EXPECTED_HASH_INVALID を info+warn 出力して停止', async () => {
    const cases: Array<{ env: Record<string, string | undefined>; expectedCode: string }> = [
      { env: { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_KEY_SHA256: undefined }, expectedCode: 'EXPECTED_HASH_MISSING' },
      { env: { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_KEY_SHA256: '' }, expectedCode: 'EXPECTED_HASH_MISSING' },
      { env: { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_KEY_SHA256: 'short_invalid_hex' }, expectedCode: 'EXPECTED_HASH_INVALID' },
      { env: { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_KEY_SHA256: 'z'.repeat(64) }, expectedCode: 'EXPECTED_HASH_INVALID' },
    ];
    for (const c of cases) {
      const { infoLogs, warnLogs, loggers } = createLogCapture();
      let storeLoaded = false;
      const res = await executeGuardedPing(c.env, async () => {
        storeLoaded = true;
      }, loggers);
      assert.equal(infoLogs.length, 1);
      assert.equal(warnLogs.length, 1);
      assert.ok(warnLogs[0].includes(c.expectedCode));
      assert.equal(storeLoaded, false);
      assert.equal(res.status, 500);
      assertNoSecretLeak([...infoLogs, ...warnLogs], res.body);
    }
  });

  await t.test('8. キー異常 (空白・改行 / 引用符 / 異なるキー / Publishable / 空キー): 理由コードを info+warn 出力して停止', async () => {
    const keyCases = [
      { key: ` ${SAMPLE_VALID_SECRET_KEY}\n`, expectedCodes: ['SUPABASE_KEY_WHITESPACE', 'SUPABASE_KEY_MISMATCH'] },
      { key: `"${SAMPLE_VALID_SECRET_KEY}"`, expectedCodes: ['SUPABASE_KEY_QUOTES', 'SUPABASE_KEY_MISMATCH'] },
      { key: ['sb', 'secret', 'different_project_key_987654321'].join('_'), expectedCodes: ['SUPABASE_KEY_MISMATCH'] },
      { key: 'sb_publishable_wrong_key_for_server_12345', expectedCodes: ['SUPABASE_KEY_TYPE_INVALID', 'SUPABASE_KEY_MISMATCH'] },
      { key: '', expectedCodes: ['SUPABASE_KEY_TYPE_INVALID', 'SUPABASE_KEY_MISMATCH'] },
    ];

    for (const kc of keyCases) {
      const env = { ...BASE_PREVIEW_ENV, SUPABASE_SECRET_KEY: kc.key };
      const { infoLogs, warnLogs, loggers } = createLogCapture();
      let storeLoaded = false;
      const httpRes = await executeGuardedPing(env, async () => {
        storeLoaded = true;
      }, loggers);
      assert.equal(infoLogs.length, 1);
      assert.equal(warnLogs.length, 1);
      for (const code of kc.expectedCodes) {
        assert.ok(warnLogs[0].includes(code), `expected ${code} in ${warnLogs[0]}`);
      }
      assert.equal(storeLoaded, false);
      assert.equal(httpRes.status, 500);
      assertNoSecretLeak([...infoLogs, ...warnLogs], httpRes.body);
    }
  });

  await t.test('9. URL異常 (HTTP / ユーザー情報付き / クエリ付き / フラグメント付き / 別ホスト / 本番URL): SUPABASE_ORIGIN_MISMATCH を出力して停止', async () => {
    const invalidUrls = [
      'http://zqcniawwhtnfcxkkwauu.supabase.co',
      'https://user:pass@zqcniawwhtnfcxkkwauu.supabase.co',
      'https://zqcniawwhtnfcxkkwauu.supabase.co?foo=bar',
      'https://zqcniawwhtnfcxkkwauu.supabase.co#frag',
      'https://zqcniawwhtnfcxkkwauu.supabase.co/other',
      'https://liyjwvgtavfjiohwryox.supabase.co',
      'https://evil.example.com',
      '',
    ];

    for (const url of invalidUrls) {
      const env = { ...BASE_PREVIEW_ENV, SUPABASE_URL: url };
      const { infoLogs, warnLogs, loggers } = createLogCapture();
      let storeLoaded = false;
      const httpRes = await executeGuardedPing(env, async () => {
        storeLoaded = true;
      }, loggers);
      assert.equal(infoLogs.length, 1);
      assert.equal(warnLogs.length, 1);
      assert.ok(warnLogs[0].includes('SUPABASE_ORIGIN_MISMATCH'));
      assert.equal(storeLoaded, false);
      assert.equal(httpRes.status, 500);
      assertNoSecretLeak([...infoLogs, ...warnLogs], httpRes.body);
    }

    const restV1Res = evaluatePreviewRuntimeDiagnostic({
      ...BASE_PREVIEW_ENV,
      SUPABASE_URL: `${EXPECTED_STAGING_SUPABASE_ORIGIN}/rest/v1`,
    });
    assert.equal(restV1Res.logPayload?.supabaseOriginMatchesStaging, true);
    assert.equal(restV1Res.shouldHaltBeforeSupabaseConnect, false);
  });

  await t.test('10. Production正常経路: 診断無効・info/warnログ0件・store正常ロード・HTTP 200', async () => {
    const prodEnv: Record<string, string | undefined> = {
      APP_ENV: 'production',
      VERCEL_ENV: 'production',
      VERCEL_GIT_COMMIT_REF: 'main',
      SUPABASE_URL: 'https://liyjwvgtavfjiohwryox.supabase.co',
      SUPABASE_SECRET_KEY: ['sb', 'secret', 'prod_dummy'].join('_'),
    };

    const { infoLogs, warnLogs, loggers } = createLogCapture();
    let storeLoaded = false;
    const evalRes = emitPreviewRuntimeDiagnostic(prodEnv, loggers);
    assert.equal(evalRes.enabled, false);
    assert.equal(evalRes.shouldHaltBeforeSupabaseConnect, false);
    assert.equal(infoLogs.length, 0);
    assert.equal(warnLogs.length, 0);

    const httpRes = await executeGuardedPing(
      prodEnv,
      async () => {
        storeLoaded = true;
      },
      loggers
    );
    assert.equal(storeLoaded, true);
    assert.equal(httpRes.status, 200);
    assert.equal(infoLogs.length, 0);
    assert.equal(warnLogs.length, 0);
  });
});
