/**
 * Cấu hình từ xa — nơi DUY NHẤT app đọc các công tắc vận hành cần đổi mà
 * không phát hành bản mới (feature flag / kill switch, theo Mảng 7 của Bản
 * đồ vận hành). Nguồn thật: GET {ADMIN_WORKER_URL}/api/config trên Worker
 * quản trị (đọc công khai, không cần đăng nhập) — trang quản trị PWA sửa
 * các cờ này, app nhận ở lần mở app tiếp theo và mỗi lần vào Cài đặt.
 *
 * Nguyên tắc an toàn (giữ từ bản seam cũ): nếu chưa nạp được cấu hình (mở
 * app lần đầu, lỗi mạng…) thì dùng giá trị đã cache trong app_kv, rồi mới
 * tới DEFAULT_FLAGS trong code — hành vi app không bao giờ phụ thuộc vào
 * việc tải cấu hình thành công.
 *
 * Các cờ máy chủ gửi (xem Worker src/routes/config.js):
 *   self_promo_enabled   — cờ cũ cho ô nhập mã (từ v75 app không còn điểm
 *                          nhập mã nào; cờ vẫn được mang theo cho tương thích)
 *   min_version          — phiên bản tối thiểu (null = không ép cập nhật)
 *   maintenance_notice   — thông báo bảo trì (null = không hiện)
 *   plan_limits_override — ghi đè giới hạn của GÓI HIỆN TẠI (áp cho cả Free
 *                          lẫn Pro; khóa phải đúng tên trường PLAN_LIMITS,
 *                          VD {"maxActiveItems": 100, "maxItemPhotos": 5})
 *   drive_keep_backups   — số bản sao lưu giữ lại trên Drive tự quản (BYOC)
 *   cloud_backup_enabled — công tắc khoá/mở sao lưu lên "mây của tôi"
 *                          (v84: false = tạm khoá, quản trị bật là mở lại)
 *   drive_backup_enabled — công tắc khoá/mở sao lưu lên Google Drive
 *                          (v84: false = tạm khoá, quản trị bật là mở lại
 *                          luồng kết nối Drive; mặc định false cả hai để
 *                          khi chưa nạp được cấu hình app cũng khoá, không
 *                          mở nhầm đường sao lưu đang tạm dừng)
 *   backup_compress_enabled — nén ảnh trong bản sao lưu (tắt = giữ ảnh gốc)
 *   backup_max_edge / backup_quality — cạnh dài + chất lượng khi nén ảnh
 *                          cho bản sao lưu (cả 3 đường: mây, file, Drive)
 *   photo_max_edge / photo_quality — cạnh dài + chất lượng khi thêm ảnh
 *                          vào app (chuẩn nén tầng 1)
 * Lưu ý: cloud_keep_backups (số bản giữ trên "mây của tôi") chỉ dùng phía
 * máy chủ khi xoay vòng — app không cần đọc nên không có trong interface
 * này; Worker tự đọc cờ từ KV CONFIG lúc upload.
 *   storage_plans        — bảng gói lưu trữ "mây của tôi": mỗi gói gồm
 *                          sizeMb (dung lượng) + priceVnd (giá/năm, VNĐ).
 *                          Bảng chốt 25/10/2026 (có thể đổi sau từ PWA):
 *                          100MB 299k / 200MB 349k / 500MB 449k / 1GB 599k.
 */

import Constants from 'expo-constants';
import { ADMIN_WORKER_URL, type PlanLimits } from '../config';
import { kvGet, kvSet } from '../db/client';

export interface StoragePlan {
  sizeMb: number;
  priceVnd: number;
}

export interface RemoteFlags {
  selfPromoEnabled: boolean;
  minVersion: string | null;
  maintenanceNotice: string | null;
  planLimitsOverride: Partial<PlanLimits> | null;
  driveKeepBackups: number;
  cloudBackupEnabled: boolean;
  driveBackupEnabled: boolean;
  backupCompressEnabled: boolean;
  backupMaxEdge: number;
  backupQuality: number;
  photoMaxEdge: number;
  photoQuality: number;
  storagePlans: StoragePlan[];
}

const DEFAULT_FLAGS: RemoteFlags = {
  // Cờ này vẫn được mang theo từ máy chủ cho tương thích, nhưng từ v75
  // app không còn điểm nhập mã nào dùng nó (mã khuyến mại đã xoá hết).
  selfPromoEnabled: true,
  minVersion: null,
  maintenanceNotice: null,
  planLimitsOverride: null,
  driveKeepBackups: 3,
  cloudBackupEnabled: false,
  driveBackupEnabled: false,
  backupCompressEnabled: true,
  backupMaxEdge: 1024,
  backupQuality: 0.7,
  photoMaxEdge: 1280,
  photoQuality: 0.75,
  storagePlans: [
    { sizeMb: 100, priceVnd: 299000 },
    { sizeMb: 200, priceVnd: 349000 },
    { sizeMb: 500, priceVnd: 449000 },
    { sizeMb: 1000, priceVnd: 599000 },
  ],
};

const CACHE_KEY = 'remote_flags';

let cachedFlags: RemoteFlags = { ...DEFAULT_FLAGS };
let loaded = false;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Số nguyên trong miền [min, max], sai thì lấy mặc định (không tin mù cờ lạ). */
function toInt(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
}

/** Chất lượng nén trong [0.1, 1], sai thì lấy mặc định. */
function toQuality(v: unknown, fallback: number): number {
  return typeof v === 'number' && v >= 0.1 && v <= 1 ? v : fallback;
}

/** Bảng gói lưu trữ: chỉ giữ gói hợp lệ, dung lượng không trùng, xếp tăng. */
function toStoragePlans(v: unknown, fallback: StoragePlan[]): StoragePlan[] {
  if (!Array.isArray(v) || v.length === 0) return fallback;
  const seen = new Set<number>();
  const out: StoragePlan[] = [];
  for (const p of v) {
    if (!isPlainObject(p)) return fallback;
    const sizeMb = p.size_mb ?? p.sizeMb;
    const priceVnd = p.price_vnd ?? p.priceVnd;
    if (
      typeof sizeMb !== 'number' || !Number.isInteger(sizeMb) || sizeMb < 1 || sizeMb > 100000 ||
      typeof priceVnd !== 'number' || !Number.isInteger(priceVnd) || priceVnd < 0 ||
      seen.has(sizeMb)
    ) {
      return fallback;
    }
    seen.add(sizeMb);
    out.push({ sizeMb, priceVnd });
  }
  out.sort((a, b) => a.sizeMb - b.sizeMb);
  return out.length > 0 ? out : fallback;
}

/** Chuẩn hoá cờ từ server về đúng kiểu — trường sai kiểu thì bỏ qua. */
function normalizeFlags(raw: unknown): RemoteFlags {
  const out: RemoteFlags = { ...DEFAULT_FLAGS };
  if (!isPlainObject(raw)) return out;
  if (typeof raw.self_promo_enabled === 'boolean') out.selfPromoEnabled = raw.self_promo_enabled;
  if (typeof raw.min_version === 'string' && raw.min_version.trim()) {
    out.minVersion = raw.min_version.trim();
  }
  if (typeof raw.maintenance_notice === 'string' && raw.maintenance_notice.trim()) {
    out.maintenanceNotice = raw.maintenance_notice.trim();
  }
  if (isPlainObject(raw.plan_limits_override) && Object.keys(raw.plan_limits_override).length > 0) {
    out.planLimitsOverride = raw.plan_limits_override as Partial<PlanLimits>;
  }
  out.driveKeepBackups = toInt(raw.drive_keep_backups, 1, 20, DEFAULT_FLAGS.driveKeepBackups);
  if (typeof raw.cloud_backup_enabled === 'boolean') out.cloudBackupEnabled = raw.cloud_backup_enabled;
  if (typeof raw.drive_backup_enabled === 'boolean') out.driveBackupEnabled = raw.drive_backup_enabled;
  if (typeof raw.backup_compress_enabled === 'boolean') {
    out.backupCompressEnabled = raw.backup_compress_enabled;
  }
  out.backupMaxEdge = toInt(raw.backup_max_edge, 256, 4096, DEFAULT_FLAGS.backupMaxEdge);
  out.backupQuality = toQuality(raw.backup_quality, DEFAULT_FLAGS.backupQuality);
  out.photoMaxEdge = toInt(raw.photo_max_edge, 256, 4096, DEFAULT_FLAGS.photoMaxEdge);
  out.photoQuality = toQuality(raw.photo_quality, DEFAULT_FLAGS.photoQuality);
  out.storagePlans = toStoragePlans(raw.storage_plans, DEFAULT_FLAGS.storagePlans);
  return out;
}

async function readCached(): Promise<RemoteFlags | null> {
  try {
    const raw = await kvGet(CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return null;
    return normalizeFlags({
      self_promo_enabled: parsed.selfPromoEnabled,
      min_version: parsed.minVersion,
      maintenance_notice: parsed.maintenanceNotice,
      plan_limits_override: parsed.planLimitsOverride,
      drive_keep_backups: parsed.driveKeepBackups,
      cloud_backup_enabled: parsed.cloudBackupEnabled,
      drive_backup_enabled: parsed.driveBackupEnabled,
      backup_compress_enabled: parsed.backupCompressEnabled,
      backup_max_edge: parsed.backupMaxEdge,
      backup_quality: parsed.backupQuality,
      photo_max_edge: parsed.photoMaxEdge,
      photo_quality: parsed.photoQuality,
      storage_plans: parsed.storagePlans,
    });
  } catch {
    return null;
  }
}

/**
 * Nạp cấu hình ĐÃ CACHE trong máy (không chạm mạng) — dùng ở lần mở app
 * để giao diện hiện ngay mà không chờ mạng: đọc KV local chỉ mất vài ms.
 * Cờ mới từ máy chủ sẽ về sau qua loadRemoteConfig() chạy nền (fix delay
 * mở app: trước đây _layout await loadRemoteConfig() nên mạng chậm là
 * màn hình "Đang tải…" đứng tới 8 giây vì timeout của fetch).
 */
export async function loadCachedRemoteConfig(): Promise<RemoteFlags> {
  cachedFlags = (await readCached()) ?? { ...DEFAULT_FLAGS };
  return cachedFlags;
}

/**
 * Nạp cấu hình từ xa vào cache — gọi khi app khởi động (cạnh loadPlan) và
 * mỗi lần vào Cài đặt. Không bao giờ ném lỗi, không bao giờ chặn khởi động.
 */
export async function loadRemoteConfig(): Promise<RemoteFlags> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${ADMIN_WORKER_URL}/api/config`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: unknown = await res.json();
      if (!isPlainObject(data) || data.ok !== true || !isPlainObject(data.flags)) {
        throw new Error('Định dạng cấu hình không hợp lệ');
      }
      cachedFlags = normalizeFlags(data.flags);
      try {
        await kvSet(CACHE_KEY, JSON.stringify(cachedFlags));
      } catch {
        // cache lỗi thì thôi — cờ trong phiên vẫn đúng
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Mất mạng / server lỗi: dùng cache cũ, rồi mới tới mặc định.
    cachedFlags = (await readCached()) ?? { ...DEFAULT_FLAGS };
  }
  loaded = true;
  return cachedFlags;
}

/** Toàn bộ cờ hiện tại (đồng bộ, từ cache — nạp mặc định nếu chưa nạp) */
export function getRemoteFlagsSync(): RemoteFlags {
  return cachedFlags;
}

/** Đã nạp cấu hình trong phiên này chưa (chỉ để chẩn đoán/test) */
export function isRemoteConfigLoaded(): boolean {
  return loaded;
}

/**
 * Cờ ô nhập mã tự quản từ máy chủ (đồng bộ). Từ v75 app không còn điểm
 * nhập mã nào dùng cờ này — giữ lại chỉ để tương thích cấu hình từ xa.
 */
export function isSelfPromoEnabled(): boolean {
  return cachedFlags.selfPromoEnabled;
}

/** Ghi đè giới hạn gói từ máy chủ (null = dùng giới hạn mặc định trong code) */
export function getPlanLimitsOverride(): Partial<PlanLimits> | null {
  return cachedFlags.planLimitsOverride;
}

/** Thông báo bảo trì từ máy chủ (null = không hiện) */
export function getMaintenanceNotice(): string | null {
  return cachedFlags.maintenanceNotice;
}

/** Số bản sao lưu giữ lại trên Drive tự quản (mặc định 5) */
export function getDriveKeepBackups(): number {
  return cachedFlags.driveKeepBackups;
}

/** Có mở sao lưu lên "mây của tôi" không (v84: false = tạm khoá) */
export function isCloudBackupEnabled(): boolean {
  return cachedFlags.cloudBackupEnabled;
}

/** Có mở sao lưu lên Google Drive không (v84: false = tạm khoá) */
export function isDriveBackupEnabled(): boolean {
  return cachedFlags.driveBackupEnabled;
}

/** Có nén ảnh trong bản sao lưu không (tắt = giữ ảnh gốc trong bản sao lưu) */
export function isBackupCompressEnabled(): boolean {
  return cachedFlags.backupCompressEnabled;
}

/** Cạnh dài tối đa (px) khi nén ảnh cho bản sao lưu */
export function getBackupMaxEdge(): number {
  return cachedFlags.backupMaxEdge;
}

/** Chất lượng JPEG khi nén ảnh cho bản sao lưu */
export function getBackupQuality(): number {
  return cachedFlags.backupQuality;
}

/** Cạnh dài tối đa (px) khi thêm ảnh vào app */
export function getPhotoMaxEdge(): number {
  return cachedFlags.photoMaxEdge;
}

/** Chất lượng ảnh khi thêm vào app */
export function getPhotoQuality(): number {
  return cachedFlags.photoQuality;
}

/** Bảng gói lưu trữ "mây của tôi" (dung lượng + giá/năm, xếp tăng dần) */
export function getStoragePlans(): StoragePlan[] {
  return cachedFlags.storagePlans;
}

/** Phiên bản tối thiểu từ máy chủ (null = không ép cập nhật) */
export function getMinVersion(): string | null {
  return cachedFlags.minVersion;
}

/** Phiên bản hiện tại của app (lấy từ expoConfig, null nếu không đọc được) */
export function getAppVersion(): string | null {
  const v = Constants.expoConfig?.version;
  return typeof v === 'string' && v ? v : null;
}

function parseVersion(v: string): number[] {
  return v
    .split('-')[0]
    .split('.')
    .map((p) => {
      const n = parseInt(p, 10);
      return Number.isNaN(n) ? 0 : n;
    });
}

/**
 * true khi phiên bản hiện tại THẤP HƠN phiên bản tối thiểu yêu cầu.
 * So sánh từng đoạn số (1.9 < 1.10 xử lý đúng). Chỉ dùng để HIỆN BANNER
 * nhắc cập nhật trong Cài đặt — không chặn app (quyết định chặn là quyết
 * định sản phẩm, không tự đặt ở đây).
 */
export function isUpdateRequired(minVersion: string | null): boolean {
  const current = getAppVersion();
  if (!minVersion || !current) return false;
  const a = parseVersion(current);
  const b = parseVersion(minVersion);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}
