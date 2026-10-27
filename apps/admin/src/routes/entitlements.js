// Cấp / thu hồi quyền lợi thủ công (quản trị viên thao tác trên PWA).
// Qua RevenueCat nếu đã cấu hình secret; ngược lại cấp/thu hồi NỘI BỘ
// vào app_accounts (pro_promo + promo_until) — cùng đường như đổi mã
// khuyến mãi (promo.js), để quản trị viên tặng Pro được ngay cả khi
// chưa nối RevenueCat. Khi nối RevenueCat sau này, các quyền nội bộ
// này vẫn có hiệu lực với app vì app kiểm tra gói theo app_accounts
// qua /api/promo/status; chúng chỉ không có trong hệ thống RevenueCat.
// Mọi thao tác đều ghi vào admin_audit.
// Cả hai route đều yêu cầu role admin (kiểm tra ở tầng router).
//
// Quy tắc chốt 27/10/2026 (rà soát cấp/thu hồi theo từng người):
// - Cấp VẪN ĐƯỢC khi Pro còn hạn (kể cả đang trả phí): số ngày CỘNG DỒN
//   vào hạn tặng hiện có — promo_until còn hạn thì cộng tiếp, hết hạn
//   hoặc chưa có thì tính từ hôm nay — và TRẦN 3 năm (1095 ngày) tính
//   từ hôm nay: hạn mới = min(hạn cũ + days, hôm nay + 1095 ngày).
//   Nếu hạn tặng hiện có đã vượt trần thì từ chối 409 — không bao giờ
//   rút ngắn hạn hiện có khi cấp.
// - Cấp KHÔNG ghi đè trạng thái trả phí: tài khoản pro_paid (hoặc 'pro'
//   không thời hạn) giữ nguyên plan_status, chỉ ghi promo_until làm
//   quyền tặng chờ phía sau — khi paid hết hạn, app đọc tới promo_until.
//   (Trước đây cấp ghi đè thành pro_promo, làm mất gói trả phí.)
// - Cấp cho ID chưa từng xuất hiện → 404, không tự tạo tài khoản ma.
// - Thu hồi trả kết quả thật: revoked=false khi không có gì để thu hồi
//   (đã free, hoặc pro_paid mà không có promo_until chờ). Thu hồi xoá
//   promo_until và chỉ đổi pro_promo → free; gói trả phí không đụng.

import { json, err, readJson, nowIso } from '../lib/http.js';
import { grantPromotional, revokePromotional } from '../lib/revenuecat.js';

/** Trần hạn tặng: 3 năm tính từ hôm nay (ngày). */
export const MAX_GRANT_DAYS = 1095;

const DAY_MS = 24 * 60 * 60 * 1000;

function addDaysIso(iso, days) {
  return new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
}

// POST /api/entitlements/grant — body: { account_id, entitlement?, days? }.
// days mặc định 30, cộng dồn vào hạn tặng hiện có, trần 3 năm từ hôm nay.
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
  const account = await env.DB.prepare(
    'SELECT plan_status, promo_until, paid_until FROM app_accounts WHERE revenuecat_app_user_id = ?'
  ).bind(accountId).first();
  if (!account) {
    return err('account_not_found', 'Tài khoản chưa từng xuất hiện — kiểm tra lại ID (không tự tạo tài khoản mới khi cấp).', 404);
  }
  const now = nowIso();
  const cap = addDaysIso(now, MAX_GRANT_DAYS);
  // Cộng dồn: hạn tặng còn hạn thì cộng tiếp, không thì tính từ hôm nay.
  const base = account.promo_until && account.promo_until > now ? account.promo_until : now;
  if (base >= cap) {
    return err('grant_cap', `Tài khoản đã có quyền tặng tới ${account.promo_until}, vượt trần tối đa 3 năm — không cấp thêm được.`, 409);
  }
  const stacked = addDaysIso(base, days);
  const clamped = stacked > cap;
  const newPromoUntil = clamped ? cap : stacked;

  const result = await grantPromotional(env, accountId, entitlement, days);
  let expiresAt;
  if (result.notConfigured) {
    // Chưa nối RevenueCat: cấp nội bộ theo hạn đã cộng dồn + trần.
    expiresAt = newPromoUntil;
  } else if (!result.ok) {
    return err('revenuecat_error', 'Không cấp được quyền lợi từ RevenueCat.', 502);
  } else {
    expiresAt = result.expiresAt;
  }
  // Giữ nguyên trạng thái trả phí / không thời hạn; chỉ tài khoản thường
  // mới chuyển sang pro_promo. (Đường RevenueCat giữ nguyên expiresAt
  // của nó; trần 3 năm áp cho đường nội bộ đang chạy.)
  const newStatus = (account.plan_status === 'pro_paid' || account.plan_status === 'pro')
    ? account.plan_status
    : 'pro_promo';
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO admin_audit (actor, action, target, detail) VALUES (?, ?, ?, ?)'
    ).bind(actor, 'entitlement_grant', accountId, JSON.stringify({
      entitlement, days, reason,
      previous_plan: account.plan_status, previous_until: account.promo_until || null,
      clamped,
    })),
    env.DB.prepare(
      `UPDATE app_accounts SET plan_status = ?, promo_until = ?, updated_at = ?
        WHERE revenuecat_app_user_id = ?`
    ).bind(newStatus, expiresAt, now, accountId),
  ]);
  return json({
    ok: true, account_id: accountId, entitlement,
    expires_at: expiresAt, previous_until: account.promo_until || null, clamped,
  });
}

// POST /api/entitlements/revoke — body: { account_id, entitlement? }.
// Thu hồi quyền tặng: xoá promo_until, chỉ đổi pro_promo → free.
// Trả revoked=false khi không có gì để thu hồi (đã free, hoặc pro_paid
// mà không có promo_until chờ) — trước đây luôn trả revoked:true.
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
  const account = await env.DB.prepare(
    'SELECT plan_status, promo_until FROM app_accounts WHERE revenuecat_app_user_id = ?'
  ).bind(accountId).first();
  if (!account) {
    return err('account_not_found', 'Tài khoản chưa từng xuất hiện — kiểm tra lại ID.', 404);
  }
  const revoked = account.plan_status === 'pro_promo' || account.promo_until !== null;
  const result = await revokePromotional(env, accountId, entitlement);
  if (!result.notConfigured && !result.ok) {
    return err('revenuecat_error', 'Không thu hồi được quyền lợi từ RevenueCat.', 502);
  }
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO admin_audit (actor, action, target, detail) VALUES (?, ?, ?, ?)'
    ).bind(actor, 'entitlement_revoke', accountId, JSON.stringify({
      entitlement, reason, revoked, previous_plan: account.plan_status,
    })),
    env.DB.prepare(
      `UPDATE app_accounts SET promo_until = NULL,
         plan_status = CASE WHEN plan_status = 'pro_promo' THEN 'free' ELSE plan_status END,
         updated_at = ?
        WHERE revenuecat_app_user_id = ?`
    ).bind(now, accountId),
  ]);
  return json({ ok: true, account_id: accountId, entitlement, revoked, previous_plan: account.plan_status });
}
