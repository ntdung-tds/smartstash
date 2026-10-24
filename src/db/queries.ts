import { getDb, ftsAvailable } from './client';
import type { Item, Location, Loan, MediaFile, ItemHistory, ItemStatus } from '../types';
import { uuid, nowISO, removeDiacritics, toFtsPrefixQuery, formatVND } from '../utils';
import { getCurrentLimits } from '../services/planService';
import { getCurrentLang } from '../theme';
import { translate } from '../i18n';

// ===================== HISTORY =====================
export async function logHistory(
  itemId: string,
  actionType: string,
  opts: {
    fromLocationId?: string | null;
    toLocationId?: string | null;
    oldStatus?: string | null;
    newStatus?: string | null;
    note?: string | null;
  } = {},
): Promise<void> {
  await getDb().runAsync(
    `INSERT INTO item_history (id, item_id, action_type, from_location_id, to_location_id, old_status, new_status, note, created_at, is_dirty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [uuid(), itemId, actionType, opts.fromLocationId ?? null, opts.toLocationId ?? null, opts.oldStatus ?? null, opts.newStatus ?? null, opts.note ?? null, nowISO()],
  );
}

export async function getItemHistory(itemId: string): Promise<ItemHistory[]> {
  return getDb().getAllAsync<ItemHistory>(
    'SELECT * FROM item_history WHERE item_id = ? ORDER BY created_at DESC',
    [itemId],
  );
}

// ===================== LOCATIONS =====================
export async function listLocations(): Promise<Location[]> {
  return getDb().getAllAsync<Location>(
    'SELECT * FROM locations WHERE is_deleted = 0 ORDER BY sort_order ASC, name ASC',
  );
}

export async function getLocation(id: string): Promise<Location | null> {
  return getDb().getFirstAsync<Location>('SELECT * FROM locations WHERE id = ? AND is_deleted = 0', [id]);
}

/** Tìm vị trí theo mã QR đã in/gán cho vị trí (cột qr_code) */
export async function findLocationByQrCode(code: string): Promise<Location | null> {
  return getDb().getFirstAsync<Location>(
    'SELECT * FROM locations WHERE qr_code = ? AND is_deleted = 0 LIMIT 1',
    [code],
  );
}

export async function createLocation(input: {
  name: string;
  type: Location['type'];
  parent_id?: string | null;
  description?: string | null;
  icon?: string | null;
}): Promise<Location> {
  const db = getDb();
  const now = nowISO();
  const loc: Location = {
    id: uuid(),
    parent_id: input.parent_id ?? null,
    name: input.name.trim(),
    type: input.type,
    description: input.description ?? null,
    scene_media_id: null,
    qr_code: 'STASH-LOC-' + Math.random().toString(16).slice(2, 8).toUpperCase(),
    latitude: null,
    longitude: null,
    address: null,
    household_id: null,
    icon: input.icon ?? null,
    sort_order: 0,
    created_at: now,
    updated_at: now,
    is_deleted: 0,
    is_dirty: 1,
    deleted_at: null,
  };
  // V21-04: kiểm tra độ sâu tối đa 4 cấp + chống vòng lặp
  const err = await validateParent(db, null, loc.parent_id);
  if (err) throw new Error(err);
  await db.runAsync(
    `INSERT INTO locations (id, parent_id, name, type, description, scene_media_id, qr_code, latitude, longitude, address, household_id, created_at, updated_at, is_deleted, is_dirty, deleted_at, icon, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, NULL, ?, ?)`,
    [loc.id, loc.parent_id, loc.name, loc.type, loc.description, null, loc.qr_code, null, null, null, null, now, now, loc.icon, loc.sort_order],
  );
  return loc;
}

/** Ghim toạ độ GPS cho vị trí (từ vị trí hiện tại của thiết bị hoặc nhập tay) */
export async function setLocationCoords(id: string, lat: number, lng: number): Promise<void> {
  await getDb().runAsync(
    'UPDATE locations SET latitude = ?, longitude = ?, updated_at = ?, is_dirty = 1 WHERE id = ?',
    [lat, lng, nowISO(), id],
  );
}

/** Xoá ghim toạ độ của vị trí */
export async function clearLocationCoords(id: string): Promise<void> {
  await getDb().runAsync(
    'UPDATE locations SET latitude = NULL, longitude = NULL, updated_at = ?, is_dirty = 1 WHERE id = ?',
    [nowISO(), id],
  );
}

/** Đặt icon tự chọn cho vị trí (null = quay về icon mặc định theo loại) */
export async function setLocationIcon(id: string, icon: string | null): Promise<void> {
  await getDb().runAsync('UPDATE locations SET icon = ?, updated_at = ?, is_dirty = 1 WHERE id = ?', [
    icon,
    nowISO(),
    id,
  ]);
}

/**
 * Lưu thứ tự mới của một nhóm anh em (cùng parent_id) sau khi kéo thả:
 * sort_order = index * 10 để còn khe chèn về sau. Chỉ cập nhật đúng các id
 * thuộc nhóm cha đó (parent_id IS ? — so sánh null-safe trong SQLite).
 */
export async function reorderLocations(parentId: string | null, orderedIds: string[]): Promise<void> {
  const db = getDb();
  const now = nowISO();
  await db.withTransactionAsync(async () => {
    for (let i = 0; i < orderedIds.length; i++) {
      await db.runAsync(
        'UPDATE locations SET sort_order = ?, updated_at = ?, is_dirty = 1 WHERE id = ? AND parent_id IS ?',
        [i * 10, now, orderedIds[i], parentId],
      );
    }
  });
}

/** Trả về thông báo lỗi nếu parent không hợp lệ (vòng lặp hoặc quá 4 cấp), ngược lại null */
export async function validateParent(
  db: ReturnType<typeof getDb>,
  locationId: string | null,
  newParentId: string | null,
): Promise<string | null> {
  if (!newParentId) return null;
  if (locationId && newParentId === locationId) return 'Không thể chọn chính vị trí này làm vị trí cha.';
  // Đi lên từ parent mới: vừa đếm độ sâu, vừa kiểm tra vòng lặp
  let depth = 1;
  let current: string | null = newParentId;
  const seen = new Set<string>();
  while (current) {
    if (locationId && current === locationId) return 'Không thể di chuyển vào chính vị trí con của nó.';
    if (seen.has(current)) break;
    seen.add(current);
    const row: { parent_id: string | null } | null = await db.getFirstAsync(
      'SELECT parent_id FROM locations WHERE id = ?',
      [current],
    );
    current = row?.parent_id ?? null;
    depth += 1;
    if (depth > 4) return 'Vị trí tối đa 4 cấp (Nơi ở > Phòng > Khu vực > Vật chứa).';
  }
  return null;
}

export async function moveLocation(id: string, newParentId: string | null): Promise<void> {
  const db = getDb();
  const err = await validateParent(db, id, newParentId);
  if (err) throw new Error(err);
  await db.runAsync('UPDATE locations SET parent_id = ?, updated_at = ?, is_dirty = 1 WHERE id = ?', [
    newParentId,
    nowISO(),
    id,
  ]);
}

export async function renameLocation(id: string, name: string): Promise<void> {
  await getDb().runAsync('UPDATE locations SET name = ?, updated_at = ?, is_dirty = 1 WHERE id = ?', [
    name.trim(),
    nowISO(),
    id,
  ]);
}

export async function softDeleteLocation(id: string): Promise<void> {
  const now = nowISO();
  await getDb().runAsync(
    'UPDATE locations SET is_deleted = 1, deleted_at = ?, updated_at = ?, is_dirty = 1 WHERE id = ?',
    [now, now, id],
  );
}

/** Đường dẫn đầy đủ từ gốc tới vị trí (recursive CTE, đi từ dưới lên) */
export async function getBreadcrumb(locationId: string | null): Promise<Location[]> {
  if (!locationId) return [];
  const rows = await getDb().getAllAsync<Location>(
    `WITH RECURSIVE up(id, parent_id, name, type, description, scene_media_id, qr_code, latitude, longitude, address, household_id, created_at, updated_at, is_deleted, is_dirty, deleted_at, icon, sort_order, depth) AS (
       SELECT *, 0 FROM locations WHERE id = ?
       UNION ALL
       SELECT l.*, up.depth + 1 FROM locations l JOIN up ON l.id = up.parent_id
     )
     SELECT * FROM up ORDER BY depth DESC`,
    [locationId],
  );
  return rows;
}

export function breadcrumbText(chain: Location[]): string {
  return chain.map((l) => l.name).join(' > ');
}

/** Toàn bộ id hậu duệ của một vị trí (gồm chính nó) — truy vấn đệ quy từ trên xuống */
export async function getDescendantLocationIds(rootId: string): Promise<string[]> {
  const rows = await getDb().getAllAsync<{ id: string }>(
    `WITH RECURSIVE down(id) AS (
       SELECT id FROM locations WHERE id = ? AND is_deleted = 0
       UNION ALL
       SELECT l.id FROM locations l JOIN down ON l.parent_id = down.id WHERE l.is_deleted = 0
     )
     SELECT id FROM down`,
    [rootId],
  );
  return rows.map((r) => r.id);
}

// ===================== ITEMS =====================
export type NewItemInput = Partial<Item> & { name: string; location_id: string };

export async function createItem(input: NewItemInput): Promise<Item> {
  const db = getDb();
  const now = nowISO();
  const item: Item = {
    id: uuid(),
    name: input.name.trim(),
    category: input.category ?? 'OTHER',
    tags: input.tags ?? null,
    location_id: input.location_id,
    position_note: input.position_note ?? null,
    scene_media_id: input.scene_media_id ?? null,
    pin_x: input.pin_x ?? null,
    pin_y: input.pin_y ?? null,
    status: 'STORED',
    condition: input.condition ?? 'GOOD',
    condition_note: input.condition_note ?? null,
    quantity: input.quantity ?? 1,
    unit: input.unit ?? 'Cái',
    purchase_price: input.purchase_price ?? null,
    purchase_date: input.purchase_date ?? null,
    purchase_place: input.purchase_place ?? null,
    warranty_expiry_date: input.warranty_expiry_date ?? null,
    expiry_date: input.expiry_date ?? null,
    alert_snoozed_until: null,
    receipt_media_id: input.receipt_media_id ?? null,
    barcode: input.barcode ?? null,
    sold_price: null,
    sold_date: null,
    sold_note: null,
    sold_to: null,
    household_id: null,
    last_accessed_at: now,
    created_at: now,
    updated_at: now,
    is_deleted: 0,
    is_dirty: 1,
    deleted_at: null,
  };
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT INTO items (id, name, category, tags, location_id, position_note, scene_media_id, pin_x, pin_y, status, condition, condition_note, quantity, unit,
        purchase_price, purchase_date, purchase_place, warranty_expiry_date, expiry_date, receipt_media_id, barcode,
        sold_price, sold_date, sold_note, sold_to, household_id, last_accessed_at, created_at, updated_at, is_deleted, is_dirty, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, 0, 1, NULL)`,
      [
        item.id, item.name, item.category, item.tags, item.location_id, item.position_note, item.scene_media_id,
        item.pin_x, item.pin_y, item.status, item.condition, item.condition_note, item.quantity, item.unit,
        item.purchase_price, item.purchase_date, item.purchase_place, item.warranty_expiry_date, item.expiry_date,
        item.receipt_media_id, item.barcode, now, now, now,
      ],
    );
    await logHistory(item.id, 'CREATED', { toLocationId: item.location_id, newStatus: 'STORED' });
  });
  return item;
}

export async function getItem(id: string): Promise<Item | null> {
  return getDb().getFirstAsync<Item>('SELECT * FROM items WHERE id = ? AND is_deleted = 0', [id]);
}

/** Tìm món đồ theo mã QR / barcode đã gắn */
export async function findItemByBarcode(barcode: string): Promise<Item | null> {
  return getDb().getFirstAsync<Item>(
    'SELECT * FROM items WHERE barcode = ? AND is_deleted = 0 LIMIT 1',
    [barcode],
  );
}

export async function updateItem(id: string, patch: Partial<Item>): Promise<void> {
  const db = getDb();
  const allowed: (keyof Item)[] = [
    'name', 'category', 'tags', 'location_id', 'position_note', 'scene_media_id', 'pin_x', 'pin_y',
    // 'status' chỉ dùng để gán trạng thái TỰ TẠO (nhãn trung tính) từ màn Sửa đồ;
    // trạng thái built-in đi qua setItemStatus để giữ hệ quả (bán/vứt/thất lạc…)
    'status',
    'condition', 'condition_note', 'quantity', 'unit', 'purchase_price', 'purchase_date', 'purchase_place',
    'warranty_expiry_date', 'expiry_date', 'receipt_media_id', 'barcode',
  ];
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of allowed) {
    if (key in patch) {
      sets.push(`${key} = ?`);
      values.push((patch[key] as unknown) ?? null);
    }
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?', 'is_dirty = 1', 'last_accessed_at = ?');
  values.push(nowISO(), nowISO(), id);
  await db.runAsync(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`, values as never[]);
}

/**
 * Các trạng thái KẾT THÚC vòng đời: chuyển món sang một trong các trạng thái
 * này (hoặc xoá món) sẽ TỰ ĐÓNG mọi lượt mượn đang mở của món trước.
 * DAMAGED cố ý KHÔNG nằm trong danh sách này: đồ báo hỏng trong lúc đang ở
 * chỗ người mượn là tình huống hợp lệ — lượt mượn phải giữ nguyên để còn
 * ghi nhận nhận lại / sửa chữa về sau (recomputeItemStatusAfterLoan cũng
 * đã có guard không ghi đè DAMAGED).
 */
const LOAN_CLOSING_STATUSES: readonly string[] = ['SOLD', 'GIFTED', 'DONATED', 'DISPOSED', 'LOST', 'USED_UP', 'EXPIRED'];

/**
 * Đóng toàn bộ record ACTIVE của món — cả lượt mượn (kind LOAN) lẫn record
 * gửi bán (kind CONSIGNMENT) — khi món kết thúc vòng đời hoặc bị xoá
 * (phương án người dùng đã chốt: "tự đóng lượt mượn rồi thực hiện thao tác").
 * Phần còn đang ở ngoài (outstanding) được ghi vào quantity_closed với
 * close_reason = 'AUTO_CLOSED' — KHÔNG giả làm người mượn đã trả đồ như
 * cách gán quantity_returned = quantity_lent trước đây — kèm 1 dòng lịch sử
 * LOAN_CLOSED (note = tên người mượn / người giữ) cho mỗi record.
 * Phải được gọi bên trong transaction của thao tác cha (setItemStatus /
 * softDeleteItem) để đóng record và đổi trạng thái là một khối nguyên tử.
 */
export async function closeActiveLoansForItem(itemId: string): Promise<void> {
  const db = getDb();
  const loans = await db.getAllAsync<Loan>(
    "SELECT * FROM loans WHERE item_id = ? AND status = 'ACTIVE' AND is_deleted = 0",
    [itemId],
  );
  if (loans.length === 0) return;
  const now = nowISO();
  for (const loan of loans) {
    const outstanding = outstandingOf(loan);
    await db.runAsync(
      "UPDATE loans SET quantity_closed = quantity_closed + ?, close_reason = 'AUTO_CLOSED', returned_at = ?, status = 'RETURNED', updated_at = ?, is_dirty = 1 WHERE id = ?",
      [outstanding, now, now, loan.id],
    );
    await logHistory(itemId, 'LOAN_CLOSED', { note: loan.borrower_name });
  }
}

export async function setItemStatus(
  id: string,
  newStatus: ItemStatus,
  opts: { note?: string; soldPrice?: number | null; soldTo?: string | null; clearLocation?: boolean } = {},
): Promise<void> {
  const db = getDb();
  const item = await getItem(id);
  if (!item) return;
  const now = nowISO();
  await db.withTransactionAsync(async () => {
    // Trạng thái kết thúc: tự đóng mọi lượt mượn đang mở TRƯỚC khi áp trạng
    // thái mới — món không thể vừa "đã bán/tặng/vứt/mất/dùng hết" vừa còn
    // lượt mượn treo. DAMAGED không đóng (xem LOAN_CLOSING_STATUSES).
    if (LOAN_CLOSING_STATUSES.includes(newStatus)) {
      await closeActiveLoansForItem(id);
    }
    if (newStatus === 'SOLD') {
      await db.runAsync(
        'UPDATE items SET status = ?, sold_price = ?, sold_date = ?, sold_note = ?, sold_to = ?, location_id = NULL, updated_at = ?, is_dirty = 1, last_accessed_at = ? WHERE id = ?',
        [newStatus, opts.soldPrice ?? null, now.slice(0, 10), opts.note ?? null, opts.soldTo ?? null, now, now, id],
      );
    } else if (newStatus === 'DISPOSED' || newStatus === 'LOST' || newStatus === 'GIFTED' || newStatus === 'DONATED' || newStatus === 'USED_UP' || newStatus === 'EXPIRED') {
      // Mọi trạng thái kết thúc (trừ SOLD có giá bán riêng): rời khỏi vị trí,
      // ghi chú kết thúc lưu chung vào sold_note như DISPOSED/LOST trước đây
      await db.runAsync(
        'UPDATE items SET status = ?, sold_note = ?, location_id = NULL, updated_at = ?, is_dirty = 1, last_accessed_at = ? WHERE id = ?',
        [newStatus, opts.note ?? null, now, now, id],
      );
    } else {
      await db.runAsync(
        'UPDATE items SET status = ?, updated_at = ?, is_dirty = 1, last_accessed_at = ? WHERE id = ?',
        [newStatus, now, now, id],
      );
    }
    await logHistory(id, newStatus === 'SOLD' ? 'SOLD' : newStatus === 'GIFTED' ? 'GIFTED' : newStatus === 'DONATED' ? 'DONATED' : newStatus === 'USED_UP' ? 'USED_UP' : newStatus === 'EXPIRED' ? 'EXPIRED' : newStatus === 'DISPOSED' || newStatus === 'LOST' ? 'DISPOSED' : 'STATUS_CHANGED', {
      oldStatus: item.status,
      newStatus,
      note: opts.note ?? null,
    });
  });
}

export async function moveItem(id: string, newLocationId: string): Promise<void> {
  const db = getDb();
  const item = await getItem(id);
  if (!item) return;
  const now = nowISO();
  await db.withTransactionAsync(async () => {
    await db.runAsync('UPDATE items SET location_id = ?, updated_at = ?, is_dirty = 1, last_accessed_at = ? WHERE id = ?', [
      newLocationId, now, now, id,
    ]);
    await logHistory(id, 'MOVED', { fromLocationId: item.location_id, toLocationId: newLocationId });
  });
}

export async function softDeleteItem(id: string): Promise<void> {
  const db = getDb();
  const now = nowISO();
  await db.withTransactionAsync(async () => {
    // Xoá món cũng là thao tác kết thúc: tự đóng các lượt mượn đang mở
    // trước khi xoá, để không còn lượt mượn treo trỏ vào một món đã xoá
    await closeActiveLoansForItem(id);
    await db.runAsync('UPDATE items SET is_deleted = 1, deleted_at = ?, updated_at = ?, is_dirty = 1 WHERE id = ?', [now, now, id]);
  });
}

export async function restoreItem(id: string): Promise<void> {
  const now = nowISO();
  await getDb().runAsync('UPDATE items SET is_deleted = 0, deleted_at = NULL, updated_at = ?, is_dirty = 1 WHERE id = ?', [now, id]);
}

export async function listDeletedItems(): Promise<Item[]> {
  return getDb().getAllAsync<Item>('SELECT * FROM items WHERE is_deleted = 1 ORDER BY deleted_at DESC');
}

export async function listItems(opts: { statusFilter?: string; locationIds?: string[] } = {}): Promise<Item[]> {
  const db = getDb();
  let sql = 'SELECT * FROM items WHERE is_deleted = 0';
  const params: unknown[] = [];
  if (opts.statusFilter === 'EXPIRING') {
    sql += " AND expiry_date IS NOT NULL AND status IN ('STORED','IN_USE') ORDER BY expiry_date ASC";
    return db.getAllAsync<Item>(sql, params as never[]);
  }
  if (opts.statusFilter && opts.statusFilter !== 'ALL') {
    sql += ' AND status = ?';
    params.push(opts.statusFilter);
  } else {
    sql += " AND status NOT IN ('SOLD','GIFTED','DONATED','DISPOSED','LOST','USED_UP','EXPIRED')";
  }
  if (opts.locationIds && opts.locationIds.length > 0) {
    sql += ` AND location_id IN (${opts.locationIds.map(() => '?').join(',')})`;
    params.push(...opts.locationIds);
  }
  sql += ' ORDER BY updated_at DESC';
  return db.getAllAsync<Item>(sql, params as never[]);
}

export async function searchItems(query: string): Promise<Item[]> {
  const db = getDb();
  const trimmed = query.trim();
  if (!trimmed) return listItems();
  if (ftsAvailable) {
    const match = toFtsPrefixQuery(trimmed);
    if (match) {
      try {
        return await db.getAllAsync<Item>(
          `SELECT i.* FROM items_fts f JOIN items i ON i.id = f.item_id
           WHERE f.items_fts MATCH ? AND i.is_deleted = 0 AND i.status NOT IN ('SOLD','GIFTED','DONATED','DISPOSED','LOST','USED_UP','EXPIRED')
           ORDER BY i.updated_at DESC`,
          [match],
        );
      } catch {
        // rơi xuống fallback bên dưới
      }
    }
  }
  // Fallback: bỏ dấu + so khớp trong JS (khi FTS5 không khả dụng)
  const needle = removeDiacritics(trimmed);
  const all = await listItems();
  return all.filter((i) => {
    const locName = '';
    const hay = removeDiacritics([i.name, i.position_note ?? '', i.tags ?? '', i.purchase_place ?? '', locName].join(' '));
    return needle.split(/\s+/).every((t) => hay.includes(t));
  });
}

export async function countActiveItems(): Promise<number> {
  const row = await getDb().getFirstAsync<{ c: number }>(
    "SELECT COUNT(*) as c FROM items WHERE is_deleted = 0 AND status NOT IN ('SOLD','GIFTED','DONATED','DISPOSED','LOST','USED_UP','EXPIRED')",
  );
  return row?.c ?? 0;
}

export async function countLocations(): Promise<number> {
  const row = await getDb().getFirstAsync<{ c: number }>('SELECT COUNT(*) as c FROM locations WHERE is_deleted = 0');
  return row?.c ?? 0;
}

export async function itemsInLocation(locationId: string, recursive = true): Promise<Item[]> {
  const ids = recursive ? await getDescendantLocationIds(locationId) : [locationId];
  if (ids.length === 0) return [];
  return getDb().getAllAsync<Item>(
    `SELECT * FROM items WHERE is_deleted = 0 AND status NOT IN ('SOLD','GIFTED','DONATED','DISPOSED','LOST','USED_UP','EXPIRED') AND location_id IN (${ids.map(() => '?').join(',')}) ORDER BY name`,
    ids as never[],
  );
}

// ===================== MEDIA =====================
export async function registerMedia(input: {
  kind: MediaFile['kind'];
  owner_type: MediaFile['owner_type'];
  owner_id: string;
  local_uri: string;
  thumbnail_uri: string;
  sha256?: string | null;
  size_bytes?: number | null;
  is_primary?: boolean;
}): Promise<MediaFile> {
  const now = nowISO();
  const media: MediaFile = {
    id: uuid(),
    kind: input.kind,
    owner_type: input.owner_type,
    owner_id: input.owner_id,
    local_uri: input.local_uri,
    thumbnail_uri: input.thumbnail_uri,
    drive_file_id: null,
    sync_status: 'PENDING',
    sha256: input.sha256 ?? null,
    size_bytes: input.size_bytes ?? null,
    pin_x: null,
    pin_y: null,
    is_primary: input.is_primary ? 1 : 0,
    created_at: now,
    updated_at: now,
    is_deleted: 0,
    is_dirty: 1,
    deleted_at: null,
  };
  await getDb().runAsync(
    `INSERT INTO media_files (id, kind, owner_type, owner_id, local_uri, thumbnail_uri, drive_file_id, sync_status, sha256, size_bytes, is_primary, created_at, updated_at, is_deleted, is_dirty, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 'PENDING', ?, ?, ?, ?, ?, 0, 1, NULL)`,
    [media.id, media.kind, media.owner_type, media.owner_id, media.local_uri, media.thumbnail_uri, media.sha256, media.size_bytes, media.is_primary, now, now],
  );
  return media;
}

export async function listMediaForOwner(ownerType: string, ownerId: string): Promise<MediaFile[]> {
  return getDb().getAllAsync<MediaFile>(
    'SELECT * FROM media_files WHERE owner_type = ? AND owner_id = ? AND is_deleted = 0 ORDER BY is_primary DESC, created_at ASC',
    [ownerType, ownerId],
  );
}

/**
 * Ảnh hiện trường của một món, kèm ghim riêng của từng tấm (pin_x/pin_y
 * trên chính hàng media_files — mô hình mỗi ảnh hiện trường một ghim).
 */
export async function listSceneMediaForItem(itemId: string): Promise<MediaFile[]> {
  return getDb().getAllAsync<MediaFile>(
    "SELECT * FROM media_files WHERE owner_type = 'ITEM' AND owner_id = ? AND kind = 'ITEM_SCENE' AND is_deleted = 0 ORDER BY created_at ASC",
    [itemId],
  );
}

/** Đặt/di chuyển ghim của MỘT ảnh (toạ độ tỉ lệ 0–1); truyền null để gỡ ghim */
export async function updateMediaPin(mediaId: string, x: number | null, y: number | null): Promise<void> {
  const now = nowISO();
  await getDb().runAsync(
    'UPDATE media_files SET pin_x = ?, pin_y = ?, updated_at = ?, is_dirty = 1 WHERE id = ?',
    [x, y, now, mediaId],
  );
}

/** Đặt một ảnh làm ảnh chính của chủ sở hữu (bỏ cờ chính của các ảnh còn lại) */
export async function setPrimaryMedia(ownerType: string, ownerId: string, mediaId: string): Promise<void> {
  const db = getDb();
  const now = nowISO();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'UPDATE media_files SET is_primary = 0, updated_at = ? WHERE owner_type = ? AND owner_id = ? AND is_deleted = 0',
      [now, ownerType, ownerId],
    );
    await db.runAsync(
      'UPDATE media_files SET is_primary = 1, updated_at = ?, is_dirty = 1 WHERE id = ?',
      [now, mediaId],
    );
  });
}

export async function softDeleteMedia(id: string): Promise<void> {
  const now = nowISO();
  await getDb().runAsync('UPDATE media_files SET is_deleted = 1, deleted_at = ?, updated_at = ?, is_dirty = 1 WHERE id = ?', [now, now, id]);
}

// ===================== LOANS =====================
/**
 * Số lượng của một record còn đang "ở ngoài" chưa ngã ngũ:
 * đã đưa ra − đã trả về nhà − đã đóng (tặng/bán/bố thí/bán hộ/tự đóng).
 * Mọi nơi cần "còn nợ bao nhiêu" đều phải dùng hàm này thay cho
 * (quantity_lent − quantity_returned) thô.
 */
export function outstandingOf(loan: Pick<Loan, 'quantity_lent' | 'quantity_returned' | 'quantity_closed'>): number {
  return Math.max(0, loan.quantity_lent - loan.quantity_returned - (loan.quantity_closed ?? 0));
}

export interface ItemQuantities {
  /** Tổng số lượng của món (items.quantity) */
  total: number;
  /** Đang cho mượn chưa về (Σ outstanding của record ACTIVE kind LOAN) */
  lentOut: number;
  /** Đang gửi bán chưa ngã ngũ (Σ outstanding của record ACTIVE kind CONSIGNMENT) */
  consignedOut: number;
  /** Tổng đang ở ngoài = lentOut + consignedOut */
  out: number;
  /** Đang ở nhà = total − out */
  available: number;
}

/** Cơ cấu số lượng hiện tại của món — nguồn sự thật duy nhất cho UI và các hàm mượn/trả/chuyển đổi */
export async function getItemQuantities(itemId: string): Promise<ItemQuantities> {
  const db = getDb();
  const item = await getItem(itemId);
  if (!item) return { total: 0, lentOut: 0, consignedOut: 0, out: 0, available: 0 };
  const rows = await db.getAllAsync<Loan>(
    "SELECT * FROM loans WHERE item_id = ? AND status = 'ACTIVE' AND is_deleted = 0",
    [itemId],
  );
  let lentOut = 0;
  let consignedOut = 0;
  for (const l of rows) {
    if (l.kind === 'CONSIGNMENT') consignedOut += outstandingOf(l);
    else lentOut += outstandingOf(l);
  }
  const out = lentOut + consignedOut;
  return { total: item.quantity, lentOut, consignedOut, out, available: Math.max(0, item.quantity - out) };
}

export async function getAvailableQuantity(itemId: string): Promise<number> {
  return (await getItemQuantities(itemId)).available;
}

/**
 * Suy trạng thái của món từ cơ cấu số lượng sau mỗi biến động mượn/trả/
 * chuyển đổi/gửi bán. Chỉ quản các trạng thái thuộc vòng đời "đang ở ngoài"
 * (STORED/IN_USE/LENT/PARTIALLY_LENT/CONSIGNED); trạng thái kết thúc
 * (SOLD/GIFTED/DONATED/DISPOSED/LOST/USED_UP/EXPIRED), DAMAGED và trạng thái TỰ TẠO
 * (id 'st_…', không thuộc tập trên) không bao giờ bị ghi đè.
 * Công thức: out = 0 → STORED; còn ở nhà → PARTIALLY_LENT; hết ở nhà mà
 * còn cho mượn → LENT; hết ở nhà, chỉ còn gửi bán → CONSIGNED.
 */
async function recomputeItemStatusAfterLoan(itemId: string): Promise<void> {
  const db = getDb();
  const item = await getItem(itemId);
  if (!item) return;
  const MANAGED: readonly string[] = ['STORED', 'IN_USE', 'LENT', 'PARTIALLY_LENT', 'CONSIGNED'];
  if (!MANAGED.includes(item.status)) return;
  const q = await getItemQuantities(itemId);
  const newStatus: ItemStatus =
    q.out === 0 ? 'STORED'
      : q.available > 0 ? 'PARTIALLY_LENT'
        : q.lentOut > 0 ? 'LENT'
          : 'CONSIGNED';
  if (newStatus !== item.status) {
    const now = nowISO();
    await db.runAsync('UPDATE items SET status = ?, updated_at = ?, is_dirty = 1 WHERE id = ?', [newStatus, now, itemId]);
  }
}

export async function createLoan(input: {
  item_id: string;
  borrower_name: string;
  borrower_phone?: string | null;
  quantity_lent: number;
  expected_return_date?: string | null;
  handover_media_id?: string | null;
  note?: string | null;
}): Promise<Loan> {
  const db = getDb();
  const available = await getAvailableQuantity(input.item_id);
  if (input.quantity_lent < 1 || input.quantity_lent > available) {
    throw new Error(`Số lượng không hợp lệ. Đang có sẵn ${available}.`);
  }
  const now = nowISO();
  const loan: Loan = {
    id: uuid(),
    item_id: input.item_id,
    kind: 'LOAN',
    borrower_name: input.borrower_name.trim(),
    borrower_phone: input.borrower_phone ?? null,
    quantity_lent: input.quantity_lent,
    quantity_returned: 0,
    quantity_closed: 0,
    close_reason: null,
    expected_price: null,
    lent_at: now,
    expected_return_date: input.expected_return_date ?? null,
    alert_snoozed_until: null,
    returned_at: null,
    status: 'ACTIVE',
    handover_media_id: input.handover_media_id ?? null,
    return_media_id: null,
    note: input.note ?? null,
    created_at: now,
    updated_at: now,
    is_deleted: 0,
    is_dirty: 1,
    deleted_at: null,
  };
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT INTO loans (id, item_id, kind, borrower_name, borrower_phone, quantity_lent, quantity_returned, quantity_closed, close_reason, expected_price, lent_at, expected_return_date, returned_at, status, handover_media_id, return_media_id, note, created_at, updated_at, is_deleted, is_dirty, deleted_at)
       VALUES (?, ?, 'LOAN', ?, ?, ?, 0, 0, NULL, NULL, ?, ?, NULL, 'ACTIVE', ?, ?, ?, ?, ?, 0, 1, NULL)`,
      [loan.id, loan.item_id, loan.borrower_name, loan.borrower_phone, loan.quantity_lent, now, loan.expected_return_date, loan.handover_media_id, loan.return_media_id, loan.note, now, now],
    );
    await logHistory(input.item_id, input.quantity_lent >= available ? 'LENT' : 'PARTIALLY_LENT', {
      note: JSON.stringify({ loan_id: loan.id, borrower: loan.borrower_name, qty: loan.quantity_lent }),
    });
    await recomputeItemStatusAfterLoan(input.item_id);
  });
  return loan;
}

/**
 * Nhận lại đồ cho một lượt mượn: cộng quantity_returned; khi outstanding về
 * 0 (tính cả phần đã đóng trước đó) thì record kết thúc với
 * close_reason = 'RETURNED'. Note lịch sử dạng JSON như các dòng mượn/trả
 * khác — gồm số lượng của lần trả này và ghi chú người dùng (nếu có) để
 * dòng lịch sử đọc lại được "ai trả, bao nhiêu, kèm lời nhắn gì".
 */
export async function returnLoan(
  loanId: string,
  quantity: number,
  opts: { note?: string | null; returnMediaId?: string | null } = {},
): Promise<void> {
  const db = getDb();
  const loan = await db.getFirstAsync<Loan>('SELECT * FROM loans WHERE id = ? AND is_deleted = 0', [loanId]);
  if (!loan || loan.status !== 'ACTIVE') return;
  const remaining = outstandingOf(loan);
  if (remaining <= 0) return;
  const qty = Math.min(Math.max(quantity, 1), remaining);
  const newReturned = loan.quantity_returned + qty;
  const fullyReturned = outstandingOf({ ...loan, quantity_returned: newReturned }) === 0;
  const now = nowISO();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'UPDATE loans SET quantity_returned = ?, returned_at = ?, status = ?, close_reason = ?, return_media_id = COALESCE(?, return_media_id), updated_at = ?, is_dirty = 1 WHERE id = ?',
      [newReturned, fullyReturned ? now : loan.returned_at, fullyReturned ? 'RETURNED' : 'ACTIVE', fullyReturned ? 'RETURNED' : loan.close_reason, opts.returnMediaId ?? null, now, loanId],
    );
    await logHistory(loan.item_id, 'LOAN_RETURNED', {
      note: JSON.stringify({ loan_id: loanId, qty, borrower: loan.borrower_name, ...(opts.note ? { note: opts.note } : null) }),
    });
    await recomputeItemStatusAfterLoan(loan.item_id);
  });
}

/**
 * Các lượt CHO MƯỢN đang mở (chỉ kind LOAN) — nguồn cho tab Cho mượn, cảnh
 * báo hạn trả ở Trang chủ và lịch nhắc. Record GỬI BÁN không bao giờ lọt
 * vào đây (không có hạn trả, không nhắc đòi) — xem listActiveConsignments.
 */
export async function listActiveLoans(): Promise<(Loan & { item_name: string; item_unit: string; item_category: string })[]> {
  return getDb().getAllAsync(
    `SELECT l.*, i.name as item_name, i.unit as item_unit, i.category as item_category FROM loans l JOIN items i ON i.id = l.item_id
     WHERE l.status = 'ACTIVE' AND l.kind = 'LOAN' AND l.is_deleted = 0
     ORDER BY (l.expected_return_date IS NULL), l.expected_return_date ASC`,
  );
}

/** Các record GỬI BÁN đang mở (kind CONSIGNMENT) — cho section "Đang gửi bán" ở tab Cho mượn */
export async function listActiveConsignments(): Promise<(Loan & { item_name: string; item_unit: string; item_category: string })[]> {
  return getDb().getAllAsync(
    `SELECT l.*, i.name as item_name, i.unit as item_unit, i.category as item_category FROM loans l JOIN items i ON i.id = l.item_id
     WHERE l.status = 'ACTIVE' AND l.kind = 'CONSIGNMENT' AND l.is_deleted = 0
     ORDER BY l.lent_at ASC`,
  );
}

export async function listReturnedLoans(): Promise<(Loan & { item_name: string; item_category: string })[]> {
  return getDb().getAllAsync(
    `SELECT l.*, i.name as item_name, i.category as item_category FROM loans l JOIN items i ON i.id = l.item_id
     WHERE l.status = 'RETURNED' AND l.kind = 'LOAN' AND l.is_deleted = 0 AND l.returned_at >= datetime('now', '-12 months')
     ORDER BY l.returned_at DESC`,
  );
}

export async function listLoansForItem(itemId: string): Promise<Loan[]> {
  return getDb().getAllAsync<Loan>(
    'SELECT * FROM loans WHERE item_id = ? AND is_deleted = 0 ORDER BY created_at DESC',
    [itemId],
  );
}

/** Số lượt mượn đang mở (ACTIVE) của món — dùng để cảnh báo tự đóng lượt ở UI */
export async function countActiveLoansForItem(itemId: string): Promise<number> {
  const row = await getDb().getFirstAsync<{ c: number }>(
    "SELECT COUNT(*) as c FROM loans WHERE item_id = ? AND status = 'ACTIVE' AND is_deleted = 0",
    [itemId],
  );
  return row?.c ?? 0;
}

// ===================== SỐ LƯỢNG Ở FORM TRẠNG THÁI =====================
/** Nhóm GIẢM KHO: áp một phần thì trừ kho, giữ nguyên trạng thái vòng đời */
const QTY_REDUCING_STATUSES: readonly string[] = ['SOLD', 'GIFTED', 'DONATED', 'USED_UP', 'DISPOSED', 'EXPIRED'];

/**
 * Áp một trạng thái đích lên `qty` cái ĐANG Ở NHÀ của món (qty luôn bị kẹp
 * trong 1..available; UI mặc định qty = available kèm cảnh báo riêng):
 * - GIẢM KHO (SOLD/GIFTED/DONATED/USED_UP/DISPOSED/EXPIRED):
 *   qty = available và không còn gì ở ngoài → setItemStatus đầy đủ như cũ
 *   (SOLD kèm sold_to/sold_price/sold_note); ngược lại chỉ trừ kho, recompute
 *   trạng thái, lịch sử action = status với note do UI soạn (uiNote).
 * - MỌI trạng thái đích còn lại (DAMAGED/LOST, trạng thái TỰ TẠO, STORED,
 *   IN_USE…) đi cơ chế TÁCH: qty = available và không còn gì ở ngoài →
 *   setItemStatus đầy đủ; ngược lại TÁCH phần qty thành bản ghi mới mang
 *   trạng thái đích (trường mô tả giữ nguyên, barcode/qr để trống, sold_*
 *   để trống, ảnh được clone trỏ cùng URI), gốc trừ kho + recompute, lịch
 *   sử gốc 'SPLIT', bản clone 'CREATED' với note "Tách từ {tên gốc}".
 *   Chạm giới hạn số món của gói thì ném lỗi để UI báo người dùng.
 */
export async function applyStatusWithQuantity(
  itemId: string,
  status: string,
  qty: number,
  opts: { note?: string | null; price?: number | null; buyer?: string | null; uiNote: string },
): Promise<void> {
  const db = getDb();
  const item = await getItem(itemId);
  if (!item) throw new Error('ITEM_NOT_FOUND');
  const q = await getItemQuantities(itemId);
  const n = Math.min(Math.max(Math.trunc(qty) || 0, 0), q.available);
  if (n <= 0) throw new Error('QTY_INVALID');

  const fullAtHome = n === q.available && q.out === 0;

  if (!QTY_REDUCING_STATUSES.includes(status)) {
    if (fullAtHome) {
      await setItemStatus(itemId, status as ItemStatus, { note: opts.note ?? undefined });
      return;
    }
    // Tách món tạo thêm 1 bản ghi đang hoạt động — chạm trần gói thì dừng
    if ((await countActiveItems()) >= getCurrentLimits().maxActiveItems) {
      throw new Error(translate(getCurrentLang(), 'qty.limitSplitMsg', { n: getCurrentLimits().maxActiveItems }));
    }
    await db.withTransactionAsync(async () => {
      const cur = await getItem(itemId);
      if (!cur) return;
      const now = nowISO();
      const cloneId = uuid();
      // Clone các hàng media trỏ cùng URI vật lý; scene/receipt của bản
      // clone trỏ sang hàng media MỚI tương ứng (không dùng chung id với gốc)
      const mediaRows = await listMediaForOwner('ITEM', itemId);
      const mediaIdMap = new Map<string, string>();
      for (const m of mediaRows) {
        const newMediaId = uuid();
        mediaIdMap.set(m.id, newMediaId);
        await db.runAsync(
          `INSERT INTO media_files (id, kind, owner_type, owner_id, local_uri, thumbnail_uri, drive_file_id, sync_status, sha256, size_bytes, pin_x, pin_y, is_primary, created_at, updated_at, is_deleted, is_dirty, deleted_at)
           VALUES (?, ?, 'ITEM', ?, ?, ?, NULL, 'PENDING', ?, ?, ?, ?, ?, ?, ?, 0, 1, NULL)`,
          [newMediaId, m.kind, cloneId, m.local_uri, m.thumbnail_uri, m.sha256, m.size_bytes, m.pin_x, m.pin_y, m.is_primary, now, now],
        );
      }
      await db.runAsync(
        `INSERT INTO items (id, name, category, tags, location_id, position_note, scene_media_id, pin_x, pin_y, status, condition, condition_note, quantity, unit,
          purchase_price, purchase_date, purchase_place, warranty_expiry_date, expiry_date, receipt_media_id, barcode,
          sold_price, sold_date, sold_note, sold_to, household_id, last_accessed_at, created_at, updated_at, is_deleted, is_dirty, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, 0, 1, NULL)`,
        [
          cloneId, cur.name, cur.category, cur.tags, cur.location_id, cur.position_note,
          cur.scene_media_id ? mediaIdMap.get(cur.scene_media_id) ?? null : null,
          cur.pin_x, cur.pin_y, status, cur.condition, cur.condition_note, n, cur.unit,
          cur.purchase_price, cur.purchase_date, cur.purchase_place, cur.warranty_expiry_date, cur.expiry_date,
          cur.receipt_media_id ? mediaIdMap.get(cur.receipt_media_id) ?? cur.receipt_media_id : null,
          cur.household_id, now, now, now,
        ],
      );
      await db.runAsync('UPDATE items SET quantity = ?, updated_at = ?, is_dirty = 1 WHERE id = ?', [cur.quantity - n, now, itemId]);
      await logHistory(itemId, 'SPLIT', { oldStatus: cur.status, newStatus: cur.status, note: opts.uiNote });
      await logHistory(cloneId, 'CREATED', {
        toLocationId: cur.location_id,
        newStatus: status,
        note: translate(getCurrentLang(), 'qty.splitFrom', { name: cur.name }),
      });
      await recomputeItemStatusAfterLoan(itemId);
    });
    return;
  }

  // Nhóm GIẢM KHO
  if (fullAtHome) {
    await setItemStatus(itemId, status as ItemStatus, {
      note: opts.note ?? undefined,
      soldPrice: opts.price ?? null,
      soldTo: opts.buyer ?? null,
    });
    return;
  }
  await db.withTransactionAsync(async () => {
    const cur = await getItem(itemId);
    if (!cur) return;
    const now = nowISO();
    await db.runAsync('UPDATE items SET quantity = ?, updated_at = ?, is_dirty = 1 WHERE id = ?', [cur.quantity - n, now, itemId]);
    await logHistory(itemId, status, { oldStatus: cur.status, newStatus: cur.status, note: opts.uiNote });
    await recomputeItemStatusAfterLoan(itemId);
  });
}

// ===================== CHUYỂN ĐỔI TRÊN RECORD MƯỢN / GỬI BÁN =====================
/**
 * Kết thúc phần của món NGAY TẠI record (tặng/bán/bố thí cho chính người
 * đang mượn): phần qty chuyển vào quantity_closed của lượt mượn (hết
 * outstanding thì record đóng với close_reason = type), đồng thời trừ kho
 * của món — kho về 0 thì món kết thúc theo type như nhánh tương ứng của
 * setItemStatus (SOLD ghi sold_price/sold_to = người mượn/sold_note =
 * uiNote).
 * Lịch sử action = type, note dạng JSON {borrower, qty, note?} như các
 * dòng mượn/trả (histWho = người nhận phía lịch sử: người mượn, riêng Bố
 * thí là nơi/người nhận bố thí; histExtra = phần phụ như giá/ghi chú) để
 * timeline đọc một khuôn "người · SL n · phụ" — uiNote chỉ còn dùng làm
 * sold_note khi món kết thúc hẳn tại record này.
 */
export async function convertLoanPortion(
  loanId: string,
  opts: {
    type: 'GIFTED' | 'SOLD' | 'DONATED'; qty: number; price?: number | null; uiNote: string;
    histWho?: string; histExtra?: string | null;
  },
): Promise<void> {
  const db = getDb();
  await db.withTransactionAsync(async () => {
    const loan = await db.getFirstAsync<Loan>('SELECT * FROM loans WHERE id = ? AND is_deleted = 0', [loanId]);
    if (!loan || loan.status !== 'ACTIVE' || loan.kind !== 'LOAN') return;
    const outstanding = outstandingOf(loan);
    const qty = Math.min(Math.max(Math.trunc(opts.qty) || 0, 0), outstanding);
    if (qty <= 0) return;
    const item = await getItem(loan.item_id);
    if (!item) return;
    const now = nowISO();
    const newClosed = loan.quantity_closed + qty;
    const done = outstandingOf({ ...loan, quantity_closed: newClosed }) === 0;
    await db.runAsync(
      'UPDATE loans SET quantity_closed = ?, status = ?, returned_at = ?, close_reason = ?, updated_at = ?, is_dirty = 1 WHERE id = ?',
      [newClosed, done ? 'RETURNED' : 'ACTIVE', done ? now : loan.returned_at, done ? opts.type : loan.close_reason, now, loanId],
    );
    const newQty = item.quantity - qty;
    if (newQty <= 0) {
      // Toàn bộ kho đã ngã ngũ tại record này → món kết thúc theo type
      if (opts.type === 'SOLD') {
        await db.runAsync(
          'UPDATE items SET status = ?, sold_price = ?, sold_date = ?, sold_note = ?, sold_to = ?, location_id = NULL, updated_at = ?, is_dirty = 1, last_accessed_at = ? WHERE id = ?',
          ['SOLD', opts.price ?? null, now.slice(0, 10), opts.uiNote, loan.borrower_name, now, now, item.id],
        );
      } else {
        await db.runAsync(
          'UPDATE items SET status = ?, sold_note = ?, location_id = NULL, updated_at = ?, is_dirty = 1, last_accessed_at = ? WHERE id = ?',
          [opts.type, opts.uiNote, now, now, item.id],
        );
      }
    } else {
      await db.runAsync('UPDATE items SET quantity = ?, updated_at = ?, is_dirty = 1 WHERE id = ?', [newQty, now, item.id]);
      await recomputeItemStatusAfterLoan(item.id);
    }
    const after = await getItem(item.id);
    await logHistory(item.id, opts.type, {
      oldStatus: item.status,
      newStatus: after?.status ?? item.status,
      note: JSON.stringify({
        borrower: opts.histWho ?? loan.borrower_name,
        qty,
        ...(opts.histExtra ? { note: opts.histExtra } : null),
      }),
    });
  });
}

/**
 * Chuyển một phần (hoặc toàn bộ) phần đang cho mượn thành GỬI BÁN: tạo
 * record MỚI kind = CONSIGNMENT (người giữ = người đang mượn, giá mong muốn
 * + ghi chú của người dùng), đồng thời giảm quantity_lent của record gốc —
 * record gốc hết outstanding thì đóng với close_reason = 'TO_CONSIGNMENT'.
 * Lịch sử action 'CONSIGNED', note dạng JSON {borrower, qty, note?} như
 * các dòng mượn/trả (histExtra = giá mong muốn đã định dạng, nếu có);
 * uiNote giữ lại trong chữ ký cho tương thích nhưng không còn được dùng
 * làm note lịch sử.
 */
export async function convertLoanToConsignment(
  loanId: string,
  opts: { qty: number; expectedPrice?: number | null; note?: string | null; uiNote: string; histExtra?: string | null },
): Promise<void> {
  const db = getDb();
  await db.withTransactionAsync(async () => {
    const loan = await db.getFirstAsync<Loan>('SELECT * FROM loans WHERE id = ? AND is_deleted = 0', [loanId]);
    if (!loan || loan.status !== 'ACTIVE' || loan.kind !== 'LOAN') return;
    const outstanding = outstandingOf(loan);
    const qty = Math.min(Math.max(Math.trunc(opts.qty) || 0, 0), outstanding);
    if (qty <= 0) return;
    const now = nowISO();
    await db.runAsync(
      `INSERT INTO loans (id, item_id, kind, borrower_name, borrower_phone, quantity_lent, quantity_returned, quantity_closed, close_reason, expected_price, lent_at, expected_return_date, returned_at, status, handover_media_id, return_media_id, note, created_at, updated_at, is_deleted, is_dirty, deleted_at)
       VALUES (?, ?, 'CONSIGNMENT', ?, ?, ?, 0, 0, NULL, ?, ?, NULL, NULL, 'ACTIVE', NULL, NULL, ?, ?, ?, 0, 1, NULL)`,
      [uuid(), loan.item_id, loan.borrower_name, loan.borrower_phone, qty, opts.expectedPrice ?? null, now, opts.note ?? null, now, now],
    );
    const newLent = loan.quantity_lent - qty;
    const done = outstandingOf({ ...loan, quantity_lent: newLent }) === 0;
    await db.runAsync(
      'UPDATE loans SET quantity_lent = ?, status = ?, returned_at = ?, close_reason = ?, updated_at = ?, is_dirty = 1 WHERE id = ?',
      [newLent, done ? 'RETURNED' : 'ACTIVE', done ? now : loan.returned_at, done ? 'TO_CONSIGNMENT' : loan.close_reason, now, loanId],
    );
    await logHistory(loan.item_id, 'CONSIGNED', {
      note: JSON.stringify({
        borrower: loan.borrower_name,
        qty,
        ...(opts.histExtra ? { note: opts.histExtra } : null),
      }),
    });
    await recomputeItemStatusAfterLoan(loan.item_id);
  });
}

/**
 * Ngã ngũ một record GỬI BÁN:
 * - SOLD (đã bán được): phần qty vào quantity_closed (hết thì đóng với
 *   close_reason = 'CONSIGNMENT_SOLD'), trừ kho của món — kho về 0 thì món
 *   kết thúc SOLD với sold_price = giá bán thực tế, sold_to = người giữ.
 * - TAKEBACK (lấy lại): phần qty vào quantity_returned (hết thì đóng với
 *   close_reason = 'TAKEN_BACK'), món recompute như một lượt trả đồ.
 * Lịch sử: SOLD → action 'SOLD'; TAKEBACK → action 'RETURNED'; note dạng
 * JSON {borrower = người giữ, qty, note = giá bán đã định dạng (chỉ SOLD)}
 * như các dòng mượn/trả; uiNote chỉ còn dùng làm sold_note khi món kết
 * thúc hẳn ở ngã ngũ Bán được.
 */
export async function resolveConsignment(
  loanId: string,
  opts: { mode: 'SOLD' | 'TAKEBACK'; qty: number; price?: number | null; uiNote: string },
): Promise<void> {
  const db = getDb();
  await db.withTransactionAsync(async () => {
    const rec = await db.getFirstAsync<Loan>('SELECT * FROM loans WHERE id = ? AND is_deleted = 0', [loanId]);
    if (!rec || rec.status !== 'ACTIVE' || rec.kind !== 'CONSIGNMENT') return;
    const outstanding = outstandingOf(rec);
    const qty = Math.min(Math.max(Math.trunc(opts.qty) || 0, 0), outstanding);
    if (qty <= 0) return;
    const item = await getItem(rec.item_id);
    if (!item) return;
    const now = nowISO();
    if (opts.mode === 'SOLD') {
      const newClosed = rec.quantity_closed + qty;
      const done = outstandingOf({ ...rec, quantity_closed: newClosed }) === 0;
      await db.runAsync(
        'UPDATE loans SET quantity_closed = ?, status = ?, returned_at = ?, close_reason = ?, updated_at = ?, is_dirty = 1 WHERE id = ?',
        [newClosed, done ? 'RETURNED' : 'ACTIVE', done ? now : rec.returned_at, done ? 'CONSIGNMENT_SOLD' : rec.close_reason, now, loanId],
      );
      const newQty = item.quantity - qty;
      if (newQty <= 0) {
        await db.runAsync(
          'UPDATE items SET status = ?, sold_price = ?, sold_date = ?, sold_note = ?, sold_to = ?, location_id = NULL, updated_at = ?, is_dirty = 1, last_accessed_at = ? WHERE id = ?',
          ['SOLD', opts.price ?? null, now.slice(0, 10), opts.uiNote, rec.borrower_name, now, now, item.id],
        );
      } else {
        await db.runAsync('UPDATE items SET quantity = ?, updated_at = ?, is_dirty = 1 WHERE id = ?', [newQty, now, item.id]);
        await recomputeItemStatusAfterLoan(item.id);
      }
      const after = await getItem(item.id);
      await logHistory(item.id, 'SOLD', {
        oldStatus: item.status,
        newStatus: after?.status ?? item.status,
        note: JSON.stringify({
          borrower: rec.borrower_name,
          qty,
          ...(opts.price ? { note: formatVND(opts.price) } : null),
        }),
      });
    } else {
      const newReturned = rec.quantity_returned + qty;
      const done = outstandingOf({ ...rec, quantity_returned: newReturned }) === 0;
      await db.runAsync(
        'UPDATE loans SET quantity_returned = ?, status = ?, returned_at = ?, close_reason = ?, updated_at = ?, is_dirty = 1 WHERE id = ?',
        [newReturned, done ? 'RETURNED' : 'ACTIVE', done ? now : rec.returned_at, done ? 'TAKEN_BACK' : rec.close_reason, now, loanId],
      );
      await recomputeItemStatusAfterLoan(item.id);
      await logHistory(item.id, 'RETURNED', {
        note: JSON.stringify({ borrower: rec.borrower_name, qty }),
      });
    }
  });
}

// ===================== CẢNH BÁO: HOÃN NHẮC + GIA HẠN VAY =====================
/** Hoãn nhắc cảnh báo hạn dùng của món tới hết ngày isoDate (YYYY-MM-DD); null = bỏ hoãn */
export async function setItemAlertSnooze(id: string, isoDate: string | null): Promise<void> {
  await getDb().runAsync('UPDATE items SET alert_snoozed_until = ?, updated_at = ?, is_dirty = 1 WHERE id = ?', [
    isoDate,
    nowISO(),
    id,
  ]);
}

/** Hoãn nhắc cảnh báo hạn trả của khoản vay tới hết ngày isoDate; null = bỏ hoãn */
export async function setLoanAlertSnooze(id: string, isoDate: string | null): Promise<void> {
  await getDb().runAsync('UPDATE loans SET alert_snoozed_until = ?, updated_at = ?, is_dirty = 1 WHERE id = ?', [
    isoDate,
    nowISO(),
    id,
  ]);
}

/** Gia hạn ngày hẹn trả của khoản vay (chỉ khi còn ACTIVE) */
export async function extendLoanDue(loanId: string, newIsoDate: string): Promise<void> {
  await getDb().runAsync(
    "UPDATE loans SET expected_return_date = ?, updated_at = ?, is_dirty = 1 WHERE id = ? AND status = 'ACTIVE'",
    [newIsoDate.slice(0, 10), nowISO(), loanId],
  );
}

export async function getExpiringItems(withinDays: number): Promise<Item[]> {
  return getDb().getAllAsync<Item>(
    `SELECT * FROM items WHERE is_deleted = 0 AND expiry_date IS NOT NULL AND status IN ('STORED','IN_USE')
     AND date(expiry_date) <= date('now', ?) ORDER BY expiry_date ASC`,
    [`+${withinDays} days`],
  );
}
