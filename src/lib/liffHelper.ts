import liff from '@line/liff';

export interface LiffUserProfile {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  statusMessage?: string;
}

const MOCK_PROFILE: LiffUserProfile = {
  userId: 'mock-user-12345',
  displayName: 'しぶ茶ちゃん (LINE模擬)',
  pictureUrl: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150', // placeholder beautiful avatar
  statusMessage: '日本茶ミルクティー大好き！',
};

class LiffManager {
  private isInited = false;
  private isMock = false;

  async init(): Promise<boolean> {
    if (typeof window === 'undefined') return false;

    try {
      // If there is no env variable, default to mock mode
      const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
      if (!liffId || liffId === 'YOUR_LIFF_ID') {
        console.warn('LIFF ID is not set. Running in MOCK Mode.');
        this.isMock = true;
        this.isInited = true;
        return true;
      }

      await liff.init({ liffId });
      this.isInited = true;
      this.isMock = false;
      return true;
    } catch (e) {
      console.error('LIFF Initialization failed. Falling back to MOCK Mode.', e);
      this.isMock = true;
      this.isInited = true;
      return true;
    }
  }

  isLoggedIn(): boolean {
    if (!this.isInited) return false;
    if (this.isMock) return true; // Mock mode always logged in
    return liff.isLoggedIn();
  }

  login(): void {
    if (this.isMock) {
      console.log('Mock login executed');
      return;
    }
    liff.login();
  }

  logout(): void {
    if (this.isMock) {
      console.log('Mock logout executed');
      return;
    }
    liff.logout();
  }

  async getProfile(): Promise<LiffUserProfile> {
    if (!this.isInited) {
      throw new Error('LIFF is not initialized. Call init() first.');
    }

    if (this.isMock) {
      return MOCK_PROFILE;
    }

    try {
      const profile = await liff.getProfile();
      return profile;
    } catch (e) {
      console.error('Failed to get real LIFF profile, returning mock profile', e);
      return MOCK_PROFILE;
    }
  }

  isInLiff(): boolean {
    if (this.isMock) return true; // Simulate being in LIFF for local development
    return liff.isInClient();
  }
}

export const liffManager = new LiffManager();
