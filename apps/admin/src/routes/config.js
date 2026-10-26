import { json, err, readJson } from '../lib/http.js';

// Cờ cấu hình từ xa (remote config) — app đọc công khai, chỉ quản trị viên ghi.
//
// Cờ hiện có (giá trị mặc định dùng khi KV chưa có gì; app KHÔNG BAO GIỜ bị
// khoá chỉ vì không đọc được cấu hình — ngoại tuyến thì dùng mặc định):
//   self_promo_enabled:   true  — bật ô nhập mã tự quản trong app (tắt = chốt chặn production).
//   min_version:          null  — phiên bản app tối thiểu (vd "0.2.0"), null = không ép cập nhật.
//   maintenance_notice:    null  — thông báo bảo trì hiển thị trong app, null = không hiện.
//   plan_limits_override:  null  — object ghi đè giới hạn gói (vd {"max_items": 100});
//                                  null = dùng PLAN_LIMITS trong code app.
//   drive_keep_backups:    5     — Số bản sao lưu giữ lại trên Drive tự quản (BYOC).
//   cloud_keep_backups:    2     — Số bản sao lưu giữ lại trên "mây của tôi" (Worker xoay vòng).
//   cloud_backup_enabled:  false — Công tắc khoá/mở sao lưu lên "mây của tôi"
//                                  (v84, tạm khoá theo yêu cầu chủ app: false =
//                                  app ẩn/khoá mục mây; quản trị bật true là
//                                  mở lại ngay, không cần bản app mới).
//   drive_backup_enabled:  false — Công tắc khoá/mở sao lưu lên Google Drive
//                                  (v84: false = app khoá mục Drive; bật true
//                                  là mở lại luồng kết nối Drive trong app.
//                                  Lưu ý: mở Drive trước khi xác minh Google
//                                  xong thì người dùng vẫn gặp giới hạn
//                                  Testing/unsafe như cũ — chỉ bật khi sẵn
//                                  sàng cho người dùng đó dùng Drive).
//   backup_compress_enabled: true — nén ảnh trong bản sao lưu (tắt = giữ ảnh gốc).
//   backup_max_edge:       1024  — cạnh dài tối đa (px) khi nén ảnh cho bản sao lưu.
//   backup_quality:        0.7   — chất lượng JPEG khi nén ảnh cho bản sao lưu.
//   photo_max_edge:        1280  — cạnh dài tối đa (px) khi thêm ảnh vào app.
//   photo_quality:         0.75  — chất lượng ảnh khi thêm vào app.
//   storage_plans:          bảng gói lưu trữ "mây của tôi" — mỗi gói gồm
//                           size_mb (dung lượng) + price_vnd (giá/năm, VNĐ).
//                           Bảng chốt 25/10/2026 (có thể đổi sau từ PWA):
//                           100MB 299.000đ / 200MB 349.000đ / 500MB 449.000đ
//                           / 1GB 599.000đ — giá đã gồm phí Play 15% + thuế
//                           TNCN VN 10%. App cũ không đọc cờ này nên đổi
//                           bảng không làm hỏng bản app cũ (chỉ ẩn giá mới).

export const DEFAULT_FLAGS = {
  self_promo_enabled: true,
  min_version: null,
  maintenance_notice: null,
  plan_limits_override: null,
  drive_keep_backups: 5,
  cloud_keep_backups: 2,
  cloud_backup_enabled: false,
  drive_backup_enabled: false,
  backup_compress_enabled: true,
  backup_max_edge: 1024,
  backup_quality: 0.7,
  photo_max_edge: 1280,
  photo_quality: 0.75,
  storage_plans: [
    { size_mb: 100, price_vnd: 299000 },
    { size_mb: 200, price_vnd: 349000 },
    { size_mb: 500, price_vnd: 449000 },
    { size_mb: 1000, price_vnd: 599000 },
  ],
};

function isIntIn(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

function isQuality(v) {
  return typeof v === 'number' && v >= 0.1 && v <= 1;
}

const KV_KEY = 'flags';

// GET /api/config — công khai (app đọc không cần token).
export async function getFlags(env) {
  let stored = null;
  if (env.CONFIG) {
    try {
      stored = await env.CONFIG.get(KV_KEY, { type: 'json' });
    } catch {
      stored = null;
    }
  }
  return { ok: true, flags: { ...DEFAULT_FLAGS, ...(stored || {}) } };
}

// PUT /api/config — quản trị viên (yêu cầu ADMIN_TOKEN ở tầng router).
// Chỉ cập nhật các khoá đã biết; khoá lạ bị bỏ qua. plan_limits_override
// phải là object mà mọi giá trị đều là số hoặc null.
// Theo SRS: sửa cấu hình yêu cầu lý do ngắn bắt buộc, ghi vào kiểm toán.
export async function putFlags(request, env, actor = 'admin') {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_fields', 'Body phải là JSON object.', 400);
  const reason = String(body.reason ?? '').trim();
  if (!reason) {
    return err('invalid_fields', 'Sửa cấu hình cần có lý do ngắn.', 400);
  }

  const current = (await getFlags(env)).flags;
  const next = { ...current };

  if (body.self_promo_enabled !== undefined) {
    if (typeof body.self_promo_enabled !== 'boolean') {
      return err('invalid_fields', 'self_promo_enabled phải là true/false.', 400);
    }
    next.self_promo_enabled = body.self_promo_enabled;
  }
  if (body.min_version !== undefined) {
    if (body.min_version !== null && typeof body.min_version !== 'string') {
      return err('invalid_fields', 'min_version phải là chuỗi hoặc null.', 400);
    }
    next.min_version = body.min_version;
  }
  if (body.maintenance_notice !== undefined) {
    if (body.maintenance_notice !== null && typeof body.maintenance_notice !== 'string') {
      return err('invalid_fields', 'maintenance_notice phải là chuỗi hoặc null.', 400);
    }
    next.maintenance_notice = body.maintenance_notice;
  }
  // Cờ vận hành sao lưu & ảnh (thêm 25/10/2026) — sai kiểu/miền thì 400,
  // app cũ không đọc cờ mới nên đổi cờ không bao giờ làm hỏng bản app cũ.
  if (body.drive_keep_backups !== undefined) {
    if (!isIntIn(body.drive_keep_backups, 1, 20)) {
      return err('invalid_fields', 'drive_keep_backups phải là số nguyên 1–20.', 400);
    }
    next.drive_keep_backups = body.drive_keep_backups;
  }
  if (body.cloud_keep_backups !== undefined) {
    if (!isIntIn(body.cloud_keep_backups, 1, 10)) {
      return err('invalid_fields', 'cloud_keep_backups phải là số nguyên 1–10.', 400);
    }
    next.cloud_keep_backups = body.cloud_keep_backups;
  }
  // Công tắc khoá/mở sao lưu (v84) — phải là boolean, app cũ bỏ qua cờ lạ.
  if (body.cloud_backup_enabled !== undefined) {
    if (typeof body.cloud_backup_enabled !== 'boolean') {
      return err('invalid_fields', 'cloud_backup_enabled phải là true/false.', 400);
    }
    next.cloud_backup_enabled = body.cloud_backup_enabled;
  }
  if (body.drive_backup_enabled !== undefined) {
    if (typeof body.drive_backup_enabled !== 'boolean') {
      return err('invalid_fields', 'drive_backup_enabled phải là true/false.', 400);
    }
    next.drive_backup_enabled = body.drive_backup_enabled;
  }
  if (body.backup_compress_enabled !== undefined) {
    if (typeof body.backup_compress_enabled !== 'boolean') {
      return err('invalid_fields', 'backup_compress_enabled phải là true/false.', 400);
    }
    next.backup_compress_enabled = body.backup_compress_enabled;
  }
  if (body.backup_max_edge !== undefined) {
    if (!isIntIn(body.backup_max_edge, 256, 4096)) {
      return err('invalid_fields', 'backup_max_edge phải là số nguyên 256–4096.', 400);
    }
    next.backup_max_edge = body.backup_max_edge;
  }
  if (body.backup_quality !== undefined) {
    if (!isQuality(body.backup_quality)) {
      return err('invalid_fields', 'backup_quality phải là số 0.1–1.', 400);
    }
    next.backup_quality = body.backup_quality;
  }
  if (body.photo_max_edge !== undefined) {
    if (!isIntIn(body.photo_max_edge, 256, 4096)) {
      return err('invalid_fields', 'photo_max_edge phải là số nguyên 256–4096.', 400);
    }
    next.photo_max_edge = body.photo_max_edge;
  }
  if (body.photo_quality !== undefined) {
    if (!isQuality(body.photo_quality)) {
      return err('invalid_fields', 'photo_quality phải là số 0.1–1.', 400);
    }
    next.photo_quality = body.photo_quality;
  }
  // Bảng gói lưu trữ (chốt 25/10/2026, có thể đổi sau): mảng 1–8 gói, mỗi
  // gói { size_mb, price_vnd }; dung lượng không trùng, lưu theo thứ tự tăng.
  if (body.storage_plans !== undefined) {
    const plans = body.storage_plans;
    if (!Array.isArray(plans) || plans.length < 1 || plans.length > 8) {
      return err('invalid_fields', 'storage_plans phải là mảng 1–8 gói.', 400);
    }
    const seen = new Set();
    const normalized = [];
    for (const p of plans) {
      if (typeof p !== 'object' || p === null || Array.isArray(p) ||
          !isIntIn(p.size_mb, 1, 100000) ||
          !Number.isInteger(p.price_vnd) || p.price_vnd < 0) {
        return err('invalid_fields', 'Mỗi gói cần size_mb nguyên 1–100000 và price_vnd nguyên ≥ 0.', 400);
      }
      if (seen.has(p.size_mb)) {
        return err('invalid_fields', 'Dung lượng các gói không được trùng nhau.', 400);
      }
      seen.add(p.size_mb);
      normalized.push({ size_mb: p.size_mb, price_vnd: p.price_vnd });
    }
    normalized.sort((a, b) => a.size_mb - b.size_mb);
    next.storage_plans = normalized;
  }
  if (body.plan_limits_override !== undefined) {
    if (body.plan_limits_override !== null &&
        (typeof body.plan_limits_override !== 'object' ||
         Array.isArray(body.plan_limits_override))) {
      return err('invalid_fields', 'plan_limits_override phải là object hoặc null.', 400);
    }
    if (body.plan_limits_override) {
      // Các khoá số trong PLAN_LIMITS phải là số; các khoá allow* phải
      // là boolean (trước đây Worker chỉ nhận số nên cờ boolean như
      // allowQrPrintPdf không sửa được từ form — app thì vẫn đọc đúng
      // kiểu boolean khi spread override). Khoá lạ vẫn giữ nguyên như
      // cũ (app bỏ qua) để không làm hỏng bản ghi đè đã lưu từ trước.
      const numberKeys = ['maxActiveItems', 'maxLocations', 'maxItemPhotos', 'maxScenePhotos'];
      const boolKeys = ['allowScenePinning', 'allowAutoCloudSync', 'allowQrPrintPdf',
        'allowExpiryNotifications', 'allowLoanReminders', 'allowWarrantyNotifications',
        'allowBasicExport', 'allowFullReport', 'allowFamilySharing'];
      for (const [key, value] of Object.entries(body.plan_limits_override)) {
        if (value === null) continue;
        if (numberKeys.includes(key) && typeof value !== 'number') {
          return err('invalid_fields', `plan_limits_override.${key} phải là số hoặc null.`, 400);
        }
        if (boolKeys.includes(key) && typeof value !== 'boolean') {
          return err('invalid_fields', `plan_limits_override.${key} phải là true/false hoặc null.`, 400);
        }
      }
    }
    next.plan_limits_override = body.plan_limits_override;
  }

  if (!env.CONFIG) {
    return err('not_configured', 'Chưa cấu hình KV CONFIG nên không lưu được cờ.', 503);
  }
  await env.CONFIG.put(KV_KEY, JSON.stringify(next));
  await env.DB.prepare(
    'INSERT INTO admin_audit (actor, action, target, detail) VALUES (?, ?, ?, ?)'
  ).bind(actor, 'config_update', 'flags', JSON.stringify({ flags: next, reason })).run();
  // Lịch sử cấu hình: mỗi lần lưu là một bản snapshot để khôi phục lại
  // được (khác kiểm toán ở chỗ kiểm toán chỉ lưu cờ mới trong detail,
  // còn đây là bảng riêng, PWA liệt kê + khôi phục trực tiếp).
  // Lỗi ghi lịch sử không được làm hỏng lần lưu chính đã thành công.
  try {
    await env.DB.prepare(
      'INSERT INTO config_history (flags, reason, actor) VALUES (?, ?, ?)'
    ).bind(JSON.stringify(next), reason, actor).run();
  } catch (e) {
    console.error('config_history insert failed:', e && e.message ? e.message : e);
  }
  return json({ ok: true, flags: next });
}

// GET /api/admin/config/history — 50 bản cấu hình gần nhất.
export async function getHistory(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, flags, reason, actor, created_at FROM config_history ORDER BY id DESC LIMIT 50'
  ).all();
  return json({ ok: true, history: results || [] });
}

// POST /api/admin/config/restore — khôi phục một bản trong lịch sử.
// Body: { id, reason }. Khôi phục cũng là một lần lưu nên nó tự ghi
// thêm một bản mới vào lịch sử (khôi phục sai thì khôi phục lại được).
export async function restoreFlags(request, env, actor = 'admin') {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const reason = String(body.reason ?? '').trim();
  if (!reason) return err('invalid_fields', 'Khôi phục cấu hình cần có lý do.', 400);
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return err('invalid_fields', 'Cần có id bản lịch sử.', 400);
  }
  const row = await env.DB.prepare(
    'SELECT flags FROM config_history WHERE id = ?'
  ).bind(id).first();
  if (!row) return err('not_found', 'Không tìm thấy bản lịch sử.', 404);
  let flags;
  try {
    flags = JSON.parse(row.flags);
  } catch {
    return err('invalid_fields', 'Bản lịch sử bị hỏng, không khôi phục được.', 400);
  }
  if (!env.CONFIG) {
    return err('not_configured', 'Chưa cấu hình KV CONFIG nên không lưu được cờ.', 503);
  }
  await env.CONFIG.put(KV_KEY, JSON.stringify(flags));
  await env.DB.prepare(
    'INSERT INTO admin_audit (actor, action, target, detail) VALUES (?, ?, ?, ?)'
  ).bind(actor, 'config_restore', 'flags', JSON.stringify({ restored_id: id, reason })).run();
  try {
    await env.DB.prepare(
      'INSERT INTO config_history (flags, reason, actor) VALUES (?, ?, ?)'
    ).bind(JSON.stringify(flags), 'Khôi phục từ bản #' + id + ': ' + reason, actor).run();
  } catch (e) {
    console.error('config_history insert failed:', e && e.message ? e.message : e);
  }
  return json({ ok: true, flags, restored_id: id });
}
