import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateEnvironmentSafety, assertStagingEnvironmentSafe } from '../src/lib/envGuard.ts';
import { createStoreSupabaseClient, normalizeSupabaseUrl } from '../src/lib/store.ts';

describe('[Phase 0-G] 環境変数ガードおよびステージング安全性テスト', () => {
  const validStagingEnv = {
    APP_ENV: 'staging',
    SUPABASE_URL: 'https://staging-ref-12345.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_staging_valid_key_sample',
    STRIPE_SECRET_KEY: 'sk_test_51MockStripeKey123',
    STAFF_PASSWORD: 'staff_secure_random_pw_9876543210',
    ADMIN_PASSWORD: 'admin_secure_random_pw_0123456789',
    AUTH_SESSION_SECRET: 'auth_secret_minimum_32_bytes_length_ok_random_key_123',
    PRODUCTION_SUPABASE_PROJECT_REF: 'liyjwvgtavfjiohwryox',
  };

  it('1. 正常なステージング環境: すべての条件を満たす場合に safe: true を返すこと', () => {
    const res = validateEnvironmentSafety(validStagingEnv);
    assert.equal(res.safe, true);
    assert.equal(res.errors.length, 0);
  });

  it('2. 本番Supabase拒絶 (項目5): APP_ENV=staging で本番Refが含まれる場合に遮断すること', () => {
    // 固定本番Ref (liyjwvgtavfjiohwryox)
    const prodRes = validateEnvironmentSafety({
      ...validStagingEnv,
      SUPABASE_URL: 'https://liyjwvgtavfjiohwryox.supabase.co',
    });
    assert.equal(prodRes.safe, false);
    assert.match(prodRes.errors.join(' '), /Production Supabase project \(liyjwvgtavfjiohwryox\) detected/);

    // assertStagingEnvironmentSafe が例外を投げること
    assert.throws(() => {
      assertStagingEnvironmentSafe({
        ...validStagingEnv,
        SUPABASE_URL: 'https://liyjwvgtavfjiohwryox.supabase.co',
      });
    }, /CRITICAL_CONFIG_ERROR: Production Supabase project/);
  });

  it('3. テスト用Supabase許可 (項目5): 独立したステージングURLが許可されること', () => {
    const stagingRes = validateEnvironmentSafety({
      ...validStagingEnv,
      SUPABASE_URL: 'https://kenocha-staging.supabase.co',
    });
    assert.equal(stagingRes.safe, true);
  });

  it('4. placeholderフォールバック禁止 (項目4): SUPABASE_URL / SECRET_KEY 欠落・placeholder時に停止すること', () => {
    // SUPABASE_URL 欠落
    const missingUrl = validateEnvironmentSafety({
      ...validStagingEnv,
      SUPABASE_URL: '',
    });
    assert.equal(missingUrl.safe, false);
    assert.match(missingUrl.errors.join(' '), /SUPABASE_URL is missing, empty, or using placeholder/);

    // SUPABASE_URL が placeholder
    const placeholderUrl = validateEnvironmentSafety({
      ...validStagingEnv,
      SUPABASE_URL: 'https://placeholder.supabase.co',
    });
    assert.equal(placeholderUrl.safe, false);
    assert.match(placeholderUrl.errors.join(' '), /SUPABASE_URL is missing, empty, or using placeholder/);

    // SUPABASE_SECRET_KEY が placeholder
    const placeholderKey = validateEnvironmentSafety({
      ...validStagingEnv,
      SUPABASE_SECRET_KEY: 'placeholder_secret_key',
    });
    assert.equal(placeholderKey.safe, false);
    assert.match(placeholderKey.errors.join(' '), /SUPABASE_SECRET_KEY is missing, empty, or using placeholder/);

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

  it('5. Stripeキー検証 (項目6): sk_test_ 必須。sk_live_ や不正プレフィックスを拒否すること', () => {
    // sk_live_ 本番キー
    const liveKeyRes = validateEnvironmentSafety({
      ...validStagingEnv,
      STRIPE_SECRET_KEY: 'sk_live_51SecretLiveKey123',
    });
    assert.equal(liveKeyRes.safe, false);
    assert.match(liveKeyRes.errors.join(' '), /sk_live_/);

    // sk_test_ でないキー (rk_等)
    const invalidPrefix = validateEnvironmentSafety({
      ...validStagingEnv,
      STRIPE_SECRET_KEY: 'pk_test_not_secret',
    });
    assert.equal(invalidPrefix.safe, false);
    assert.match(invalidPrefix.errors.join(' '), /STRIPE_SECRET_KEY must start with sk_test_/);
  });

  it('6. 固定サンプル値禁止 (項目7): 固定パスワードや短いセッション秘密鍵を遮断すること', () => {
    // サンプルスタッフパスワード
    const sampleStaff = validateEnvironmentSafety({
      ...validStagingEnv,
      STAFF_PASSWORD: 'staging_staff_pass_2026',
    });
    assert.equal(sampleStaff.safe, false);
    assert.match(sampleStaff.errors.join(' '), /STAFF_PASSWORD is missing or set to an insecure sample value/);

    // サンプル管理者パスワード
    const sampleAdmin = validateEnvironmentSafety({
      ...validStagingEnv,
      ADMIN_PASSWORD: 'staging_admin_pass_2026',
    });
    assert.equal(sampleAdmin.safe, false);
    assert.match(sampleAdmin.errors.join(' '), /ADMIN_PASSWORD is missing or set to an insecure sample value/);

    // サンプルセッションシークレット
    const sampleSecret = validateEnvironmentSafety({
      ...validStagingEnv,
      AUTH_SESSION_SECRET: 'staging_session_secret_32bytes_min_length_xxxx',
    });
    assert.equal(sampleSecret.safe, false);
    assert.match(sampleSecret.errors.join(' '), /AUTH_SESSION_SECRET is missing, set to an insecure sample value/);

    // 32文字未満の短いシークレット
    const shortSecret = validateEnvironmentSafety({
      ...validStagingEnv,
      AUTH_SESSION_SECRET: 'short_secret_under_32',
    });
    assert.equal(shortSecret.safe, false);
    assert.match(shortSecret.errors.join(' '), /shorter than 32 characters/);
  });

  it('7. Supabase URL正規化: /rest/v1 や末尾スラッシュが付加されていても正しく除去すること', () => {
    assert.equal(
      normalizeSupabaseUrl('https://zqcniawwhtnfcxkkwauu.supabase.co/rest/v1/'),
      'https://zqcniawwhtnfcxkkwauu.supabase.co'
    );
    assert.equal(
      normalizeSupabaseUrl('https://zqcniawwhtnfcxkkwauu.supabase.co/rest/v1'),
      'https://zqcniawwhtnfcxkkwauu.supabase.co'
    );
    assert.equal(
      normalizeSupabaseUrl('https://zqcniawwhtnfcxkkwauu.supabase.co/'),
      'https://zqcniawwhtnfcxkkwauu.supabase.co'
    );
    assert.equal(
      normalizeSupabaseUrl('https://zqcniawwhtnfcxkkwauu.supabase.co'),
      'https://zqcniawwhtnfcxkkwauu.supabase.co'
    );
  });
});
