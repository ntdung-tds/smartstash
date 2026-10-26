// Thống kê tổng quan + các màn quản lý bổ sung (tài khoản app, tài khoản
// sao lưu, nhật ký audit). Tất cả route GET ở đây chỉ đọc nên mọi vai trò
// (viewer trở lên) đều xem được; ghi (đổi gói sao lưu) chỉ dành cho admin
// (kiểm tra ở tầng router).

import { json, err, readJson } from '../lib/http.js';
import { audit } from '../lib/adminAuth.js';
import { getTierSizes } from './backups.js';

// GET /api/admin/stats — số liệu tổng hợp cho tab Tổng quan.
export async function getStats(env) {
  const byPlan = await env.DB.prepare(
    'SELECT plan_status, COUNT(*) AS n FROM app_accounts GROUP BY plan_status'
  ).all();
  const promo = await env.DB.prepare(
    'SELECT COUNT(*) AS total, COALESCE(SUM(enabled), 0) AS enabled FROM promo_codes'
  ).first();
  const redeem = await env.DB.prepare(
    "SELECT result, COUNT(*) AS n FROM redemptions GROUP BY result"
  ).all();
  const redeem30 = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM redemptions WHERE result = 'granted' AND redeemed_at >= datetime('now', '-30 days')"
  ).first();
  const backups = await env.DB.prepare(
    'SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM backup_files'
  ).first();
  const backupAccounts = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM backup_accounts'
  ).first();
  const admins = await env.DB.prepare(
    'SELECT COUNT(*) AS total, COALESCE(SUM(active), 0) AS active FROM admin_users'
  ).first();
  // Tài khoản mới 30 ngày (chỉ tính dòng có created_at — tài khoản cũ trước
  // khi có cột này mang NULL và không được tính).
  const new30 = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM app_accounts WHERE created_at >= datetime('now', '-30 days')"
  ).first();
  // Lượt đổi theo ngày, 14 ngày gần nhất (cho biểu đồ nhỏ ở Tổng quan).
  const daily = await env.DB.prepare(
    `SELECT substr(redeemed_at, 1, 10) AS day, result, COUNT(*) AS n
       FROM redemptions WHERE redeemed_at >= datetime('now', '-14 days')
      GROUP BY day, result ORDER BY day ASC`
  ).all();

  const plans = { free: 0, pro_paid: 0, pro_promo: 0, pro: 0 };
  for (const r of byPlan.results || []) plans[r.plan_status] = r.n;
  const redeemByResult = { granted: 0, rejected: 0, error: 0 };
  for (const r of redeem.results || []) redeemByResult[r.result] = r.n;

  const dailyMap = {};
  for (const r of daily.results || []) {
    if (!dailyMap[r.day]) dailyMap[r.day] = { day: r.day, granted: 0, rejected: 0, error: 0 };
    if (r.result in dailyMap[r.day]) dailyMap[r.day][r.result] = r.n;
  }
  return json({
    ok: true,
    accounts: {
      total: plans.free + plans.pro_paid + plans.pro_promo + plans.pro,
      by_plan: plans,
      new_30d: new30?.n || 0,
    },
    promos: { total: promo?.total || 0, enabled: promo?.enabled || 0 },
    redemptions: { ...redeemByResult, granted_30d: redeem30?.n || 0, daily: Object.values(dailyMap) },
    backups: {
      accounts: backupAccounts?.n || 0,
      files: backups?.files || 0,
      bytes: backups?.bytes || 0,
    },
    admins: { total: admins?.total || 0, active: admins?.active || 0 },
  });
}

// GET /api/admin/accounts/:id — tra cứu một tài khoản (theo ID hoặc email),
// kèm lượt đổi mã của tài khoản đó. Theo SRS màn Tài khoản.
export async function getAccountDetail(env, idOrEmail) {
  const q = String(idOrEmail || '').trim();
  if (!q) return err('invalid_fields', 'Cần có ID hoặc email tài khoản.', 400);
  const account = await env.DB.prepare(
    `SELECT revenuecat_app_user_id, email, plan_status, paid_until, promo_until,
            created_at, updated_at FROM app_accounts
      WHERE revenuecat_app_user_id = ? OR email = ?`
  ).bind(q, q).first();
  if (!account) return err('not_found', 'Không tìm thấy tài khoản.', 404);
  const blockedRow = await env.DB.prepare(
    'SELECT reason FROM blocked_accounts WHERE account_id = ?'
  ).bind(account.revenuecat_app_user_id).first();
  account.blocked = blockedRow ? 1 : 0;
  account.blocked_reason = blockedRow ? blockedRow.reason : null;
  const backupRow = await env.DB.prepare(
    `SELECT ba.account_id AS backup_account_id, ba.tier_mb AS backup_tier_mb,
            COUNT(bf.id) AS backup_files, COALESCE(SUM(bf.size_bytes), 0) AS backup_bytes
       FROM backup_accounts ba
       LEFT JOIN backup_files bf ON bf.account_id = ba.account_id
      WHERE ba.app_account_id = ?
      GROUP BY ba.account_id`
  ).bind(account.revenuecat_app_user_id).all();
  account.backup = (backupRow.results || []).length
    ? backupRow.results[0]
    : null;
  const { results } = await env.DB.prepare(
    'SELECT * FROM redemptions WHERE account_id = ? ORDER BY redeemed_at DESC LIMIT 50'
  ).bind(account.revenuecat_app_user_id).all();
  return json({ ok: true, account, redemptions: results || [] });
}

// GET /api/admin/health — trạng thái hệ thống thật (không chỉ "Worker sống").
// Kiểm tra từng tầng mà PWA hiển thị: D1 (SELECT 1), KV (đọc được khoá
// cấu hình hay chưa — chưa từng lưu thì vẫn là OK vì get trả null),
// R2 (list 1 object). Tầng nào lỗi thì cờ đó false, không làm hỏng cả
// kết quả — quản trị viên thấy ngay tầng nào đang gặp vấn đề.
export async function getSystemHealth(env) {
  const checks = { worker: true, d1: false, kv: false, r2: false };
  try {
    await env.DB.prepare('SELECT 1 AS x').first();
    checks.d1 = true;
  } catch { /* giữ false */ }
  try {
    if (env.CONFIG) {
      // Khoá 'flags' là nơi putFlags lưu cấu hình; chưa từng lưu thì
      // get trả null nhưng vẫn chứng tỏ KV đọc được.
      await env.CONFIG.get('flags', { type: 'text' });
      checks.kv = true;
    }
  } catch { /* giữ false */ }
  try {
    if (env.BACKUPS) {
      await env.BACKUPS.list({ limit: 1 });
      checks.r2 = true;
    }
  } catch { /* giữ false */ }
  return json({ ok: true, checks, time: new Date().toISOString() });
}

// GET /api/admin/login-logs?limit=&offset=&email=&success= — lịch sử
// đăng nhập quản trị (chỉ admin, vì có IP). Trả kèm bảng tổng hợp theo
// từng email: số lần thành công / thất bại / lần gần nhất — chính là
// "số lần đăng nhập" mà bảng người dùng trước đây không có.
export async function listLoginLogs(env, url) {
  let limit = parseInt(url.searchParams.get('limit') || '100', 10);
  if (!Number.isInteger(limit) || limit < 1) limit = 100;
  if (limit > 200) limit = 200;
  let offset = parseInt(url.searchParams.get('offset') || '0', 10);
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  const email = (url.searchParams.get('email') || '').trim();
  const success = (url.searchParams.get('success') || '').trim();
  const where = [];
  const params = [];
  if (email) { where.push('email LIKE ?'); params.push('%' + email + '%'); }
  if (success === '1' || success === '0') { where.push('success = ?'); params.push(Number(success)); }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM admin_login_logs' + whereSql
  ).bind(...params).first();
  const { results } = await env.DB.prepare(
    `SELECT id, user_id, email, success, ip, user_agent, reason, created_at
       FROM admin_login_logs${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();
  const summary = await env.DB.prepare(
    `SELECT email,
            SUM(success) AS ok_count,
            SUM(1 - success) AS fail_count,
            MAX(created_at) AS last_at
       FROM admin_login_logs GROUP BY email ORDER BY last_at DESC`
  ).all();
  return json({
    ok: true, logs: results || [], summary: summary.results || [],
    total: total?.n || 0, offset, limit,
  });
}

// GET /api/admin/revenue — doanh thu theo thời gian từ revenue_events.
// Giá là GIÁ GỘP theo webhook, tách riêng từng currency (không cộng dồn
// tiền khác loại). Chưa nối RevenueCat thì các mảng đều rỗng — PWA hiện
// trạng thái chờ thay vì bịa số.
export async function getRevenue(env) {
  const monthly = await env.DB.prepare(
    `SELECT substr(event_at, 1, 7) AS month, currency,
            SUM(CASE WHEN type IN ('INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE') THEN COALESCE(price, 0) ELSE 0 END) AS gross,
            SUM(CASE WHEN type = 'INITIAL_PURCHASE' THEN 1 ELSE 0 END) AS new_paid,
            SUM(CASE WHEN type = 'RENEWAL' THEN 1 ELSE 0 END) AS renewals,
            SUM(CASE WHEN type = 'CANCELLATION' THEN 1 ELSE 0 END) AS cancellations,
            SUM(CASE WHEN type = 'EXPIRATION' THEN 1 ELSE 0 END) AS expirations
       FROM revenue_events WHERE event_at IS NOT NULL
      GROUP BY month, currency ORDER BY month DESC LIMIT 60`
  ).all();
  const byProduct = await env.DB.prepare(
    `SELECT product_id, currency,
            SUM(CASE WHEN type IN ('INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE') THEN COALESCE(price, 0) ELSE 0 END) AS gross,
            COUNT(*) AS events
       FROM revenue_events GROUP BY product_id, currency ORDER BY gross DESC`
  ).all();
  const byStore = await env.DB.prepare(
    `SELECT store, currency,
            SUM(CASE WHEN type IN ('INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE') THEN COALESCE(price, 0) ELSE 0 END) AS gross,
            COUNT(*) AS events
       FROM revenue_events GROUP BY store, currency ORDER BY gross DESC`
  ).all();
  const byCountry = await env.DB.prepare(
    `SELECT country, currency,
            SUM(CASE WHEN type IN ('INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE') THEN COALESCE(price, 0) ELSE 0 END) AS gross,
            COUNT(*) AS events
       FROM revenue_events WHERE country IS NOT NULL
      GROUP BY country, currency ORDER BY gross DESC`
  ).all();
  const totals = await env.DB.prepare(
    `SELECT currency,
            SUM(CASE WHEN type IN ('INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE') THEN COALESCE(price, 0) ELSE 0 END) AS gross,
            SUM(CASE WHEN type = 'INITIAL_PURCHASE' THEN 1 ELSE 0 END) AS new_paid,
            SUM(CASE WHEN type = 'RENEWAL' THEN 1 ELSE 0 END) AS renewals,
            SUM(CASE WHEN type = 'CANCELLATION' THEN 1 ELSE 0 END) AS cancellations
       FROM revenue_events GROUP BY currency`
  ).all();
  return json({
    ok: true,
    monthly: monthly.results || [],
    by_product: byProduct.results || [],
    by_store: byStore.results || [],
    by_country: byCountry.results || [],
    totals: totals.results || [],
  });
}

// GET /api/admin/audit?limit=50&offset=0 — nhật ký thao tác quản trị.
// Phân trang bằng offset + total để PWA lật được trang khi vượt giới hạn.
export async function listAudit(env, url) {
  let limit = parseInt(url.searchParams.get('limit') || '50', 10);
  if (!Number.isInteger(limit) || limit < 1) limit = 50;
  if (limit > 200) limit = 200;
  let offset = parseInt(url.searchParams.get('offset') || '0', 10);
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  const total = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM admin_audit'
  ).first();
  const { results } = await env.DB.prepare(
    'SELECT actor, action, target, detail, at FROM admin_audit ORDER BY id DESC LIMIT ? OFFSET ?'
  ).bind(limit, offset).all();
  return json({ ok: true, entries: results || [], total: total?.n || 0, offset, limit });
}

// GET /api/admin/accounts?plan=&limit=100 — tài khoản app (người dùng cuối).
// Kèm trạng thái khoá (blocked) từ bảng blocked_accounts: khoá là cổng
// chặn riêng, không đổi plan_status nên mở khoá là khôi phục nguyên gói.
export async function listAppAccounts(env, url) {
  let limit = parseInt(url.searchParams.get('limit') || '100', 10);
  if (!Number.isInteger(limit) || limit < 1) limit = 100;
  if (limit > 500) limit = 500;
  let offset = parseInt(url.searchParams.get('offset') || '0', 10);
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  const plan = (url.searchParams.get('plan') || '').trim();
  const validPlans = ['free', 'pro_paid', 'pro_promo', 'pro'];
  // Dung lượng sao lưu của từng tài khoản app: nối qua
  // backup_accounts.app_account_id rồi cộng dồn backup_files. Tài khoản
  // chưa nối thì các cột backup_* là 0/null — PWA hiện "Chưa nối".
  const select = `SELECT a.revenuecat_app_user_id, a.email, a.plan_status, a.paid_until,
            a.promo_until, a.updated_at,
            CASE WHEN b.account_id IS NOT NULL THEN 1 ELSE 0 END AS blocked,
            MAX(b.reason) AS blocked_reason,
            MAX(ba.account_id) AS backup_account_id,
            MAX(ba.tier_mb) AS backup_tier_mb,
            COALESCE(SUM(bf.size_bytes), 0) AS backup_bytes,
            COUNT(bf.id) AS backup_files
       FROM app_accounts a LEFT JOIN blocked_accounts b
         ON b.account_id = a.revenuecat_app_user_id
       LEFT JOIN backup_accounts ba
         ON ba.app_account_id = a.revenuecat_app_user_id
       LEFT JOIN backup_files bf ON bf.account_id = ba.account_id`;
  let rows;
  let total;
  if (plan && validPlans.includes(plan)) {
    total = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM app_accounts WHERE plan_status = ?'
    ).bind(plan).first();
    rows = await env.DB.prepare(
      select + ' WHERE a.plan_status = ? GROUP BY a.revenuecat_app_user_id ORDER BY a.updated_at DESC LIMIT ? OFFSET ?'
    ).bind(plan, limit, offset).all();
  } else {
    total = await env.DB.prepare('SELECT COUNT(*) AS n FROM app_accounts').first();
    rows = await env.DB.prepare(
      select + ' GROUP BY a.revenuecat_app_user_id ORDER BY a.updated_at DESC LIMIT ? OFFSET ?'
    ).bind(limit, offset).all();
  }
  return json({ ok: true, accounts: rows.results || [], total: total?.n || 0, offset, limit });
}

// POST /api/admin/accounts/:id/block — khoá tài khoản app (chỉ admin).
// Tài khoản bị khoá: đổi mã bị từ chối (mã không bị tiêu), kiểm tra gói
// trả về free, cấp thủ công bị từ chối. Gói gốc không bị đổi nên mở
// khoá là khôi phục. Cần lý do, ghi kiểm toán.
export async function blockAppAccount(request, env, actor, accountId) {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const reason = String(body.reason ?? '').trim();
  if (!reason) return err('invalid_fields', 'Khoá tài khoản cần có lý do.', 400);
  const exists = await env.DB.prepare(
    'SELECT 1 AS x FROM app_accounts WHERE revenuecat_app_user_id = ?'
  ).bind(accountId).first();
  if (!exists) return err('not_found', 'Không tìm thấy tài khoản app.', 404);
  await env.DB.prepare(
    `INSERT INTO blocked_accounts (account_id, reason, blocked_by)
     VALUES (?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET reason = excluded.reason,
       blocked_by = excluded.blocked_by, blocked_at = datetime('now')`
  ).bind(accountId, reason, actor).run();
  await audit(env, actor, 'app_account_block', accountId, { reason });
  return json({ ok: true, account_id: accountId, blocked: true });
}

// POST /api/admin/accounts/:id/unblock — mở khoá tài khoản app (chỉ admin).
export async function unblockAppAccount(request, env, actor, accountId) {
  const res = await env.DB.prepare(
    'DELETE FROM blocked_accounts WHERE account_id = ?'
  ).bind(accountId).run();
  if (res.meta.changes === 0) {
    return err('not_found', 'Tài khoản này không bị khoá.', 404);
  }
  await audit(env, actor, 'app_account_unblock', accountId, null);
  return json({ ok: true, account_id: accountId, blocked: false });
}

// DELETE /api/admin/accounts/:id — xoá hẳn tài khoản app (chỉ admin).
// Chỉ xoá dòng app_accounts (+ dòng khoá nếu có); lịch sử đổi mã trong
// redemptions được GIỮ. Lưu ý: xoá không chặn được tài khoản — tài
// khoản bị xoá vẫn đổi mã lại được và tạo dòng mới; muốn chặn thì
// dùng Khoá, không dùng Xoá. Cần lý do, ghi kiểm toán.
export async function deleteAppAccount(request, env, actor, accountId) {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const reason = String(body.reason ?? '').trim();
  if (!reason) return err('invalid_fields', 'Xoá tài khoản cần có lý do.', 400);
  const res = await env.DB.prepare(
    'DELETE FROM app_accounts WHERE revenuecat_app_user_id = ?'
  ).bind(accountId).run();
  if (res.meta.changes === 0) {
    return err('not_found', 'Không tìm thấy tài khoản app.', 404);
  }
  await env.DB.prepare(
    'DELETE FROM blocked_accounts WHERE account_id = ?'
  ).bind(accountId).run();
  await audit(env, actor, 'app_account_delete', accountId, { reason });
  return json({ ok: true, account_id: accountId, deleted: true });
}

// GET /api/admin/backups/accounts/:id/files — danh sách file sao lưu
// (chỉ metadata: tên, dung lượng, thời điểm) của một tài khoản mây
// (chỉ admin/staff/viewer xem; KHÔNG trả nội dung file — riêng tư).
export async function listBackupAccountFiles(env, accountId) {
  const exists = await env.DB.prepare(
    'SELECT 1 AS x FROM backup_accounts WHERE account_id = ?'
  ).bind(accountId).first();
  if (!exists) return err('not_found', 'Không tìm thấy tài khoản sao lưu.', 404);
  const { results } = await env.DB.prepare(
    `SELECT file_name, size_bytes, updated_at FROM backup_files
      WHERE account_id = ? ORDER BY updated_at DESC`
  ).bind(accountId).all();
  return json({ ok: true, account_id: accountId, files: results || [] });
}

// GET /api/admin/backups/accounts — tài khoản "mây của tôi" kèm dung lượng
// thực tế (số file + tổng byte) và gói hiện tại.
export async function listBackupAccounts(env) {
  const { results } = await env.DB.prepare(
    `SELECT ba.account_id, ba.tier_mb, ba.created_at, ba.updated_at,
            ba.app_account_id, a.email AS owner_email, a.plan_status AS owner_plan,
            COUNT(bf.id) AS files, COALESCE(SUM(bf.size_bytes), 0) AS bytes
       FROM backup_accounts ba
       LEFT JOIN backup_files bf ON bf.account_id = ba.account_id
       LEFT JOIN app_accounts a ON a.revenuecat_app_user_id = ba.app_account_id
      GROUP BY ba.account_id
      ORDER BY ba.updated_at DESC`
  ).all();
  return json({ ok: true, accounts: results || [] });
}

// PATCH /api/admin/backups/accounts/:id — admin đổi gói lưu trữ cho một tài
// khoản (vd: tặng thêm dung lượng khi hỗ trợ khách). Body: { tier_mb }.
export async function setBackupTier(request, env, actor, accountId) {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const tier = Number(body.tier_mb);
  const tierSizes = await getTierSizes(env);
  if (!tierSizes.includes(tier)) {
    return err('invalid_fields', 'tier_mb phải là một trong ' + tierSizes.join(', ') + '.', 400);
  }
  const res = await env.DB.prepare(
    'UPDATE backup_accounts SET tier_mb = ?, updated_at = ? WHERE account_id = ?'
  ).bind(tier, new Date().toISOString(), accountId).run();
  if (res.meta.changes === 0) return err('not_found', 'Không tìm thấy tài khoản sao lưu.', 404);
  await audit(env, actor, 'backup_tier_change', accountId, { tier_mb: tier });
  return json({ ok: true, account_id: accountId, tier_mb: tier });
}
