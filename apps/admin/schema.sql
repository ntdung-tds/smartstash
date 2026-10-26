-- SmartStash Admin — schema D1 (SQLite).
-- Áp dụng bằng: wrangler d1 execute DB --file=schema.sql
-- Chạy lại file này an toàn: mọi câu đều có IF NOT EXISTS / OR IGNORE.
-- KHÔNG có dữ liệu mẫu, KHÔNG có mã khuyến mãi mẫu, KHÔNG có bí mật.

-- 1. Mã khuyến mãi tự quản.
--    code luôn lưu dạng VIẾT HOA (app và API chuẩn hoá trước khi ghi).
--    days = số ngày quyền lợi tặng có hiệu lực kể từ lúc cấp.
--    max_uses = tổng số lượt đổi tối đa của mã (mặc định 1).
--    enabled = 0 nghĩa là mã đã bị tắt (mọi lượt đổi sau đó đều bị từ chối).
--    used_count = bộ đếm phục vụ chiếm lượt NGUYÊN TỬ khi đổi mã
--    (UPDATE ... WHERE used_count < max_uses); nguồn sự thật về lượt đã
--    cấp vẫn là redemptions result='granted' (xem mục 2). DB đã tồn tại
--    thì áp migration migrations/20261026-promo-used-count.sql.
CREATE TABLE IF NOT EXISTS promo_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  entitlement TEXT NOT NULL DEFAULT 'pro',
  days        INTEGER NOT NULL CHECK (days > 0),
  starts_at   TEXT,
  expires_at  TEXT,
  max_uses    INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 0),
  used_count  INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
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
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
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

-- 7. Tài khoản "mây của tôi" — xác thực TOFU (trust on first use).
--    account_id: UUID ngẫu nhiên do app tự tạo, lưu ở app_kv trên máy user.
--    token_hash: SHA-256 của token (32 byte hex) do app tự tạo; server KHÔNG
--    bao giờ thấy token gốc sau lần bind đầu (chỉ so hash).
--    tier_mb: gói lưu trữ hiện tại (100/200/500/1000). TODO(RevenueCat): khi
--    nối paywall thật, tier phải tra từ entitlement phía máy chủ thay vì tin
--    client khai báo.
CREATE TABLE IF NOT EXISTS backup_accounts (
  account_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  tier_mb    INTEGER NOT NULL DEFAULT 100 CHECK (tier_mb IN (100, 200, 500, 1000)),
  app_account_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_backup_accounts_app ON backup_accounts(app_account_id);

-- 8. Tài khoản quản trị viên (đăng nhập trang quản trị — thay mã ADMIN_TOKEN chung).
--    Mỗi người một tài khoản riêng; mật khẩu KHÔNG lưu dạng gốc, chỉ lưu hash
--    PBKDF2-SHA256 (xem src/lib/adminAuth.js). role: 'admin' | 'staff' | 'viewer'.
--    admin: toàn quyền (kể cả quản lý người dùng, cấu hình, cấp/thu hồi).
--    staff: xem + tạo/bật-tắt mã khuyến mãi. viewer: chỉ xem.
--    active = 0 nghĩa là tài khoản đã bị khoá (không đăng nhập được nữa).
CREATE TABLE IF NOT EXISTS admin_users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'viewer'
    CHECK (role IN ('admin', 'staff', 'viewer')),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users (email);

-- 9. Phiên đăng nhập quản trị — server-side, thu hồi được ngay khi khoá/xoá
--    tài khoản hoặc đổi mật khẩu. Chỉ lưu SHA-256 của token, không lưu token gốc.
--    expires_at: ISO 8601 UTC; phiên hết hạn sau 30 ngày, đăng nhập lại.
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES admin_users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions (user_id);

-- 10. Sự kiện doanh thu từ webhook RevenueCat (Mảng 10 — đối soát tài chính).
--    Mỗi event webhook (đã chống trùng theo event_id) ghi thêm một dòng ở đây
--    với các trường có sẵn trong payload; trường nào webhook không gửi thì NULL.
--    price là GIÁ GỘP theo webhook, theo từng currency — KHÔNG cộng dồn các
--    currency khác nhau; phí Play 15% trừ riêng khi đối soát (xem README).
--    Khi chưa nối RevenueCat (Play đang tạm gác) bảng này trống — tab Doanh thu
--    trên PWA hiện trạng thái chờ, không bịa số.
CREATE TABLE IF NOT EXISTS revenue_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL,
  app_user_id TEXT,
  product_id  TEXT,
  price       REAL,
  currency    TEXT,
  store       TEXT,
  country     TEXT,
  period      TEXT,
  event_at    TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_revenue_events_at ON revenue_events (event_at);
CREATE INDEX IF NOT EXISTS idx_revenue_events_type ON revenue_events (type);

-- 11. app_accounts.created_at — ngày tài khoản xuất hiện lần đầu trên máy chủ
--    (để đếm "tài khoản mới theo ngày"). Chỉ ghi khi INSERT; các lần upsert
--    sau không đụng tới. Tài khoản đã tồn tại trước cột này có created_at NULL
--    và không được tính vào số liệu "mới" (ghi rõ trên PWA).
--    (Bảng cũ đã tạo trước đó: chạy thêm
--     ALTER TABLE app_accounts ADD COLUMN created_at TEXT DEFAULT (datetime('now'));)

-- 12. Tài khoản app bị khoá + lịch sử cấu hình (26/10/2026, xem migration
--     20261026-blocked-and-config-history.sql cho DB đã tạo từ trước).
CREATE TABLE IF NOT EXISTS blocked_accounts (
  account_id TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  blocked_by TEXT,
  blocked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS config_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  flags      TEXT NOT NULL,
  reason     TEXT,
  actor      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_config_history_created ON config_history(created_at);

-- 13. Nối tài khoản sao lưu với tài khoản app + nhật ký đăng nhập quản
--     trị (26/10/2026, xem migration 20261026-account-link-and-login-logs.sql).
CREATE TABLE IF NOT EXISTS admin_login_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT,
  email      TEXT NOT NULL,
  success    INTEGER NOT NULL DEFAULT 0 CHECK (success IN (0, 1)),
  ip         TEXT,
  user_agent TEXT,
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_logs_email ON admin_login_logs(email);
CREATE INDEX IF NOT EXISTS idx_login_logs_created ON admin_login_logs(created_at);
