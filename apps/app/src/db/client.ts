import * as SQLite from 'expo-sqlite';
import { INIT_SQL, FTS_SQL, SCHEMA_VERSION } from './schema';

let db: SQLite.SQLiteDatabase | null = null;
export let ftsAvailable = false;

export function getDb(): SQLite.SQLiteDatabase {
  if (!db) {
    db = SQLite.openDatabaseSync('smartstash.db');
  }
  return db;
}

export async function initDb(): Promise<void> {
  const database = getDb();
  await database.execAsync('PRAGMA journal_mode = WAL;');
  await database.execAsync('PRAGMA foreign_keys = ON;');

  const row = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  const version = row?.user_version ?? 0;

  if (version < SCHEMA_VERSION) {
    await database.withTransactionAsync(async () => {
      await database.execAsync(INIT_SQL);
    });
    await database.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  } else {
    await database.execAsync(INIT_SQL);
  }

  // Bổ sung cột mới cho DB cũ: INIT_SQL dùng CREATE TABLE IF NOT EXISTS nên bảng đã tồn tại
  // sẽ không nhận cột mới từ INIT_SQL. Kiểm tra PRAGMA table_info rồi ALTER TABLE nếu thiếu —
  // idempotent, chạy an toàn mỗi lần mở app, không cần tăng SCHEMA_VERSION.
  await ensureColumn(database, 'items', 'condition_note', 'TEXT');
  await ensureColumn(database, 'items', 'alert_snoozed_until', 'TEXT');
  await ensureColumn(database, 'items', 'sold_to', 'TEXT');
  await ensureColumn(database, 'loans', 'alert_snoozed_until', 'TEXT');
  // Gói số lượng + gửi bán: kind phân biệt cho mượn / gửi bán trên cùng bảng loans,
  // quantity_closed + close_reason ghi phần đã đóng không quay về nhà, expected_price
  // là giá mong muốn của record gửi bán
  await ensureColumn(database, 'loans', 'kind', "TEXT NOT NULL DEFAULT 'LOAN'");
  await ensureColumn(database, 'loans', 'quantity_closed', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'loans', 'close_reason', 'TEXT');
  await ensureColumn(database, 'loans', 'expected_price', 'REAL');
  await ensureColumn(database, 'locations', 'icon', 'TEXT');
  await ensureColumn(database, 'locations', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  // Ghim theo từng ảnh hiện trường: pin_x/pin_y nằm trên chính hàng media_files
  // của tấm ảnh đó (trước đây là 1 ghim duy nhất/món ở items.pin_x/pin_y)
  await ensureColumn(database, 'media_files', 'pin_x', 'REAL');
  await ensureColumn(database, 'media_files', 'pin_y', 'REAL');
  await migrateLegacyItemPins(database);
  // latitude/longitude đã có trong INIT_SQL gốc; ensureColumn ở đây chỉ là lưới an toàn cho DB rất cũ
  await ensureColumn(database, 'locations', 'latitude', 'REAL');
  await ensureColumn(database, 'locations', 'longitude', 'REAL');

  // FTS5: nếu bản build SQLite không có FTS5 thì app tự fallback sang lọc trong JS (xem queries.searchItems)
  try {
    await database.execAsync(FTS_SQL);
    ftsAvailable = true;
  } catch (e) {
    ftsAvailable = false;
    console.warn('[SmartStash] FTS5 không khả dụng, dùng fallback search:', e);
  }

  await purgeTrash(database);
}

/** Thêm cột vào bảng nếu chưa có (migration nhẹ, idempotent) */
async function ensureColumn(
  database: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  declaration: string,
): Promise<void> {
  const cols = await database.getAllAsync<{ name: string }>(`PRAGMA table_info(${table});`);
  if (!cols.some((c) => c.name === column)) {
    await database.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration};`);
  }
}

/**
 * Di trú ghim kiểu cũ → mô hình mới (mỗi ảnh hiện trường một ghim riêng):
 * với mỗi item còn ghim cũ (items.pin_x/pin_y) và scene_media_id trỏ tới
 * một hàng media còn tồn tại mà hàng đó CHƯA có ghim, copy ghim của item
 * sang chính hàng media đó. Câu UPDATE tự idempotent — sau khi copy, media
 * đã có ghim nên guard `pin_x IS NULL` khiến các lần mở app sau không làm
 * lại gì cả (kể cả khi khôi phục backup cũ, ghim cũng tự về đúng ảnh).
 * Cột items.pin_x/pin_y được giữ nguyên (legacy), app không đọc/ghi nữa.
 */
async function migrateLegacyItemPins(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    await database.runAsync(
      `UPDATE media_files
       SET pin_x = (SELECT i.pin_x FROM items i WHERE i.scene_media_id = media_files.id),
           pin_y = (SELECT i.pin_y FROM items i WHERE i.scene_media_id = media_files.id)
       WHERE media_files.pin_x IS NULL
         AND EXISTS (
           SELECT 1 FROM items i
           WHERE i.scene_media_id = media_files.id
             AND i.pin_x IS NOT NULL AND i.pin_y IS NOT NULL
         )`,
    );
  } catch {
    // bảng chưa sẵn sàng thì bỏ qua — lần mở app sau sẽ thử lại
  }
}

/** V21-09: xoá cứng bản ghi đã xoá mềm quá 30 ngày */
async function purgeTrash(database: SQLite.SQLiteDatabase): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  for (const table of ['items', 'locations', 'media_files', 'loans']) {
    try {
      await database.runAsync(
        `DELETE FROM ${table} WHERE is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?`,
        [cutoff],
      );
    } catch {
      // bỏ qua nếu bảng chưa sẵn sàng
    }
  }
}

export async function kvGet(key: string): Promise<string | null> {
  const row = await getDb().getFirstAsync<{ value: string | null }>(
    'SELECT value FROM app_kv WHERE key = ?',
    [key],
  );
  return row?.value ?? null;
}

export async function kvSet(key: string, value: string): Promise<void> {
  await getDb().runAsync(
    'INSERT INTO app_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}
