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
import { getDriveKeepBackups, isDriveBackupEnabled } from './remoteConfigService';
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
export const DRIVE_KEEP_BACKUPS = 3;

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

/**
 * TÁCH LUỒNG v82 (tạm thời, cho tới khi xác minh OAuth xong):
 * - Đổi mã khuyến mãi dùng đăng nhập Google SCOPE CƠ BẢN (mặc định của
 *   SDK: email + profile, không xin drive.appdata) nên không vướng màn
 *   cảnh báo / trần của scope nhạy cảm — đổi mã chạy được ngay.
 * - Sao lưu Drive TẠM DỪNG ở tầng UI (nút Drive báo "đang phát triển",
 *   không gọi connectDrive) — các hàm Drive bên dưới vẫn giữ nguyên để
 *   mở lại chỉ bằng cách gỡ cổng ở UI, không cần viết lại service.
 * SDK cho phép configure lại: mỗi luồng tự cấu hình scope của mình trước
 * khi dùng, lần configure sau ghi đè lần trước — không dùng chung 1 cờ
 * "đã cấu hình" nữa để tránh kẹt scope Drive sang luồng đổi mã.
 */
let lastGoogleScopes: 'promo' | 'drive' | null = null;

function ensurePromoGoogleConfigured(): void {
  if (lastGoogleScopes === 'promo') return;
  lastGoogleScopes = 'promo';
  GoogleSignin.configure({
    webClientId: DRIVE_CLIENT_IDS.web,
    offlineAccess: false,
  });
}

function ensureDriveGoogleConfigured(): void {
  if (lastGoogleScopes === 'drive') return;
  lastGoogleScopes = 'drive';
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
  ensureDriveGoogleConfigured();
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
  ensureDriveGoogleConfigured();
  try {
    return GoogleSignin.hasPreviousSignIn();
  } catch {
    return false;
  }
}

/** Trạng thái kết nối + email của phiên SDK hiện tại, để UI hiện "Đã kết nối: …" */
export async function getDriveConnectionInfo(): Promise<{ connected: boolean; email: string | null; photo: string | null }> {
  ensureDriveGoogleConfigured();
  try {
    if (!GoogleSignin.hasPreviousSignIn()) return { connected: false, email: null, photo: null };
    const user = GoogleSignin.getCurrentUser();
    return { connected: true, email: user?.user.email ?? null, photo: user?.user.photo ?? null };
  } catch {
    return { connected: false, email: null, photo: null };
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
  ensureDriveGoogleConfigured();
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
 * Đổi tài khoản Google (v80): đăng xuất khỏi phiên SDK rồi đăng nhập lại
 * để hộp thoại chọn tài khoản của Google hiện ra — gọi signIn() trực tiếp
 * khi đã có phiên sẽ trả về tài khoản cũ ngay mà không hiện bảng chọn,
 * nên bắt buộc phải signOut trước. KHÔNG revokeAccess: chỉ xoá phiên,
 * quyền Drive đã cấp được giữ nguyên để tài khoản cũ kết nối lại vẫn dùng
 * được ngay.
 *
 * Giới hạn kỹ thuật (SDK 16): signOut xoá phiên TRƯỚC khi bảng chọn hiện,
 * nên nếu người dùng huỷ bảng chọn thì phiên cũ KHÔNG khôi phục lại được
 * một cách im lặng — hàm thử signInSilently() để cứu (chỉ thành công khi
 * signOut trước đó thực ra chưa xoá được phiên), nếu không được thì trả
 * 'signed_out' để UI báo rõ "bạn đã đăng xuất, hãy đăng nhập lại" thay vì
 * đăng xuất lén hay crash. Không bao giờ đổi sang tài khoản khác khi người
 * dùng chưa chọn.
 */
export type GoogleSwitchResult =
  | { status: 'switched'; email: string | null }
  | { status: 'cancelled' }
  | { status: 'signed_out' };

export async function switchGoogleAccount(): Promise<GoogleSwitchResult> {
  if (!isDriveConfigured()) {
    throw new DriveError('NOT_CONFIGURED', 'Drive chưa được cấu hình Client ID');
  }
  ensureDriveGoogleConfigured();
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  } catch (e) {
    if (isErrorWithCode(e) && e.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
      throw new DriveError('PLAY_SERVICES', 'Thiết bị không có Google Play Services');
    }
    throw e;
  }
  try {
    await GoogleSignin.signOut();
  } catch {
    // best-effort: vẫn thử mở bảng chọn bên dưới
  }
  const res = await GoogleSignin.signIn();
  if (res.type === 'cancelled') {
    // Cứu phiên cũ nếu còn cứu được (signOut trước đó chưa xoá xong).
    try {
      const silent = await GoogleSignin.signInSilently();
      if (silent.type === 'success') return { status: 'cancelled' };
    } catch {
      // không cứu được — rơi xuống 'signed_out' bên dưới
    }
    return { status: 'signed_out' };
  }
  return { status: 'switched', email: res.data.user.email ?? null };
}

/* ----------------- Đăng nhập Google cho ĐỔI MÃ (v82, scope cơ bản) ----------------- */

/**
 * Đăng nhập Google chỉ để đổi mã: scope mặc định email + profile, KHÔNG
 * xin drive.appdata nên không chạm tới xác minh scope nhạy cảm. Huỷ
 * picker → { status: 'cancelled' } để UI im lặng ở lại khối đăng nhập.
 * Dùng chung phiên SDK với Drive về mặt kỹ thuật, nhưng từ v82 UI Drive
 * không gọi signIn nữa nên phiên này thực chất chỉ phục vụ đổi mã.
 */
export async function signInForPromo(): Promise<DriveConnectResult> {
  if (!isDriveConfigured()) {
    throw new DriveError('NOT_CONFIGURED', 'Chưa được cấu hình Client ID');
  }
  ensurePromoGoogleConfigured();
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

/**
 * Đổi tài khoản Google cho luồng đổi mã (v82): cùng logic v80 (signOut
 * rồi signIn để hiện bảng chọn, không revokeAccess), chỉ khác là cấu
 * hình scope cơ bản. Huỷ bảng chọn mà phiên cũ không cứu được → trả
 * 'signed_out' để UI báo rõ, không đăng xuất lén.
 */
export async function switchPromoGoogleAccount(): Promise<GoogleSwitchResult> {
  if (!isDriveConfigured()) {
    throw new DriveError('NOT_CONFIGURED', 'Chưa được cấu hình Client ID');
  }
  ensurePromoGoogleConfigured();
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  } catch (e) {
    if (isErrorWithCode(e) && e.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
      throw new DriveError('PLAY_SERVICES', 'Thiết bị không có Google Play Services');
    }
    throw e;
  }
  try {
    await GoogleSignin.signOut();
  } catch {
    // best-effort: vẫn thử mở bảng chọn bên dưới
  }
  const res = await GoogleSignin.signIn();
  if (res.type === 'cancelled') {
    try {
      const silent = await GoogleSignin.signInSilently();
      if (silent.type === 'success') return { status: 'cancelled' };
    } catch {
      // không cứu được — rơi xuống 'signed_out' bên dưới
    }
    return { status: 'signed_out' };
  }
  return { status: 'switched', email: res.data.user.email ?? null };
}

/** Trạng thái đăng nhập + email của phiên đổi mã (scope cơ bản) */
/**
 * Trạng thái luồng đổi mã + ảnh đại diện Google (v84): SDK trả user.photo
 * (URL lh3.googleusercontent.com, truy cập công khai, không cần token) —
 * trước đây chỉ lấy email nên thẻ tài khoản chỉ hiện placeholder tím.
 * photo = null khi tài khoản không có ảnh (khi đó UI giữ placeholder).
 */
export async function getPromoConnectionInfo(): Promise<{ connected: boolean; email: string | null; photo: string | null }> {
  ensurePromoGoogleConfigured();
  try {
    if (!GoogleSignin.hasPreviousSignIn()) return { connected: false, email: null, photo: null };
    const user = GoogleSignin.getCurrentUser();
    return { connected: true, email: user?.user.email ?? null, photo: user?.user.photo ?? null };
  } catch {
    return { connected: false, email: null, photo: null };
  }
}

/**
 * Access token cho Drive REST: SDK tự giữ phiên + tự làm tươi token, JS
 * không lưu token ở bất cứ đâu (khác hẳn luồng cũ tự giữ
 * refresh token trong SecureStore).
 */
export async function getValidAccessToken(): Promise<string> {
  ensureDriveGoogleConfigured();
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
 * ID token Google cho luồng đổi mã khuyến mãi (v78, v82 tách scope cơ
 * bản): SDK tự giữ phiên + tự làm tươi token giống access token; Worker
 * tự kiểm tra token này với Google rồi mới lấy định danh tài khoản thật
 * — app KHÔNG BAO GIỜ tự ghi ID tài khoản gửi lên máy chủ. Trả null khi
 * chưa đăng nhập hoặc SDK không cấp được ID token (để UI hiện nút đăng
 * nhập thay vì báo lỗi chung).
 */
export async function getGoogleIdToken(): Promise<string | null> {
  ensurePromoGoogleConfigured();
  if (!GoogleSignin.hasPreviousSignIn()) return null;
  try {
    const { idToken } = await GoogleSignin.getTokens();
    return idToken || null;
  } catch {
    return null;
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

/** Xoay vòng: chỉ giữ số bản theo cờ drive_keep_backups (mặc định
 * DRIVE_KEEP_BACKUPS = 3), xoá các bản cũ hơn */
async function rotateDriveBackups(): Promise<void> {
  const files = await listDriveBackups();
  const keep = getDriveKeepBackups() || DRIVE_KEEP_BACKUPS;
  for (const extra of files.slice(keep)) {
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

/** app_kv: đã hiện cảnh báo mất sao lưu cho lần phát hiện hiện tại chưa */
const MISSING_WARNED_KEY = 'drive_missing_warned';

async function recordDriveStatus(ok: boolean): Promise<void> {
  try {
    if (ok) {
      await kvSet('drive_last_at', new Date().toISOString());
      // Sao lưu thành công = đã có bản mới trên Drive: xoá cờ "đã cảnh
      // báo mất sao lưu" để nếu SAU NÀY sao lưu lại mất tiếp thì cảnh báo
      // được hiện lại (mỗi lần mất là một lần báo mới).
      await kvSet(MISSING_WARNED_KEY, '0');
    }
    await kvSet('drive_last_status', ok ? 'ok' : 'error');
  } catch {
    // ghi trạng thái là phụ trợ — không để nó che lỗi chính
  }
}

/**
 * Tạo 1 bản sao lưu mã hoá v2 và đẩy lên Drive của khách, xoay vòng giữ
 * số bản theo cờ drive_keep_backups (mặc định 3). Ghi app_kv
 * drive_last_at/drive_last_status sau mỗi lượt. Ảnh trong bản sao lưu
 * được nén như bản sao lưu mây (theo cờ backup_*) để file nhẹ hơn — ảnh
 * gốc trên máy không bị đụng.
 */
export async function createDriveBackup(): Promise<{ id: string; name: string }> {
  try {
    if (!isDriveConfigured()) throw new DriveError('NOT_CONFIGURED', 'Drive chưa được cấu hình Client ID');
    const masterKey = await getMasterKey();
    if (!masterKey) throw new DriveError('NO_MASTER_KEY', 'Chưa đặt mật khẩu sao lưu Drive');
    const wrapped = await getStoredWrappedKey();
    if (!wrapped) throw new DriveError('NO_MASTER_KEY', 'Thiếu blob khoá đã bọc trong SecureStore');
    const payload = await collectData({ compressImages: true });
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
 * Phát hiện sao lưu trên Drive BỊ MẤT (đặc tả Mảng 8 của Bản đồ vận hành):
 * danh sách bản sao lưu trên Drive RỖNG trong khi máy còn dấu vết ĐÃ TỪNG
 * sao lưu thành công (app_kv drive_last_at) — nghĩa là thư mục/file sao
 * lưu có thể đã bị người dùng xoá hoặc chuyển vào Thùng rác trên Drive.
 *
 * Trả true = "cần hiện cảnh báo NGAY lần này". Chống nhắc phiền: mỗi lần
 * phát hiện chỉ báo đúng 1 lần (ghi app_kv drive_missing_warned); cờ tự
 * xoá khi thấy sao lưu còn tồn tại, hoặc khi có sao lưu thành công mới
 * (recordDriveStatus) — mất tiếp sau đó thì báo lại như lần mất mới.
 *
 * An toàn dữ liệu là trên hết: hàm này CHỈ ĐỌC (liệt kê file + đọc/ghi cờ
 * app_kv), tuyệt đối không xoá hay chạm vào dữ liệu cục bộ — SQLite trên
 * máy luôn là bản gốc an toàn. Mọi lỗi/không chắc chắn (chưa kết nối, mất
 * mạng, chưa từng sao lưu…) đều trả false để không báo oan.
 */
export async function checkDriveBackupMissing(): Promise<boolean> {
  try {
    if (!isDriveConfigured()) return false;
    // Chưa từng sao lưu thành công lần nào → không có gì để "mất"
    if (!(await kvGet('drive_last_at'))) return false;
    if (!(await isDriveConnected())) return false;
    const files = await listDriveBackups();
    if (files.length > 0) {
      // Sao lưu vẫn còn: xoá cờ đã báo để lần mất SAU báo lại được
      if ((await kvGet(MISSING_WARNED_KEY)) === '1') {
        await kvSet(MISSING_WARNED_KEY, '0');
      }
      return false;
    }
    // Danh sách rỗng dù đã từng sao lưu → sao lưu đã mất thật
    if ((await kvGet(MISSING_WARNED_KEY)) === '1') return false;
    await kvSet(MISSING_WARNED_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Tự động sao lưu nền khi mở app (gọi từ _layout sau init): chỉ chạy khi
 * đã cấu hình + SDK còn phiên đăng nhập + bật công tắc drive_auto + có
 * khoá chính + bản gần nhất đã quá 24 giờ (hoặc chưa có). Mọi lỗi đều bị
 * nuốt — chỉ ghi drive_last_status, TUYỆT ĐỐI không làm phiền người dùng
 * lúc mở app.
 */
// v84: tự động sao lưu Drive nền chỉ chạy khi cờ quản trị
// drive_backup_enabled đang BẬT (thay cờ cứng DRIVE_LOGIN_DISABLED_V82
// của v82). Cờ tắt thì không chạy — tránh ghi drive_last_status='error'
// oan cho phiên đổi mã (scope cơ bản, không có quyền Drive). _layout đã
// nạp cấu hình từ xa trước khi gọi hàm này nên cờ ở đây là cờ mới nhất.
export async function runAutoDriveBackupIfDue(): Promise<void> {
  try {
    if (!isDriveBackupEnabled()) return;
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
