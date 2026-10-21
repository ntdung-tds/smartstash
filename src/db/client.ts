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
  await ensureColumn(database, 'loans', 'alert_snoozed_until', 'TEXT');
  await ensureColumn(database, 'locations', 'icon', 'TEXT');
  await ensureColumn(database, 'locations', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');

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
