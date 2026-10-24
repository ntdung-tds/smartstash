import '../lib/cryptoPolyfill';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import CryptoJS from 'crypto-js';
import { kvGet, kvSet } from '../db/client';

/**
 * Khoá ứng dụng bằng mã PIN (+ sinh trắc học).
 *
 * Bảo mật:
 * - PIN KHÔNG bao giờ lưu thô. Chỉ lưu salt ngẫu nhiên + SHA-256(salt + PIN)
 *   trong SecureStore (Keystore/Keychain của hệ điều hành) — tuyệt đối không
 *   đưa hash/salt vào SQLite hay app_kv.
 * - Cấu hình thuần (bật/tắt, thời gian tự khoá, độ dài PIN) lưu app_kv
 *   'applock_cfg' dạng JSON, có cache trong bộ nhớ như alertSettings.
 */
const SALT_KEY = 'applock_pin_salt';
const HASH_KEY = 'applock_pin_hash';
const CFG_KEY = 'applock_cfg';

export interface LockConfig {
  /** Đã bật khoá ứng dụng hay chưa */
  lockEnabled: boolean;
  /** Số giây rời app trước khi khoá lại; 0 = khoá ngay khi quay lại */
  lockTimeoutSec: number;
  /** Cho phép mở khoá bằng vân tay / khuôn mặt */
  biometricEnabled: boolean;
  /** Độ dài PIN đã đặt (4–6) — màn hình khoá vẽ đúng số chấm */
  pinLength: number;
}

export const LOCK_CONFIG_DEFAULTS: LockConfig = {
  lockEnabled: false,
  lockTimeoutSec: 0,
  biometricEnabled: true,
  pinLength: 6,
};

export const LOCK_TIMEOUT_CHOICES = [0, 60, 300];

let cfgCache: LockConfig | null = null;

function sanitize(raw: Partial<LockConfig> | null | undefined): LockConfig {
  const d = LOCK_CONFIG_DEFAULTS;
  const timeout = typeof raw?.lockTimeoutSec === 'number' && raw.lockTimeoutSec >= 0
    ? raw.lockTimeoutSec
    : d.lockTimeoutSec;
  const pinLength = typeof raw?.pinLength === 'number'
    ? Math.min(6, Math.max(4, Math.round(raw.pinLength)))
    : d.pinLength;
  return {
    lockEnabled: typeof raw?.lockEnabled === 'boolean' ? raw.lockEnabled : d.lockEnabled,
    lockTimeoutSec: timeout,
    biometricEnabled: typeof raw?.biometricEnabled === 'boolean' ? raw.biometricEnabled : d.biometricEnabled,
    pinLength,
  };
}

export async function getLockConfig(): Promise<LockConfig> {
  try {
    const rawStr = await kvGet(CFG_KEY);
    cfgCache = sanitize(rawStr ? (JSON.parse(rawStr) as Partial<LockConfig>) : null);
  } catch {
    cfgCache = { ...LOCK_CONFIG_DEFAULTS };
  }
  return cfgCache;
}

export function getCachedLockConfig(): LockConfig {
  return cfgCache ?? LOCK_CONFIG_DEFAULTS;
}

export async function setLockConfig(patch: Partial<LockConfig>): Promise<LockConfig> {
  const current = cfgCache ?? (await getLockConfig());
  const next = sanitize({ ...current, ...patch });
  cfgCache = next;
  try {
    await kvSet(CFG_KEY, JSON.stringify(next));
  } catch {
    // best-effort: cache vẫn giữ giá trị mới trong phiên này
  }
  return next;
}

function hashPin(salt: string, pin: string): string {
  return CryptoJS.SHA256(`${salt}:${pin}`).toString(CryptoJS.enc.Hex);
}

/** Đã đặt mã PIN hay chưa (hash tồn tại trong SecureStore) */
export async function hasPin(): Promise<boolean> {
  try {
    return !!(await SecureStore.getItemAsync(HASH_KEY));
  } catch {
    return false;
  }
}

/** Đặt/đổi mã PIN: tạo salt mới, lưu hash vào SecureStore, ghi nhớ độ dài PIN */
export async function setPin(pin: string): Promise<void> {
  const salt = CryptoJS.lib.WordArray.random(16).toString(CryptoJS.enc.Hex);
  await SecureStore.setItemAsync(SALT_KEY, salt);
  await SecureStore.setItemAsync(HASH_KEY, hashPin(salt, pin));
  await setLockConfig({ pinLength: pin.length });
}

/** Kiểm tra mã PIN người dùng nhập so với hash đã lưu */
export async function verifyPin(pin: string): Promise<boolean> {
  try {
    const salt = await SecureStore.getItemAsync(SALT_KEY);
    const hash = await SecureStore.getItemAsync(HASH_KEY);
    if (!salt || !hash) return false;
    return hashPin(salt, pin) === hash;
  } catch {
    return false;
  }
}

/** Thiết bị có phần cứng sinh trắc VÀ người dùng đã đăng ký vân tay/khuôn mặt */
export async function isBiometricAvailable(): Promise<boolean> {
  try {
    const [hardware, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    return hardware && enrolled;
  } catch {
    return false;
  }
}

/**
 * Mở prompt sinh trắc của hệ điều hành. disableDeviceFallback = true để mã
 * khoá máy không qua mặt được khoá app — không qua sinh trắc thì nhập PIN app.
 */
export async function authenticateBiometric(promptMessage: string): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      disableDeviceFallback: true,
    });
    return result.success;
  } catch {
    return false;
  }
}
