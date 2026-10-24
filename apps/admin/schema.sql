-- SmartStash Admin — schema D1 (SQLite).
-- Áp dụng bằng: wrangler d1 execute DB --file=schema.sql
-- Chạy lại file này an toàn: mọi câu đều có IF NOT EXISTS / OR IGNORE.
-- KHÔNG có dữ liệu mẫu, KHÔNG có mã khuyến mãi mẫu, KHÔNG có bí mật.

-- 1. Mã khuyến mãi tự quản.
--    code luôn lưu dạng VIẾT HOA (app và API chuẩn hoá trước khi ghi).
--    days = số ngày quyền lợi tặng có hiệu lực kể từ lúc cấp.
--    max_uses = tổng số lượt đổi tối đa của mã (mặc định 1).
--    enabled = 0 nghĩa là mã đã bị tắt (mọi lượt đổi sau đó đều bị từ chối).
CREATE TABLE IF NOT EXISTS promo_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  entitlement TEXT NOT NULL DEFAULT 'pro',
  days        INTEGER NOT NULL CHECK (days > 0),
  starts_at   TEXT,
  expires_at  TEXT,
  max_uses    INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 0),
  campaign    TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. Nhật ký đổi mã — APPEND-ONLY (không UPDATE, không DELETE qua API).
--    result: 'granted' | 'rejected' | 'error'
--    reason: 'paid_active' | 'not_found' | 'disabled' | 'not_started' |
--            'expired' | 'uses_exhausted' | 'campaign_used' | 'revenuecat_error'
--    QUAN TRỌNG: số lượt đã dùng của một mã chỉ tính từ các dòng result='granted'.
--    Vì vậy một lần đổi bị từ chối (kể cả vì tài khoản đang có gói trả tiền)
--    KHÔNG BAO GIỜ làm mã bị tiêu lượt.
--    idempotency_key: chống xử lý trùng một yêu cầu đổi mã (UNIQUE).
CREATE TABLE IF NOT EXISTS redemptions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  result           TEXT NOT NULL CHECK (result IN ('granted', 'rejected', 'error')),
  reason           TEXT,
  idempotency_key  TEXT UNIQUE,
  redeemed_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_redemptions_code ON redemptions (code);
CREATE INDEX IF NOT EXISTS idx_redemptions_account ON redemptions (account_id);

-- 3. Nhật ký quản trị — mọi thao tác ghi của quản trị viên và hệ thống đều ghi vào đây.
CREATE TABLE IF NOT EXISTS admin_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,  -- 'admin' | 'system' | 'webhook'
  action     TEXT NOT NULL,  -- vd: 'promo_create', 'promo_toggle', 'promo_grant', 'entitlement_grant', 'config_update'
  target     TEXT,
  detail     TEXT,
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit (at);

-- 4. Tài khoản app (định danh bằng RevenueCat App User ID — chính là ID tài khoản
--    mà app dùng khi gọi RevenueCat; KHÔNG dùng email làm khoá chính).
--    plan_status: 'free' | 'pro_paid' (đang trả tiền qua cửa hàng) |
--                 'pro_promo' (đang dùng quyền lợi tặng) | 'pro' (chung, khi chưa rõ nguồn)
--    paid_until / promo_until: thời điểm hết hạn từng nguồn quyền lợi (ISO 8601, UTC).
CREATE TABLE IF NOT EXISTS app_accounts (
  revenuecat_app_user_id TEXT PRIMARY KEY,
  email                  TEXT,
  plan_status            TEXT NOT NULL DEFAULT 'free'
    CHECK (plan_status IN ('free', 'pro_paid', 'pro_promo', 'pro')),
  paid_until             TEXT,
  promo_until            TEXT,
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 5. Siêu dữ liệu file sao lưu "mây của tôi" (ghi khi adapter lưu trữ đã kích hoạt).
--    Nội dung file KHÔNG nằm ở đây — chỉ có tên, kích thước và thời điểm.
--    Endpoint GET /api/backups/usage thống kê từ bảng này.
CREATE TABLE IF NOT EXISTS backup_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  file_name  TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, file_name)
);
CREATE INDEX IF NOT EXISTS idx_backup_files_account ON backup_files (account_id);

-- 6. Sự kiện webhook đã xử lý — chống xử lý trùng một event của RevenueCat.
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id    TEXT PRIMARY KEY,
  type        TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
