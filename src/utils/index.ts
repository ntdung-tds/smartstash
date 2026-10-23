import * as Crypto from 'expo-crypto';
import type { AlertTier } from '../types';

export function uuid(): string {
  return Crypto.randomUUID();
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Bỏ dấu tiếng Việt để fallback tìm kiếm khi FTS5 không khả dụng */
export function removeDiacritics(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/** Vệ sinh truy vấn trước khi đưa vào FTS5 MATCH: tách token, ghép tiền tố `token*` */
export function toFtsPrefixQuery(raw: string): string | null {
  const tokens = removeDiacritics(raw)
    .replace(/["*()\-+:^]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `${t}*`).join(' ');
}

export function formatVND(value: number | null | undefined): string {
  if (value == null) return '—';
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' đ';
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/** Che (mask) ô nhập ngày: chỉ giữ số, tự chèn '/' → 'DD/MM/YYYY' (tối đa 8 số) */
export function maskDateInput(text: string): string {
  const digits = text.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

/** Parse chuỗi hiển thị 'DD/MM/YYYY' → ISO 'YYYY-MM-DD'; null nếu không phải ngày thật */
export function parseDisplayDate(str: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(str.trim());
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** ISO 'YYYY-MM-DD' → chuỗi hiển thị cho ô nhập 'DD/MM/YYYY' */
export function formatDisplayDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return '';
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** Định dạng ngày để HIỂN THỊ tĩnh theo ngôn ngữ: vi = DD/MM/YYYY, en = 'MMM D, YYYY' */
export function formatDateForLang(iso: string | null | undefined, lang: 'vi' | 'en'): string {
  if (!iso) return '—';
  if (lang === 'en') {
    try {
      const d = new Date(iso.slice(0, 10) + 'T00:00:00');
      if (!isNaN(d.getTime())) {
        return new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
      }
    } catch {
      // rơi xuống fallback bên dưới
    }
    return iso.slice(0, 10);
  }
  return formatDate(iso);
}

/** Ngôn ngữ máy: 'en' nếu locale bắt đầu bằng 'en', còn lại mặc định 'vi' */
export function detectDeviceLang(): 'vi' | 'en' {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale ?? '';
    return locale.toLowerCase().startsWith('en') ? 'en' : 'vi';
  } catch {
    return 'vi';
  }
}

/** Số ngày từ hôm nay tới một ngày ISO (âm = đã qua) */
export function daysUntil(isoDate: string | null | undefined): number | null {
  if (!isoDate) return null;
  const target = new Date(isoDate.slice(0, 10) + 'T00:00:00');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/**
 * Chọn mẫu tin NHẮC NGƯỜI MƯỢN theo trạng thái hạn trả của một lượt mượn:
 * - Có hạn trả và ngày tới hạn ≤ soonDays: đã quá hạn → mẫu quá hạn
 *   (alerts.remindMsgOverdue, params {item, borrower, days}); chưa quá hạn
 *   → mẫu đến hạn (alerts.remindMsgDue, params {item, borrower}).
 * - Không có hạn trả, hoặc hạn còn xa hơn soonDays → mẫu hỏi thăm nhẹ
 *   không nhắc hạn (alerts.remindMsgCheckin, params {borrower, item, date}
 *   với date là NGÀY MƯỢN đã định dạng DD/MM/YYYY).
 * Trả về key i18n + params đã khớp placeholders của key đó; nơi gọi tự
 * dịch bằng t() rồi Share — dùng chung cho banner/thẻ ở chi tiết đồ và
 * thẻ ở tab Cho mượn để hai nơi luôn chọn cùng một kiểu lời nhắc.
 */
export function pickRemindMessage(args: {
  borrower: string;
  item: string;
  lentAt: string;
  due: string | null | undefined;
  soonDays: number;
}): { key: string; params: Record<string, string | number> } {
  const { borrower, item, lentAt, due, soonDays } = args;
  const days = daysUntil(due);
  if (due && days != null && days <= soonDays) {
    if (days < 0) {
      return { key: 'alerts.remindMsgOverdue', params: { item, borrower, days: -days } };
    }
    return { key: 'alerts.remindMsgDue', params: { item, borrower } };
  }
  return { key: 'alerts.remindMsgCheckin', params: { borrower, item, date: formatDate(lentAt) } };
}

// ---------- Cảnh báo 4 mức ----------
export interface AlertInfo {
  tier: AlertTier;
  /** Số ngày còn lại tới hạn (âm = đã quá hạn) */
  days: number;
}

/** Thứ hạng khẩn cấp: số càng nhỏ càng khẩn (để so sánh/chọn nguồn cảnh báo cao nhất) */
export const ALERT_TIER_RANK: Record<AlertTier, number> = { OVERDUE: 0, DUE: 1, SOON: 2, WATCH: 3 };

/**
 * Phân mức cảnh báo cho một ngày hạn, so sánh theo NGÀY LỊCH địa phương
 * (qua daysUntil): <0 OVERDUE, =0 DUE, 1..soonDays SOON, ..watchDays WATCH,
 * xa hơn hoặc không có ngày → null (không cảnh báo).
 */
export function getAlertTier(
  dateIso: string | null | undefined,
  soonDays: number,
  watchDays: number,
): AlertInfo | null {
  const days = daysUntil(dateIso);
  if (days == null) return null;
  if (days < 0) return { tier: 'OVERDUE', days };
  if (days === 0) return { tier: 'DUE', days };
  if (days <= soonDays) return { tier: 'SOON', days };
  if (days <= watchDays) return { tier: 'WATCH', days };
  return null;
}

/** Ngày hôm nay theo lịch địa phương dạng 'YYYY-MM-DD' */
export function localTodayISO(): string {
  const n = new Date();
  const mm = String(n.getMonth() + 1).padStart(2, '0');
  const dd = String(n.getDate()).padStart(2, '0');
  return `${n.getFullYear()}-${mm}-${dd}`;
}

/** Cộng/trừ ngày trên chuỗi 'YYYY-MM-DD', trả 'YYYY-MM-DD' */
export function addDaysISO(isoDate: string, days: number): string {
  const d = new Date(isoDate.slice(0, 10) + 'T00:00:00');
  d.setDate(d.getDate() + days);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Nguồn cảnh báo có đang bị hoãn không (hoãn tới hết ngày alert_snoozed_until) */
export function isAlertSnoozed(snoozedUntil: string | null | undefined): boolean {
  const d = daysUntil(snoozedUntil);
  return d != null && d >= 0;
}
