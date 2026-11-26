import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  EXPECTED_STAGING_SUPABASE_ORIGIN,
  PREVIEW_DIAG_REASONS_HEADER,
  canEmitDiagnosticResponseHeader,
  emitPreviewRuntimeDiagnostic,
  evaluatePreviewRuntimeDiagnostic,
  executeGuardedPing,
  type DiagnosticLoggers,
} from '../src/lib/previewRuntimeDiagnostic.ts';
import {
  GET as pingRouteGET,
  dynamic as pingRouteDynamic,
  runtime as pingRouteRuntime,
} from '../src/app/api/ping/route.ts';

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
  const errorLogs: string[] = [];
  const loggers: DiagnosticLoggers = {
    info: (m) => infoLogs.push(m),
    warn: (m) => warnLogs.push(m),
    error: (m) => errorLogs.push(m),
  };
  return { infoLogs, warnLogs, errorLogs, loggers };
}

function assertNoSecretLeak(
  allLogs: string[],
  body: Record<string, string>,
  headers: Record<string, string> = {}
) {
  const combined = [...allLogs, JSON.stringify(body), JSON.stringify(headers)].join('\n');
  assert.equal(combined.includes(SAMPLE_VALID_SECRET_KEY), false);
  assert.equal(combined.includes(SAMPLE_EXPECTED_SHA256), false);
  assert.equal(combined.includes('Authorization'), false);

  const headerSerialized = JSON.stringify(headers);
  assert.equal(headerSerialized.includes(EXPECTED_STAGING_SUPABASE_ORIGIN), false);
  assert.equal(headerSerialized.includes('zqcniawwhtnfcxkkwauu'), false);
  assert.equal(headerSerialized.includes('liyjwvgtavfjiohwryox'), false);
  assert.equal(headerSerialized.includes('secretKeyRawLength'), false);
}

test('[PreviewRuntimeDiagnostic] Fail-Closed安全診断・停止理由コード・限定ヘッダ出力テスト', async (t) => {
  await t.test('1. 正常なURL・キー・環境条件: infoログ出力・warn/errorログ0件・no-store付与・診断ヘッダ非出力・接続許可 (HTTP 200)', async () => {
    const { infoLogs, warnLogs, errorLogs, loggers } = createLogCapture();
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
    assert.equal(httpRes.headers['Cache-Control'], 'no-store');
    assert.equal(httpRes.headers[PREVIEW_DIAG_REASONS_HEADER], undefined);
    assert.equal(infoLogs.length, 1);
    assert.equal(warnLogs.length, 0);
    assert.equal(errorLogs.length, 0);
    assertNoSecretLeak([...infoLogs, ...warnLogs, ...errorLogs], httpRes.body, httpRes.headers);
  });

  await t.test('2. APP_ENV 未設定・誤設定: warn+error出力・no-store・対象Preview確認済みのため限定ヘッダへ固定コード出力して停止', async () => {
    const cases: Array<{ env: Record<string, string | undefined>; expectedCode: string }> = [
      { env: { ...BASE_PREVIEW_ENV, APP_ENV: undefined }, expectedCode: 'APP_ENV_MISSING' },
      { env: { ...BASE_PREVIEW_ENV, APP_ENV: 'development' }, expectedCode: 'APP_ENV_MISMATCH' },
      { env: { ...BASE_PREVIEW_ENV, APP_ENV: 'production' }, expectedCode: 'APP_ENV_MISMATCH' },
    ];
    for (const c of cases) {
      const { infoLogs, warnLogs, errorLogs, loggers } = createLogCapture();
      let storeLoaded = false;
      const res = await executeGuardedPing(c.env, async () => {
        storeLoaded = true;
      }, loggers);
      assert.equal(storeLoaded, false);
      assert.equal(res.status, 500);
      assert.equal(infoLogs.length, 0);
      assert.equal(warnLogs.length, 1);
      assert.equal(errorLogs.length, 1);
      assert.ok(warnLogs[0].includes('[PreviewRuntimeDiagnostic][HALT]'));
      assert.ok(errorLogs[0].includes('[PreviewRuntimeDiagnostic][HALT]'));
      assert.ok(errorLogs[0].includes(c.expectedCode));
      assert.equal(res.headers['Cache-Control'], 'no-store');
      assert.equal(res.headers[PREVIEW_DIAG_REASONS_HEADER], c.expectedCode);
      assertNoSecretLeak([...warnLogs, ...errorLogs], res.body, res.headers);
    }
  });

  await t.test('3. VERCEL_ENV 未設定・誤設定: warn+error出力・no-store・環境識別不可のため診断ヘッダ非出力で停止', async () => {
    const cases: Array<{ env: Record<string, string | undefined>; expectedCode: string }> = [
      { env: { ...BASE_PREVIEW_ENV, VERCEL_ENV: undefined }, expectedCode: 'VERCEL_ENV_MISSING' },
      { env: { ...BASE_PREVIEW_ENV, VERCEL_ENV: 'development' }, expectedCode: 'VERCEL_ENV_MISMATCH' },
    ];
    for (const c of cases) {
      const { warnLogs, errorLogs, loggers } = createLogCapture();
      let storeLoaded = false;
      const res = await executeGuardedPing(c.env, async () => {
        storeLoaded = true;
      }, loggers);
      assert.equal(storeLoaded, false);
      assert.equal(res.status, 500);
      assert.equal(warnLogs.length, 1);
      assert.equal(errorLogs.length, 1);
      assert.ok(errorLogs[0].includes(c.expectedCode));
      assert.equal(res.headers['Cache-Control'], 'no-store');
      assert.equal(res.headers[PREVIEW_DIAG_REASONS_HEADER], undefined);
      assertNoSecretLeak([...warnLogs, ...errorLogs], res.body, res.headers);
    }
  });

  await t.test('4. ブランチ情報 未設定・不一致: warn+error出力・no-store・対象外ブランチのため診断ヘッダ非出力で停止', async () => {
    const cases: Array<{ env: Record<string, string | undefined>; expectedCode: string }> = [
      { env: { ...BASE_PREVIEW_ENV, VERCEL_GIT_COMMIT_REF: undefined }, expectedCode: 'GIT_REF_MISSING' },
      { env: { ...BASE_PREVIEW_ENV, VERCEL_GIT_COMMIT_REF: 'main' }, expectedCode: 'GIT_REF_MISMATCH' },
      { env: { ...BASE_PREVIEW_ENV, VERCEL_GIT_COMMIT_REF: 'feature/other' }, expectedCode: 'GIT_REF_MISMATCH' },
    ];
    for (const c of cases) {
      const { warnLogs, errorLogs, loggers } = createLogCapture();
      let storeLoaded = false;
      const res = await executeGuardedPing(c.env, async () => {
        storeLoaded = true;
      }, loggers);
      assert.equal(storeLoaded, false);
      assert.equal(res.status, 500);
      assert.equal(warnLogs.length, 1);
      assert.equal(errorLogs.length, 1);
      assert.ok(errorLogs[0].includes(c.expectedCode));
      assert.equal(res.headers['Cache-Control'], 'no-store');
      assert.equal(res.headers[PREVIEW_DIAG_REASONS_HEADER], undefined);
      assertNoSecretLeak([...warnLogs, ...errorLogs], res.body, res.headers);
    }
  });

  await t.test('5. 診断フラグ 未設定・不一致: warn+error出力・no-store・診断フラグ不成立のため診断ヘッダ非出力で停止', async () => {
    const cases: Array<{ env: Record<string, string | undefined>; expectedCode: string }> = [
      { env: { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_DIAG_ENABLED: undefined }, expectedCode: 'DIAGNOSTIC_FLAG_MISSING' },
      { env: { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_DIAG_ENABLED: 'false' }, expectedCode: 'DIAGNOSTIC_FLAG_MISMATCH' },
      { env: { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_DIAG_ENABLED: '1' }, expectedCode: 'DIAGNOSTIC_FLAG_MISMATCH' },
    ];
    for (const c of cases) {
      const { warnLogs, errorLogs, loggers } = createLogCapture();
      let storeLoaded = false;
      const res = await executeGuardedPing(c.env, async () => {
        storeLoaded = true;
      }, loggers);
      assert.equal(storeLoaded, false);
      assert.equal(res.status, 500);
      assert.equal(warnLogs.length, 1);
      assert.equal(errorLogs.length, 1);
      assert.ok(errorLogs[0].includes(c.expectedCode));
      assert.equal(res.headers['Cache-Control'], 'no-store');
      assert.equal(res.headers[PREVIEW_DIAG_REASONS_HEADER], undefined);
      assertNoSecretLeak([...warnLogs, ...errorLogs], res.body, res.headers);
    }
  });

  await t.test('6. 複数前提条件の同時不成立: warn+errorへ全理由コード出力・識別欠落のため診断ヘッダ非出力で停止', async () => {
    const { warnLogs, errorLogs, loggers } = createLogCapture();
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
    assert.equal(errorLogs.length, 1);
    assert.ok(errorLogs[0].includes('VERCEL_ENV_MISSING'));
    assert.ok(errorLogs[0].includes('GIT_REF_MISSING'));
    assert.ok(errorLogs[0].includes('"appEnvOk":true'));
    assert.ok(errorLogs[0].includes('"diagFlagOk":true'));
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers[PREVIEW_DIAG_REASONS_HEADER], undefined);
    assertNoSecretLeak([...warnLogs, ...errorLogs], res.body, res.headers);
  });

  await t.test('7. 照合基準 未設定・不正形式: info+warn+error出力・限定ヘッダへ固定コード出力して停止', async () => {
    const cases: Array<{ env: Record<string, string | undefined>; expectedCode: string }> = [
      { env: { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_KEY_SHA256: undefined }, expectedCode: 'EXPECTED_HASH_MISSING' },
      { env: { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_KEY_SHA256: '' }, expectedCode: 'EXPECTED_HASH_MISSING' },
      { env: { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_KEY_SHA256: 'short_invalid_hex' }, expectedCode: 'EXPECTED_HASH_INVALID' },
      { env: { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_KEY_SHA256: 'z'.repeat(64) }, expectedCode: 'EXPECTED_HASH_INVALID' },
    ];
    for (const c of cases) {
      const { infoLogs, warnLogs, errorLogs, loggers } = createLogCapture();
      let storeLoaded = false;
      const res = await executeGuardedPing(c.env, async () => {
        storeLoaded = true;
      }, loggers);
      assert.equal(infoLogs.length, 1);
      assert.equal(warnLogs.length, 1);
      assert.equal(errorLogs.length, 1);
      assert.ok(errorLogs[0].includes(c.expectedCode));
      assert.equal(res.headers['Cache-Control'], 'no-store');
      assert.equal(res.headers[PREVIEW_DIAG_REASONS_HEADER], c.expectedCode);
      assert.equal(storeLoaded, false);
      assert.equal(res.status, 500);
      assertNoSecretLeak([...infoLogs, ...warnLogs, ...errorLogs], res.body, res.headers);
    }
  });

  await t.test('8. キー異常 (空白・改行 / 引用符 / 異なるキー / Publishable / 空キー): 固定コードのみをヘッダ・ログ出力して停止', async () => {
    const keyCases = [
      { key: ` ${SAMPLE_VALID_SECRET_KEY}\n`, expectedCodes: ['SUPABASE_KEY_WHITESPACE', 'SUPABASE_KEY_MISMATCH'] },
      { key: `"${SAMPLE_VALID_SECRET_KEY}"`, expectedCodes: ['SUPABASE_KEY_QUOTES', 'SUPABASE_KEY_MISMATCH'] },
      { key: ['sb', 'secret', 'different_project_key_987654321'].join('_'), expectedCodes: ['SUPABASE_KEY_MISMATCH'] },
      { key: 'sb_publishable_wrong_key_for_server_12345', expectedCodes: ['SUPABASE_KEY_TYPE_INVALID', 'SUPABASE_KEY_MISMATCH'] },
      { key: '', expectedCodes: ['SUPABASE_KEY_TYPE_INVALID', 'SUPABASE_KEY_MISMATCH'] },
    ];

    for (const kc of keyCases) {
      const env = { ...BASE_PREVIEW_ENV, SUPABASE_SECRET_KEY: kc.key };
      const { infoLogs, warnLogs, errorLogs, loggers } = createLogCapture();
      let storeLoaded = false;
      const httpRes = await executeGuardedPing(env, async () => {
        storeLoaded = true;
      }, loggers);
      assert.equal(infoLogs.length, 1);
      assert.equal(warnLogs.length, 1);
      assert.equal(errorLogs.length, 1);
      for (const code of kc.expectedCodes) {
        assert.ok(errorLogs[0].includes(code), `expected ${code} in ${errorLogs[0]}`);
      }
      assert.equal(httpRes.headers['Cache-Control'], 'no-store');
      assert.equal(httpRes.headers[PREVIEW_DIAG_REASONS_HEADER], kc.expectedCodes.join(','));
      assert.equal(storeLoaded, false);
      assert.equal(httpRes.status, 500);
      assertNoSecretLeak([...infoLogs, ...warnLogs, ...errorLogs], httpRes.body, httpRes.headers);
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
      const { infoLogs, warnLogs, errorLogs, loggers } = createLogCapture();
      let storeLoaded = false;
      const httpRes = await executeGuardedPing(env, async () => {
        storeLoaded = true;
      }, loggers);
      assert.equal(infoLogs.length, 1);
      assert.equal(warnLogs.length, 1);
      assert.equal(errorLogs.length, 1);
      assert.ok(errorLogs[0].includes('SUPABASE_ORIGIN_MISMATCH'));
      assert.equal(httpRes.headers['Cache-Control'], 'no-store');
      assert.equal(httpRes.headers[PREVIEW_DIAG_REASONS_HEADER], 'SUPABASE_ORIGIN_MISMATCH');
      assert.equal(storeLoaded, false);
      assert.equal(httpRes.status, 500);
      assertNoSecretLeak([...infoLogs, ...warnLogs, ...errorLogs], httpRes.body, httpRes.headers);
    }

    const restV1Res = evaluatePreviewRuntimeDiagnostic({
      ...BASE_PREVIEW_ENV,
      SUPABASE_URL: `${EXPECTED_STAGING_SUPABASE_ORIGIN}/rest/v1`,
    });
    assert.equal(restV1Res.logPayload?.supabaseOriginMatchesStaging, true);
    assert.equal(restV1Res.shouldHaltBeforeSupabaseConnect, false);
  });

  await t.test('10. Production正常経路: 診断無効・ログ0件・診断ヘッダ非出力・store正常ロード・HTTP 200', async () => {
    const prodEnv: Record<string, string | undefined> = {
      APP_ENV: 'production',
      VERCEL_ENV: 'production',
      VERCEL_GIT_COMMIT_REF: 'main',
      PREVIEW_SUPABASE_DIAG_ENABLED: 'true',
      SUPABASE_URL: 'https://liyjwvgtavfjiohwryox.supabase.co',
      SUPABASE_SECRET_KEY: ['sb', 'secret', 'prod_dummy'].join('_'),
    };

    assert.equal(canEmitDiagnosticResponseHeader(prodEnv), false);

    const { infoLogs, warnLogs, errorLogs, loggers } = createLogCapture();
    let storeLoaded = false;
    const evalRes = emitPreviewRuntimeDiagnostic(prodEnv, loggers);
    assert.equal(evalRes.enabled, false);
    assert.equal(evalRes.shouldHaltBeforeSupabaseConnect, false);
    assert.equal(infoLogs.length, 0);
    assert.equal(warnLogs.length, 0);
    assert.equal(errorLogs.length, 0);

    const httpRes = await executeGuardedPing(
      prodEnv,
      async () => {
        storeLoaded = true;
      },
      loggers
    );
    assert.equal(storeLoaded, true);
    assert.equal(httpRes.status, 200);
    assert.equal(httpRes.headers[PREVIEW_DIAG_REASONS_HEADER], undefined);
    assert.equal(httpRes.headers['Cache-Control'], undefined);
    assert.equal(infoLogs.length, 0);
    assert.equal(warnLogs.length, 0);
    assert.equal(errorLogs.length, 0);
  });

  await t.test('11. 実コード src/app/api/ping/route.ts 直接オフライン実行: Route Segment Config・ヘッダ・console.error・Fail-Closed検証', async () => {
    assert.equal(pingRouteDynamic, 'force-dynamic');
    assert.equal(pingRouteRuntime, 'nodejs');

    const keysToManage = [
      'APP_ENV',
      'VERCEL_ENV',
      'VERCEL_GIT_COMMIT_REF',
      'VERCEL_GIT_COMMIT_SHA',
      'PREVIEW_SUPABASE_DIAG_ENABLED',
      'SUPABASE_URL',
      'SUPABASE_SECRET_KEY',
      'PREVIEW_SUPABASE_KEY_SHA256',
    ];

    const savedEnv: Record<string, string | undefined> = {};
    for (const k of keysToManage) {
      savedEnv[k] = process.env[k];
    }

    const origWarn = console.warn;
    const origError = console.error;
    const origInfo = console.info;

    const runWithEnv = async (override: Record<string, string | undefined>) => {
      const capturedWarn: string[] = [];
      const capturedError: string[] = [];
      const capturedInfo: string[] = [];
      console.warn = (...args: unknown[]) => capturedWarn.push(args.map(String).join(' '));
      console.error = (...args: unknown[]) => capturedError.push(args.map(String).join(' '));
      console.info = (...args: unknown[]) => capturedInfo.push(args.map(String).join(' '));

      for (const k of keysToManage) {
        if (override[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = override[k];
        }
      }

      try {
        const res = await pingRouteGET();
        const body = (await res.json()) as Record<string, string>;
        return { res, body, capturedWarn, capturedError, capturedInfo };
      } finally {
        console.warn = origWarn;
        console.error = origError;
        console.info = origInfo;
      }
    };

    try {
      // Case A: 対象Preview確認済みで APP_ENV 欠落 → HTTP 500 + no-store + X-Preview-Diag-Reasons: APP_ENV_MISSING
      const caseA = await runWithEnv({ ...BASE_PREVIEW_ENV, APP_ENV: undefined });
      assert.equal(caseA.res.status, 500);
      assert.equal(caseA.body.message, 'Preview diagnostic precondition halted Supabase connection');
      assert.equal(caseA.res.headers.get('cache-control'), 'no-store');
      assert.equal(caseA.res.headers.get(PREVIEW_DIAG_REASONS_HEADER), 'APP_ENV_MISSING');
      assert.equal(caseA.capturedError.length, 1);
      assert.ok(caseA.capturedError[0].includes('APP_ENV_MISSING'));

      // Case B: VERCEL_ENV 欠落 → HTTP 500 + no-store + 診断ヘッダ非出力
      const caseB = await runWithEnv({ ...BASE_PREVIEW_ENV, VERCEL_ENV: undefined });
      assert.equal(caseB.res.status, 500);
      assert.equal(caseB.res.headers.get('cache-control'), 'no-store');
      assert.equal(caseB.res.headers.get(PREVIEW_DIAG_REASONS_HEADER), null);
      assert.equal(caseB.capturedError.length, 1);
      assert.ok(caseB.capturedError[0].includes('VERCEL_ENV_MISSING'));

      // Case C: 対象Preview確認済みで空白混入キー → HTTP 500 + no-store + 固定理由コードのみ・秘密情報非漏洩
      const caseC = await runWithEnv({
        ...BASE_PREVIEW_ENV,
        SUPABASE_SECRET_KEY: ` ${SAMPLE_VALID_SECRET_KEY}\n`,
      });
      assert.equal(caseC.res.status, 500);
      assert.equal(caseC.res.headers.get('cache-control'), 'no-store');
      assert.equal(
        caseC.res.headers.get(PREVIEW_DIAG_REASONS_HEADER),
        'SUPABASE_KEY_WHITESPACE,SUPABASE_KEY_MISMATCH'
      );
      assert.equal(caseC.capturedError.length, 1);
      const caseCHeaders: Record<string, string> = {};
      caseC.res.headers.forEach((v, k) => {
        caseCHeaders[k] = v;
      });
      assertNoSecretLeak(
        [...caseC.capturedInfo, ...caseC.capturedWarn, ...caseC.capturedError],
        caseC.body,
        caseCHeaders
      );
    } finally {
      for (const k of keysToManage) {
        if (savedEnv[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = savedEnv[k];
        }
      }
    }
  });
});
