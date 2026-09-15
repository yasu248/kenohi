export const CLOSED_DATES = [
  '2026-09-11', // 臨時休業
  '2026-09-21', // 敬老の日
  '2026-09-22', // 国民の休日
  '2026-09-23', // 秋分の日
  '2026-09-24', // 臨時休業
  '2026-09-25', // 臨時休業
];

export function isBusinessHours(date: Date = new Date()): boolean {
  // Convert date to JST (Asia/Tokyo) string
  const jstString = date.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' });
  const jstDate = new Date(jstString);

  const year = jstDate.getFullYear();
  const month = String(jstDate.getMonth() + 1).padStart(2, '0');
  const day = String(jstDate.getDate()).padStart(2, '0');
  const dateString = `${year}-${month}-${day}`;

  const dayOfWeek = jstDate.getDay();
  const hours = jstDate.getHours();

  // 1. 土日は定休
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return false;
  }

  // 2. 祝日・臨時休業日をチェック
  if (CLOSED_DATES.includes(dateString)) {
    return false;
  }

  // 時間の判定は isStoreCurrentlyOpen に完全に委譲するため、ここでは営業日（平日）であれば true を返すように変更
  return true;
}

export function isStoreCurrentlyOpen(
  state: { isManualOpen: boolean; date: string; openedAt?: number } | null,
  pageLoadJstDate?: Date
): boolean {
  if (!state || !state.isManualOpen) return false;
  
  const today = new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' });
  const todayJst = new Date(today);
  const dateStr = `${todayJst.getFullYear()}-${String(todayJst.getMonth() + 1).padStart(2, '0')}-${String(todayJst.getDate()).padStart(2, '0')}`;
  
  // 今日の日付でなければオフ
  if (state.date !== dateStr) return false;
  
  const currentHour = todayJst.getHours();
  const currentMinute = todayJst.getMinutes();
  
  // openedAt が記録されていない場合は旧ロジック
  if (!state.openedAt) {
    return currentHour < 15;
  }
  
  // 開けた時間が15時より前か後か判定
  const openedJst = new Date(new Date(state.openedAt).toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const openedHour = openedJst.getHours();
  
  if (currentHour >= 15 && openedHour < 15) {
    // 15時より前に開けて、現在15時を過ぎている -> 基本は自動クローズ
    
    // ただし、15時より前にページを開いていた人への猶予措置 (15:10まで)
    if (pageLoadJstDate) {
      const loadHour = pageLoadJstDate.getHours();
      // ページを開いたのが15時前なら、15:10までは許可
      if (loadHour < 15) {
        if (currentHour === 15 && currentMinute < 10) {
          return true;
        }
      }
    }
    
    return false;
  }
  
  // それ以外（まだ15時前、または15時以降に手動で開け直した）ならオン
  return true;
}
