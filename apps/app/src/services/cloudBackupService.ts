import { collectData, restoreData, parseBackupPayload } from './backupService';
import { decryptBackupText, encryptBackupText } from './backupCrypto';
import {
  getCloudApiUrl,
  getOrCreateCloudAccount,
  getStorageTier,
} from './storagePlanService';

/**
 * Sao lưu "mây của tôi" (Phase 6) — app ↔ Worker qua HTTPS.
 *
 * - Payload dùng chung định dạng backup v1 (collectData/restoreData), nhưng
 *   ảnh được nén thêm một bước trước khi mã hoá (collectData({ compressImages: true })).
 * - File .ssbak mã hoá zero-knowledge bằng mật khẩu người dùng — máy chủ chỉ
 *   thấy bytes mã hoá, không thấy dữ liệu thật.
 * - Máy chủ giữ đúng 2 bản mới nhất + kiểm tra hạn mức theo gói (xem Worker).
 * - Mật khẩu KHÔNG lưu ở bất cứ đâu (giống backup file/Drive).
 */

export class CloudBackupError extends Error {
  code:
    | 'NOT_CONFIGURED'
    | 'UNAUTHORIZED'
    | 'QUOTA_EXCEEDED'
    | 'STORAGE_NOT_CONFIGURED'
    | 'NOT_FOUND'
    | 'NETWORK'
    | 'SERVER';
  constructor(
    code: CloudBackupError['code'],
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

export interface CloudBackupFile {
  name: string;
  size: number;
  updatedAt: string | null;
}

export interface CloudUsage {
  tier_mb: number;
  quota_bytes: number;
  used_bytes: number;
  files: CloudBackupFile[];
}

async function apiBase(): Promise<string> {
  const url = (await getCloudApiUrl()).trim();
  if (!url) {
    throw new CloudBackupError('NOT_CONFIGURED', 'Chưa nhập địa chỉ máy chủ.');
  }
  return url.replace(/\/+$/, '');
}

async function authHeaders(): Promise<Record<string, string>> {
  const { accountId, token } = await getOrCreateCloudAccount();
  return { 'X-Account-Id': accountId, Authorization: `Bearer ${token}` };
}

function fileNameForNow(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `SmartStash-Backup-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.ssbak`;
}

async function readErrorBody(res: Response): Promise<{ error?: string; message?: string } | null> {
  try {
    return (await res.json()) as { error?: string; message?: string };
  } catch {
    return null;
  }
}

function toCloudError(res: Response, body: { error?: string; message?: string } | null): CloudBackupError {
  const msg = body?.message ?? `Máy chủ báo lỗi (${res.status}).`;
  switch (body?.error) {
    case 'unauthorized':
      return new CloudBackupError('UNAUTHORIZED', msg);
    case 'quota_exceeded':
      return new CloudBackupError('QUOTA_EXCEEDED', msg);
    case 'storage_not_configured':
      return new CloudBackupError('STORAGE_NOT_CONFIGURED', msg);
    case 'not_found':
      return new CloudBackupError('NOT_FOUND', msg);
    default:
      return new CloudBackupError('SERVER', msg);
  }
}

/**
 * Sao lưu toàn bộ dữ liệu lên mây: thu thập (nén ảnh) → mã hoá → upload.
 * Trả về danh sách bản còn lại trên mây sau khi máy chủ xoay vòng (tối đa 2).
 */
export async function uploadCloudBackup(password: string): Promise<{
  name: string;
  size: number;
  tier_mb: number;
  files: CloudBackupFile[];
}> {
  const base = await apiBase();
  const tier = await getStorageTier();
  const payload = await collectData({ compressImages: true });
  const fileText = await encryptBackupText(JSON.stringify(payload), password);
  const name = fileNameForNow();
  let res: Response;
  try {
    res = await fetch(`${base}/api/backups/upload`, {
      method: 'POST',
      headers: {
        ...(await authHeaders()),
        'X-File-Name': name,
        'X-Tier-Mb': String(tier),
        'Content-Type': 'application/octet-stream',
      },
      body: fileText,
    });
  } catch {
    throw new CloudBackupError('NETWORK', 'Không kết nối được tới máy chủ.');
  }
  if (!res.ok) throw toCloudError(res, await readErrorBody(res));
  const data = (await res.json()) as {
    name: string;
    size: number;
    tier_mb: number;
    files: CloudBackupFile[];
  };
  return { name: data.name, size: data.size, tier_mb: data.tier_mb, files: data.files ?? [] };
}

/** Liệt kê các bản sao lưu trên mây của tài khoản này */
export async function listCloudBackups(): Promise<{ tier_mb: number; files: CloudBackupFile[] }> {
  const base = await apiBase();
  let res: Response;
  try {
    res = await fetch(`${base}/api/backups/list`, { headers: await authHeaders() });
  } catch {
    throw new CloudBackupError('NETWORK', 'Không kết nối được tới máy chủ.');
  }
  if (!res.ok) throw toCloudError(res, await readErrorBody(res));
  const data = (await res.json()) as { tier_mb: number; files: CloudBackupFile[] };
  return { tier_mb: data.tier_mb, files: data.files ?? [] };
}

/** Dung lượng đã dùng / hạn mức gói */
export async function getCloudUsage(): Promise<CloudUsage> {
  const base = await apiBase();
  let res: Response;
  try {
    res = await fetch(`${base}/api/backups/usage-account`, { headers: await authHeaders() });
  } catch {
    throw new CloudBackupError('NETWORK', 'Không kết nối được tới máy chủ.');
  }
  if (!res.ok) throw toCloudError(res, await readErrorBody(res));
  const data = (await res.json()) as CloudUsage;
  return { ...data, files: data.files ?? [] };
}

/** Đổi gói lưu trữ (đồng bộ lên máy chủ) */
export async function setCloudTier(mb: number): Promise<number> {
  const base = await apiBase();
  let res: Response;
  try {
    res = await fetch(`${base}/api/backups/tier`, {
      method: 'POST',
      headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier_mb: mb }),
    });
  } catch {
    throw new CloudBackupError('NETWORK', 'Không kết nối được tới máy chủ.');
  }
  if (!res.ok) throw toCloudError(res, await readErrorBody(res));
  const data = (await res.json()) as { tier_mb: number };
  return data.tier_mb;
}

/**
 * Khôi phục từ một bản trên mây: tải về → giải mã → validate → ghi đè
 * toàn bộ dữ liệu hiện tại (giống khôi phục từ file/Drive).
 */
export async function downloadCloudBackup(name: string, password: string): Promise<void> {
  const base = await apiBase();
  let res: Response;
  try {
    res = await fetch(`${base}/api/backups/download?name=${encodeURIComponent(name)}`, {
      headers: await authHeaders(),
    });
  } catch {
    throw new CloudBackupError('NETWORK', 'Không kết nối được tới máy chủ.');
  }
  if (!res.ok) throw toCloudError(res, await readErrorBody(res));
  const fileText = await res.text();
  const plain = await decryptBackupText(fileText, password);
  await restoreData(parseBackupPayload(plain));
}
