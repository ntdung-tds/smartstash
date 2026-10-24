# Chỉ mục tài liệu SmartStash

Thư mục này cố tình KHÔNG chứa bản sao của các tài liệu lớn (PRD/SRS,
Bản đồ vận hành, Thiết kế Cloudflare, hướng dẫn). Các tài liệu đó có bản chính
thức duy nhất nằm ở kho tài liệu của dự án (thư mục tài liệu của goal
`smartstash-app-build`); sao chép sang đây sẽ tạo hai bản lệch nhau theo thời gian.

## Tài liệu chính thức (bản chính, cập nhật tại đó)

| Tài liệu | Nội dung |
| :--- | :--- |
| PRD+SRS v2.2 (docx) | Tài liệu hợp nhất yêu cầu sản phẩm — single source of truth về tính năng |
| Bản đồ quản lý & vận hành v1.3 Final (docx) | Runbook vận hành: 11 mảng quản lý, checklist D-30 → D-0, quyết định đã chốt |
| Thiết kế kiến trúc Cloudflare v1.0 (docx) | PWA quản trị + Workers + D1 + KV + tầng lưu trữ Drive/R2 |
| Hướng dẫn nối RevenueCat | Sản phẩm, entitlement, offering; điều kiện cần Play Console |
| Hướng dẫn tạo keystore phát hành | Cách A/B, Play App Signing, quy trình chuyển từ bản test |
| Hướng dẫn tạo Google Client ID | OAuth cho đăng nhập Drive (project 276230190448) |

## Tài liệu trong repo này

| Tài liệu | Nội dung |
| :--- | :--- |
| `apps/app/BUILD_NOTES.md` | Môi trường build Android, script build, quy trình ký APK |
| `apps/app/README.md` | Giới thiệu app |
| `apps/admin/README.md` | Triển khai hệ thống quản trị lên Cloudflare |
