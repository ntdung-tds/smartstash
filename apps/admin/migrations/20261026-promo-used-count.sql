-- Migration v78 (26/10/2026): thêm bộ đếm used_count cho promo_codes để
-- đổi mã chiếm lượt NGUYÊN TỬ (UPDATE ... WHERE used_count < max_uses),
-- chặn hai tài khoản đua nhau đổi cùng một mã 1 lượt.
--
-- ÁP DỤNG (chỉ chạy MỘT lần trên DB live, KHÔNG chạy lại):
--   CLOUDFLARE_API_TOKEN=... ./node_modules/.bin/wrangler d1 execute DB \
--     --remote --file=migrations/20261026-promo-used-count.sql
-- (Chạy lại sẽ lỗi "duplicate column name" ở câu ALTER đầu tiên — đó là
-- dấu hiệu migration đã áp xong, không phải lỗi dữ liệu. Kiểm tra bằng:
--   wrangler d1 execute DB --remote \
--     --command="SELECT code, max_uses, used_count FROM promo_codes;")
--
-- DB tạo mới từ schema.sql đã có sẵn cột này nên không cần migration.
-- Nếu cột đã tồn tại mà vẫn muốn backfill lại, chỉ chạy riêng câu UPDATE.

ALTER TABLE promo_codes ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0);

UPDATE promo_codes
   SET used_count = (
     SELECT COUNT(*) FROM redemptions r
      WHERE r.code = promo_codes.code AND r.result = 'granted'
   );
