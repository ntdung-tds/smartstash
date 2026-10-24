# Hệ thống quản trị SmartStash (Cloudflare)

Hệ thống quản trị riêng cho app SmartStash, chạy toàn bộ trên Cloudflare:
**PWA quản trị** (Pages) + **API** (Workers) + **D1** (dữ liệu mã/nhật ký) +
**KV** (cấu hình từ xa). Chi phí quy mô đầu: **0–5 USD/tháng**.

Phạm vi: quản lý **mã khuyến mãi tự quản**, **cấp/thu hồi quyền lợi thủ công**,
**cờ cấu hình từ xa** và **thống kê sao lưu "mây của tôi"**.
**Không có gói Family** — tính năng Family đã bị huỷ hoàn toàn, không xây,
không tạo sản phẩm Family trên RevenueCat.

> **Trạng thái triển khai: CHƯA TRIỂN KHAI LÊN MẠNG.**
> Code đã hoàn chỉnh và kiểm tra cú pháp, nhưng chưa có tài khoản Cloudflare,
> chưa có secret, chưa có D1/KV thật. Chủ app làm theo mục "Triển khai" bên dưới
> thì hệ thống chạy được ngay. Xem mục "TODO — cần thông tin từ chủ app".

## 1. Cấu trúc thư mục

```
smartstash-admin/
├── wrangler.toml          # Cấu hình Worker: bindings D1 (DB), KV (CONFIG)
├── package.json           # type: module; scripts dev/deploy/db:apply
├── schema.sql             # Schema D1 (chạy 1 lần, idempotent)
├── README.md              # Tài liệu này
├── src/
│   ├── index.js           # Điểm vào Worker: routing, phân quyền, CORS
│   ├── lib/
│   │   ├── http.js        # Trả JSON, đọc body, chuẩn hoá mã
│   │   ├── auth.js        # Kiểm tra ADMIN_TOKEN, giới hạn tốc độ đổi mã
│   │   ├── revenuecat.js  # Cấp/thu hồi quyền lợi tặng, xác minh webhook
│   │   └── storage.js     # Tầng lưu trữ trừu tượng + khung adapter Drive
│   └── routes/
│       ├── promo.js       # Mã khuyến mãi + LUỒNG ĐỔI MÃ cốt lõi
│       ├── entitlements.js# Cấp/thu hồi thủ công
│       ├── config.js      # Cờ cấu hình từ xa
│       ├── backups.js     # Thống kê + khung tải lên/tải xuống
│       └── webhooks.js    # Nhận webhook RevenueCat
└── public/                # PWA quản trị (deploy lên Cloudflare Pages)
    ├── index.html         # 5 màn: mã, nhật ký, cấp/thu hồi, cờ, sao lưu
    ├── styles.css
    ├── app.js             # Gọi API bằng fetch + ADMIN_TOKEN
    ├── manifest.json
    ├── sw.js              # Service worker tối giản (cache vỏ giao diện)
    ├── icon-192.png       # Icon PWA tạm (nền tím) — thay bằng logo thật khi phát hành
    └── icon-512.png
```

## 2. API — tổng quan

Trả JSON dạng `{ ok: true, ... }` hoặc `{ ok: false, error, message }`.
Mã lỗi dùng xuyên suốt: `unauthorized`, `not_found`, `invalid_fields`,
`missing_fields`, `paid_active`, `disabled`, `not_started`, `expired`,
`uses_exhausted`, `campaign_used`, `rate_limited`, `not_configured`,
`revenuecat_error`, `storage_not_configured`, `internal_error`.

### Công khai (không cần ADMIN_TOKEN)

| Route | Mô tả |
|---|---|
| `GET /api/health` | Kiểm tra sống (cho uptime check). |
| `GET /api/config` | App đọc cờ cấu hình (ngoại tuyến thì dùng mặc định trong code). |
| `POST /api/promo/redeem` | **Luồng đổi mã cốt lõi** (xem mục 3). Body: `{ code, account_id, idempotency_key? }`; header `X-Idempotency-Key` được ưu tiên. Giới hạn 10 lần / 60 giây / tài khoản. |
| `POST /api/webhooks/revenuecat` | Nhận webhook RevenueCat, xác minh bằng `REVENUECAT_WEBHOOK_SECRET`, chống xử lý trùng theo event id. |

### Quản trị (bắt buộc header `Authorization: Bearer <ADMIN_TOKEN>`)

| Route | Mô tả |
|---|---|
| `GET /api/promo` | Liệt kê mã kèm số lượt đã đổi (chỉ tính lượt `granted`). |
| `POST /api/promo` | Tạo mã: `{ code, entitlement?, days, max_uses?, campaign?, starts_at?, expires_at? }`. |
| `PATCH /api/promo/:code` | Bật/tắt mã: `{ enabled: true/false }`. |
| `GET /api/promo/redemptions?limit=100` | Nhật ký đổi mã gần nhất. |
| `GET /api/promo/:code/redemptions` | Nhật ký đổi của một mã. |
| `POST /api/entitlements/grant` | Cấp thủ công: `{ account_id, entitlement?, days? }`. |
| `POST /api/entitlements/revoke` | Thu hồi tặng: `{ account_id, entitlement? }`. |
| `PUT /api/config` | Ghi cờ: `self_promo_enabled`, `min_version`, `maintenance_notice`, `plan_limits_override`. |
| `GET /api/backups/usage` | Thống kê từ bảng `backup_files` trong D1 + trạng thái adapter. |
| `POST /api/backups/upload`, `GET /api/backups/download` | **Khung chưa kích hoạt**: luôn trả `503 storage_not_configured` cho tới khi adapter Drive được kích hoạt (mục 6). |

## 3. Luồng đổi mã — chính sách đã chốt (đọc kỹ trước khi sửa)

Thứ tự kiểm tra trong `POST /api/promo/redeem` (file `src/routes/promo.js`):

1. **Tài khoản đang có gói trả tiền còn hiệu lực** (`app_accounts.plan_status =
   'pro_paid'` và `paid_until` còn trong tương lai) → **từ chối với mã lỗi
   `paid_active`, mã KHÔNG bị tiêu**. Lý do: chu kỳ trừ tiền tự động của cửa
   hàng chạy độc lập với quyền lợi tặng; cho đổi sẽ sinh khiếu nại "đã nhập mã
   sao vẫn bị trừ tiền".
2. Mã tồn tại + đang bật + trong khoảng thời gian áp dụng + còn lượt.
3. Tài khoản chưa từng dùng mã thuộc cùng đợt (`campaign`; mã không có campaign
   thì mỗi mã là một đợt riêng).
4. Gọi RevenueCat cấp quyền lợi tặng (secret từ Worker secrets). **Nếu chưa cấu
   hình secret, API trả `503 not_configured` rõ ràng — không ghi lượt đổi thành
   công, không giả vờ thành công.**
5. Ghi `redemptions` (granted) + `admin_audit` + cập nhật `app_accounts`
   thành `pro_promo` trong cùng một lần xử lý (D1 batch).

**Số lượt đã dùng của một mã chỉ tính từ các dòng `result='granted'`.**
Vì vậy mọi lần đổi bị từ chối (kể cả `paid_active`) đều không làm mã mất lượt.
Chống xử lý trùng: cùng `idempotency_key` + cùng tài khoản thì trả lại kết
quả cũ, không cấp hai lần.

## 4. Triển khai

### 4.1. Tài khoản và công cụ

1. Tạo tài khoản Cloudflare miễn phí tại dash.cloudflare.com.
2. Cài đặt công cụ dòng lệnh (trên máy của bạn, cần Node.js 18+):
   ```
   npm install -g wrangler
   wrangler login
   ```

### 4.2. Tạo D1 và KV, áp schema

```
cd smartstash-admin
wrangler d1 create smartstash-admin
wrangler kv namespace create CONFIG
```

Lấy `database_id` và KV `id` trả về, thay vào hai chỗ `REPLACE_WITH_D1_ID`
và `REPLACE_WITH_KV_ID` trong `wrangler.toml`, rồi áp schema:

```
npm run db:apply
# tương đương: wrangler d1 execute DB --file=schema.sql
```

### 4.3. Cấu hình secrets (không bao giờ ghi vào code hay repo)

```
wrangler secret put ADMIN_TOKEN
# -> tự đặt một chuỗi dài ngẫu nhiên, chỉ chủ app biết. PWA nhập token này 1 lần.

wrangler secret put REVENUECAT_SECRET_KEY
# -> khoá bí mật (sk_...) lấy trong RevenueCat dashboard (Project Settings > API Keys).
#    Khoá này CHỈ ở phía Worker. App và PWA không bao giờ thấy nó.

wrangler secret put REVENUECAT_WEBHOOK_SECRET
# -> chuỗi bí mật tự đặt, rồi điền cùng chuỗi đó vào cấu hình webhook của RevenueCat.
```

### 4.4. Deploy Worker

```
npm run deploy
# hoặc: wrangler deploy
```

Worker sẽ có địa chỉ dạng `https://smartstash-admin.<subdomain>.workers.dev`.
Kiểm tra sống: mở `https://<địa-chỉ-worker>/api/health` — phải trả
`{"ok":true,"service":"smartstash-admin"}`.

### 4.5. Deploy PWA quản trị lên Pages + bật Cloudflare Access

```
npx wrangler pages deploy public --project-name smartstash-admin
```

Sau đó, trong Cloudflare dashboard → **Zero Trust → Access → Applications →
Add an application** (kiểu Self-hosted), trỏ tới domain Pages vừa tạo, chính
sách **chỉ cho phép email của chủ app** (điền email thật của bạn, không dùng
email mẫu). Đây là lớp bảo vệ chính thức của trang quản trị; việc PWA lưu
`ADMIN_TOKEN` ở localStorage chỉ là biện pháp tạm cho trình duyệt quản trị.

Trong PWA, nhập **địa chỉ Worker** và **ADMIN_TOKEN** ở mục "Kết nối" rồi bấm
"Lưu kết nối". Cài PWA lên màn hình chính điện thoại: mở trang Pages trên
trình duyệt di động → "Thêm vào màn hình chính".

### 4.6. Chạy local để thử (không cần tài khoản Cloudflare)

```
npm install
npm run dev
# Worker chạy ở http://localhost:8787 (D1/KV local do wrangler tự tạo).
# PWA: mở public/index.html bằng bất kỳ máy chủ tĩnh nào, vd: npx serve public
# rồi nhập apiBase = http://localhost:8787 và ADMIN_TOKEN (đặt qua .dev.vars).
```

Với local dev, tạo file `.dev.vars` (đã có trong `.gitignore`, không commit)
chứa `ADMIN_TOKEN=<token-thử>`; endpoint đổi mã chưa có RevenueCat secret sẽ
trả `503 not_configured` đúng như thiết kế — đó là hành vi mong muốn, không
phải lỗi.

## 5. Kết nối với app SmartStash (khi tới giai đoạn này)

- **Đọc cấu hình:** app gọi `GET <worker>/api/config` khi có mạng; ngoại tuyến
  dùng mặc định trong code (đã có seam `remoteConfigService` từ bản v62, chỉ
  cần thay phần đọc bên trong sang gọi endpoint này).
- **Đổi mã:** app gọi `POST <worker>/api/promo/redeem` thay cho bảng mô phỏng
  trong code, kèm `idempotency_key` duy nhất cho mỗi lần bấm "Áp dụng".
- **Cờ `self_promo_enabled = false`** = chốt chặn production: app ẩn ô nhập mã
  tự quản và `promoService` từ chối đổi mã (đã nối sẵn ở v62).
- **Webhook RevenueCat:** trong RevenueCat dashboard, tạo webhook trỏ tới
  `POST <worker>/api/webhooks/revenuecat` và điền cùng `REVENUECAT_WEBHOOK_SECRET`
  đã đặt ở mục 4.3. Các sự kiện xử lý: `INITIAL_PURCHASE`, `RENEWAL`,
  `UNCANCELLATION` → `pro_paid`; `EXPIRATION`, `CANCELLATION` → `free`
  (chỉ khi đang là `pro_paid`); `NON_RENEWING_PURCHASE` → `pro_promo`.

## 6. Kích hoạt adapter Drive cho "mây của tôi" (giai đoạn sau)

Adapter hiện tại là khung chưa kích hoạt: mọi thao tác lưu trữ đều trả
`storage_not_configured`. Để kích hoạt, chủ app cần:

1. Chuẩn bị thông tin xác thực Drive của chủ sản phẩm (service account có quyền
   ghi vào thư mục Drive dùng làm kho, hoặc phương án tương đương).
2. Đặt secrets: `DRIVE_CLIENT_EMAIL`, `DRIVE_PRIVATE_KEY`, `DRIVE_FOLDER_ID`.
3. Hoàn thiện phần TODO trong `src/lib/storage.js` (lấy access token bằng JWT
   → OAuth2, rồi gọi Drive API v3: `files.create` / `files.get` / `files.list` /
   `files.delete`, xoay vòng giữ 5 bản mới nhất cho mỗi người dùng) và ghi siêu
   dữ liệu file vào bảng `backup_files` để endpoint usage thống kê được.
4. **Trước khi mở cho người dùng thật:** cập nhật khai báo Data safety sang
   "có thu thập" dữ liệu đồ đạc (theo tài liệu vận hành Mảng 9).
5. **Lưu ý kiểm chứng:** nếu gói Drive 30TB là Google One cá nhân thay vì
   Google Workspace, làm rõ điều khoản trước khi đưa dữ liệu khách lên.

Khi chuyển sang R2 sau này: thêm adapter mới tuân theo interface trong
`src/lib/storage.js`, mở binding `BACKUPS` đã chừa sẵn trong `wrangler.toml`,
đổi một dòng trong `getStorageAdapter()` — app và API không đổi.

## 7. Bảo mật — những điều không được làm

- Không bao giờ đưa `REVENUECAT_SECRET_KEY`, `ADMIN_TOKEN` hay thông tin xác
  thực Drive vào code, repo, PWA hay ảnh chụp màn hình.
- Không dùng chung `ADMIN_TOKEN` cho nhiều người; đổi token khi nghi lộ
  (`wrangler secret put ADMIN_TOKEN` rồi cập nhật trong PWA).
- Không sửa/xoá dòng trong `redemptions` và `admin_audit` — đó là nhật ký kiểm
  toán, là căn cứ duy nhất khi có khiếu nại "đã nhập mã mà không được Pro".
- Mọi endpoint quản trị đều kiểm tra token ở tầng router (`src/index.js`);
  không thêm route ghi mới mà quên kiểm tra.
- Sao lưu D1 định kỳ ra nơi độc lập (mục tiêu RPO 24 giờ / RTO 4 giờ);
  test khôi phục hằng quý; xoay khoá 6 tháng/lần.

## 8. Kiểm tra trước khi cấp quyền lợi thật lần đầu

1. Chạy `npm run dev`, gọi `GET /api/health` → `ok: true`.
2. Tạo mã thử trên PWA, đổi mã với tài khoản thử → khi chưa có RevenueCat
   secret phải nhận `503 not_configured` (không được nhận thành công giả).
3. Sau khi đặt `REVENUECAT_SECRET_KEY`, đổi mã thử bằng tài khoản sandbox của
   RevenueCat → kiểm tra quyền lợi xuất hiện trong RevenueCat dashboard và
   dòng `granted` xuất hiện trong nhật ký.
4. Kiểm tra lại hai endpoint RevenueCat dùng trong `src/lib/revenuecat.js`
   (cấp/thu hồi quyền lợi tặng) theo tài liệu RevenueCat hiện hành, vì hãng có
   thể đổi API v1 sang v2.

## 9. TODO — cần thông tin từ chủ app (trạng thái: chưa có)

| # | Cần gì | Dùng cho | Trạng thái |
|---|---|---|---|
| 1 | Tài khoản Cloudflare (miễn phí) | Deploy Worker, D1, KV, Pages | Chưa có |
| 2 | `REVENUECAT_SECRET_KEY` | Cấp/thu hồi quyền lợi tặng | Chưa có |
| 3 | `REVENUECAT_WEBHOOK_SECRET` (tự đặt) | Xác minh webhook | Chưa có |
| 4 | Email chủ app cho Cloudflare Access | Khoá trang quản trị | Chưa có |
| 5 | Thông tin xác thực Drive (giai đoạn sau) | Kích hoạt adapter "mây của tôi" | Chưa có |
| 6 | Icon logo thật cho PWA | Thay 2 file PNG tạm | Chưa có |

## 10. Chi phí ước tính (quy mô đầu)

Pages + Workers + D1 + KV đều có gói miễn phí đủ rộng; Workers gói trả phí
khoảng 5 USD/tháng khi vượt giới hạn miễn phí. Tổng ước tính **0–5 USD/tháng**;
Drive 30TB đã có sẵn nên chưa phát sinh chi phí lưu trữ; R2 chỉ tính khi
chuyển sang sau này.
