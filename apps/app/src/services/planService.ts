import { kvGet, kvSet } from '../db/client';
import { PLAN_LIMITS, type PlanLimits } from '../config';
import { getPlanLimitsOverride } from './remoteConfigService';

/**
 * Nguồn sự thật DUY NHẤT về gói hiện tại (FREE/PRO) và bộ giới hạn áp dụng.
 *
 * Gói hiệu lực đọc từ cờ app_kv 'plan_sim_pro': mã khuyến mại tự quản
 * (promoService) cấp Pro qua cờ này; khi paywall lên sóng, getCurrentPlan()
 * sẽ đọc entitlement từ RevenueCat thay cho cờ này (TODO(RevenueCat) dưới).
 * Mọi điểm kiểm tra giới hạn (tạo món/vị trí/ảnh) và cổng tính năng
 * (in nhãn QR…) PHẢI đi qua module này — không đọc
 * PLAN_LIMITS/CURRENT_LIMITS trực tiếp nữa.
 *
 * Bộ số giới hạn lấy từ PLAN_LIMITS ở src/config.ts (từ v75):
 * FREE = 30 món / 20 vị trí / ảnh đồ vật 3 + ảnh hiện trường 2 mỗi món,
 * PRO = không giới hạn món + vị trí, 10 + 10 ảnh, allowQrPrintPdf = true.
 */
export type PlanId = 'FREE' | 'PRO';
export type { PlanLimits };

const SIM_KEY = 'plan_sim_pro';

let cachedPlan: PlanId = 'FREE';
let loaded = false;

/** Nạp gói hiệu lực từ KV (cờ mã khuyến mại) vào cache — gọi khi app khởi động */
export async function loadPlan(): Promise<PlanId> {
  try {
    cachedPlan = (await kvGet(SIM_KEY)) === '1' ? 'PRO' : 'FREE';
  } catch {
    cachedPlan = 'FREE';
  }
  loaded = true;
  return cachedPlan;
}

/** Gói hiện tại (nạp từ KV nếu phiên này chưa nạp) */
export async function getCurrentPlan(): Promise<PlanId> {
  return loaded ? cachedPlan : loadPlan();
}

/** Đọc đồng bộ từ cache — dùng trong render/handler sau khi app đã khởi động */
export function getPlanSync(): PlanId {
  return cachedPlan;
}

/**
 * Cấp/thu hồi quyền lợi tương đương Pro qua cờ mã khuyến mại — CHỈ
 * promoService gọi (khi đổi mã thành công). Khi paywall lên sóng, thay bằng
 * entitlement RevenueCat ở đợt paywall (TODO(RevenueCat)).
 */
export async function setSimPro(enabled: boolean): Promise<PlanId> {
  cachedPlan = enabled ? 'PRO' : 'FREE';
  loaded = true;
  try {
    await kvSet(SIM_KEY, enabled ? '1' : '0');
  } catch {
    // best-effort: cache vẫn giữ giá trị mới trong phiên này
  }
  return cachedPlan;
}

/**
 * Bộ giới hạn của một gói = giới hạn mặc định trong code, GHI ĐÈ bằng
 * plan_limits_override từ máy chủ (nếu có). Ghi đè áp cho gói hiện tại của
 * người dùng — kể cả khi đang Free hay Pro — và chỉ gồm các khóa đúng tên
 * trường PLAN_LIMITS; khóa lạ không ảnh hưởng gì (không có điểm nào đọc).
 * Chưa nạp được cấu hình thì override = null, dùng mặc định (offline-first).
 */
export function getLimits(plan: PlanId): PlanLimits {
  const override = getPlanLimitsOverride();
  if (!override) return PLAN_LIMITS[plan];
  // PlanLimits là union của 2 literal type (FREE/PRO) nên object sau khi
  // spread không còn khớp literal — ép kiểu có chủ đích: khóa đã được
  // Partial<PlanLimits> giới hạn, giá trị runtime vẫn đúng kiểu number/boolean.
  return { ...PLAN_LIMITS[plan], ...override } as PlanLimits;
}

/** Bộ giới hạn của gói hiện tại (đồng bộ, từ cache) */
export function getCurrentLimits(): PlanLimits {
  return getLimits(cachedPlan);
}
