// Tiện ích HTTP dùng chung: trả JSON + đọc JSON body + định dạng lỗi thống nhất.
// Mọi API đều trả JSON dạng { ok: true, ... } hoặc { ok: false, error, message }.

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export function err(error, message, status = 400) {
  return json({ ok: false, error, message }, status);
}

export async function readJson(request) {
  if (!request.body) return {};
  try {
    const text = await request.text();
    if (!text.trim()) return {};
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { __invalid: true };
    }
    return parsed;
  } catch {
    return { __invalid: true };
  }
}

// Chuẩn hoá mã khuyến mãi: bỏ khoảng trắng hai đầu, viết hoa.
// Mọi nơi (tạo mã, đổi mã, tra cứu) đều phải qua hàm này.
export function normalizeCode(raw) {
  return String(raw ?? '').trim().toUpperCase();
}

// Thời điểm hiện tại dạng ISO 8601 UTC (khớp định dạng lưu trong D1).
export function nowIso() {
  return new Date().toISOString();
}
