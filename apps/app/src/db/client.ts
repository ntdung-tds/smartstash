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
  // v93: ghi lại đợt xoá vị trí kiểu chuyển đồ để khôi phục được đồ về
  await ensureColumn(database, 'locations', 'trash_meta', 'TEXT');
  // Ghim theo từng ảnh hiện trường: pin_x/pin_y nằm trên chính hàng media_files
  // của tấm ảnh đó (trước đây là 1 ghim duy nhất/món ở items.pin_x/pin_y)
  await ensureColumn(database, 'media_files', 'pin_x', 'REAL');
  await ensureColumn(database, 'media_files', 'pin_y', 'REAL');
  await migrateLegacyItemPins(database);
  await migrateLocationNames(database);
  await migrateDefaultHomeTree(database);
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

/**
 * Đổi tên vị trí theo yêu cầu 25/10/2026 + thêm thư mục gốc 'Kho chính':
 * - 'Kho tầng 2' → 'Kho tầng 1' (đổi tên đúng hàng đó, cây con giữ nguyên cha).
 * - Tạo thư mục gốc 'Kho chính' (PROPERTY, cùng cấp 'Nhà chính') nếu chưa có.
 * Idempotent: sau lần đầu, UPDATE không còn hàng nào khớp và INSERT bị chặn
 * bởi guard NOT EXISTS, nên các lần mở app sau không làm gì thêm.
 */
async function migrateLocationNames(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    await database.runAsync(
      `UPDATE locations SET name = 'Kho tầng 1', is_dirty = 1
       WHERE name = 'Kho tầng 2' AND is_deleted = 0`,
    );
  } catch {
    // bảng chưa sẵn sàng thì bỏ qua — lần mở app sau sẽ thử lại
  }
  try {
    const now = new Date().toISOString();
    const id = 'loc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const qr = 'STASH-LOC-' + Math.random().toString(16).slice(2, 8).toUpperCase();
    await database.runAsync(
      `INSERT INTO locations (id, parent_id, name, type, qr_code, created_at, updated_at, is_deleted, is_dirty, sort_order)
       SELECT ?, NULL, 'Kho chính', 'PROPERTY', ?, ?, ?, 0, 1, 0
       WHERE NOT EXISTS (
         SELECT 1 FROM locations
         WHERE name = 'Kho chính' AND parent_id IS NULL AND is_deleted = 0
       )`,
      [id, qr, now, now],
    );
  } catch {
    // đã có 'Kho chính' hoặc bảng chưa sẵn sàng — lần mở app sau sẽ thử lại nếu cần
  }
}

/**
 * Cây vị trí mặc định 'Nhà chính' (v79, 26/10/2026) — thường trực như 'Kho chính',
 * KHÔNG nằm trong demo_seed_ids, KHÔNG gắn với nút dữ liệu mẫu:
 * - 'Nhà chính' (PROPERTY, gốc, sort_order 0); 'Kho chính' gốc đang ở 0 thì
 *   đẩy xuống 1 để 'Nhà chính' hiển thị trên trong danh sách gốc.
 * - Con của 'Nhà chính' (ROOM): 'Phòng khách', 'Nhà bếp', 'Tầng 1', 'Tầng 2'.
 * - Con của 'Tầng 1': 'Tủ thuốc' (FURNITURE), 'Ngăn bàn làm việc' (CONTAINER).
 * - Con của 'Tầng 2': 'Kệ sách' (FURNITURE), 'Ngăn kéo bàn trang điểm' (CONTAINER).
 * 'Phòng khách' và 'Nhà bếp' là PHÒNG nên ở trực thuộc 'Nhà chính', không
 * nhét dưới 'Tầng 2'. Idempotent tuyệt đối: mỗi node tra cha rồi INSERT ...
 * WHERE NOT EXISTS (parent_id + name + is_deleted = 0); máy đã có node cùng
 * tên dưới cùng cha thì bỏ qua, không tạo trùng, không đổi sort_order của
 * node người dùng đã có. Node xoá mềm (is_deleted = 1) thì guard không thấy
 * nên tạo lại — giống hệt cách 'Kho chính' đang làm. Mỗi INSERT bọc
 * try/catch riêng, lần mở app sau thử lại phần còn thiếu.
 */
async function migrateDefaultHomeTree(database: SQLite.SQLiteDatabase): Promise<void> {
  const makeId = () =>
    'loc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const makeQr = () =>
    'STASH-LOC-' + Math.random().toString(16).slice(2, 8).toUpperCase();

  const findId = async (parentId: string | null, name: string): Promise<string | null> => {
    try {
      const row = await database.getFirstAsync<{ id: string }>(
        parentId === null
          ? 'SELECT id FROM locations WHERE name = ? AND parent_id IS NULL AND is_deleted = 0 LIMIT 1'
          : 'SELECT id FROM locations WHERE name = ? AND parent_id = ? AND is_deleted = 0 LIMIT 1',
        parentId === null ? [name] : [name, parentId],
      );
      return row?.id ?? null;
    } catch {
      return null;
    }
  };

  const ensureNode = async (
    parentId: string | null,
    name: string,
    type: string,
    sortOrder: number,
  ): Promise<string | null> => {
    try {
      const now = new Date().toISOString();
      if (parentId === null) {
        await database.runAsync(
          `INSERT INTO locations (id, parent_id, name, type, qr_code, created_at, updated_at, is_deleted, is_dirty, sort_order)
           SELECT ?, NULL, ?, ?, ?, ?, ?, 0, 1, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM locations
             WHERE name = ? AND parent_id IS NULL AND is_deleted = 0
           )`,
          [makeId(), name, type, makeQr(), now, now, sortOrder, name],
        );
      } else {
        await database.runAsync(
          `INSERT INTO locations (id, parent_id, name, type, qr_code, created_at, updated_at, is_deleted, is_dirty, sort_order)
           SELECT ?, ?, ?, ?, ?, ?, ?, 0, 1, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM locations
             WHERE name = ? AND parent_id = ? AND is_deleted = 0
           )`,
          [makeId(), parentId, name, type, makeQr(), now, now, sortOrder, name, parentId],
        );
      }
    } catch {
      // đã có node hoặc bảng chưa sẵn sàng — lần mở app sau sẽ thử lại nếu cần
    }
    return findId(parentId, name);
  };

  // Gốc 'Nhà chính' phải đứng trước 'Kho chính' trong danh sách gốc.
  const homeId = await ensureNode(null, 'Nhà chính', 'PROPERTY', 0);
  try {
    await database.runAsync(
      `UPDATE locations SET sort_order = 1, is_dirty = 1
       WHERE name = 'Kho chính' AND parent_id IS NULL AND is_deleted = 0 AND sort_order = 0`,
    );
  } catch {
    // bảng chưa sẵn sàng — lần mở app sau sẽ thử lại
  }
  if (!homeId) return;

  await ensureNode(homeId, 'Phòng khách', 'ROOM', 0);
  await ensureNode(homeId, 'Nhà bếp', 'ROOM', 1);
  const floor1Id = await ensureNode(homeId, 'Tầng 1', 'ROOM', 2);
  const floor2Id = await ensureNode(homeId, 'Tầng 2', 'ROOM', 3);
  if (floor1Id) {
    await ensureNode(floor1Id, 'Tủ thuốc', 'FURNITURE', 0);
    await ensureNode(floor1Id, 'Ngăn bàn làm việc', 'CONTAINER', 1);
  }
  if (floor2Id) {
    await ensureNode(floor2Id, 'Kệ sách', 'FURNITURE', 0);
    await ensureNode(floor2Id, 'Ngăn kéo bàn trang điểm', 'CONTAINER', 1);
  }
}
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
