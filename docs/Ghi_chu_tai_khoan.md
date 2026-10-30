# Ghi chú tên tài khoản — SmartStash

File này chỉ ghi TÊN tài khoản/dự án để khỏi nhầm, KHÔNG chứa token, key hay mật khẩu nào.
Token/key/mật khẩu nằm ở nơi riêng (xem cuối file).

## GitHub

- Người dùng: **ntdung-tds**
- Repo: **github.com/ntdung-tds/smartstash**
- Nhánh `master`: dòng v0.1 chính thức (tag `v0.1` = bản v111, app 0.1.8)
- Nhánh `feature/ai-add`: dòng AI (bản app 0.1.9, gọi Worker `/api/ai`)

## Cloudflare

- Tài khoản (subdomain workers.dev): **iaict-platform**
- Worker: **smartstash-admin** — https://smartstash-admin.iaict-platform.workers.dev
- Pages quản trị: **smartstash-admin** — https://smartstash-admin.pages.dev
- Pages trang công khai: **smartstash-site** — https://smartstash-site.pages.dev
- D1: **smartstash-admin**
- KV: **CONFIG**
- R2: **smartstash-backups**
- Domain gắn vào Pages: **smartstash.iaict-platform.com** (cần thêm CNAME `smartstash` → `smartstash-admin.pages.dev` để Cloudflare xác minh + cấp chứng chỉ)

## Nơi giữ bí mật (không ghi vào file này)

- Token API Cloudflare: chỉ nằm trên máy ảo (`~/.cf-api-token`), thu hồi từ dashboard Cloudflare.
- Key Gemini/Groq cho AI: nằm ở Worker secrets (`GEMINI_API_KEY`, `GROQ_API_KEY`), không nằm trong app hay repo.
- Keystore phát hành Android: người dùng giữ duy nhất, không có bản sao trong repo.
