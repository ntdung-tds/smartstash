import { kvGet, kvSet } from '../db/client';

/**
 * Cấu hình cảnh báo 4 mức — lưu 1 cục JSON ở app_kv 'alert_cfg'.
 * Có cache trong bộ nhớ để các component (ItemCard…) đọc đồng bộ sau lần nạp đầu;
 * setAlertSetting cập nhật cả cache lẫn KV.
 */
export interface AlertSettings {
  /** Ngưỡng "Sắp hết hạn": còn ≤ số ngày này (3/5/7/14) */
  soonDays: number;
  /** Ngưỡng "Sắp đến hạn/Đang theo dõi": còn ≤ số ngày này (14/30/60) */
  watchDays: number;
  notifyExpiry: boolean;
  notifyLoan: boolean;
  notifyWarranty: boolean;
  /** Nhắc lại mỗi ngày khi khoản vay quá hạn (tối đa +3 ngày) */
  loanRepeat: boolean;
}

export const ALERT_SETTINGS_DEFAULTS: AlertSettings = {
  soonDays: 7,
  watchDays: 30,
  notifyExpiry: true,
  notifyLoan: true,
  notifyWarranty: true,
  loanRepeat: true,
};

const KEY = 'alert_cfg';
const SOON_CHOICES = [3, 5, 7, 14];
const WATCH_CHOICES = [14, 30, 60];

let cache: AlertSettings | null = null;

function sanitize(raw: Partial<AlertSettings> | null | undefined): AlertSettings {
  const d = ALERT_SETTINGS_DEFAULTS;
  const soonDays = raw && SOON_CHOICES.includes(raw.soonDays ?? -1) ? (raw.soonDays as number) : d.soonDays;
  let watchDays = raw && WATCH_CHOICES.includes(raw.watchDays ?? -1) ? (raw.watchDays as number) : d.watchDays;
  // Mốc theo dõi phải lớn hơn mốc sắp hết hạn, nếu không WATCH không bao giờ xuất hiện
  if (watchDays <= soonDays) {
    watchDays = WATCH_CHOICES.find((w) => w > soonDays) ?? d.watchDays;
  }
  return {
    soonDays,
    watchDays,
    notifyExpiry: typeof raw?.notifyExpiry === 'boolean' ? raw.notifyExpiry : d.notifyExpiry,
    notifyLoan: typeof raw?.notifyLoan === 'boolean' ? raw.notifyLoan : d.notifyLoan,
    notifyWarranty: typeof raw?.notifyWarranty === 'boolean' ? raw.notifyWarranty : d.notifyWarranty,
    loanRepeat: typeof raw?.loanRepeat === 'boolean' ? raw.loanRepeat : d.loanRepeat,
  };
}

export async function getAlertSettings(): Promise<AlertSettings> {
  try {
    const rawStr = await kvGet(KEY);
    const parsed = rawStr ? (JSON.parse(rawStr) as Partial<AlertSettings>) : null;
    cache = sanitize(parsed);
  } catch {
    cache = { ...ALERT_SETTINGS_DEFAULTS };
  }
  return cache;
}

/** Đọc đồng bộ từ cache (chưa nạp lần nào → mặc định). Dùng cho render (ItemCard). */
export function getCachedAlertSettings(): AlertSettings {
  return cache ?? ALERT_SETTINGS_DEFAULTS;
}

export async function setAlertSetting<K extends keyof AlertSettings>(
  key: K,
  value: AlertSettings[K],
): Promise<AlertSettings> {
  const current = cache ?? (await getAlertSettings());
  const next = sanitize({ ...current, [key]: value });
  cache = next;
  try {
    await kvSet(KEY, JSON.stringify(next));
  } catch {
    // best-effort: cache vẫn giữ giá trị mới trong phiên này
  }
  return next;
}
