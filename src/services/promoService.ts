import { kvGet, kvSet } from '../db/client';
import { PROMO_CODE_SIM } from '../config';
import { setSimPro } from './planService';
import { isSelfPromoEnabled } from './remoteConfigService';

/**
 * Đổi MÃ KHUYẾN MÃI TỰ QUẢN của chủ app (khác hẳn mã Google Play).
 *
 * Cơ chế đích (theo tài liệu Google/RevenueCat):
 * - Mã tự quản do CHỦ APP phát hành: người dùng nhập mã trong app → app gửi
 *   mã lên BACKEND của chủ app kiểm tra (tồn tại / còn hạn / còn lượt) →
 *   backend gọi RevenueCat (Promotional Entitlements API) cấp entitlement
 *   cho đúng người dùng đó. App không tự chứa danh sách mã thật và không tự
 *   quyết định cấp quyền — chống gian lận nằm ở backend.
 * - Mã GOOGLE PLAY thì ngược lại: app KHÔNG ĐƯỢC tự kiểm tra. Việc đổi mã
 *   do Google xử lý tại https://play.google.com/redeem — UI chỉ mở liên kết
 *   đó (xem khu vực "Đổi mã Google Play" trong modal nhập mã ở Cài đặt).
 *
 * TODO(backend): hiện CHƯA có backend và RevenueCat chưa nối, nên hàm dưới
 * đây là SEAM mô phỏng: tra bảng PROMO_CODE_SIM trong src/config.ts và cấp
 * quyền qua cùng cờ giả lập 'plan_sim_pro' mà planService đang đọc (nên UI
 * Premium mở khoá thật khi test). Khi có backend: thay thân hàm bằng lời gọi
 * API kiểm tra mã + chờ backend cấp entitlement qua RevenueCat, rồi đồng bộ
 * lại gói bằng planService — chữ ký hàm và kiểu kết quả giữ nguyên.
 *
 * Lịch sử đổi mã của thiết bị lưu ở app_kv 'promo_redeemed_<MÃ>' = số lần đã
 * đổi thành công (chuỗi số nguyên) — seam mô phỏng dùng để test nhánh
 * "đã dùng"; bản backend thì lượt dùng do backend quản theo tài khoản.
 */
export type PromoRedeemResult =
  | { status: 'success'; code: string }
  | { status: 'not_found' }
  | { status: 'already_used'; code: string }
  | { status: 'expired'; code: string }
  /** Công tắc cấu hình từ xa đang TẮT ô nhập mã tự quản (remoteConfigService) */
  | { status: 'disabled' };

const REDEEMED_KEY_PREFIX = 'promo_redeemed_';

/** Chuẩn hoá mã người dùng nhập trước khi so: cắt khoảng trắng + viết hoa */
export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Đổi một mã khuyến mãi tự quản. Trả về kết quả PHÂN LOẠI rõ ràng để UI báo
 * lỗi tại chỗ đúng từng trường hợp: success / not_found / already_used /
 * expired. Thành công → cấp quyền lợi của mã (hiện tại: tương đương Pro qua
 * cờ giả lập của planService) và ghi nhận lượt dùng vào app_kv.
 */
export async function redeemPromoCode(rawCode: string): Promise<PromoRedeemResult> {
  // Chốt chặn ở TẦNG SERVICE (không chỉ ẩn giao diện): công tắc cấu hình
  // từ xa tắt ô nhập mã tự quản thì từ chối đổi mọi mã ngay tại đây —
  // xem cờ selfPromoEnabled trong remoteConfigService.
  if (!isSelfPromoEnabled()) {
    return { status: 'disabled' };
  }
  const code = normalizePromoCode(rawCode);
  const entry = PROMO_CODE_SIM[code];
  if (!entry) {
    return { status: 'not_found' };
  }
  if (entry.expiresAt && Date.now() > Date.parse(entry.expiresAt)) {
    return { status: 'expired', code };
  }
  const key = REDEEMED_KEY_PREFIX + code;
  const usedRaw = await kvGet(key);
  const usedCount = usedRaw ? parseInt(usedRaw, 10) || 0 : 0;
  if (usedCount >= (entry.maxUses ?? 1)) {
    return { status: 'already_used', code };
  }
  // Cấp quyền lợi: seam mô phỏng đi qua setSimPro để planService (nguồn sự
  // thật về gói) áp giới hạn Pro cho toàn app ngay trong phiên.
  // TODO(backend): thay bằng API backend + RevenueCat Promotional Entitlement.
  if (entry.grant === 'PRO') {
    await setSimPro(true);
  }
  await kvSet(key, String(usedCount + 1));
  return { status: 'success', code };
}
