// Tầng gọi RevenueCat — mọi bí mật lấy từ Worker secrets, không hard-code.
//
// Các endpoint dùng (theo tài liệu công khai của RevenueCat, API v1):
//   Cấp quyền lợi tặng:  POST   /v1/subscribers/{appUserId}/entitlements/{entitlement}/promotional
//                        body: { end_time_ms: <thời điểm hết hạn, ms epoch> }
//   Thu hồi quyền lợi tặng: DELETE /v1/subscribers/{appUserId}/entitlements/{entitlement}/promotional
// Lưu ý khi triển khai: kiểm tra lại hai endpoint trên trong môi trường sandbox
// của RevenueCat trước khi cấp quyền lợi thật lần đầu (xem README mục "Kiểm tra").

const RC_BASE = 'https://api.revenuecat.com/v1';

function rcHeaders(env) {
  return {
    Authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Cấp quyền lợi tặng cho một tài khoản trong `days` ngày.
// Trả { ok: true, expiresAt } khi thành công, { ok: false, status, detail } khi lỗi.
export async function grantPromotional(env, appUserId, entitlement, days) {
  if (!env.REVENUECAT_SECRET_KEY) {
    return { ok: false, notConfigured: true };
  }
  const endTimeMs = Date.now() + days * 24 * 60 * 60 * 1000;
  const url = `${RC_BASE}/subscribers/${encodeURIComponent(appUserId)}` +
    `/entitlements/${encodeURIComponent(entitlement)}/promotional`;
  const res = await fetch(url, {
    method: 'POST',
    headers: rcHeaders(env),
    body: JSON.stringify({ end_time_ms: endTimeMs }),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, detail: await safeText(res) };
  }
  return { ok: true, expiresAt: new Date(endTimeMs).toISOString() };
}

// Thu hồi quyền lợi tặng của một tài khoản.
export async function revokePromotional(env, appUserId, entitlement) {
  if (!env.REVENUECAT_SECRET_KEY) {
    return { ok: false, notConfigured: true };
  }
  const url = `${RC_BASE}/subscribers/${encodeURIComponent(appUserId)}` +
    `/entitlements/${encodeURIComponent(entitlement)}/promotional`;
  const res = await fetch(url, { method: 'DELETE', headers: rcHeaders(env) });
  if (!res.ok) {
    return { ok: false, status: res.status, detail: await safeText(res) };
  }
  return { ok: true };
}

// Xác minh webhook RevenueCat: RevenueCat gửi kèm header Authorization chứa
// chuỗi bí mật mà bạn cấu hình trong dashboard webhook của RevenueCat.
// (RevenueCat không ký HMAC cho webhook — cơ chế xác thực là header bí mật này.)
export function verifyWebhook(request, env) {
  if (!env.REVENUECAT_WEBHOOK_SECRET) return false;
  const header = request.headers.get('Authorization') || '';
  // Dashboard RevenueCat cho phép đặt header dạng "Bearer <secret>" hoặc secret trần.
  const presented = header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : header.trim();
  if (!presented) return false;
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(env.REVENUECAT_WEBHOOK_SECRET);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function safeText(res) {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return '';
  }
}
