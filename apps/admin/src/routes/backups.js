// Thống kê và khung tải lên/tải xuống cho tính năng "mây của tôi".
//
// Trạng thái hiện tại: adapter lưu trữ CHƯA kích hoạt (xem src/lib/storage.js).
// Vì vậy:
// - GET /api/backups/usage trả thống kê thật từ D1 (bảng backup_files) + trạng
//   thái configured của adapter — số liệu bằng 0 cho tới khi adapter chạy.
// - POST /api/backups/upload và GET /api/backups/download là KHUNG: chúng trả
//   503 storage_not_configured cho tới khi adapter Drive được kích hoạt.
//   KHÔNG giả dữ liệu, KHÔNG trả file giả.
// - Khi adapter kích hoạt, hai route này phải được bổ sung xác thực phía app
//   (ví dụ token riêng của từng tài khoản) trước khi mở cho người dùng thật.

import { json, err } from '../lib/http.js';
import { getStorageAdapter } from '../lib/storage.js';

// GET /api/backups/usage — quản trị viên.
export async function usage(env) {
  const adapter = getStorageAdapter(env);
  const stats = await env.DB.prepare(
    'SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM backup_files'
  ).first();
  const adapterUsage = await adapter.usage();
  return json({
    ok: true,
    storage: adapterUsage.configured ? 'drive' : 'not_configured',
    files: stats?.files ?? 0,
    bytes: stats?.bytes ?? 0,
  });
}

// POST /api/backups/upload — khung, chưa kích hoạt (xem storage.js).
export async function upload(env) {
  const adapter = getStorageAdapter(env);
  const result = await adapter.put();
  if (!result.ok) return err(result.error, result.message, 503);
  return json({ ok: true });
}

// GET /api/backups/download?name=... — khung, chưa kích hoạt (xem storage.js).
export async function download(env) {
  const adapter = getStorageAdapter(env);
  const result = await adapter.get();
  if (!result.ok) return err(result.error, result.message, 503);
  return json({ ok: true });
}
