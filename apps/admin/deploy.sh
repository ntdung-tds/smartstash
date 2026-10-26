#!/bin/bash
# Deploy Worker "mây của tôi" lên Cloudflare — chạy 1 lần với token API.
#
# Cách dùng (token dùng một lần, KHÔNG lưu vào file hay repo):
#   CLOUDFLARE_API_TOKEN=<token> bash deploy.sh
#
# Các bước (dừng ngay khi có bước lỗi — set -e):
#   1. Tạo D1 smartstash-admin + KV CONFIG + R2 smartstash-backups (nếu chưa có).
#   2. Điền ID thật vào wrangler.toml (chỉ thay các placeholder REPLACE_WITH_*).
#   3. Áp schema.sql lên D1 (tạo bảng promo/redemptions/backup_files/backup_accounts...).
#   4. wrangler deploy → in URL Worker (dùng nhập vào mục "Mây của tôi" trong app).
#
# KHÔNG deploy PWA quản trị ở đây (Pages + Cloudflare Access làm riêng sau,
# theo README mục 4.5) — app chỉ cần Worker là test được tải lên mây thật.
set -e
cd "$(dirname "$0")"

: "${CLOUDFLARE_API_TOKEN:?Cần đặt CLOUDFLARE_API_TOKEN trong môi trường}"
export CLOUDFLARE_API_TOKEN
W="./node_modules/.bin/wrangler"

echo "== 1. D1 =="
D1_ID=$($W d1 list 2>/dev/null | awk '/smartstash-admin/ {print $1; exit}')
if [ -z "$D1_ID" ]; then
  echo "Chưa có D1 smartstash-admin — đang tạo..."
  D1_ID=$($W d1 create smartstash-admin | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
fi
[ -n "$D1_ID" ] || { echo "Không lấy được D1 ID."; exit 1; }
echo "D1 ID: $D1_ID"

echo "== 2. KV =="
KV_ID=$($W kv namespace list 2>/dev/null | grep -B1 '"title": "smartstash-admin-CONFIG"' | grep -oE '"id": "[^"]+"' | head -1 | cut -d'"' -f4)
if [ -z "$KV_ID" ]; then
  echo "Chưa có KV CONFIG — đang tạo..."
  KV_ID=$($W kv namespace create CONFIG | grep -oE '"id": "[^"]+"' | head -1 | cut -d'"' -f4)
fi
[ -n "$KV_ID" ] || { echo "Không lấy được KV ID."; exit 1; }
echo "KV ID: $KV_ID"

echo "== 3. R2 =="
if $W r2 bucket list 2>/dev/null | grep -q "smartstash-backups"; then
  echo "Bucket smartstash-backups đã có."
else
  echo "Chưa có bucket — đang tạo..."
  $W r2 bucket create smartstash-backups
fi

echo "== 4. Điền ID vào wrangler.toml =="
sed -i 's/REPLACE_WITH_D1_ID/'"$D1_ID"'/' wrangler.toml
sed -i 's/REPLACE_WITH_KV_ID/'"$KV_ID"'/' wrangler.toml
grep -n "database_id\|^id =" wrangler.toml

echo "== 5. Áp schema lên D1 (BẮT BUỘC --remote: d1 execute mặc định chạy local!) =="
$W d1 execute DB --remote --file=schema.sql

echo "== 6. Deploy Worker =="
$W deploy

echo
echo "XONG. Lấy URL Worker ở trên (dạng https://smartstash-admin.<tên>.workers.dev)"
echo "rồi nhập vào mục Mây của tôi trong app để test tải lên mây thật."
