import * as Crypto from 'expo-crypto';
import { ADMIN_WORKER_URL } from '../config';
import { kvGet, kvSet } from '../db/client';
import { getStoragePlans } from './remoteConfigService';

/**
 * Gói lưu trữ "mây của tôi" (Phase 6) — chọn gói, hạn mức, tài khoản mây.
 *
 * - Gói: bảng từ cờ storage_plans (mặc định 100MB / 200MB / 500MB / 1GB,
 *   quy ước 1GB = 1000MB, khớp phía máy chủ). Giá năm chốt 25/10/2026:
 *   299k / 349k / 449k / 599k (đã gồm phí Play 15% + thuế TNCN VN 10%) —
 *   đổi giá sau này chỉ cần sửa trên trang quản trị, không cần bản app mới
 *   (app đọc lại cờ mỗi lần mở app và vào Cài đặt).
 * - Tài khoản mây: app tự tạo account_id (UUID) + token (32 byte hex), lưu
 *   ở app_kv trên máy — máy chủ chỉ lưu hash token (TOFU, xem Worker).
 * - Máy chủ mây: cố định là Worker live của SmartStash (ADMIN_WORKER_URL
 *   trong config.ts) — người dùng không bao giờ phải nhập URL máy chủ.
 *   Giá trị app_kv cloud_api_url cũ (nếu máy nào từng lưu) từ nay bị bỏ qua,
 *   không cần migration xoá key.
 */

export const STORAGE_TIERS_MB = [100, 200, 500, 1000] as const;
export type StorageTierMb = (typeof STORAGE_TIERS_MB)[number];
export const DEFAULT_STORAGE_TIER_MB: StorageTierMb = 100;

/** Dung lượng (MB) được phép theo cờ hiện tại (rớt về bảng cứng nếu cờ rỗng) */
export function allowedStorageTiersMb(): number[] {
  const sizes = getStoragePlans().map((p) => p.sizeMb);
  return sizes.length > 0 ? sizes : [...STORAGE_TIERS_MB];
}

const TIER_KEY = 'cloud_storage_tier_mb';
const ACCOUNT_ID_KEY = 'cloud_account_id';
const TOKEN_KEY = 'cloud_account_token';

let cachedTier: number | null = null;

export function storageQuotaBytes(tierMb: number): number {
  return tierMb * 1000 * 1000;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1000 * 1000) return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
  if (bytes >= 1000) return `${(bytes / 1000).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** Gói hiện tại (mặc định = gói nhỏ nhất trong bảng) */
export async function getStorageTier(): Promise<number> {
  const allowed = allowedStorageTiersMb();
  if (cachedTier !== null) return allowed.includes(cachedTier) ? cachedTier : allowed[0];
  try {
    const raw = await kvGet(TIER_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    cachedTier = allowed.includes(n) ? n : allowed[0];
  } catch {
    cachedTier = allowed[0];
  }
  return cachedTier;
}

/** Đổi gói (chỉ lưu ở máy — đồng bộ lên máy chủ khi upload/tier lần tới) */
export async function setStorageTier(mb: number): Promise<void> {
  if (!allowedStorageTiersMb().includes(mb)) return;
  cachedTier = mb;
  try {
    await kvSet(TIER_KEY, String(mb));
  } catch {
    // best-effort: cache vẫn giữ giá trị mới trong phiên này
  }
}

/** Địa chỉ máy chủ mây: luôn là Worker live của SmartStash (cố định). */
export async function getCloudApiUrl(): Promise<string> {
  return ADMIN_WORKER_URL;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function formatUuid(bytes: Uint8Array): string {
  const h = toHex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Tạo hoặc đọc tài khoản mây của máy này (id + token đều ở app_kv) */
export async function getOrCreateCloudAccount(): Promise<{ accountId: string; token: string }> {
  let accountId: string | null = null;
  let token: string | null = null;
  try {
    accountId = await kvGet(ACCOUNT_ID_KEY);
    token = await kvGet(TOKEN_KEY);
  } catch {
    // đọc lỗi → tạo mới bên dưới
  }
  if (!accountId || !token) {
    const idBytes = await Crypto.getRandomBytesAsync(16);
    const tokenBytes = await Crypto.getRandomBytesAsync(32);
    accountId = formatUuid(idBytes);
    token = toHex(tokenBytes);
    try {
      await kvSet(ACCOUNT_ID_KEY, accountId);
      await kvSet(TOKEN_KEY, token);
    } catch {
      // best-effort: vẫn dùng trong phiên này
    }
  }
  return { accountId, token };
}
