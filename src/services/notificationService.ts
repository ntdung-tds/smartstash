import * as Notifications from 'expo-notifications';
import { getCurrentLang } from '../theme';
import { translate } from '../i18n';
import { listItems, listActiveLoans } from '../db/queries';
import { getAlertSettings } from './alertSettings';
import { isAlertSnoozed } from '../utils';
import type { Item } from '../types';

// Thông báo cục bộ — best-effort. Mọi lỗi đều bị nuốt để không chặn luồng chính.
// Thông báo được ĐẶT LỊCH trước (scheduled) nên vẫn bắn khi app đã tắt hẳn;
// rescheduleAllReminders() đồng bộ lại toàn bộ lịch theo dữ liệu + cấu hình cảnh báo hiện tại.

let handlerSet = false;

export async function ensureNotificationSetup(): Promise<void> {
  try {
    if (!handlerSet) {
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: false,
          shouldSetBadge: false,
        }),
      });
      handlerSet = true;
    }
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) {
      await Notifications.requestPermissionsAsync();
    }
  } catch {
    // thiết bị không hỗ trợ / chưa cấp quyền — bỏ qua
  }
}

async function scheduleAt(date: Date, title: string, body: string, identifier?: string): Promise<void> {
  if (date.getTime() <= Date.now()) return;
  try {
    const trigger: Notifications.SchedulableNotificationTriggerInput =
      Notifications.SchedulableTriggerInputTypes != null
        ? { type: Notifications.SchedulableTriggerInputTypes.DATE, date }
        : ({ date } as never);
    await Notifications.scheduleNotificationAsync({
      ...(identifier ? { identifier } : null),
      content: { title, body },
      trigger,
    });
  } catch {
    // bỏ qua
  }
}

function atTime(isoDate: string, addDays: number, hour: number, minute: number): Date {
  const d = new Date(isoDate.slice(0, 10) + 'T00:00:00');
  d.setDate(d.getDate() + addDays);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** Nhắc hết hạn nhanh khi vừa tạo món (rescheduleAllReminders sẽ đồng bộ lại ngay sau đó) */
export async function scheduleExpiryReminders(itemName: string, expiryDateISO: string): Promise<void> {
  try {
    await ensureNotificationSetup();
    const lang = getCurrentLang();
    const cfg = await getAlertSettings();
    if (!cfg.notifyExpiry) return;
    for (const daysBefore of [cfg.watchDays, cfg.soonDays]) {
      const d = atTime(expiryDateISO, -daysBefore, 8, 30);
      await scheduleAt(
        d,
        translate(lang, 'notif.expiryTitle'),
        translate(lang, 'notif.expiryBody', { name: itemName, n: daysBefore, date: expiryDateISO.slice(0, 10) }),
      );
    }
  } catch {
    // bỏ qua
  }
}

/** Nhắc đòi đồ: 09:00 ngày hẹn trả (B.15) */
export async function scheduleLoanReminder(itemName: string, borrower: string, expectedDateISO: string): Promise<void> {
  try {
    await ensureNotificationSetup();
    const lang = getCurrentLang();
    const d = atTime(expectedDateISO, 0, 9, 0);
    await scheduleAt(
      d,
      translate(lang, 'notif.loanDueTitle'),
      translate(lang, 'notif.loanDueBody', { name: itemName, borrower }),
    );
  } catch {
    // bỏ qua
  }
}

type DateEventKind = 'expiry' | 'warranty';
type DateMilestone = 'soon' | 'minus1' | 'due' | 'overdue';

interface DateEvent {
  fire: Date;
  kind: DateEventKind;
  milestone: DateMilestone;
  item: Item;
  /** Ngày hạn gốc (YYYY-MM-DD) */
  targetDate: string;
}

/**
 * Đặt lại TOÀN BỘ lịch nhắc theo dữ liệu + cấu hình cảnh báo (alert_cfg):
 * - Huỷ mọi thông báo đã đặt, rồi đặt lại từ DB.
 * - Hạn dùng (món STORED/IN_USE, chưa hoãn nhắc): 08:30 các mốc bước vào "Sắp hết hạn"
 *   (hạn − soonDays), hạn −1 ngày, ngày hết hạn, +1 ngày sau hết hạn.
 * - Hạn trả (khoản vay ACTIVE có ngày hẹn, chưa hoãn): 09:00 các mốc hạn −1, ngày hẹn trả,
 *   và nếu bật loanRepeat: +1, +2, +3 ngày.
 * - Bảo hành: 08:30 các mốc hết bảo hành − soonDays và ngày hết bảo hành.
 * - GỘP: các sự kiện hạn dùng/bảo hành (từng loại riêng) rơi vào cùng một buổi sáng mà
 *   có ≥3 món thì gộp thành 1 thông báo tổng hợp (identifier suy ra từ kind+ngày để
 *   lần reschedule sau huỷ đúng). Khoản vay KHÔNG gộp.
 * - Nguồn đã tắt trong cài đặt (notify*) hoặc đang hoãn (alert_snoozed_until) bị bỏ qua.
 * Nội dung thông báo được soạn theo MỐC SỰ KIỆN (sắp hết hạn / đến hạn / quá hạn).
 * Best-effort: lỗi từng món không chặn món khác; lỗi tổng không ném ra ngoài.
 */
export async function rescheduleAllReminders(): Promise<void> {
  try {
    await ensureNotificationSetup();
    try {
      await Notifications.cancelAllScheduledNotificationsAsync();
    } catch {
      // bỏ qua — vẫn thử đặt lịch mới bên dưới
    }
    const lang = getCurrentLang();
    const cfg = await getAlertSettings();
    const items = await listItems();
    const nameById = new Map(items.map((i) => [i.id, i.name]));

    // ---- Thu thập sự kiện theo ngày (hạn dùng + bảo hành) ----
    const events: DateEvent[] = [];
    const pushEvent = (kind: DateEventKind, milestone: DateMilestone, item: Item, target: string, offsetDays: number) => {
      events.push({ fire: atTime(target, offsetDays, 8, 30), kind, milestone, item, targetDate: target });
    };
    for (const item of items) {
      try {
        const snoozed = isAlertSnoozed(item.alert_snoozed_until);
        if (snoozed) continue;
        if (cfg.notifyExpiry && item.expiry_date && (item.status === 'STORED' || item.status === 'IN_USE')) {
          const expiry = item.expiry_date;
          pushEvent('expiry', 'soon', item, expiry, -cfg.soonDays);
          pushEvent('expiry', 'minus1', item, expiry, -1);
          pushEvent('expiry', 'due', item, expiry, 0);
          pushEvent('expiry', 'overdue', item, expiry, 1);
        }
        if (cfg.notifyWarranty && item.warranty_expiry_date) {
          const warranty = item.warranty_expiry_date;
          pushEvent('warranty', 'soon', item, warranty, -cfg.soonDays);
          pushEvent('warranty', 'due', item, warranty, 0);
        }
      } catch {
        // một món lỗi không chặn các món khác
      }
    }

    // ---- Đặt lịch sự kiện theo ngày: gộp ≥3 sự kiện cùng loại + cùng buổi sáng ----
    const future = events.filter((e) => e.fire.getTime() > Date.now());
    const groups = new Map<string, DateEvent[]>();
    for (const e of future) {
      const dayKey = `${e.fire.getFullYear()}-${e.fire.getMonth()}-${e.fire.getDate()}`;
      const key = `${e.kind}|${dayKey}`;
      const arr = groups.get(key) ?? [];
      arr.push(e);
      groups.set(key, arr);
    }
    for (const [key, group] of groups) {
      try {
        const kind = key.split('|')[0] as DateEventKind;
        const title = translate(lang, kind === 'expiry' ? 'notif.expiryTitle' : 'alerts.notifWarrantyTitle');
        if (group.length >= 3) {
          const first = group[0];
          const yyyymmdd = first.fire.toISOString().slice(0, 10);
          await scheduleAt(
            first.fire,
            title,
            translate(lang, kind === 'expiry' ? 'alerts.notifSummaryExpiry' : 'alerts.notifSummaryWarranty', { n: group.length }),
            `alert-grp-${kind}-${yyyymmdd}`,
          );
          continue;
        }
        for (const e of group) {
          let body: string;
          if (e.kind === 'expiry') {
            if (e.milestone === 'soon') body = translate(lang, 'notif.expirySoonBody', { name: e.item.name, n: cfg.soonDays, date: e.targetDate });
            else if (e.milestone === 'minus1') body = translate(lang, 'notif.expirySoonBody', { name: e.item.name, n: 1, date: e.targetDate });
            else if (e.milestone === 'due') body = translate(lang, 'notif.expiryTodayBody', { name: e.item.name, date: e.targetDate });
            else body = translate(lang, 'alerts.notifExpiryOverdueBody', { name: e.item.name, date: e.targetDate });
          } else if (e.milestone === 'soon') {
            body = translate(lang, 'alerts.notifWarrantySoonBody', { name: e.item.name, date: e.targetDate });
          } else {
            body = translate(lang, 'alerts.notifWarrantyDueBody', { name: e.item.name, date: e.targetDate });
          }
          await scheduleAt(e.fire, title, body, `alert-${e.kind}-${e.item.id}-${e.milestone}-${e.targetDate}`);
        }
      } catch {
        // một nhóm lỗi không chặn các nhóm khác
      }
    }

    // ---- Hạn trả: từng khoản vay riêng, không gộp ----
    if (cfg.notifyLoan) {
      const loans = await listActiveLoans();
      for (const loan of loans) {
        try {
          if (loan.status !== 'ACTIVE' || !loan.expected_return_date) continue;
          if (isAlertSnoozed(loan.alert_snoozed_until)) continue;
          const itemName = loan.item_name ?? nameById.get(loan.item_id) ?? '';
          const due = loan.expected_return_date;
          await scheduleAt(
            atTime(due, -1, 9, 0),
            translate(lang, 'notif.loanDueTitle'),
            translate(lang, 'alerts.notifLoanTomorrowBody', { name: itemName, borrower: loan.borrower_name }),
            `alert-loan-${loan.id}-minus1`,
          );
          await scheduleAt(
            atTime(due, 0, 9, 0),
            translate(lang, 'notif.loanDueTitle'),
            translate(lang, 'notif.loanDueBody', { name: itemName, borrower: loan.borrower_name }),
            `alert-loan-${loan.id}-due`,
          );
          await scheduleAt(
            atTime(due, 1, 9, 0),
            translate(lang, 'notif.loanOverdueTitle'),
            translate(lang, 'notif.loanOverdueBody', { name: itemName, borrower: loan.borrower_name }),
            `alert-loan-${loan.id}-plus1`,
          );
          if (cfg.loanRepeat) {
            for (const extra of [2, 3]) {
              await scheduleAt(
                atTime(due, extra, 9, 0),
                translate(lang, 'notif.loanOverdueTitle'),
                translate(lang, 'alerts.notifLoanOverdueDaysBody', { name: itemName, borrower: loan.borrower_name, n: extra }),
                `alert-loan-${loan.id}-plus${extra}`,
              );
            }
          }
        } catch {
          // một khoản mượn lỗi không chặn các khoản khác
        }
      }
    }
  } catch {
    // best-effort toàn cục
  }
}
