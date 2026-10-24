// Nhóm route mã khuyến mãi.
//
// Quy tắc nghiệp vụ (đã chốt, không được đổi thứ tự):
//   Đổi mã kiểm tra theo thứ tự:
//     (a) tài khoản đang có gói trả tiền còn hiệu lực → TỪ CHỐI, mã KHÔNG bị tiêu.
//     (b) mã tồn tại + đang bật + còn hạn + còn lượt.
//     (c) tài khoản chưa từng dùng mã thuộc cùng đợt (campaign).
//   Số lượt đã dùng của mã chỉ tính từ các dòng redemptions có result='granted',
//   nên mọi lần từ chối đều không làm mã mất lượt.

import { json, err, readJson, normalizeCode, nowIso } from '../lib/http.js';
import { redeemRateLimitOk } from '../lib/auth.js';
import { grantPromotional } from '../lib/revenuecat.js';

async function insertRedemption(env, code, accountId, result, reason, idempotencyKey) {
  await env.DB.prepare(
    'INSERT INTO redemptions (code, account_id, result, reason, idempotency_key) ' +
    'VALUES (?, ?, ?, ?, ?)'
  ).bind(code, accountId, result, reason, idempotencyKey ?? null).run();
}

async function audit(env, actor, action, target, detail) {
  await env.DB.prepare(
    'INSERT INTO admin_audit (actor, action, target, detail) VALUES (?, ?, ?, ?)'
  ).bind(actor, action, target, detail ? JSON.stringify(detail) : null).run();
}

// GET /api/promo — liệt kê mã kèm số lượt đã đổi (chỉ tính lượt granted).
export async function listPromos(env) {
  const { results } = await env.DB.prepare(
    `SELECT p.*,
       (SELECT COUNT(*) FROM redemptions r WHERE r.code = p.code AND r.result = 'granted') AS used
     FROM promo_codes p ORDER BY p.created_at DESC`
  ).all();
  return json({ ok: true, promos: results });
}

// POST /api/promo — tạo mã mới (quản trị).
export async function createPromo(request, env) {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const code = normalizeCode(body.code);
  const days = Number(body.days);
  const maxUses = body.max_uses === undefined ? 1 : Number(body.max_uses);
  if (!code || !Number.isInteger(days) || days <= 0) {
    return err('invalid_fields', 'Cần có code (chuỗi) và days (số nguyên > 0).', 400);
  }
  if (!Number.isInteger(maxUses) || maxUses < 0) {
    return err('invalid_fields', 'max_uses phải là số nguyên >= 0.', 400);
  }
  const entitlement = String(body.entitlement || 'pro').trim() || 'pro';
  const campaign = body.campaign ? String(body.campaign).trim() : null;
  try {
    await env.DB.prepare(
      `INSERT INTO promo_codes
         (code, entitlement, days, starts_at, expires_at, max_uses, campaign, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).bind(
      code, entitlement, days,
      body.starts_at || null, body.expires_at || null, maxUses, campaign
    ).run();
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      return err('code_exists', `Mã ${code} đã tồn tại.`, 409);
    }
    throw e;
  }
  await audit(env, 'admin', 'promo_create', code, { entitlement, days, max_uses: maxUses, campaign });
  return json({ ok: true, code }, 201);
}

// PATCH /api/promo/:code — bật/tắt mã (quản trị).
export async function togglePromo(request, env, codeRaw) {
  const body = await readJson(request);
  if (body.__invalid || typeof body.enabled !== 'boolean') {
    return err('invalid_fields', 'Body cần có enabled (true/false).', 400);
  }
  const code = normalizeCode(codeRaw);
  const res = await env.DB.prepare(
    'UPDATE promo_codes SET enabled = ?, updated_at = ? WHERE code = ?'
  ).bind(body.enabled ? 1 : 0, nowIso(), code).run();
  if (res.meta.changes === 0) return err('not_found', `Không tìm thấy mã ${code}.`, 404);
  await audit(env, 'admin', 'promo_toggle', code, { enabled: body.enabled });
  return json({ ok: true, code, enabled: body.enabled });
}

// GET /api/promo/redemptions — nhật ký đổi mã gần nhất (quản trị).
export async function listRedemptions(env, url) {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100) || 100));
  const { results } = await env.DB.prepare(
    'SELECT * FROM redemptions ORDER BY redeemed_at DESC LIMIT ?'
  ).bind(limit).all();
  return json({ ok: true, redemptions: results });
}

// GET /api/promo/:code/redemptions — nhật ký đổi của một mã (quản trị).
export async function listRedemptionsForCode(env, codeRaw) {
  const code = normalizeCode(codeRaw);
  const { results } = await env.DB.prepare(
    'SELECT * FROM redemptions WHERE code = ? ORDER BY redeemed_at DESC LIMIT 200'
  ).bind(code).all();
  return json({ ok: true, code, redemptions: results });
}

// POST /api/promo/redeem — LUỒNG CỐT LÕI, gọi từ app (KHÔNG cần ADMIN_TOKEN).
// Body: { code, account_id, idempotency_key? }.
// Header X-Idempotency-Key (nếu có) được ưu tiên hơn body.
export async function redeem(request, env) {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const code = normalizeCode(body.code);
  const accountId = String(body.account_id ?? '').trim();
  if (!code || !accountId) {
    return err('missing_fields', 'Cần có code và account_id.', 400);
  }
  const idempotencyKey =
    request.headers.get('X-Idempotency-Key') || body.idempotency_key || null;

  // Chống xử lý trùng: cùng key + cùng tài khoản thì trả lại kết quả cũ.
  if (idempotencyKey) {
    const prev = await env.DB.prepare(
      'SELECT * FROM redemptions WHERE idempotency_key = ? AND account_id = ?'
    ).bind(idempotencyKey, accountId).first();
    if (prev) {
      return json({
        ok: prev.result === 'granted',
        result: prev.result,
        reason: prev.reason,
        duplicate: true,
      });
    }
  }

  // Giới hạn tốc độ: 10 lần / 60 giây / tài khoản.
  if (!(await redeemRateLimitOk(env, accountId))) {
    return err('rate_limited', 'Bạn nhập mã quá nhanh. Vui lòng thử lại sau ít phút.', 429);
  }

  const now = nowIso();

  // (a) Tài khoản đang có gói trả tiền còn hiệu lực → TỪ CHỐI, mã KHÔNG bị tiêu.
  const account = await env.DB.prepare(
    'SELECT * FROM app_accounts WHERE revenuecat_app_user_id = ?'
  ).bind(accountId).first();
  if (account && account.plan_status === 'pro_paid' &&
      (!account.paid_until || account.paid_until > now)) {
    await insertRedemption(env, code, accountId, 'rejected', 'paid_active', idempotencyKey);
    return err(
      'paid_active',
      'Tài khoản đang có gói trả tiền còn hiệu lực. Mã quà tặng chỉ áp dụng cho ' +
      'tài khoản Free hoặc sau khi gói trả tiền hiện tại đã hết hạn. Mã chưa bị tiêu.',
      409
    );
  }

  // (b) Mã tồn tại + đang bật + còn hạn + còn lượt.
  const promo = await env.DB.prepare(
    'SELECT * FROM promo_codes WHERE code = ?'
  ).bind(code).first();
  if (!promo) {
    await insertRedemption(env, code, accountId, 'rejected', 'not_found', idempotencyKey);
    return err('not_found', 'Mã khuyến mãi không tồn tại.', 404);
  }
  if (!promo.enabled) {
    await insertRedemption(env, code, accountId, 'rejected', 'disabled', idempotencyKey);
    return err('disabled', 'Mã khuyến mãi này đã bị tắt.', 409);
  }
  if (promo.starts_at && promo.starts_at > now) {
    await insertRedemption(env, code, accountId, 'rejected', 'not_started', idempotencyKey);
    return err('not_started', 'Mã khuyến mãi chưa tới thời gian áp dụng.', 409);
  }
  if (promo.expires_at && promo.expires_at <= now) {
    await insertRedemption(env, code, accountId, 'rejected', 'expired', idempotencyKey);
    return err('expired', 'Mã khuyến mãi đã hết hạn.', 409);
  }
  const usedRow = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM redemptions WHERE code = ? AND result = 'granted'"
  ).bind(code).first();
  if ((usedRow?.c ?? 0) >= promo.max_uses) {
    await insertRedemption(env, code, accountId, 'rejected', 'uses_exhausted', idempotencyKey);
    return err('uses_exhausted', 'Mã khuyến mãi đã hết lượt sử dụng.', 409);
  }

  // (c) Tài khoản chưa từng dùng mã thuộc cùng đợt (campaign; mã không có campaign
  // thì mỗi mã là một đợt riêng).
  const prior = await env.DB.prepare(
    `SELECT r.id FROM redemptions r
       JOIN promo_codes p ON p.code = r.code
      WHERE r.account_id = ? AND r.result = 'granted'
        AND (p.campaign = ? OR (p.campaign IS NULL AND p.code = ?))
      LIMIT 1`
  ).bind(accountId, promo.campaign, promo.code).first();
  if (prior) {
    await insertRedemption(env, code, accountId, 'rejected', 'campaign_used', idempotencyKey);
    return err('campaign_used', 'Tài khoản này đã dùng một mã thuộc đợt này rồi.', 409);
  }

  // Cấp quyền lợi qua RevenueCat. Nếu chưa cấu hình secret thì BÁO RÕ và
  // KHÔNG ghi lượt đổi thành công, KHÔNG giả vờ thành công.
  const grant = await grantPromotional(env, accountId, promo.entitlement, promo.days);
  if (grant.notConfigured) {
    return err(
      'not_configured',
      'Máy chủ chưa cấu hình REVENUECAT_SECRET_KEY nên chưa thể cấp quyền lợi. ' +
      'Mã chưa bị tiêu, vui lòng thử lại sau khi quản trị viên cấu hình xong.',
      503
    );
  }
  if (!grant.ok) {
    await insertRedemption(env, code, accountId, 'error', 'revenuecat_error', idempotencyKey);
    return err('revenuecat_error', 'Không cấp được quyền lợi từ RevenueCat. Vui lòng thử lại sau.', 502);
  }

  // Ghi lượt đổi + audit + cập nhật trạng thái tài khoản trong cùng một lần xử lý.
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO redemptions (code, account_id, result, reason, idempotency_key) ' +
      'VALUES (?, ?, ?, ?, ?)'
    ).bind(code, accountId, 'granted', null, idempotencyKey),
    env.DB.prepare(
      'INSERT INTO admin_audit (actor, action, target, detail) VALUES (?, ?, ?, ?)'
    ).bind('system', 'promo_grant', code, JSON.stringify({
      account_id: accountId, entitlement: promo.entitlement, days: promo.days,
    })),
    env.DB.prepare(
      `INSERT INTO app_accounts
         (revenuecat_app_user_id, plan_status, promo_until, updated_at)
       VALUES (?, 'pro_promo', ?, ?)
       ON CONFLICT(revenuecat_app_user_id) DO UPDATE SET
         plan_status = 'pro_promo', promo_until = excluded.promo_until,
         updated_at = excluded.updated_at`
    ).bind(accountId, grant.expiresAt, now),
  ]);

  return json({
    ok: true,
    result: 'granted',
    entitlement: promo.entitlement,
    days: promo.days,
    expires_at: grant.expiresAt,
  });
}
