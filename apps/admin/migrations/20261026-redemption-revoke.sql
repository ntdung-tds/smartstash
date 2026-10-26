-- Migration 26/10/2026 (áp 1 lần trên DB live, KHÔNG chạy lại):
--   Thu hồi từng lượt đổi trong nhật ký đổi mã: dòng lượt đổi được đánh
--   dấu đã thu hồi thay vì bị xoá, để: (1) tài khoản được đổi lại mã
--   cùng đợt (cửa chặn campaign bỏ qua dòng đã thu hồi), (2) lượt dùng
--   của mã được trả lại 1, (3) vẫn đối soát được ai thu hồi vì lý do gì.
--
-- ÁP DỤNG (trước khi deploy Worker mới):
--   CLOUDFLARE_API_TOKEN=$(cat ~/.cf-api-token) ./node_modules/.bin/wrangler d1 execute smartstash-admin \
--     --remote --file=migrations/20261026-redemption-revoke.sql
--
-- DB tạo mới từ schema.sql đã có sẵn các cột này nên không cần migration.

ALTER TABLE redemptions ADD COLUMN revoked_at TEXT;
ALTER TABLE redemptions ADD COLUMN revoked_by TEXT;
ALTER TABLE redemptions ADD COLUMN revoked_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_redemptions_revoked ON redemptions(revoked_at);
