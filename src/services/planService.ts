import { kvGet, kvSet } from '../db/client';
import { PLAN_LIMITS, type PlanLimits } from '../config';

/**
 * Nguồn sự thật DUY NHẤT về gói hiện tại (FREE/PRO) và bộ giới hạn áp dụng.
 *
 * TODO(RevenueCat): khi paywall lên sóng, getCurrentPlan() sẽ đọc entitlement
 * từ RevenueCat thay cho cờ giả lập dev 'plan_sim_pro' trong app_kv. Mọi điểm
 * kiểm tra giới hạn (tạo món/vị trí/ảnh) và cổng tính năng (in nhãn QR…) PHẢI
 * đi qua module này — không đọc PLAN_LIMITS/CURRENT_LIMITS trực tiếp nữa.
 *
 * Bộ số giới hạn lấy từ PLAN_LIMITS ở src/config.ts (theo B.12 PRD v2.1):
 * FREE = 50 món / 30 vị trí / ảnh đồ vật 3 + ảnh hiện trường 2 mỗi món,
 * PRO = không giới hạn món + vị trí, 10 + 10 ảnh, allowQrPrintPdf = true.
 */
export type PlanId = 'FREE' | 'PRO';
export type { PlanLimits };

const SIM_KEY = 'plan_sim_pro';

let cachedPlan: PlanId = 'FREE';
let loaded = false;

/** Nạp gói hiệu lực từ KV (cờ giả lập) vào cache — gọi khi app khởi động */
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

/** Bộ giới hạn của một gói */
export function getLimits(plan: PlanId): PlanLimits {
  return PLAN_LIMITS[plan];
}

/** Bộ giới hạn của gói hiện tại (đồng bộ, từ cache) */
export function getCurrentLimits(): PlanLimits {
  return PLAN_LIMITS[cachedPlan];
}

/**
 * Bật/tắt giả lập gói Pro — CHỈ phục vụ kiểm tra trước phát hành,
 * thay bằng entitlement RevenueCat ở đợt paywall.
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
