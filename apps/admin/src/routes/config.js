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

export const DEFAULT_FLAGS = {
  self_promo_enabled: true,
  min_version: null,
  maintenance_notice: null,
  plan_limits_override: null,
};

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
export async function putFlags(request, env) {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_fields', 'Body phải là JSON object.', 400);

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
  if (body.plan_limits_override !== undefined) {
    if (body.plan_limits_override !== null &&
        (typeof body.plan_limits_override !== 'object' ||
         Array.isArray(body.plan_limits_override))) {
      return err('invalid_fields', 'plan_limits_override phải là object hoặc null.', 400);
    }
    if (body.plan_limits_override) {
      for (const value of Object.values(body.plan_limits_override)) {
        if (value !== null && typeof value !== 'number') {
          return err('invalid_fields', 'Mọi giá trị trong plan_limits_override phải là số hoặc null.', 400);
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
  ).bind('admin', 'config_update', 'flags', JSON.stringify(next)).run();
  return json({ ok: true, flags: next });
}
