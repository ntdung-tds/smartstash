import { getDb, ftsAvailable } from './client';
import type { Item, Location, Loan, MediaFile, ItemHistory, ItemStatus } from '../types';
import { uuid, nowISO, removeDiacritics, toFtsPrefixQuery } from '../utils';

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
        sold_price, sold_date, sold_note, household_id, last_accessed_at, created_at, updated_at, is_deleted, is_dirty, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, 0, 1, NULL)`,
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

export async function setItemStatus(
  id: string,
  newStatus: ItemStatus,
  opts: { note?: string; soldPrice?: number | null; clearLocation?: boolean } = {},
): Promise<void> {
  const db = getDb();
  const item = await getItem(id);
  if (!item) return;
  const now = nowISO();
  await db.withTransactionAsync(async () => {
    if (newStatus === 'SOLD') {
      await db.runAsync(
        'UPDATE items SET status = ?, sold_price = ?, sold_date = ?, sold_note = ?, location_id = NULL, updated_at = ?, is_dirty = 1, last_accessed_at = ? WHERE id = ?',
        [newStatus, opts.soldPrice ?? null, now.slice(0, 10), opts.note ?? null, now, now, id],
      );
    } else if (newStatus === 'DISPOSED' || newStatus === 'LOST') {
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
    await logHistory(id, newStatus === 'SOLD' ? 'SOLD' : newStatus === 'DISPOSED' || newStatus === 'LOST' ? 'DISPOSED' : 'STATUS_CHANGED', {
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
  const now = nowISO();
  await getDb().runAsync('UPDATE items SET is_deleted = 1, deleted_at = ?, updated_at = ?, is_dirty = 1 WHERE id = ?', [now, now, id]);
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
    sql += " AND status NOT IN ('SOLD','DISPOSED','LOST')";
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
           WHERE f.items_fts MATCH ? AND i.is_deleted = 0 AND i.status NOT IN ('SOLD','DISPOSED','LOST')
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
    "SELECT COUNT(*) as c FROM items WHERE is_deleted = 0 AND status NOT IN ('SOLD','DISPOSED','LOST')",
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
    `SELECT * FROM items WHERE is_deleted = 0 AND status NOT IN ('SOLD','DISPOSED','LOST') AND location_id IN (${ids.map(() => '?').join(',')}) ORDER BY name`,
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
export async function getAvailableQuantity(itemId: string): Promise<number> {
  const db = getDb();
  const item = await getItem(itemId);
  if (!item) return 0;
  const row = await db.getFirstAsync<{ s: number | null }>(
    "SELECT COALESCE(SUM(quantity_lent - quantity_returned), 0) as s FROM loans WHERE item_id = ? AND status = 'ACTIVE' AND is_deleted = 0",
    [itemId],
  );
  return item.quantity - (row?.s ?? 0);
}

async function recomputeItemStatusAfterLoan(itemId: string): Promise<void> {
  const db = getDb();
  const item = await getItem(itemId);
  if (!item || item.status === 'SOLD' || item.status === 'DISPOSED' || item.status === 'LOST') return;
  const available = await getAvailableQuantity(itemId);
  const lentOut = item.quantity - available;
  const newStatus: ItemStatus = lentOut <= 0 ? 'STORED' : available <= 0 ? 'LENT' : 'PARTIALLY_LENT';
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
    borrower_name: input.borrower_name.trim(),
    borrower_phone: input.borrower_phone ?? null,
    quantity_lent: input.quantity_lent,
    quantity_returned: 0,
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
      `INSERT INTO loans (id, item_id, borrower_name, borrower_phone, quantity_lent, quantity_returned, lent_at, expected_return_date, returned_at, status, handover_media_id, return_media_id, note, created_at, updated_at, is_deleted, is_dirty, deleted_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, 'ACTIVE', ?, ?, ?, ?, ?, 0, 1, NULL)`,
      [loan.id, loan.item_id, loan.borrower_name, loan.borrower_phone, loan.quantity_lent, now, loan.expected_return_date, loan.handover_media_id, loan.return_media_id, loan.note, now, now],
    );
    await logHistory(input.item_id, input.quantity_lent >= available ? 'LENT' : 'PARTIALLY_LENT', {
      note: JSON.stringify({ loan_id: loan.id, borrower: loan.borrower_name, qty: loan.quantity_lent }),
    });
    await recomputeItemStatusAfterLoan(input.item_id);
  });
  return loan;
}

export async function returnLoan(loanId: string, quantity: number, returnMediaId?: string | null): Promise<void> {
  const db = getDb();
  const loan = await db.getFirstAsync<Loan>('SELECT * FROM loans WHERE id = ? AND is_deleted = 0', [loanId]);
  if (!loan || loan.status !== 'ACTIVE') return;
  const remaining = loan.quantity_lent - loan.quantity_returned;
  const qty = Math.min(Math.max(quantity, 1), remaining);
  const newReturned = loan.quantity_returned + qty;
  const fullyReturned = newReturned >= loan.quantity_lent;
  const now = nowISO();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'UPDATE loans SET quantity_returned = ?, returned_at = ?, status = ?, return_media_id = COALESCE(?, return_media_id), updated_at = ?, is_dirty = 1 WHERE id = ?',
      [newReturned, fullyReturned ? now : loan.returned_at, fullyReturned ? 'RETURNED' : 'ACTIVE', returnMediaId ?? null, now, loanId],
    );
    await logHistory(loan.item_id, 'LOAN_RETURNED', {
      note: JSON.stringify({ loan_id: loanId, qty, borrower: loan.borrower_name }),
    });
    await recomputeItemStatusAfterLoan(loan.item_id);
  });
}

export async function listActiveLoans(): Promise<(Loan & { item_name: string })[]> {
  return getDb().getAllAsync(
    `SELECT l.*, i.name as item_name FROM loans l JOIN items i ON i.id = l.item_id
     WHERE l.status = 'ACTIVE' AND l.is_deleted = 0
     ORDER BY (l.expected_return_date IS NULL), l.expected_return_date ASC`,
  );
}

export async function listReturnedLoans(): Promise<(Loan & { item_name: string })[]> {
  return getDb().getAllAsync(
    `SELECT l.*, i.name as item_name FROM loans l JOIN items i ON i.id = l.item_id
     WHERE l.status = 'RETURNED' AND l.is_deleted = 0 AND l.returned_at >= datetime('now', '-12 months')
     ORDER BY l.returned_at DESC`,
  );
}

export async function listLoansForItem(itemId: string): Promise<Loan[]> {
  return getDb().getAllAsync<Loan>(
    'SELECT * FROM loans WHERE item_id = ? AND is_deleted = 0 ORDER BY created_at DESC',
    [itemId],
  );
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
