import '../lib/cryptoPolyfill';
import type { Buffer } from 'react-native-quick-crypto';

/**
 * Mã hoá bản sao lưu bằng mật khẩu (Phase 5 lõi) — lõi crypto chạy bằng
 * react-native-quick-crypto (NATIVE — OpenSSL/JSI qua Nitro Modules) thay
 * cho crypto-js thuần JS trước đây: PBKDF2 100k vòng bằng crypto-js chặn
 * luồng UI vài giây trên máy thật mỗi lần đặt mật khẩu/tạo sao lưu.
 *
 * ĐỊNH DẠNG KHÔNG ĐỔI so với bản crypto-js (đã kiểm chứng tương thích hai
 * chiều bằng test node — xem báo cáo vòng v35):
 *   v1 (file .ssbak): { app: 'SmartStashBackup', version: 1, salt, iv, data }
 *   v2 (Drive):       { app: 'SmartStashBackup', version: 2,
 *                       wrappedKey: { salt, iv, data }, iv, data }
 * - salt/iv: 16 byte ngẫu nhiên mỗi lần tạo (randomBytes native), base64.
 * - key: PBKDF2-HMAC-SHA256(password UTF-8, salt, 100_000 vòng, 256 bit).
 * - data: AES-256-CBC + PKCS7 (autoPadding mặc định của cipher), base64.
 * Mật khẩu KHÔNG bao giờ được lưu ở bất cứ đâu.
 *
 * NẠP LƯỜI (lazy) react-native-quick-crypto — BẮT BUỘC, đừng đổi lại import
 * tĩnh ở đầu file: khi build release, Expo Router nạp các route (kéo theo
 * file này) trong môi trường NODE để dựng server manifest; module native
 * (Nitro) thực thi ngay lúc import và chạm TurboModuleRegistry.getEnforcing
 * — không tồn tại trong node → build chết ở bước 'Exporting server' dù
 * bundle Android đã đóng gói xong. Vì vậy mọi API native chỉ được lấy qua
 * loadQuickCrypto() tại thời điểm thực sự mã hoá/giải mã trên thiết bị.
 * (Import type ở trên là type-only, bị xoá lúc biên dịch — an toàn.)
 *
 * Dòng import đầu tiên vẫn nạp cryptoPolyfill (idempotent, giữ nguyên cho
 * các nơi còn dùng crypto-js — appLockService) dù file này không còn cần nó.
 */

type QuickCryptoModule = typeof import('react-native-quick-crypto');

let quickCryptoCache: QuickCryptoModule | null = null;

/** Lấy module quick-crypto, nạp 1 lần duy nhất ở lần gọi đầu tiên (xem ghi chú ở đầu file) */
function loadQuickCrypto(): QuickCryptoModule {
  if (!quickCryptoCache) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    quickCryptoCache = require('react-native-quick-crypto') as QuickCryptoModule;
  }
  return quickCryptoCache;
}

export interface BackupEnvelope {
  app: 'SmartStashBackup';
  version: 1;
  salt: string;
  iv: string;
  data: string;
}

export class BackupError extends Error {
  code: 'WRONG_PASSWORD' | 'INVALID_FILE';

  constructor(code: 'WRONG_PASSWORD' | 'INVALID_FILE', message: string) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

const PBKDF2_ITERATIONS = 100000;
const KEY_BYTES = 256 / 8;
const SALT_BYTES = 128 / 8;
const IV_BYTES = 128 / 8;

/** PBKDF2-HMAC-SHA256 native (bất đồng bộ — không chặn luồng UI) */
function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  const { pbkdf2 } = loadQuickCrypto();
  return new Promise((resolve, reject) => {
    pbkdf2(password, salt, PBKDF2_ITERATIONS, KEY_BYTES, 'sha256', (err, derivedKey) => {
      if (err || !derivedKey) {
        reject(err ?? new Error('PBKDF2 không trả về khoá'));
      } else {
        resolve(derivedKey);
      }
    });
  });
}

/** AES-256-CBC + PKCS7 (autoPadding mặc định) — tương đương đường crypto-js cũ */
function aesEncrypt(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  const { Buffer: QuickBuffer, createCipheriv } = loadQuickCrypto();
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return QuickBuffer.concat([cipher.update(data), cipher.final()]);
}

/**
 * Giải AES-256-CBC. Sai khoá → lớp đệm PKCS7 không hợp lệ → final() ném lỗi;
 * nơi gọi bắt lỗi này và quy về WRONG_PASSWORD (như bản crypto-js: giải ra
 * rác/rỗng thì tầng trên báo sai mật khẩu).
 */
function aesDecrypt(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  const { Buffer: QuickBuffer, createDecipheriv } = loadQuickCrypto();
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  return QuickBuffer.concat([decipher.update(data), decipher.final()]);
}

const b64 = (buf: Buffer): string => buf.toString('base64');
const fromB64 = (text: string): Buffer => loadQuickCrypto().Buffer.from(text, 'base64');

/**
 * Giải bytes thành chuỗi UTF-8 NGHIÊM NGẶT: bản crypto-js dùng
 * decrypted.toString(enc.Utf8) — UTF-8 hỏng sẽ văng lỗi/rác. Ở đây kiểm tra
 * bằng vòng tròn encode: không khớp byte gốc → trả null (sai mật khẩu/khoá).
 */
function utf8Strict(buf: Buffer): string | null {
  const { Buffer: QuickBuffer } = loadQuickCrypto();
  const text = buf.toString('utf8');
  return QuickBuffer.from(text, 'utf8').equals(buf) ? text : null;
}

/** Mã hoá chuỗi gốc thành nội dung file .ssbak (JSON) */
export async function encryptBackupText(plainText: string, password: string): Promise<string> {
  const { Buffer: QuickBuffer, randomBytes } = loadQuickCrypto();
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(password, salt);
  const ciphertext = aesEncrypt(key, iv, QuickBuffer.from(plainText, 'utf8'));
  const envelope: BackupEnvelope = {
    app: 'SmartStashBackup',
    version: 1,
    salt: b64(salt),
    iv: b64(iv),
    data: b64(ciphertext),
  };
  return JSON.stringify(envelope);
}

/**
 * Giải mã nội dung file .ssbak về chuỗi gốc.
 * Sai mật khẩu → đệm PKCS7 hỏng khi giải AES, hoặc giải ra bytes không phải
 * UTF-8 hợp lệ / chuỗi rỗng → ném BackupError('WRONG_PASSWORD').
 * File không đúng định dạng → 'INVALID_FILE'.
 */
export async function decryptBackupText(fileText: string, password: string): Promise<string> {
  let envelope: BackupEnvelope | null = null;
  try {
    envelope = JSON.parse(fileText) as BackupEnvelope;
  } catch {
    throw new BackupError('INVALID_FILE', 'File không phải JSON hợp lệ');
  }
  if (
    !envelope
    || envelope.app !== 'SmartStashBackup'
    || envelope.version !== 1
    || typeof envelope.salt !== 'string'
    || typeof envelope.iv !== 'string'
    || typeof envelope.data !== 'string'
  ) {
    throw new BackupError('INVALID_FILE', 'Thiếu trường salt/iv/data của bản sao lưu');
  }
  const key = await deriveKey(password, fromB64(envelope.salt));
  let plain: Buffer;
  try {
    plain = aesDecrypt(key, fromB64(envelope.iv), fromB64(envelope.data));
  } catch {
    throw new BackupError('WRONG_PASSWORD', 'Giải mã thất bại — sai mật khẩu');
  }
  const text = utf8Strict(plain);
  if (!text) {
    throw new BackupError('WRONG_PASSWORD', 'Giải mã cho kết quả rỗng — sai mật khẩu');
  }
  return text;
}

/* =====================================================================
 * Phong bì v2 — sao lưu Google Drive (BYOC).
 *
 * Thiết kế khoá theo V21-12 của PRD (khoá chính được BỌC bằng mật khẩu):
 * - Khoá chính (master key): 32 byte ngẫu nhiên, sinh 1 lần trên máy khi
 *   người dùng đặt "mật khẩu sao lưu Drive". Máy này giữ khoá chính trong
 *   SecureStore để sao lưu/khôi phục không cần gõ lại mật khẩu.
 * - Khoá chính được bọc (wrap) bằng khoá suy ra từ mật khẩu (PBKDF2-SHA256
 *   100k vòng như v1) — blob đã bọc ĐI KÈM trong mọi phong bì v2, nên sang
 *   máy mới chỉ cần mật khẩu là mở được khoá chính rồi giải mã dữ liệu.
 * - Dữ liệu: AES-256-CBC + PKCS7 trực tiếp bằng khoá chính (IV riêng).
 *
 * Định dạng: { app:'SmartStashBackup', version:2,
 *              wrappedKey:{ salt, iv, data }, iv, data } — mọi trường base64.
 * Đường v1 ở trên GIỮ NGUYÊN định dạng cho sao lưu ra file thủ công.
 * ===================================================================== */

export interface WrappedMasterKey {
  salt: string;
  iv: string;
  data: string;
}

export interface BackupEnvelopeV2 {
  app: 'SmartStashBackup';
  version: 2;
  wrappedKey: WrappedMasterKey;
  iv: string;
  data: string;
}

export const MASTER_KEY_BYTES = 32;

/** Sinh khoá chính mới: 32 byte ngẫu nhiên (native), trả về dạng base64 */
export function generateMasterKey(): string {
  const { randomBytes } = loadQuickCrypto();
  return b64(randomBytes(MASTER_KEY_BYTES));
}

/** Bọc khoá chính bằng khoá suy ra từ mật khẩu (PBKDF2-SHA256 100k vòng) */
export async function wrapMasterKey(masterKeyB64: string, password: string): Promise<WrappedMasterKey> {
  const { randomBytes } = loadQuickCrypto();
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const wrappingKey = await deriveKey(password, salt);
  const ciphertext = aesEncrypt(wrappingKey, iv, fromB64(masterKeyB64));
  return {
    salt: b64(salt),
    iv: b64(iv),
    data: b64(ciphertext),
  };
}

/**
 * Mở khoá chính từ blob đã bọc + mật khẩu. Sai mật khẩu → lớp đệm PKCS7
 * không hợp lệ khi giải AES / độ dài khoá mở ra khác 32 byte →
 * BackupError('WRONG_PASSWORD').
 */
export async function unwrapMasterKey(wrapped: WrappedMasterKey, password: string): Promise<string> {
  if (
    !wrapped
    || typeof wrapped.salt !== 'string'
    || typeof wrapped.iv !== 'string'
    || typeof wrapped.data !== 'string'
  ) {
    throw new BackupError('INVALID_FILE', 'Thiếu trường wrappedKey của bản sao lưu Drive');
  }
  const wrappingKey = await deriveKey(password, fromB64(wrapped.salt));
  let masterKey: Buffer;
  try {
    masterKey = aesDecrypt(wrappingKey, fromB64(wrapped.iv), fromB64(wrapped.data));
  } catch {
    throw new BackupError('WRONG_PASSWORD', 'Mở khoá chính thất bại — sai mật khẩu');
  }
  if (masterKey.length !== MASTER_KEY_BYTES) {
    throw new BackupError('WRONG_PASSWORD', 'Mở khoá chính thất bại — sai mật khẩu');
  }
  return b64(masterKey);
}

function parseMasterKey(masterKeyB64: string): Buffer {
  const key = fromB64(masterKeyB64);
  if (key.length !== MASTER_KEY_BYTES) {
    throw new BackupError('INVALID_FILE', 'Khoá chính không đủ 32 byte');
  }
  return key;
}

/** Mã hoá chuỗi gốc thành phong bì v2 bằng khoá chính (kèm blob khoá đã bọc) */
export async function encryptByMasterKey(
  plainText: string,
  masterKeyB64: string,
  wrappedKey: WrappedMasterKey,
): Promise<string> {
  const { Buffer: QuickBuffer, randomBytes } = loadQuickCrypto();
  const key = parseMasterKey(masterKeyB64);
  const iv = randomBytes(IV_BYTES);
  const ciphertext = aesEncrypt(key, iv, QuickBuffer.from(plainText, 'utf8'));
  const envelope: BackupEnvelopeV2 = {
    app: 'SmartStashBackup',
    version: 2,
    wrappedKey,
    iv: b64(iv),
    data: b64(ciphertext),
  };
  return JSON.stringify(envelope);
}

/**
 * Giải mã phong bì v2 về chuỗi gốc:
 * - Có `masterKey` (máy cũ đã lưu khoá chính) → giải trực tiếp.
 * - Chỉ có `password` (máy mới) → mở wrappedKey lấy khoá chính rồi giải.
 * Sai mật khẩu → BackupError('WRONG_PASSWORD'); sai định dạng → 'INVALID_FILE'.
 */
export async function decryptDriveEnvelope(
  fileText: string,
  credentials: { masterKey?: string; password?: string },
): Promise<string> {
  let envelope: BackupEnvelopeV2 | null = null;
  try {
    envelope = JSON.parse(fileText) as BackupEnvelopeV2;
  } catch {
    throw new BackupError('INVALID_FILE', 'File không phải JSON hợp lệ');
  }
  if (
    !envelope
    || envelope.app !== 'SmartStashBackup'
    || envelope.version !== 2
    || typeof envelope.iv !== 'string'
    || typeof envelope.data !== 'string'
    || !envelope.wrappedKey
  ) {
    throw new BackupError('INVALID_FILE', 'Thiếu trường wrappedKey/iv/data của bản sao lưu Drive');
  }
  let masterKeyB64: string;
  if (credentials.masterKey) {
    masterKeyB64 = credentials.masterKey;
  } else if (credentials.password) {
    masterKeyB64 = await unwrapMasterKey(envelope.wrappedKey, credentials.password);
  } else {
    throw new BackupError('WRONG_PASSWORD', 'Cần khoá chính hoặc mật khẩu để giải mã');
  }
  const key = parseMasterKey(masterKeyB64);
  let plain: Buffer;
  try {
    plain = aesDecrypt(key, fromB64(envelope.iv), fromB64(envelope.data));
  } catch {
    throw new BackupError('WRONG_PASSWORD', 'Giải mã thất bại — khoá chính không khớp');
  }
  const text = utf8Strict(plain);
  if (!text) {
    throw new BackupError('WRONG_PASSWORD', 'Giải mã cho kết quả rỗng — khoá chính không khớp');
  }
  return text;
}
