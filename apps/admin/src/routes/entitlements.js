// Cấp / thu hồi quyền lợi thủ công (quản trị viên thao tác trên PWA).
// Mọi thao tác đều qua RevenueCat và đều ghi vào admin_audit.
// Cả hai route đều yêu cầu ADMIN_TOKEN (kiểm tra ở tầng router).

import { json, err, readJson, nowIso } from '../lib/http.js';
import { grantPromotional, revokePromotional } from '../lib/revenuecat.js';

// POST /api/entitlements/grant — body: { account_id, entitlement?, days? }.
// days mặc định 30. Dùng để tặng gói thủ công cho một tài khoản cụ thể.
export async function grant(request, env) {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const accountId = String(body.account_id ?? '').trim();
  const entitlement = String(body.entitlement || 'pro').trim() || 'pro';
  const days = body.days === undefined ? 30 : Number(body.days);
  if (!accountId || !Number.isInteger(days) || days <= 0) {
    return err('invalid_fields', 'Cần có account_id và days (số nguyên > 0).', 400);
  }
  const result = await grantPromotional(env, accountId, entitlement, days);
  if (result.notConfigured) {
    return err('not_configured', 'Máy chủ chưa cấu hình REVENUECAT_SECRET_KEY.', 503);
  }
  if (!result.ok) {
    return err('revenuecat_error', 'Không cấp được quyền lợi từ RevenueCat.', 502);
  }
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO admin_audit (actor, action, target, detail) VALUES (?, ?, ?, ?)'
    ).bind('admin', 'entitlement_grant', accountId, JSON.stringify({ entitlement, days })),
    env.DB.prepare(
      `INSERT INTO app_accounts
         (revenuecat_app_user_id, plan_status, promo_until, updated_at)
       VALUES (?, 'pro_promo', ?, ?)
       ON CONFLICT(revenuecat_app_user_id) DO UPDATE SET
         plan_status = 'pro_promo', promo_until = excluded.promo_until,
         updated_at = excluded.updated_at`
    ).bind(accountId, result.expiresAt, now),
  ]);
  return json({ ok: true, account_id: accountId, entitlement, expires_at: result.expiresAt });
}

// POST /api/entitlements/revoke — body: { account_id, entitlement? }.
// Thu hồi quyền lợi tặng; trạng thái tài khoản quay về 'free' (chỉ khi đang là pro_promo).
export async function revoke(request, env) {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const accountId = String(body.account_id ?? '').trim();
  const entitlement = String(body.entitlement || 'pro').trim() || 'pro';
  if (!accountId) return err('invalid_fields', 'Cần có account_id.', 400);
  const result = await revokePromotional(env, accountId, entitlement);
  if (result.notConfigured) {
    return err('not_configured', 'Máy chủ chưa cấu hình REVENUECAT_SECRET_KEY.', 503);
  }
  if (!result.ok) {
    return err('revenuecat_error', 'Không thu hồi được quyền lợi từ RevenueCat.', 502);
  }
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO admin_audit (actor, action, target, detail) VALUES (?, ?, ?, ?)'
    ).bind('admin', 'entitlement_revoke', accountId, JSON.stringify({ entitlement })),
    env.DB.prepare(
      `UPDATE app_accounts SET plan_status = 'free', promo_until = NULL, updated_at = ?
        WHERE revenuecat_app_user_id = ? AND plan_status = 'pro_promo'`
    ).bind(now, accountId),
  ]);
  return json({ ok: true, account_id: accountId, entitlement, revoked: true });
}
