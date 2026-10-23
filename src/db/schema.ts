// Schema v2 (v2.1) — theo B.14 tài liệu hợp nhất SmartStash v2.1
// Đã áp dụng: V21-05 (FOOD, KIDS), V21-06 (LOST, NEED_REPAIR), V21-08 (trigger FTS bỏ OF), V21-09 (deleted_at)

export const SCHEMA_VERSION = 2;

export const INIT_SQL = `
CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'CONTAINER',
  description TEXT,
  scene_media_id TEXT,
  qr_code TEXT UNIQUE,
  latitude REAL,
  longitude REAL,
  address TEXT,
  household_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  is_dirty INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  icon TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (parent_id) REFERENCES locations(id) ON DELETE SET NULL,
  FOREIGN KEY (scene_media_id) REFERENCES media_files(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations(parent_id) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_locations_qr ON locations(qr_code) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'OTHER',
  tags TEXT,
  location_id TEXT,
  position_note TEXT,
  scene_media_id TEXT,
  pin_x REAL,
  pin_y REAL,
  status TEXT NOT NULL DEFAULT 'STORED',
  condition TEXT NOT NULL DEFAULT 'GOOD',
  condition_note TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit TEXT DEFAULT 'Cái',
  purchase_price INTEGER,
  purchase_date TEXT,
  purchase_place TEXT,
  warranty_expiry_date TEXT,
  expiry_date TEXT,
  alert_snoozed_until TEXT,
  receipt_media_id TEXT,
  barcode TEXT,
  sold_price INTEGER,
  sold_date TEXT,
  sold_note TEXT,
  sold_to TEXT,
  household_id TEXT,
  last_accessed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  is_dirty INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_items_location ON items(location_id) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_items_expiry ON items(expiry_date) WHERE is_deleted = 0 AND expiry_date IS NOT NULL;

CREATE TABLE IF NOT EXISTS media_files (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  local_uri TEXT NOT NULL,
  thumbnail_uri TEXT NOT NULL,
  drive_file_id TEXT,
  sync_status TEXT NOT NULL DEFAULT 'PENDING',
  sha256 TEXT,
  size_bytes INTEGER,
  pin_x REAL,
  pin_y REAL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  is_dirty INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_media_owner ON media_files(owner_type, owner_id) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_media_sync ON media_files(sync_status) WHERE is_deleted = 0;

CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'LOAN',
  borrower_name TEXT NOT NULL,
  borrower_phone TEXT,
  quantity_lent INTEGER NOT NULL DEFAULT 1,
  quantity_returned INTEGER NOT NULL DEFAULT 0,
  quantity_closed INTEGER NOT NULL DEFAULT 0,
  close_reason TEXT,
  expected_price REAL,
  lent_at TEXT NOT NULL,
  expected_return_date TEXT,
  alert_snoozed_until TEXT,
  returned_at TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  handover_media_id TEXT,
  return_media_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  is_dirty INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_loans_item ON loans(item_id) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_loans_active ON loans(status, expected_return_date) WHERE is_deleted = 0 AND status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS households (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  drive_folder_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  is_dirty INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS household_members (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL,
  user_id TEXT,
  email TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'MEMBER',
  invite_status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  is_dirty INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS item_history (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  from_location_id TEXT,
  to_location_id TEXT,
  old_status TEXT,
  new_status TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  is_dirty INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_history_item ON item_history(item_id, created_at);

CREATE TABLE IF NOT EXISTS app_kv (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT
);

CREATE TABLE IF NOT EXISTS custom_terms (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  icon TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_custom_terms_kind ON custom_terms(kind) WHERE is_deleted = 0;
`;

export const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  item_id UNINDEXED,
  name,
  position_note,
  tags,
  purchase_place,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS trg_items_fts_insert
AFTER INSERT ON items BEGIN
  INSERT INTO items_fts (item_id, name, position_note, tags, purchase_place)
  VALUES (new.id, new.name, new.position_note, new.tags, new.purchase_place);
END;
CREATE TRIGGER IF NOT EXISTS trg_items_fts_update
AFTER UPDATE ON items BEGIN
  DELETE FROM items_fts WHERE item_id = old.id;
  INSERT INTO items_fts (item_id, name, position_note, tags, purchase_place)
  VALUES (new.id, new.name, new.position_note, new.tags, new.purchase_place);
END;
CREATE TRIGGER IF NOT EXISTS trg_items_fts_delete
AFTER DELETE ON items BEGIN
  DELETE FROM items_fts WHERE item_id = old.id;
END;
`;
