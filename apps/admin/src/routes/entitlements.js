// Cấp / thu hồi quyền lợi thủ công (quản trị viên thao tác trên PWA).
// Qua RevenueCat nếu đã cấu hình secret; ngược lại cấp/thu hồi NỘI BỘ
// vào app_accounts (pro_promo + promo_until) — cùng đường như đổi mã
// khuyến mãi (promo.js), để quản trị viên tặng Pro được ngay cả khi
// chưa nối RevenueCat. Khi nối RevenueCat sau này, các quyền nội bộ
// này vẫn có hiệu lực với app vì app kiểm tra gói theo app_accounts
// qua /api/promo/status; chúng chỉ không có trong hệ thống RevenueCat.
// Mọi thao tác đều ghi vào admin_audit.
// Cả hai route đều yêu cầu role admin (kiểm tra ở tầng router).

import { json, err, readJson, nowIso } from '../lib/http.js';
import { grantPromotional, revokePromotional } from '../lib/revenuecat.js';

// POST /api/entitlements/grant — body: { account_id, entitlement?, days? }.
// days mặc định 30. Dùng để tặng gói thủ công cho một tài khoản cụ thể.
// Theo SRS: cấp/thu hồi thủ công yêu cầu lý do bắt buộc, ghi vào kiểm toán.
export async function grant(request, env, actor = 'admin') {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const accountId = String(body.account_id ?? '').trim();
  const entitlement = String(body.entitlement || 'pro').trim() || 'pro';
  const days = body.days === undefined ? 30 : Number(body.days);
  const reason = String(body.reason ?? '').trim();
  if (!accountId || !Number.isInteger(days) || days <= 0) {
    return err('invalid_fields', 'Cần có account_id và days (số nguyên > 0).', 400);
  }
  if (!reason) {
    return err('invalid_fields', 'Cấp quyền lợi cần có lý do.', 400);
  }
  const blocked = await env.DB.prepare(
    'SELECT 1 AS x FROM blocked_accounts WHERE account_id = ?'
  ).bind(accountId).first();
  if (blocked) {
    return err('account_blocked', 'Tài khoản này đang bị khoá — mở khoá trước khi cấp.', 403);
  }
  const result = await grantPromotional(env, accountId, entitlement, days);
  let expiresAt;
  if (result.notConfigured) {
    // Chưa nối RevenueCat: cấp nội bộ, hết hạn sau đúng số ngày yêu cầu.
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  } else if (!result.ok) {
    return err('revenuecat_error', 'Không cấp được quyền lợi từ RevenueCat.', 502);
  } else {
    expiresAt = result.expiresAt;
  }
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO admin_audit (actor, action, target, detail) VALUES (?, ?, ?, ?)'
    ).bind(actor, 'entitlement_grant', accountId, JSON.stringify({ entitlement, days, reason })),
    env.DB.prepare(
      `INSERT INTO app_accounts
         (revenuecat_app_user_id, plan_status, promo_until, updated_at)
       VALUES (?, 'pro_promo', ?, ?)
       ON CONFLICT(revenuecat_app_user_id) DO UPDATE SET
         plan_status = 'pro_promo', promo_until = excluded.promo_until,
         updated_at = excluded.updated_at`
    ).bind(accountId, expiresAt, now),
  ]);
  return json({ ok: true, account_id: accountId, entitlement, expires_at: expiresAt });
}

// POST /api/entitlements/revoke — body: { account_id, entitlement? }.
// Thu hồi quyền lợi tặng; trạng thái tài khoản quay về 'free' (chỉ khi đang là pro_promo).
export async function revoke(request, env, actor = 'admin') {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const accountId = String(body.account_id ?? '').trim();
  const entitlement = String(body.entitlement || 'pro').trim() || 'pro';
  const reason = String(body.reason ?? '').trim();
  if (!accountId) return err('invalid_fields', 'Cần có account_id.', 400);
  if (!reason) {
    return err('invalid_fields', 'Thu hồi quyền lợi cần có lý do.', 400);
  }
  const result = await revokePromotional(env, accountId, entitlement);
  if (!result.notConfigured && !result.ok) {
    return err('revenuecat_error', 'Không thu hồi được quyền lợi từ RevenueCat.', 502);
  }
  // Chưa nối RevenueCat: thu hồi nội bộ — câu UPDATE dưới đây chỉ
  // đổi pro_promo về free, tài khoản pro_paid không bị đụng tới.
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO admin_audit (actor, action, target, detail) VALUES (?, ?, ?, ?)'
    ).bind(actor, 'entitlement_revoke', accountId, JSON.stringify({ entitlement, reason })),
    env.DB.prepare(
      `UPDATE app_accounts SET plan_status = 'free', promo_until = NULL, updated_at = ?
        WHERE revenuecat_app_user_id = ? AND plan_status = 'pro_promo'`
    ).bind(now, accountId),
  ]);
  return json({ ok: true, account_id: accountId, entitlement, revoked: true });
}
