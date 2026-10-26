// Quản lý tài khoản quản trị — CHỈ role admin.
//
// Rào chắn an toàn (không cho tự khoá mình):
// - Không đổi role / khoá / xoá chính mình.
// - Luôn phải còn ít nhất 1 tài khoản admin đang hoạt động.
// - Đổi mật khẩu của người khác thì thu hồi toàn bộ phiên của người đó.

import { json, err, readJson } from '../lib/http.js';
import {
  normalizeEmail, newId, hashPassword, revokeSessions, audit, publicUser,
  MIN_PASSWORD_LEN,
} from '../lib/adminAuth.js';

const VALID_ROLES = ['admin', 'staff', 'viewer'];

// GET /api/admin/users — liệt kê (không bao giờ trả password_hash).
export async function listUsers(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, email, role, active, created_at, last_login_at FROM admin_users ORDER BY created_at ASC'
  ).all();
  return json({ ok: true, users: (results || []).map(publicUser) });
}

// POST /api/admin/users — body: { email, password, role? }.
export async function createUser(request, env, actor) {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const email = normalizeEmail(body.email);
  const password = String(body.password ?? '');
  const role = String(body.role || 'viewer');
  if (!email || !email.includes('@')) return err('invalid_fields', 'Cần có email hợp lệ.', 400);
  if (password.length < MIN_PASSWORD_LEN) {
    return err('invalid_fields', `Mật khẩu cần tối thiểu ${MIN_PASSWORD_LEN} ký tự.`, 400);
  }
  if (!VALID_ROLES.includes(role)) return err('invalid_fields', 'Role phải là admin, staff hoặc viewer.', 400);
  const id = newId();
  try {
    await env.DB.prepare(
      'INSERT INTO admin_users (id, email, password_hash, role, active) VALUES (?, ?, ?, ?, 1)'
    ).bind(id, email, await hashPassword(password), role).run();
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      return err('email_exists', `Email ${email} đã có tài khoản.`, 409);
    }
    throw e;
  }
  await audit(env, actor.email, 'admin_user_create', email, { role });
  return json({ ok: true, user: { id, email, role, active: true } }, 201);
}

async function loadUser(env, id) {
  return env.DB.prepare('SELECT * FROM admin_users WHERE id = ?').bind(id).first();
}

async function countActiveAdmins(env) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM admin_users WHERE role = 'admin' AND active = 1"
  ).first();
  return row?.n || 0;
}

// PATCH /api/admin/users/:id — body: { role?, active? }.
export async function updateUser(request, env, actor, id) {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const target = await loadUser(env, id);
  if (!target) return err('not_found', 'Không tìm thấy tài khoản.', 404);
  if (target.id === actor.id) {
    return err('forbidden', 'Không tự đổi role hoặc tự khoá chính mình.', 403);
  }
  const changes = {};
  if (body.role !== undefined) {
    if (!VALID_ROLES.includes(String(body.role))) {
      return err('invalid_fields', 'Role phải là admin, staff hoặc viewer.', 400);
    }
    changes.role = String(body.role);
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') {
      return err('invalid_fields', 'active phải là true/false.', 400);
    }
    changes.active = body.active ? 1 : 0;
  }
  if (Object.keys(changes).length === 0) {
    return err('invalid_fields', 'Không có gì để đổi.', 400);
  }
  // Không được để mất tài khoản admin hoạt động cuối cùng.
  if ((changes.role && changes.role !== 'admin' && target.role === 'admin') ||
      (changes.active === 0 && target.role === 'admin')) {
    if ((await countActiveAdmins(env)) <= 1) {
      return err('last_admin', 'Không thể hạ quyền hoặc khoá tài khoản admin hoạt động cuối cùng.', 403);
    }
  }
  if (changes.role !== undefined) {
    await env.DB.prepare('UPDATE admin_users SET role = ? WHERE id = ?').bind(changes.role, id).run();
  }
  if (changes.active !== undefined) {
    await env.DB.prepare('UPDATE admin_users SET active = ? WHERE id = ?').bind(changes.active, id).run();
    if (changes.active === 0) await revokeSessions(env, id);
  }
  await audit(env, actor.email, 'admin_user_update', target.email, changes);
  return json({ ok: true });
}

// DELETE /api/admin/users/:id — xoá hẳn tài khoản (kèm toàn bộ phiên của nó).
export async function deleteUser(env, actor, id) {
  const target = await loadUser(env, id);
  if (!target) return err('not_found', 'Không tìm thấy tài khoản.', 404);
  if (target.id === actor.id) {
    return err('forbidden', 'Không tự xoá chính mình.', 403);
  }
  if (target.role === 'admin' && (await countActiveAdmins(env)) <= 1) {
    return err('last_admin', 'Không thể xoá tài khoản admin hoạt động cuối cùng.', 403);
  }
  await revokeSessions(env, id);
  await env.DB.prepare('DELETE FROM admin_users WHERE id = ?').bind(id).run();
  await audit(env, actor.email, 'admin_user_delete', target.email, null);
  return json({ ok: true });
}

// POST /api/admin/users/:id/reset-password — body: { password }.
// Admin đặt lại mật khẩu cho người khác; thu hồi toàn bộ phiên của người đó.
export async function resetPassword(request, env, actor, id) {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const password = String(body.password ?? '');
  if (password.length < MIN_PASSWORD_LEN) {
    return err('invalid_fields', `Mật khẩu cần tối thiểu ${MIN_PASSWORD_LEN} ký tự.`, 400);
  }
  const target = await loadUser(env, id);
  if (!target) return err('not_found', 'Không tìm thấy tài khoản.', 404);
  if (target.id === actor.id) {
    return err('forbidden', 'Muốn đổi mật khẩu của mình thì dùng Đổi mật khẩu, không dùng đặt lại.', 403);
  }
  await env.DB.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').bind(await hashPassword(password), id).run();
  await revokeSessions(env, id);
  await audit(env, actor.email, 'admin_user_reset_password', target.email, null);
  return json({ ok: true });
}
