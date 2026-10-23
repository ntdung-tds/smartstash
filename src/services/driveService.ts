import '../lib/cryptoPolyfill';
import * as SecureStore from 'expo-secure-store';
import {
  GoogleSignin,
  isErrorWithCode,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import { kvGet, kvSet } from '../db/client';
import { DRIVE_CLIENT_IDS, isDriveConfigured } from '../config';
import { collectData, parseBackupPayload, restoreData } from './backupService';
import {
  BackupError,
  decryptDriveEnvelope,
  encryptByMasterKey,
  generateMasterKey,
  unwrapMasterKey,
  wrapMasterKey,
  type WrappedMasterKey,
} from './backupCrypto';

export { BackupError };

/**
 * Sao lưu Google Drive của khách (BYOC — Phase 5) qua Drive REST API v3.
 *
 * Mô hình bảo mật (theo V21-12): dữ liệu mã hoá bằng KHOÁ CHÍNH ngẫu nhiên
 * 32 byte TRƯỚC khi rời máy (phong bì v2 ở backupCrypto.ts). Khoá chính:
 * - lưu trong SecureStore của máy này ('drive_master_key') để sao lưu /
 *   khôi phục hằng ngày không cần gõ lại mật khẩu;
 * - được BỌC bằng mật khẩu sao lưu Drive của người dùng — blob đã bọc đi
 *   kèm trong từng phong bì .ssbak trên Drive, nên sang máy mới chỉ cần
 *   mật khẩu là khôi phục được. Mật khẩu KHÔNG lưu ở bất cứ đâu.
 *
 * Đăng nhập Google là NATIVE (@react-native-google-signin/google-signin):
 * bấm Kết nối mở hộp thoại chọn tài khoản của Google Play Services ngay
 * trong máy (không qua trình duyệt như luồng đăng nhập cũ). SDK tự
 * giữ phiên đăng nhập + tự làm tươi access token (getTokens) — app KHÔNG
 * còn tự lưu access/refresh token ở SecureStore như trước.
 * Toàn bộ lớp này chỉ hoạt động khi DRIVE_CLIENT_IDS đã được điền trong
 * src/config.ts (isDriveConfigured) — chưa cấu hình thì UI ẩn luồng kết nối.
 */

const MASTER_KEY_STORE = 'drive_master_key';
const WRAPPED_KEY_STORE = 'drive_wrapped_key';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

/** Số bản sao lưu giữ lại trên Drive — bản cũ hơn tự xoá sau mỗi lần tải lên */
export const DRIVE_KEEP_BACKUPS = 5;

export class DriveError extends Error {
  code:
    | 'NOT_CONFIGURED'
    | 'NOT_CONNECTED'
    | 'NO_MASTER_KEY'
    | 'PASSWORD_REQUIRED'
    | 'AUTH'
    | 'NETWORK'
    | 'PLAY_SERVICES';

  constructor(code: DriveError['code'], message: string) {
    super(message);
    this.name = 'DriveError';
    this.code = code;
  }
}

export interface DriveBackupFile {
  id: string;
  name: string;
  createdTime?: string;
}

/* --------------------- Đăng nhập Google (SDK native) --------------------- */

let googleConfigured = false;

/**
 * Cấu hình SDK Google Sign-In đúng 1 lần (lười — chỉ chạy khi thật sự cần
 * tới Drive). Chỉ cần WEB Client ID: trên Android, Play Services tự đối
 * chiếu package + SHA-1 của app với Android OAuth client đã đăng ký trên
 * Google Cloud, không cần redirect URI như luồng trình duyệt cũ.
 */
function ensureGoogleConfigured(): void {
  if (googleConfigured) return;
  googleConfigured = true;
  GoogleSignin.configure({
    webClientId: DRIVE_CLIENT_IDS.web,
    scopes: [DRIVE_SCOPE],
    offlineAccess: false,
  });
}

export type DriveConnectResult =
  | { status: 'connected'; email: string | null }
  | { status: 'cancelled' };

/**
 * Kết nối Drive: kiểm tra Google Play Services rồi mở hộp thoại chọn tài
 * khoản native của Google — chọn 1 chạm, không mở trình duyệt.
 * - Người dùng đóng/huỷ picker → trả { status: 'cancelled' } để UI im lặng.
 * - Máy thiếu/chưa cập nhật Play Services → DriveError('PLAY_SERVICES')
 *   để UI báo rõ thay vì lỗi chung chung.
 * - Lỗi native khác (kể cả DEVELOPER_ERROR khi package/SHA-1 lệch đăng ký)
 *   ném nguyên lên UI để hiển thị.
 */
export async function connectDrive(): Promise<DriveConnectResult> {
  if (!isDriveConfigured()) {
    throw new DriveError('NOT_CONFIGURED', 'Drive chưa được cấu hình Client ID');
  }
  ensureGoogleConfigured();
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  } catch (e) {
    if (isErrorWithCode(e) && e.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
      throw new DriveError('PLAY_SERVICES', 'Thiết bị không có Google Play Services');
    }
    throw e;
  }
  const res = await GoogleSignin.signIn();
  if (res.type === 'cancelled') return { status: 'cancelled' };
  return { status: 'connected', email: res.data.user.email ?? null };
}

/** SDK còn giữ phiên đăng nhập Google hay không */
export async function isDriveConnected(): Promise<boolean> {
  ensureGoogleConfigured();
  try {
    return GoogleSignin.hasPreviousSignIn();
  } catch {
    return false;
  }
}

/** Trạng thái kết nối + email của phiên SDK hiện tại, để UI hiện "Đã kết nối: …" */
export async function getDriveConnectionInfo(): Promise<{ connected: boolean; email: string | null }> {
  ensureGoogleConfigured();
  try {
    if (!GoogleSignin.hasPreviousSignIn()) return { connected: false, email: null };
    const user = GoogleSignin.getCurrentUser();
    return { connected: true, email: user?.user.email ?? null };
  } catch {
    return { connected: false, email: null };
  }
}

/**
 * Ngắt kết nối Drive: THU HỒI quyền đã cấp (revokeAccess) để lần kết nối
 * sau hiện lại trình chọn tài khoản (đổi tài khoản được), rồi đăng xuất
 * khỏi SDK (signOut). Khoá chính trong SecureStore được GIỮ LẠI có chủ
 * đích — kết nối lại sau này vẫn giải mã được các bản sao lưu cũ trên
 * Drive mà không cần biết mật khẩu.
 */
export async function disconnectDrive(): Promise<void> {
  ensureGoogleConfigured();
  try {
    await GoogleSignin.revokeAccess();
  } catch {
    // best-effort
  }
  try {
    await GoogleSignin.signOut();
  } catch {
    // best-effort
  }
}

/**
 * Access token cho Drive REST: SDK tự giữ phiên + tự làm tươi token, JS
 * không lưu token ở bất cứ đâu (khác hẳn luồng cũ tự giữ
 * refresh token trong SecureStore).
 */
export async function getValidAccessToken(): Promise<string> {
  ensureGoogleConfigured();
  if (!GoogleSignin.hasPreviousSignIn()) {
    throw new DriveError('NOT_CONNECTED', 'Chưa kết nối Google Drive');
  }
  try {
    const { accessToken } = await GoogleSignin.getTokens();
    return accessToken;
  } catch {
    throw new DriveError('AUTH', 'Không lấy được token Google — hãy kết nối lại');
  }
}

/**
 * fetch kèm Authorization; gặp 401 thì xoá access token SDK đang cache,
 * xin token mới 1 lần rồi thử lại (tương đương refresh ở luồng cũ).
 */
async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await getValidAccessToken();
  const withAuth = (bearer: string): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${bearer}` },
  });
  let res: Response;
  try {
    res = await fetch(url, withAuth(token));
  } catch {
    throw new DriveError('NETWORK', 'Không kết nối được tới Google Drive');
  }
  if (res.status === 401) {
    await GoogleSignin.clearCachedAccessToken(token).catch(() => {});
    let fresh: string;
    try {
      fresh = (await GoogleSignin.getTokens()).accessToken;
    } catch {
      throw new DriveError('AUTH', 'Phiên đăng nhập Google đã hết hạn — hãy kết nối lại');
    }
    try {
      res = await fetch(url, withAuth(fresh));
    } catch {
      throw new DriveError('NETWORK', 'Không kết nối được tới Google Drive');
    }
    if (res.status === 401) {
      throw new DriveError('AUTH', 'Phiên đăng nhập Google đã hết hạn — hãy kết nối lại');
    }
  }
  return res;
}

/* --------------------------- Drive REST ---------------------------- */

/** Danh sách các bản .ssbak trong appDataFolder, mới nhất trước */
export async function listDriveBackups(): Promise<DriveBackupFile[]> {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    fields: 'files(id,name,createdTime)',
    orderBy: 'createdTime desc',
    pageSize: '50',
  });
  const res = await driveFetch(`${DRIVE_API}/files?${params.toString()}`);
  if (!res.ok) throw new DriveError('NETWORK', `Drive list lỗi ${res.status}`);
  const json = (await res.json()) as { files?: DriveBackupFile[] };
  return (json.files ?? []).filter((f) => f.name.endsWith('.ssbak'));
}

/** Tải 1 file lên appDataFolder bằng upload multipart (metadata + nội dung JSON text) */
export async function uploadDriveBackup(name: string, content: string): Promise<DriveBackupFile> {
  const boundary = `ssbak${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
  const metadata = JSON.stringify({ name, parents: ['appDataFolder'] });
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n' +
    `${content}\r\n` +
    `--${boundary}--`;
  const res = await driveFetch(`${UPLOAD_API}?uploadType=multipart&fields=id,name,createdTime`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new DriveError('NETWORK', `Drive upload lỗi ${res.status}`);
  return (await res.json()) as DriveBackupFile;
}

/** Tải nội dung 1 file trên Drive về dạng text */
export async function downloadDriveFile(id: string): Promise<string> {
  const res = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`);
  if (!res.ok) throw new DriveError('NETWORK', `Drive download lỗi ${res.status}`);
  return res.text();
}

export async function deleteDriveFile(id: string): Promise<void> {
  const res = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new DriveError('NETWORK', `Drive delete lỗi ${res.status}`);
}

/** Xoay vòng: chỉ giữ DRIVE_KEEP_BACKUPS bản mới nhất, xoá các bản cũ hơn */
async function rotateDriveBackups(): Promise<void> {
  const files = await listDriveBackups();
  for (const extra of files.slice(DRIVE_KEEP_BACKUPS)) {
    await deleteDriveFile(extra.id).catch(() => {});
  }
}

/* ---------------------------- Khoá chính ---------------------------- */

export async function hasDriveMasterKey(): Promise<boolean> {
  try {
    return !!(await SecureStore.getItemAsync(MASTER_KEY_STORE));
  } catch {
    return false;
  }
}

async function getMasterKey(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(MASTER_KEY_STORE);
  } catch {
    return null;
  }
}

async function getStoredWrappedKey(): Promise<WrappedMasterKey | null> {
  try {
    const raw = await SecureStore.getItemAsync(WRAPPED_KEY_STORE);
    return raw ? (JSON.parse(raw) as WrappedMasterKey) : null;
  } catch {
    return null;
  }
}

/**
 * Đặt mật khẩu sao lưu Drive lần đầu: sinh khoá chính 32 byte, lưu khoá
 * chính + blob đã bọc bằng mật khẩu vào SecureStore. Blob đã bọc còn được
 * ghi kèm trong mọi phong bì sao lưu để khôi phục ở máy mới bằng mật khẩu.
 */
export async function setupDriveMasterKey(password: string): Promise<void> {
  const masterKey = generateMasterKey();
  const wrapped = await wrapMasterKey(masterKey, password);
  await SecureStore.setItemAsync(MASTER_KEY_STORE, masterKey);
  await SecureStore.setItemAsync(WRAPPED_KEY_STORE, JSON.stringify(wrapped));
}

/* ------------------------- Sao lưu / khôi phục ------------------------- */

function driveBackupFileName(now: Date): string {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return `smartstash-${d.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.ssbak`;
}

async function recordDriveStatus(ok: boolean): Promise<void> {
  try {
    if (ok) await kvSet('drive_last_at', new Date().toISOString());
    await kvSet('drive_last_status', ok ? 'ok' : 'error');
  } catch {
    // ghi trạng thái là phụ trợ — không để nó che lỗi chính
  }
}

/**
 * Tạo 1 bản sao lưu mã hoá v2 và đẩy lên Drive của khách, xoay vòng giữ
 * 5 bản mới nhất. Ghi app_kv drive_last_at/drive_last_status sau mỗi lượt.
 */
export async function createDriveBackup(): Promise<{ id: string; name: string }> {
  try {
    if (!isDriveConfigured()) throw new DriveError('NOT_CONFIGURED', 'Drive chưa được cấu hình Client ID');
    const masterKey = await getMasterKey();
    if (!masterKey) throw new DriveError('NO_MASTER_KEY', 'Chưa đặt mật khẩu sao lưu Drive');
    const wrapped = await getStoredWrappedKey();
    if (!wrapped) throw new DriveError('NO_MASTER_KEY', 'Thiếu blob khoá đã bọc trong SecureStore');
    const payload = await collectData();
    const fileText = await encryptByMasterKey(JSON.stringify(payload), masterKey, wrapped);
    const file = await uploadDriveBackup(driveBackupFileName(new Date()), fileText);
    await rotateDriveBackups().catch(() => {});
    await recordDriveStatus(true);
    return { id: file.id, name: file.name };
  } catch (e) {
    await recordDriveStatus(false);
    throw e;
  }
}

/**
 * Khôi phục từ 1 bản trên Drive: download → giải mã → ghi đè dữ liệu.
 * - Máy này còn khoá chính → giải trực tiếp; khoá không khớp (bản sao lưu
 *   của máy khác) thì fallback sang mật khẩu nếu UI truyền vào.
 * - Không có khoá chính (máy mới) → BẮT BUỘC có `password`; thiếu thì ném
 *   DriveError('PASSWORD_REQUIRED') để UI mở modal xin mật khẩu.
 * Sau khi giải bằng mật khẩu thành công, khoá chính + blob đã bọc của bản
 * sao lưu được nhận về SecureStore để các lần sau không cần mật khẩu nữa.
 */
export async function restoreFromDrive(fileId: string, password?: string): Promise<void> {
  const fileText = await downloadDriveFile(fileId);
  const masterKey = await getMasterKey();
  let plain: string | null = null;
  if (masterKey) {
    try {
      plain = await decryptDriveEnvelope(fileText, { masterKey });
    } catch (e) {
      if (!(e instanceof BackupError && e.code === 'WRONG_PASSWORD')) throw e;
      // Khoá chính của máy không mở được bản này → thử bằng mật khẩu bên dưới
    }
  }
  if (plain === null) {
    if (!password) {
      throw new DriveError('PASSWORD_REQUIRED', 'Cần mật khẩu sao lưu Drive để khôi phục trên máy này');
    }
    plain = await decryptDriveEnvelope(fileText, { password });
    // Nhận khoá chính của bản sao lưu về máy này cho các lần sau
    try {
      const envelope = JSON.parse(fileText) as { wrappedKey: WrappedMasterKey };
      const recovered = await unwrapMasterKey(envelope.wrappedKey, password);
      await SecureStore.setItemAsync(MASTER_KEY_STORE, recovered);
      await SecureStore.setItemAsync(WRAPPED_KEY_STORE, JSON.stringify(envelope.wrappedKey));
    } catch {
      // Không nhận được khoá thì lần khôi phục sau lại hỏi mật khẩu — không chặn khôi phục lần này
    }
  }
  await restoreData(parseBackupPayload(plain));
}

/**
 * Tự động sao lưu nền khi mở app (gọi từ _layout sau init): chỉ chạy khi
 * đã cấu hình + SDK còn phiên đăng nhập + bật công tắc drive_auto + có
 * khoá chính + bản gần nhất đã quá 24 giờ (hoặc chưa có). Mọi lỗi đều bị
 * nuốt — chỉ ghi drive_last_status, TUYỆT ĐỐI không làm phiền người dùng
 * lúc mở app.
 */
export async function runAutoDriveBackupIfDue(): Promise<void> {
  try {
    if (!isDriveConfigured()) return;
    if ((await kvGet('drive_auto')) !== '1') return;
    if (!(await isDriveConnected())) return;
    if (!(await hasDriveMasterKey())) return;
    const lastAt = await kvGet('drive_last_at');
    if (lastAt) {
      const ageMs = Date.now() - new Date(lastAt).getTime();
      if (Number.isFinite(ageMs) && ageMs < 24 * 60 * 60 * 1000) return;
    }
    await createDriveBackup();
  } catch {
    // createDriveBackup đã ghi drive_last_status='error' — nuốt lỗi tại đây
  }
}
