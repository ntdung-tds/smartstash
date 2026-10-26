// Route xác thực tài khoản quản trị: trạng thái, bootstrap, đăng nhập,
// đăng xuất, thông tin phiên, đổi mật khẩu của chính mình.
//
// Lỗi đăng nhập luôn trả thông điệp chung ("Email hoặc mật khẩu không
// đúng.") để không lộ tài khoản có tồn tại hay không.

import { json, err, readJson, nowIso } from '../lib/http.js';
import {
  normalizeEmail, newId, hashPassword, verifyPassword, createSession,
  revokeSessions, audit, loginRateLimitOk, timingSafeEqual, sha256Hex,
  MIN_PASSWORD_LEN,
} from '../lib/adminAuth.js';

// Nhật ký đăng nhập quản trị (bảng admin_login_logs, xem thêm route
// GET /api/admin/login-logs ở routes/admin.js).
// - Ghi cả thành công lẫn sai mật khẩu (không phân biệt "không có tài
//   khoản" với "sai mật khẩu" trong reason để log cũng không lộ).
// - IP lấy từ CF-Connecting-IP (Cloudflare đặt) rồi mới tới
//   X-Forwarded-For; IP là dữ liệu cá nhân nên route xem log chỉ dành
//   cho admin, không cho viewer/staff.
// - Lỗi ghi log không được làm hỏng đăng nhập (bảng có thể chưa có ở
//   DB tạo trước migration) nên luôn try/catch.
// - Không ghi khi bị chặn bởi giới hạn tốc độ: bộ đếm chống dò đã chặn
//   rồi, ghi nữa thì một đợt dò sẽ làm đầy bảng.
function clientIp(request) {
  const cf = (request.headers.get('CF-Connecting-IP') || '').trim();
  if (cf) return cf;
  const fwd = (request.headers.get('X-Forwarded-For') || '').trim();
  if (fwd) return fwd.split(',')[0].trim();
  return null;
}
async function logLogin(env, request, email, userId, success, reason) {
  try {
    const ua = (request.headers.get('User-Agent') || '').slice(0, 300) || null;
    await env.DB.prepare(
      `INSERT INTO admin_login_logs
         (user_id, email, success, ip, user_agent, reason)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, email, success ? 1 : 0, clientIp(request), ua, reason).run();
  } catch (e) {
    console.error('admin_login_logs insert failed:', e && e.message ? e.message : e);
  }
}

// GET /api/auth/status — công khai. Chỉ trả hasUsers (có tài khoản nào chưa)
// để PWA biết nên hiện màn tạo tài khoản đầu tiên hay màn đăng nhập.
export async function status(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_users').first();
  return json({ ok: true, hasUsers: (row?.n || 0) > 0 });
}

// POST /api/auth/setup — tạo tài khoản quản trị ĐẦU TIÊN.
// Body: { email, password, setup_token }. setup_token phải bằng ADMIN_TOKEN
// (Worker secret) và chỉ có tác dụng khi bảng admin_users còn trống.
// Sau bước này ADMIN_TOKEN không còn mở được API nào nữa.
export async function setup(request, env) {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const email = normalizeEmail(body.email);
  const password = String(body.password ?? '');
  const setupToken = String(body.setup_token ?? '');
  if (!email || !email.includes('@')) return err('invalid_fields', 'Cần có email hợp lệ.', 400);
  if (password.length < MIN_PASSWORD_LEN) {
    return err('invalid_fields', `Mật khẩu cần tối thiểu ${MIN_PASSWORD_LEN} ký tự.`, 400);
  }
  if (!env.ADMIN_TOKEN || !timingSafeEqual(setupToken, env.ADMIN_TOKEN)) {
    return err('unauthorized', 'Mã thiết lập không đúng.', 401);
  }
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_users').first();
  if ((row?.n || 0) > 0) {
    return err('already_setup', 'Đã có tài khoản quản trị, không tạo lại được.', 409);
  }
  const id = newId();
  const passwordHash = await hashPassword(password);
  await env.DB.prepare(
    'INSERT INTO admin_users (id, email, password_hash, role, active) VALUES (?, ?, ?, ?, 1)'
  ).bind(id, email, passwordHash, 'admin').run();
  const session = await createSession(env, id);
  await audit(env, email, 'admin_setup', email, { role: 'admin' });
  return json({ ok: true, token: session.token, expires_at: session.expires_at, user: { email, role: 'admin' } }, 201);
}

// POST /api/auth/login — body: { email, password }.
// Trả { token, expires_at, user } khi đúng; lỗi chung khi sai.
export async function login(request, env) {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const email = normalizeEmail(body.email);
  const password = String(body.password ?? '');
  if (!email || !password) return err('invalid_fields', 'Cần có email và mật khẩu.', 400);
  if (!(await loginRateLimitOk(env, email))) {
    return err('rate_limited', 'Đăng nhập sai quá nhiều lần. Thử lại sau 15 phút.', 429);
  }
  const user = await env.DB.prepare('SELECT * FROM admin_users WHERE email = ?').bind(email).first();
  const WRONG = err('unauthorized', 'Email hoặc mật khẩu không đúng.', 401);
  if (!user || user.active !== 1) {
    await logLogin(env, request, email, user ? user.id : null, false, 'invalid_credentials');
    return WRONG;
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    await logLogin(env, request, email, user.id, false, 'invalid_credentials');
    return WRONG;
  }
  const session = await createSession(env, user.id);
  await env.DB.prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?').bind(nowIso(), user.id).run();
  await audit(env, email, 'admin_login', email, null);
  await logLogin(env, request, email, user.id, true, null);
  return json({ ok: true, token: session.token, expires_at: session.expires_at, user: { email: user.email, role: user.role } });
}

// POST /api/auth/logout — xoá phiên hiện tại. Luôn trả ok (kể cả khi phiên
// đã hết hạn) để PWA không kẹt ở trạng thái đăng xuất lỗi.
export async function logout(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token) {
      await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
    }
  }
  return json({ ok: true });
}

// GET /api/auth/me — trả tài khoản của phiên hiện tại (router đã xác thực).
export async function me(user) {
  return json({ ok: true, user: { email: user.email, role: user.role } });
}

// POST /api/auth/change-password — tự đổi mật khẩu của mình.
// Body: { current_password, new_password }. Đổi xong thu hồi mọi phiên khác.
export async function changePassword(request, env, user) {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const current = String(body.current_password ?? '');
  const next = String(body.new_password ?? '');
  if (!current || !next) return err('invalid_fields', 'Cần có mật khẩu hiện tại và mật khẩu mới.', 400);
  if (next.length < MIN_PASSWORD_LEN) {
    return err('invalid_fields', `Mật khẩu mới cần tối thiểu ${MIN_PASSWORD_LEN} ký tự.`, 400);
  }
  const row = await env.DB.prepare('SELECT * FROM admin_users WHERE id = ?').bind(user.id).first();
  if (!row || !(await verifyPassword(current, row.password_hash))) {
    return err('unauthorized', 'Mật khẩu hiện tại không đúng.', 401);
  }
  await env.DB.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').bind(await hashPassword(next), user.id).run();
  const header = request.headers.get('Authorization') || '';
  const currentHash = header.startsWith('Bearer ') ? await sha256Hex(header.slice('Bearer '.length).trim()) : null;
  await revokeSessions(env, user.id, currentHash);
  await audit(env, user.email, 'admin_change_password', user.email, null);
  return json({ ok: true });
}
