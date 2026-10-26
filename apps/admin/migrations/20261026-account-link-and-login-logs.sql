-- Migration 26/10/2026 (áp 1 lần trên DB live, KHÔNG chạy lại):
--   1. backup_accounts.app_account_id — nối tài khoản sao lưu (UUID ẩn
--      danh) với tài khoản app (anchor google:<sub>). App gửi liên kết
--      qua POST /api/backups/link khi đã đăng nhập Google; khách cũ chỉ
--      nối được sau khi cập nhật app và sao lưu lại (không nối ngược
--      được dữ liệu cũ vì trước đây Worker không biết UUID nào của ai).
--   2. admin_login_logs — nhật ký đăng nhập quản trị: IP, trình duyệt,
--      thành công/thất bại, để xem "ai đăng nhập bao nhiêu lần, từ đâu".
--
-- ÁP DỤNG:
--   CLOUDFLARE_API_TOKEN=$(cat ~/.cf-api-token) ./node_modules/.bin/wrangler d1 execute smartstash-admin \
--     --remote --file=migrations/20261026-account-link-and-login-logs.sql
--
-- DB tạo mới từ schema.sql đã có sẵn cột/bảng này nên không cần migration.

ALTER TABLE backup_accounts ADD COLUMN app_account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_backup_accounts_app ON backup_accounts(app_account_id);

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
