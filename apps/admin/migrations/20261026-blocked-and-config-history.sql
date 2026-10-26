-- Migration 26/10/2026 (áp 1 lần trên DB live, KHÔNG chạy lại):
--   1. blocked_accounts — tài khoản app bị khoá (cổng chặn riêng, không
--      đổi plan_status nên mở khoá là khôi phục nguyên gói).
--   2. config_history — snapshot cấu hình mỗi lần lưu, để khôi phục.
--
-- ÁP DỤNG:
--   CLOUDFLARE_API_TOKEN=$(cat ~/.cf-api-token) ./node_modules/.bin/wrangler d1 execute smartstash-admin \
--     --remote --file=migrations/20261026-blocked-and-config-history.sql
--
-- DB tạo mới từ schema.sql đã có sẵn 2 bảng này nên không cần migration.

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
