import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPECTED_PREVIEW_BRANCH,
  EXPECTED_STAGING_SUPABASE_ORIGIN,
  assertStagingEnvironmentSafe,
  isStrictStagingSupabaseUrl,
  normalizeSupabaseUrlForGuard,
  validateEnvironmentSafety,
} from '../src/lib/envGuard.ts';
import { createStoreSupabaseClient, normalizeSupabaseUrl } from '../src/lib/store.ts';
import {
  PING_ERROR_CODE,
  PING_ERROR_MESSAGE,
  executeSafePing,
} from '../src/lib/pingHealthcheck.ts';

describe('[Phase 0-G / 恒久EnvGuard] 環境変数ガードおよびステージング・Preview安全性テスト', () => {
  const dummySecretKey = ['sb', 'secret', 'staging_valid_key_sample_0123456789'].join('_');
  const dummyStripeTestKey = ['sk', 'test', '51MockStripeKey123'].join('_');
  const dummyStripeLiveKey = ['sk', 'live', '51SecretLiveKey123'].join('_');

  const validStagingEnv: Record<string, string | undefined> = {
    APP_ENV: 'staging',
    VERCEL: '1',
    VERCEL_ENV: 'preview',
    VERCEL_GIT_COMMIT_REF: EXPECTED_PREVIEW_BRANCH,
    SUPABASE_URL: EXPECTED_STAGING_SUPABASE_ORIGIN,
    SUPABASE_SECRET_KEY: dummySecretKey,
    STRIPE_SECRET_KEY: dummyStripeTestKey,
    STAFF_PASSWORD: 'staff_secure_random_pw_9876543210',
    ADMIN_PASSWORD: 'admin_secure_random_pw_0123456789',
    AUTH_SESSION_SECRET: 'auth_secret_minimum_32_bytes_length_ok_random_key_123',
    PRODUCTION_SUPABASE_PROJECT_REF: 'liyjwvgtavfjiohwryox',
  };

  it('1. 正常なステージング/Preview環境: 診断用一時環境変数2項目が未設定でも safe: true を返すこと', () => {
    assert.equal('PREVIEW_SUPABASE_DIAG_ENABLED' in validStagingEnv, false);
    assert.equal('PREVIEW_SUPABASE_KEY_SHA256' in validStagingEnv, false);

    const res = validateEnvironmentSafety(validStagingEnv);
    assert.equal(res.safe, true);
    assert.equal(res.errors.length, 0);

    // /rest/v1 付きステージング URL も store.ts と整合して許可されること
    const restV1Res = validateEnvironmentSafety({
      ...validStagingEnv,
      SUPABASE_URL: `${EXPECTED_STAGING_SUPABASE_ORIGIN}/rest/v1/`,
    });
    assert.equal(restV1Res.safe, true);
  });

  it('2. 本番Supabase拒絶: APP_ENV=staging で本番Refが含まれる場合に遮断すること', () => {
    const prodRes = validateEnvironmentSafety({
      ...validStagingEnv,
      SUPABASE_URL: 'https://liyjwvgtavfjiohwryox.supabase.co',
    });
    assert.equal(prodRes.safe, false);
    assert.match(prodRes.errors.join(' '), /Production Supabase project \(liyjwvgtavfjiohwryox\) detected/);

    assert.throws(() => {
      assertStagingEnvironmentSafe({
        ...validStagingEnv,
        SUPABASE_URL: 'https://liyjwvgtavfjiohwryox.supabase.co',
      });
    }, /CRITICAL_CONFIG_ERROR: Production Supabase project/);
  });

  it('3. 厳密なステージングSupabase URL検証: 許可オリジン以外の別ホスト・HTTP・ユーザー情報・クエリ・フラグメント・不正パスを拒否すること', () => {
    const invalidUrls = [
      'https://kenocha-staging.supabase.co',
      'https://evil.example.com',
      'http://zqcniawwhtnfcxkkwauu.supabase.co',
      'https://user:pass@zqcniawwhtnfcxkkwauu.supabase.co',
      'https://zqcniawwhtnfcxkkwauu.supabase.co?foo=bar',
      'https://zqcniawwhtnfcxkkwauu.supabase.co#frag',
      'https://zqcniawwhtnfcxkkwauu.supabase.co/other',
      'https://zqcniawwhtnfcxkkwauu.supabase.co/rest/v2',
    ];

    for (const url of invalidUrls) {
      assert.equal(isStrictStagingSupabaseUrl(url), false, `should reject ${url}`);
      const res = validateEnvironmentSafety({
        ...validStagingEnv,
        SUPABASE_URL: url,
      });
      assert.equal(res.safe, false, `validateEnvironmentSafety should reject ${url}`);
      assert.match(res.errors.join(' '), /strictly match the dedicated staging Supabase origin/);
    }
  });

  it('4. 環境識別情報の欠落・矛盾時の Fail-Closed 停止: VERCEL_ENV=preview の APP_ENV 欠落・不一致、production/staging 矛盾、Vercel ランタイム識別欠落を拒否すること', () => {
    // VERCEL_ENV=preview で APP_ENV 未設定
    const previewNoAppEnv = validateEnvironmentSafety({
      ...validStagingEnv,
      APP_ENV: undefined,
    });
    assert.equal(previewNoAppEnv.safe, false);
    assert.match(previewNoAppEnv.errors.join(' '), /APP_ENV must be set to "staging" when VERCEL_ENV is "preview"/);

    // VERCEL_ENV=preview で APP_ENV=production
    const previewProdAppEnv = validateEnvironmentSafety({
      ...validStagingEnv,
      APP_ENV: 'production',
    });
    assert.equal(previewProdAppEnv.safe, false);
    assert.match(previewProdAppEnv.errors.join(' '), /APP_ENV must be set to "staging" when VERCEL_ENV is "preview"/);

    // VERCEL_ENV=production と APP_ENV=staging の矛盾
    const prodStagingConflict = validateEnvironmentSafety({
      ...validStagingEnv,
      VERCEL_ENV: 'production',
      VERCEL_GIT_COMMIT_REF: 'main',
      APP_ENV: 'staging',
    });
    assert.equal(prodStagingConflict.safe, false);
    assert.match(prodStagingConflict.errors.join(' '), /Conflicting environment identifiers/);

    // 対象 Preview ブランチで VERCEL_ENV 欠落 (VERCEL=1 あり / VERCEL 未設定の双方)
    const branchNoVercelEnv = validateEnvironmentSafety({
      ...validStagingEnv,
      VERCEL_ENV: undefined,
    });
    assert.equal(branchNoVercelEnv.safe, false);
    assert.match(branchNoVercelEnv.errors.join(' '), /Target preview branch requires VERCEL_ENV="preview" and APP_ENV="staging"/);

    const branchNoVercelAtAll = validateEnvironmentSafety({
      ...validStagingEnv,
      VERCEL: undefined,
      VERCEL_ENV: undefined,
    });
    assert.equal(branchNoVercelAtAll.safe, false);
    assert.match(branchNoVercelAtAll.errors.join(' '), /Target preview branch requires VERCEL_ENV="preview" and APP_ENV="staging"/);

    // VERCEL_ENV=production かつ VERCEL_GIT_COMMIT_REF=phase0-safe-foundation の矛盾
    const prodWithPreviewBranch = validateEnvironmentSafety({
      ...validStagingEnv,
      VERCEL_ENV: 'production',
      APP_ENV: 'production',
      VERCEL_GIT_COMMIT_REF: EXPECTED_PREVIEW_BRANCH,
    });
    assert.equal(prodWithPreviewBranch.safe, false);
    assert.match(prodWithPreviewBranch.errors.join(' '), /Target preview branch requires VERCEL_ENV="preview" and APP_ENV="staging"/);

    // VERCEL_ENV=preview かつ APP_ENV=staging だが Git ブランチ識別情報 (VERCEL_GIT_COMMIT_REF) 未設定
    const previewNoGitRef = validateEnvironmentSafety({
      ...validStagingEnv,
      VERCEL_GIT_COMMIT_REF: undefined,
    });
    assert.equal(previewNoGitRef.safe, false);
    assert.match(previewNoGitRef.errors.join(' '), /VERCEL_GIT_COMMIT_REF is required when VERCEL_ENV is "preview"/);

    // Vercel ランタイム上で VERCEL_ENV 欠落 (対象外ブランチ含む)
    const vercelMissingEnv = validateEnvironmentSafety({
      VERCEL: '1',
      VERCEL_ENV: undefined,
      APP_ENV: 'production',
    });
    assert.equal(vercelMissingEnv.safe, false);
    assert.match(vercelMissingEnv.errors.join(' '), /VERCEL_ENV is missing or invalid in Vercel runtime/);
  });

  it('5. placeholderフォールバック禁止および Secret Key 形式検証: 欠落・placeholder・空白・引用符・非 sb_secret_* を遮断し秘密値を出力しないこと', () => {
    const missingUrl = validateEnvironmentSafety({
      ...validStagingEnv,
      SUPABASE_URL: '',
    });
    assert.equal(missingUrl.safe, false);
    assert.match(missingUrl.errors.join(' '), /SUPABASE_URL is missing, empty, or using placeholder/);

    const placeholderUrl = validateEnvironmentSafety({
      ...validStagingEnv,
      SUPABASE_URL: 'https://placeholder.supabase.co',
    });
    assert.equal(placeholderUrl.safe, false);
    assert.match(placeholderUrl.errors.join(' '), /SUPABASE_URL is missing, empty, or using placeholder/);

    const placeholderKey = validateEnvironmentSafety({
      ...validStagingEnv,
      SUPABASE_SECRET_KEY: 'placeholder_secret_key',
    });
    assert.equal(placeholderKey.safe, false);
    assert.match(placeholderKey.errors.join(' '), /SUPABASE_SECRET_KEY is missing, empty, or using placeholder/);

    const whitespaceKey = validateEnvironmentSafety({
      ...validStagingEnv,
      SUPABASE_SECRET_KEY: ` ${dummySecretKey}\n`,
    });
    assert.equal(whitespaceKey.safe, false);
    assert.match(whitespaceKey.errors.join(' '), /leading or trailing whitespace/);
    assert.equal(whitespaceKey.errors.join(' ').includes(dummySecretKey), false);

    const quotedKey = validateEnvironmentSafety({
      ...validStagingEnv,
      SUPABASE_SECRET_KEY: `"${dummySecretKey}"`,
    });
    assert.equal(quotedKey.safe, false);
    assert.match(quotedKey.errors.join(' '), /surrounding quotes/);
    assert.equal(quotedKey.errors.join(' ').includes(dummySecretKey), false);

    const publishableKey = validateEnvironmentSafety({
      ...validStagingEnv,
      SUPABASE_SECRET_KEY: 'sb_publishable_wrong_key_for_server',
    });
    assert.equal(publishableKey.safe, false);
    assert.match(publishableKey.errors.join(' '), /must use the sb_secret_\* format/);
    assert.equal(publishableKey.errors.join(' ').includes('sb_publishable_wrong_key_for_server'), false);

    // createStoreSupabaseClient で非テスト環境時に例外を投げること
    const prevEnv = process.env.APP_ENV;
    try {
      process.env.APP_ENV = 'staging';
      const prevUrl = process.env.SUPABASE_URL;
      delete process.env.SUPABASE_URL;
      assert.throws(() => {
        createStoreSupabaseClient();
      }, /Missing or placeholder SUPABASE_URL/);
      process.env.SUPABASE_URL = prevUrl;
    } finally {
      process.env.APP_ENV = prevEnv;
    }
  });

  it('6. Stripeキー検証: sk_test_ 必須。sk_live_ や不正プレフィックスを拒否し実値を出力しないこと', () => {
    const liveKeyRes = validateEnvironmentSafety({
      ...validStagingEnv,
      STRIPE_SECRET_KEY: dummyStripeLiveKey,
    });
    assert.equal(liveKeyRes.safe, false);
    assert.match(liveKeyRes.errors.join(' '), /sk_live_/);
    assert.equal(liveKeyRes.errors.join(' ').includes(dummyStripeLiveKey), false);

    const invalidPrefix = validateEnvironmentSafety({
      ...validStagingEnv,
      STRIPE_SECRET_KEY: 'pk_test_not_secret',
    });
    assert.equal(invalidPrefix.safe, false);
    assert.match(invalidPrefix.errors.join(' '), /STRIPE_SECRET_KEY must start with sk_test_/);
  });

  it('7. 固定サンプル値禁止: 固定パスワードや短いセッション秘密鍵を遮断すること', () => {
    const sampleStaff = validateEnvironmentSafety({
      ...validStagingEnv,
      STAFF_PASSWORD: 'staging_staff_pass_2026',
    });
    assert.equal(sampleStaff.safe, false);
    assert.match(sampleStaff.errors.join(' '), /STAFF_PASSWORD is missing or set to an insecure sample value/);

    const sampleAdmin = validateEnvironmentSafety({
      ...validStagingEnv,
      ADMIN_PASSWORD: 'staging_admin_pass_2026',
    });
    assert.equal(sampleAdmin.safe, false);
    assert.match(sampleAdmin.errors.join(' '), /ADMIN_PASSWORD is missing or set to an insecure sample value/);

    const sampleSecret = validateEnvironmentSafety({
      ...validStagingEnv,
      AUTH_SESSION_SECRET: 'staging_session_secret_32bytes_min_length_xxxx',
    });
    assert.equal(sampleSecret.safe, false);
    assert.match(sampleSecret.errors.join(' '), /AUTH_SESSION_SECRET is missing, set to an insecure sample value/);

    const shortSecret = validateEnvironmentSafety({
      ...validStagingEnv,
      AUTH_SESSION_SECRET: 'short_secret_under_32',
    });
    assert.equal(shortSecret.safe, false);
    assert.match(shortSecret.errors.join(' '), /shorter than 32 characters/);
  });

  it('8. Production正常経路・ローカル開発経路の回帰確認: 正常なProductionおよびローカル開発が誤遮断されないこと', () => {
    const prodRes = validateEnvironmentSafety({
      VERCEL: '1',
      VERCEL_ENV: 'production',
      VERCEL_GIT_COMMIT_REF: 'main',
      APP_ENV: 'production',
      SUPABASE_URL: 'https://liyjwvgtavfjiohwryox.supabase.co',
      SUPABASE_SECRET_KEY: ['sb', 'secret', 'prod_dummy_value'].join('_'),
      STRIPE_SECRET_KEY: dummyStripeLiveKey,
    });
    assert.equal(prodRes.safe, true);
    assert.equal(prodRes.errors.length, 0);

    // Production で APP_ENV 未設定 (現行本番互換)
    const prodNoAppEnv = validateEnvironmentSafety({
      VERCEL: '1',
      VERCEL_ENV: 'production',
      VERCEL_GIT_COMMIT_REF: 'main',
      SUPABASE_URL: 'https://liyjwvgtavfjiohwryox.supabase.co',
      SUPABASE_SECRET_KEY: ['sb', 'secret', 'prod_dummy_value'].join('_'),
      STRIPE_SECRET_KEY: dummyStripeLiveKey,
    });
    assert.equal(prodNoAppEnv.safe, true);

    // ローカル開発 (VERCEL 未設定・APP_ENV 未設定)
    const localDevRes = validateEnvironmentSafety({
      NODE_ENV: 'development',
    });
    assert.equal(localDevRes.safe, true);
  });

  it('9. Supabase URL正規化: store.ts と envGuard.ts が /rest/v1 や末尾スラッシュを同一仕様で除去すること', () => {
    const cases = [
      'https://zqcniawwhtnfcxkkwauu.supabase.co/rest/v1/',
      'https://zqcniawwhtnfcxkkwauu.supabase.co/rest/v1',
      'https://zqcniawwhtnfcxkkwauu.supabase.co/',
      'https://zqcniawwhtnfcxkkwauu.supabase.co',
    ];
    for (const input of cases) {
      assert.equal(normalizeSupabaseUrl(input), EXPECTED_STAGING_SUPABASE_ORIGIN);
      assert.equal(normalizeSupabaseUrlForGuard(input), EXPECTED_STAGING_SUPABASE_ORIGIN);
    }
  });

  it('10. GET /api/ping エラー情報非露出: 秘密値・URL・内部例外を含む例外発生時でもHTTPレスポンスおよびログへ一切露出しないこと', async () => {
    const leakedSecret = ['sb', 'secret', 'simulated_leaked_key_99999'].join('_');
    const leakedStripe = ['sk', 'test', 'simulated_leaked_stripe_88888'].join('_');
    const leakedAuthHeader = `Authorization: Bearer ${leakedSecret}`;
    const errorLogs: string[] = [];

    const failRes = await executeSafePing(
      async () => {
        throw new Error(
          `Supabase internal failure at ${EXPECTED_STAGING_SUPABASE_ORIGIN} with ${leakedAuthHeader} and ${leakedStripe}`
        );
      },
      (msg) => errorLogs.push(msg)
    );

    assert.equal(failRes.status, 500);
    assert.deepEqual(failRes.body, {
      status: 'error',
      message: PING_ERROR_MESSAGE,
    });
    assert.equal(errorLogs.length, 1);
    assert.equal(errorLogs[0], `[PingHealthcheck] code=${PING_ERROR_CODE}`);

    const combined = `${JSON.stringify(failRes.body)}\n${errorLogs.join('\n')}`;
    assert.equal(combined.includes(leakedSecret), false);
    assert.equal(combined.includes(leakedStripe), false);
    assert.equal(combined.includes(EXPECTED_STAGING_SUPABASE_ORIGIN), false);
    assert.equal(combined.includes('Authorization'), false);
    assert.equal(combined.includes('Supabase internal failure'), false);

    // 正常時のレスポンス仕様が維持されていること
    const okLogs: string[] = [];
    const okRes = await executeSafePing(
      async () => {
        return [];
      },
      (msg) => okLogs.push(msg)
    );
    assert.equal(okRes.status, 200);
    assert.equal(okRes.body.status, 'ok');
    assert.equal(okRes.body.message, 'Supabase is alive');
    assert.ok(typeof okRes.body.timestamp === 'string' && okRes.body.timestamp.length > 0);
    assert.equal(okLogs.length, 0);
  });
});
