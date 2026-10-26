import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { getDb } from '../db/client';
import { decryptBackupText, encryptBackupText, BackupError } from './backupCrypto';
import { compressImageForBackup } from './imageService';

export { BackupError };

/**
 * Sao lưu & khôi phục bằng file mã hoá (Phase 5 lõi).
 *
 * Payload: { app:'SmartStash', backupVersion:1, createdAt,
 *            tables:{ <bảng>: hàng[] }, mediaFiles:[{ id, base64, thumbBase64 }] }
 *
 * Bảng nghiệp vụ: locations, items, loans, item_history, custom_terms,
 * media_files (+ households/household_members cho đủ bộ schema) và app_kv
 * TRỪ các key dành cho máy/phiên hiện tại (thiết bị này giữ nguyên khi
 * khôi phục): onboarded, recent_locations, lang_mode, pinned_terms.
 *
 * Mật khẩu sao lưu KHÔNG được lưu ở bất cứ đâu (DB/kv/file).
 */

type Row = Record<string, unknown>;
type BindValue = string | number | null;

const CONTENT_TABLES = [
  'locations',
  'items',
  'loans',
  'item_history',
  'custom_terms',
  'media_files',
  'households',
  'household_members',
] as const;

/** Thứ tự xoá: bảng con trước (ràng buộc FK), media_files trước locations */
const DELETE_ORDER = [
  'item_history',
  'loans',
  'items',
  'locations',
  'media_files',
  'custom_terms',
  'household_members',
  'households',
] as const;

/** Thứ tự chèn: bảng cha trước */
const INSERT_ORDER = [
  'media_files',
  'locations',
  'households',
  'household_members',
  'items',
  'loans',
  'item_history',
  'custom_terms',
] as const;

/** app_kv key thuộc về máy/phiên — không đưa vào backup, không ghi đè khi khôi phục */
const MACHINE_KV_KEYS = new Set(['onboarded', 'recent_locations', 'lang_mode', 'pinned_terms']);

export interface BackupPayload {
  app: 'SmartStash';
  backupVersion: 1;
  createdAt: string;
  tables: Record<string, Row[]>;
  mediaFiles: { id: string; base64: string; thumbBase64: string | null }[];
}

/**
 * Đọc toàn bộ dữ liệu nghiệp vụ + bytes ảnh (base64) thành payload.
 * opts.compressImages (mây của tôi): ảnh chính được nén thêm một bước
 * (cạnh dài tối đa 1024px) trước khi đưa vào payload — ảnh gốc trên máy
 * không bị đụng, file tạm nén xong sẽ xoá ngay.
 */
export async function collectData(opts?: { compressImages?: boolean }): Promise<BackupPayload> {
  const db = getDb();
  const tables: Record<string, Row[]> = {};
  for (const table of CONTENT_TABLES) {
    tables[table] = await db.getAllAsync<Row>(`SELECT * FROM ${table}`);
  }
  const kvRows = await db.getAllAsync<{ key: string; value: string | null }>('SELECT key, value FROM app_kv');
  tables.app_kv = kvRows.filter((r) => !MACHINE_KV_KEYS.has(r.key));

  const mediaFiles: BackupPayload['mediaFiles'] = [];
  for (const row of tables.media_files) {
    try {
      let sourceUri = String(row.local_uri);
      let tempUri: string | null = null;
      if (opts?.compressImages) {
        const compressed = await compressImageForBackup(sourceUri);
        if (compressed !== sourceUri) {
          sourceUri = compressed;
          tempUri = compressed;
        }
      }
      let base64: string;
      try {
        base64 = await FileSystem.readAsStringAsync(sourceUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
      } finally {
        if (tempUri) {
          await FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
        }
      }
      let thumbBase64: string | null = null;
      if (row.thumbnail_uri) {
        try {
          thumbBase64 = await FileSystem.readAsStringAsync(String(row.thumbnail_uri), {
            encoding: FileSystem.EncodingType.Base64,
          });
        } catch {
          // thiếu thumbnail thì bỏ qua — ảnh chính vẫn khôi phục được
        }
      }
      mediaFiles.push({ id: String(row.id), base64, thumbBase64 });
    } catch {
      // File ảnh đã mất trên máy: vẫn khôi phục metadata, ảnh đó hiện placeholder
    }
  }
  return { app: 'SmartStash', backupVersion: 1, createdAt: new Date().toISOString(), tables, mediaFiles };
}

function extOf(uri: unknown): string {
  if (typeof uri !== 'string') return 'jpg';
  const base = uri.split('/').pop() ?? '';
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  return /^[a-z0-9]{2,5}$/.test(ext) ? ext : 'jpg';
}

/**
 * Ghi đè toàn bộ dữ liệu hiện tại bằng payload backup:
 * 1) ghi lại file ảnh vào thư mục media của app, dựng map id → uri mới;
 * 2) trong 1 transaction: xoá sạch bảng nghiệp vụ + chèn lại (uri ảnh
 *    trong media_files trỏ về đường dẫn mới); app_kv chỉ chạm các key có
 *    trong backup nên key máy hiện tại được giữ nguyên.
 * items_fts tự đồng bộ qua trigger sẵn có khi INSERT/DELETE items.
 */
export async function restoreData(payload: BackupPayload): Promise<void> {
  const db = getDb();
  const docDir = FileSystem.documentDirectory ?? '';
  const imagesDir = `${docDir}images/`;
  const thumbsDir = `${docDir}thumbs/`;
  for (const dir of [imagesDir, thumbsDir]) {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }

  const mediaRows = payload.tables.media_files ?? [];
  const rowById = new Map(mediaRows.map((r) => [String(r.id), r]));
  const uriById = new Map<string, { local: string; thumb: string | null }>();
  for (const mf of payload.mediaFiles ?? []) {
    const local = `${imagesDir}${mf.id}.${extOf(rowById.get(mf.id)?.local_uri)}`;
    await FileSystem.writeAsStringAsync(local, mf.base64, { encoding: FileSystem.EncodingType.Base64 });
    let thumb: string | null = null;
    if (mf.thumbBase64) {
      thumb = `${thumbsDir}${mf.id}.jpg`;
      await FileSystem.writeAsStringAsync(thumb, mf.thumbBase64, { encoding: FileSystem.EncodingType.Base64 });
    }
    uriById.set(mf.id, { local, thumb });
  }

  await db.withTransactionAsync(async () => {
    for (const table of DELETE_ORDER) {
      await db.runAsync(`DELETE FROM ${table}`);
    }
    const kvRows = payload.tables.app_kv ?? [];
    for (const row of kvRows) {
      await db.runAsync('DELETE FROM app_kv WHERE key = ?', [String(row.key)]);
    }
    for (const table of INSERT_ORDER) {
      for (const raw of payload.tables[table] ?? []) {
        const row: Row = { ...raw };
        if (table === 'media_files') {
          const mapped = uriById.get(String(row.id));
          if (mapped) {
            row.local_uri = mapped.local;
            if (mapped.thumb) row.thumbnail_uri = mapped.thumb;
          }
        }
        const cols = Object.keys(row);
        if (cols.length === 0) continue;
        const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
        await db.runAsync(sql, cols.map((c) => (row[c] ?? null) as BindValue));
      }
    }
    for (const row of kvRows) {
      await db.runAsync('INSERT INTO app_kv (key, value) VALUES (?, ?)', [
        String(row.key),
        (row.value ?? null) as BindValue,
      ]);
    }
  });
}

/** Tạo file .ssbak mã hoá rồi mở hộp thoại chia sẻ để người dùng cất file.
 * Ảnh trong file được nén như bản sao lưu mây (cạnh dài tối đa 1024px) để
 * file nhẹ hơn — ảnh gốc trên máy không bị đụng. */
export async function exportBackup(password: string): Promise<{ path: string; shared: boolean }> {
  const payload = await collectData({ compressImages: true });
  const fileText = await encryptBackupText(JSON.stringify(payload), password);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const path = `${FileSystem.cacheDirectory ?? ''}SmartStash-Backup-${stamp}.ssbak`;
  await FileSystem.writeAsStringAsync(path, fileText, { encoding: FileSystem.EncodingType.UTF8 });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(path, { mimeType: 'application/octet-stream', dialogTitle: 'SmartStash Backup' });
    return { path, shared: true };
  }
  return { path, shared: false };
}

/**
 * Parse + validate chuỗi JSON đã giải mã thành BackupPayload.
 * Dùng chung cho khôi phục từ file (v1) và từ Google Drive (v2) — payload
 * bên trong phong bì là một, chỉ khác cách mã hoá ở lớp ngoài.
 */
export function parseBackupPayload(plain: string): BackupPayload {
  let payload: BackupPayload | null = null;
  try {
    payload = JSON.parse(plain) as BackupPayload;
  } catch {
    // Giải mã "thành công" nhưng không phải JSON → thực chất sai mật khẩu/khoá
    throw new BackupError('WRONG_PASSWORD', 'Nội dung giải mã không phải JSON');
  }
  if (
    !payload
    || payload.app !== 'SmartStash'
    || payload.backupVersion !== 1
    || typeof payload.tables !== 'object'
    || payload.tables === null
  ) {
    throw new BackupError('INVALID_FILE', 'Payload không đúng định dạng SmartStash backup v1');
  }
  return payload;
}

/**
 * Khôi phục từ file .ssbak đã chọn: đọc → giải mã → validate → restoreData.
 * Ném BackupError('WRONG_PASSWORD' | 'INVALID_FILE') để tầng UI báo đúng.
 */
export async function importBackup(uri: string, password: string): Promise<void> {
  const fileText = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 });
  const plain = await decryptBackupText(fileText, password);
  await restoreData(parseBackupPayload(plain));
}
