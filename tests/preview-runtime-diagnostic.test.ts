import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  EXPECTED_STAGING_SUPABASE_ORIGIN,
  emitPreviewRuntimeDiagnostic,
  evaluatePreviewRuntimeDiagnostic,
  executeGuardedPing,
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

test('[PreviewRuntimeDiagnostic] Fail-Closed安全診断・全シナリオ単体テスト', async (t) => {
  await t.test('1. 正常なURL・キー・環境条件: 診断ログ出力後に接続許可 (HTTP 200・レスポンス診断非露出)', async () => {
    const logs: string[] = [];
    let storeLoaded = false;

    const httpRes = await executeGuardedPing(
      BASE_PREVIEW_ENV,
      async () => {
        storeLoaded = true;
      },
      (m) => logs.push(m)
    );

    assert.equal(storeLoaded, true);
    assert.equal(httpRes.status, 200);
    assert.equal(httpRes.body.status, 'ok');
    assert.equal('secretKeyType' in httpRes.body, false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].includes(SAMPLE_VALID_SECRET_KEY), false);
    assert.equal(logs[0].includes(SAMPLE_EXPECTED_SHA256), false);
    assert.equal(logs[0].includes('Authorization'), false);
  });

  await t.test('2. APP_ENV 未設定・誤設定 (Previewコンテキスト): Fail-Closed停止・store未ロード', async () => {
    const cases: Array<Record<string, string | undefined>> = [
      { ...BASE_PREVIEW_ENV, APP_ENV: undefined },
      { ...BASE_PREVIEW_ENV, APP_ENV: 'development' },
      { ...BASE_PREVIEW_ENV, APP_ENV: 'production' },
    ];
    for (const env of cases) {
      let storeLoaded = false;
      const res = await executeGuardedPing(env, async () => {
        storeLoaded = true;
      });
      assert.equal(storeLoaded, false);
      assert.equal(res.status, 500);
    }
  });

  await t.test('3. VERCEL_ENV 未設定・誤設定 (診断フラグ有効または対象ブランチ): Fail-Closed停止・store未ロード', async () => {
    const cases: Array<Record<string, string | undefined>> = [
      { ...BASE_PREVIEW_ENV, VERCEL_ENV: undefined },
      { ...BASE_PREVIEW_ENV, VERCEL_ENV: 'development' },
    ];
    for (const env of cases) {
      let storeLoaded = false;
      const res = await executeGuardedPing(env, async () => {
        storeLoaded = true;
      });
      assert.equal(storeLoaded, false);
      assert.equal(res.status, 500);
    }
  });

  await t.test('4. ブランチ情報 未設定・不一致 (Previewコンテキスト): Fail-Closed停止・store未ロード', async () => {
    const cases: Array<Record<string, string | undefined>> = [
      { ...BASE_PREVIEW_ENV, VERCEL_GIT_COMMIT_REF: undefined },
      { ...BASE_PREVIEW_ENV, VERCEL_GIT_COMMIT_REF: 'main' },
      { ...BASE_PREVIEW_ENV, VERCEL_GIT_COMMIT_REF: 'feature/other' },
    ];
    for (const env of cases) {
      let storeLoaded = false;
      const res = await executeGuardedPing(env, async () => {
        storeLoaded = true;
      });
      assert.equal(storeLoaded, false);
      assert.equal(res.status, 500);
    }
  });

  await t.test('5. 診断フラグ 未設定・不一致 (対象Previewブランチ): Fail-Closed停止・store未ロード', async () => {
    const cases: Array<Record<string, string | undefined>> = [
      { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_DIAG_ENABLED: undefined },
      { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_DIAG_ENABLED: 'false' },
      { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_DIAG_ENABLED: '1' },
    ];
    for (const env of cases) {
      let storeLoaded = false;
      const res = await executeGuardedPing(env, async () => {
        storeLoaded = true;
      });
      assert.equal(storeLoaded, false);
      assert.equal(res.status, 500);
    }
  });

  await t.test('6. 照合基準 (PREVIEW_SUPABASE_KEY_SHA256) 未設定・不正形式: ログ出力後にFail-Closed停止・store未ロード', async () => {
    const cases: Array<Record<string, string | undefined>> = [
      { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_KEY_SHA256: undefined },
      { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_KEY_SHA256: '' },
      { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_KEY_SHA256: 'short_invalid_hex' },
      { ...BASE_PREVIEW_ENV, PREVIEW_SUPABASE_KEY_SHA256: 'z'.repeat(64) },
    ];
    for (const env of cases) {
      const logs: string[] = [];
      let storeLoaded = false;
      const res = await executeGuardedPing(
        env,
        async () => {
          storeLoaded = true;
        },
        (m) => logs.push(m)
      );
      assert.equal(logs.length, 1);
      assert.equal(storeLoaded, false);
      assert.equal(res.status, 500);
    }
  });

  await t.test('7. キー異常 (空白・改行 / 引用符 / 異なるキー / Publishable / 空キー): ログ出力後にFail-Closed停止・store未ロード', async () => {
    const keyCases = [
      { key: ` ${SAMPLE_VALID_SECRET_KEY}\n`, expectedWs: true, expectedQuotes: false, expectedTrimMatch: true, expectedRawMatch: false },
      { key: `"${SAMPLE_VALID_SECRET_KEY}"`, expectedWs: false, expectedQuotes: true, expectedTrimMatch: false, expectedRawMatch: false },
      { key: ['sb', 'secret', 'different_project_key_987654321'].join('_'), expectedWs: false, expectedQuotes: false, expectedTrimMatch: false, expectedRawMatch: false },
      { key: 'sb_publishable_wrong_key_for_server_12345', expectedWs: false, expectedQuotes: false, expectedTrimMatch: false, expectedRawMatch: false },
      { key: '', expectedWs: false, expectedQuotes: false, expectedTrimMatch: false, expectedRawMatch: false },
    ];

    for (const kc of keyCases) {
      const env = { ...BASE_PREVIEW_ENV, SUPABASE_SECRET_KEY: kc.key };
      const evalRes = evaluatePreviewRuntimeDiagnostic(env);
      assert.equal(evalRes.enabled, true);
      assert.equal(evalRes.shouldHaltBeforeSupabaseConnect, true);
      assert.equal(evalRes.logPayload?.hasLeadingOrTrailingWhitespace, kc.expectedWs);
      assert.equal(evalRes.logPayload?.hasSurroundingQuotes, kc.expectedQuotes);
      assert.equal(evalRes.logPayload?.matchesExpectedLocalKey, kc.expectedTrimMatch);
      assert.equal(evalRes.logPayload?.passedValueMatchesExpectedLocalKey, kc.expectedRawMatch);

      let storeLoaded = false;
      const logs: string[] = [];
      const httpRes = await executeGuardedPing(
        env,
        async () => {
          storeLoaded = true;
        },
        (m) => logs.push(m)
      );
      assert.equal(logs.length, 1);
      assert.equal(storeLoaded, false);
      assert.equal(httpRes.status, 500);
    }
  });

  await t.test('8. URL異常 (HTTP / ユーザー情報付き / クエリ付き / フラグメント付き / 別ホスト / 本番URL): ログ出力後にFail-Closed停止・store未ロード', async () => {
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
      const evalRes = evaluatePreviewRuntimeDiagnostic(env);
      assert.equal(evalRes.enabled, true);
      assert.equal(evalRes.logPayload?.supabaseOriginMatchesStaging, false, `must reject: ${url}`);
      assert.equal(evalRes.shouldHaltBeforeSupabaseConnect, true);

      let storeLoaded = false;
      const httpRes = await executeGuardedPing(env, async () => {
        storeLoaded = true;
      });
      assert.equal(storeLoaded, false);
      assert.equal(httpRes.status, 500);
    }

    // store.ts の normalizeSupabaseUrl と整合する末尾 /rest/v1 のみ許容
    const restV1Res = evaluatePreviewRuntimeDiagnostic({
      ...BASE_PREVIEW_ENV,
      SUPABASE_URL: `${EXPECTED_STAGING_SUPABASE_ORIGIN}/rest/v1`,
    });
    assert.equal(restV1Res.logPayload?.supabaseOriginMatchesStaging, true);
    assert.equal(restV1Res.shouldHaltBeforeSupabaseConnect, false);
  });

  await t.test('9. Production環境: 既存動作に一切影響しない (診断無効・ログ0件・store正常ロード・HTTP 200)', async () => {
    const prodEnv: Record<string, string | undefined> = {
      APP_ENV: 'production',
      VERCEL_ENV: 'production',
      VERCEL_GIT_COMMIT_REF: 'main',
      SUPABASE_URL: 'https://liyjwvgtavfjiohwryox.supabase.co',
      SUPABASE_SECRET_KEY: ['sb', 'secret', 'prod_dummy'].join('_'),
    };

    const logs: string[] = [];
    let storeLoaded = false;
    const evalRes = emitPreviewRuntimeDiagnostic(prodEnv, (m) => logs.push(m));
    assert.equal(evalRes.enabled, false);
    assert.equal(evalRes.shouldHaltBeforeSupabaseConnect, false);
    assert.equal(logs.length, 0);

    const httpRes = await executeGuardedPing(
      prodEnv,
      async () => {
        storeLoaded = true;
      },
      (m) => logs.push(m)
    );
    assert.equal(storeLoaded, true);
    assert.equal(httpRes.status, 200);
    assert.equal(logs.length, 0);
  });
});
