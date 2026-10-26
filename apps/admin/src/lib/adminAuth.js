// Xác thực tài khoản quản trị viên (thay mã ADMIN_TOKEN chung).
//
// Mô hình:
// - Mỗi người một tài khoản riêng trong bảng admin_users, mật khẩu chỉ lưu
//   dạng hash PBKDF2-SHA256 (WebCrypto, chạy được trên Workers).
// - Phiên đăng nhập là token ngẫu nhiên 32 byte, server chỉ lưu SHA-256 của
//   token (bảng admin_sessions) — thu hồi ngay được khi khoá/xoá tài khoản
//   hoặc đổi mật khẩu, không cần chờ token hết hạn.
// - ADMIN_TOKEN (Worker secret) chỉ còn đúng một vai trò: khoá bootstrap cho
//   lần tạo tài khoản quản trị đầu tiên (khi bảng admin_users còn trống).
//   Sau khi đã có tài khoản, ADMIN_TOKEN không mở được bất kỳ API nào nữa.
// - Phân quyền: admin (toàn quyền) > staff (xem + tạo/bật-tắt mã) > viewer
//   (chỉ xem). Mọi kiểm tra quyền đều ở phía server; PWA chỉ ẩn/hiện nút
//   cho gọn giao diện, không phải lớp bảo vệ.

import { nowIso } from './http.js';

const encoder = new TextEncoder();

// Thứ tự quyền: số càng lớn quyền càng cao.
export const ROLES = { viewer: 1, staff: 2, admin: 3 };
export const SESSION_TTL_DAYS = 30;
export const MIN_PASSWORD_LEN = 8;

function b64url(bytes) {
  let s = '';
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// So sánh chuỗi trong thời gian hằng số (tránh rò rỉ qua timing).
export function timingSafeEqual(a, b) {
  const ab = encoder.encode(String(a ?? ''));
  const bb = encoder.encode(String(b ?? ''));
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export function normalizeEmail(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

export function newId() {
  return crypto.randomUUID();
}

export function newSessionToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return hex(digest);
}

// Hash mật khẩu: định dạng `pbkdf2$<iterations>$<saltB64url>$<hashB64url>`.
// BÀI HỌC CỨNG (25/10/2026): WebCrypto trên Workers thật GIỚI HẠN PBKDF2 tối
// đa 100.000 vòng — đặt 120.000 thì local (miniflare) vẫn chạy nhưng production
// ném "Pbkdf2 failed: iteration counts above 100000 are not supported" và làm
// setup sập với lỗi 500. Số vòng đọc từ chuỗi hash khi xác minh nên đổi mặc
// định này không làm hỏng hash cũ.
export async function hashPassword(password, iterations = 100000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  );
  return `pbkdf2$${iterations}$${b64url(salt)}$${b64url(bits)}`;
}

export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iterations = parseInt(parts[1], 10);
    if (!Number.isInteger(iterations) || iterations <= 0) return false;
    const salt = unb64url(parts[2]);
    const expected = unb64url(parts[3]);
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        key,
        expected.length * 8
      )
    );
    if (bits.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}

// Lấy user từ header Authorization: Bearer <session token>.
// Trả null khi thiếu token, sai token, tài khoản bị khoá, hoặc phiên hết hạn.
export async function getSessionUser(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.role, u.active, s.expires_at
       FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  ).bind(tokenHash).first();
  if (!row) return null;
  if (row.active !== 1) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  return { id: row.id, email: row.email, role: row.role };
}

// true khi user có quyền tối thiểu `minRole`.
export function hasRole(user, minRole) {
  if (!user) return false;
  return (ROLES[user.role] || 0) >= (ROLES[minRole] || 0);
}

export async function createSession(env, userId) {
  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 3600 * 1000).toISOString();
  // 27/10/2026: dọn các phiên đã hết hạn mỗi lần đăng nhập — trước đây
  // hàng hết hạn không bao giờ bị xoá (chỉ xoá khi chính token đó được
  // trình lại hoặc khi đăng xuất/đổi mật khẩu).
  await env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').bind(new Date().toISOString()).run();
  await env.DB.prepare(
    'INSERT INTO admin_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(await sha256Hex(token), userId, expires).run();
  return { token, expires_at: expires };
}

export async function revokeSessions(env, userId, exceptTokenHash = null) {
  if (exceptTokenHash) {
    await env.DB.prepare(
      'DELETE FROM admin_sessions WHERE user_id = ? AND token_hash != ?'
    ).bind(userId, exceptTokenHash).run();
  } else {
    await env.DB.prepare('DELETE FROM admin_sessions WHERE user_id = ?').bind(userId).run();
  }
}

export async function audit(env, actor, action, target, detail) {
  await env.DB.prepare(
    'INSERT INTO admin_audit (actor, action, target, detail) VALUES (?, ?, ?, ?)'
  ).bind(actor, action, target, detail ? JSON.stringify(detail) : null).run();
}

// Chống dò mật khẩu: tối đa 10 lần đăng nhập sai / 15 phút / email.
// Nếu chưa có KV (chạy local chưa cấu hình binding) thì bỏ qua — chỉ dev.
export async function loginRateLimitOk(env, email, limit = 10, windowSec = 900) {
  if (!env.CONFIG) return true;
  const key = `ratelimit:login:${email}`;
  const raw = await env.CONFIG.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  if (count >= limit) return false;
  await env.CONFIG.put(key, String(count + 1), { expirationTtl: windowSec });
  return true;
}

export function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    active: row.active === 1,
    created_at: row.created_at,
    last_login_at: row.last_login_at || null,
  };
}

export { nowIso };
