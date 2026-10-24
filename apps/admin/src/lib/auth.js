// Xác thực quản trị viên và chống lạm dụng cho endpoint đổi mã công khai.
//
// Nguyên tắc:
// - Mọi endpoint GHI của quản trị đều yêu cầu header:
//     Authorization: Bearer <ADMIN_TOKEN>
//   ADMIN_TOKEN chỉ tồn tại dưới dạng Worker secret, không có trong code,
//   không có trong PWA, không có trong repo.
// - So sánh token bằng phép so sánh thời gian hằng số để tránh tấn công timing.
// - Endpoint đổi mã (gọi từ app, không cần ADMIN_TOKEN) được giới hạn tốc độ
//   bằng KV: tối đa 10 lần / 60 giây / tài khoản. Nếu chưa có KV (chạy local
//   chưa cấu hình binding) thì bỏ qua giới hạn — chỉ dùng cho môi trường dev.

const encoder = new TextEncoder();

// So sánh chuỗi trong thời gian hằng số (tránh rò rỉ qua timing).
export function timingSafeEqual(a, b) {
  const ab = encoder.encode(String(a ?? ''));
  const bb = encoder.encode(String(b ?? ''));
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// Trả true nếu request mang đúng ADMIN_TOKEN.
export function isAdmin(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (!env.ADMIN_TOKEN || !token) return false;
  return timingSafeEqual(token, env.ADMIN_TOKEN);
}

// Giới hạn tốc độ đổi mã: tối đa `limit` lần trong `windowSec` giây cho một tài khoản.
// Trả true khi còn trong giới hạn (và đã tăng bộ đếm), false khi vượt giới hạn.
export async function redeemRateLimitOk(env, accountId, limit = 10, windowSec = 60) {
  if (!env.CONFIG) return true; // Chưa có KV: bỏ qua (chỉ dùng khi dev local).
  const key = `ratelimit:redeem:${accountId}`;
  const raw = await env.CONFIG.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  if (count >= limit) return false;
  await env.CONFIG.put(key, String(count + 1), { expirationTtl: windowSec });
  return true;
}
