# SmartStash — Kho Đồ Số

Monorepo cho SmartStash: app quản lý & định vị đồ đạc cá nhân (offline-first)
và hệ thống quản trị đi kèm. Đội một người, Android trước, iOS sau.

## Cấu trúc

```
apps/app/     App React Native + Expo (TypeScript, SQLite/FTS5, Google Drive BYOC)
apps/admin/   Hệ thống quản trị: PWA + Cloudflare Workers + D1 + KV
docs/         Chỉ mục tài liệu (bản chính thức nằm ở kho tài liệu dự án — xem docs/README.md)
```

## App (`apps/app/`)

Xem `apps/app/README.md` và `apps/app/BUILD_NOTES.md` (môi trường build Android
offline đặc thù: JDK 17, Gradle 9.4.1, kho Maven local, build-tools 36.0.0).

Build release (sau khi sửa code):

```bash
BUILD_TASK=assembleRelease bash ~/build_loop.sh   # đã trỏ vào apps/app/android
```

Lưu ý: thư mục `apps/app/android/` là thư mục native do Expo prebuild tạo ra
và được gitignore theo chuẩn Expo — từ bản clone mới cần chạy prebuild trước,
rồi áp lại các sửa tay cho AndroidManifest theo `BUILD_NOTES.md`.

## Quản trị (`apps/admin/`)

Xem `apps/admin/README.md`. Triển khai lên Cloudflare (Pages + Workers + D1 +
KV) theo hướng dẫn trong đó. Trang quản trị khoá bằng Cloudflare Access.

## Quy tắc an toàn

- **Không bao giờ commit** keystore, file `.key`, `.p12`, `.p8`, `.pem`,
  `.dev.vars`, token hay mật khẩu. Khoá bí mật chỉ nằm ở Worker secrets và
  trình quản lý mật khẩu của chủ sản phẩm.
- Keystore phát hành do chủ sản phẩm giữ bản duy nhất (không nằm trong repo này).
- Gói Family đã bị huỷ — không tạo sản phẩm Family trên RevenueCat.
