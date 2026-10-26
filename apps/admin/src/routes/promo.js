// Nhóm route mã khuyến mãi.
//
// Đổi mã BẮT BUỘC tài khoản Google đã xác thực phía máy chủ (từ v78):
// app gửi kèm Google ID token, Worker tự kiểm tra token với Google rồi
// mới lấy định danh thật (sub) làm anchor `google:<sub>`. Mọi kiểm tra
// dưới đây đều chạy trên anchor này — KHÔNG BAO GIỜ tin account_id do
// client gửi (chuỗi thô, ai cũng tự ghi được).
//
// Quy tắc nghiệp vụ (đã chốt, không được đổi thứ tự):
//   Đổi mã kiểm tra theo thứ tự:
//     (a) tài khoản đang có gói trả tiền còn hiệu lực → TỪ CHỐI, mã KHÔNG bị tiêu.
//     (b) mã tồn tại + đang bật + còn hạn.
//     (c) tài khoản chưa từng dùng mã thuộc cùng đợt (campaign).
//     (d) còn lượt — chiếm lượt NGUYÊN TỬ (UPDATE ... WHERE used_count <
//         max_uses); chiếm không được → TỪ CHỐI, mã KHÔNG bị tiêu.
//     (e) cấp quyền (RevenueCat nếu đã cấu hình secret, ngược lại cấp nội
//         bộ vào app_accounts). Cấp thất bại → HOÀN lượt đã chiếm.
//   Số lượt đã dùng của mã chỉ tính từ các dòng redemptions có result='granted',
//   nên mọi lần từ chối đều không làm mã mất lượt. used_count là bộ đếm
//   phục vụ chiếm lượt nguyên tử; nguồn sự thật về lượt đã cấp vẫn là
//   redemptions (xem migration 20261026-promo-used-count.sql).

import { json, err, readJson, normalizeCode, nowIso } from '../lib/http.js';
import { redeemRateLimitOk } from '../lib/auth.js';
import { grantPromotional } from '../lib/revenuecat.js';
import {
  extractIdToken,
  googleAnchor,
  verifyGoogleIdToken,
} from '../lib/googleAuth.js';

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
       (SELECT COUNT(*) FROM redemptions r WHERE r.code = p.code AND r.result = 'granted' AND r.revoked_at IS NULL) AS used
     FROM promo_codes p ORDER BY p.created_at DESC`
  ).all();
  return json({ ok: true, promos: results });
}

// POST /api/promo — tạo mã mới (quản trị).
export async function createPromo(request, env, actor = 'admin') {
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
  await audit(env, actor, 'promo_create', code, { entitlement, days, max_uses: maxUses, campaign });
  return json({ ok: true, code }, 201);
}

// PATCH /api/promo/:code — sửa mã (quản trị, staff trở lên).
// Trước đây chỉ bật/tắt; từ nay sửa được thêm: days, max_uses,
// starts_at, expires_at, campaign. Gọi chỉ với { enabled, reason }
// vẫn hoạt động như cũ (đường bật/tắt của PWA không đổi).
// Theo SRS: mọi lần sửa đều yêu cầu lý do ngắn bắt buộc, ghi kiểm toán.
// max_uses mới không được nhỏ hơn số lượt đã cấp thật (đếm từ
// redemptions granted — nguồn sự thật, không phải used_count).
// Sửa days/chỉ ảnh hưởng lượt đổi sau đó, không đổi hạn của quyền
// đã cấp cho khách trước đó.
export async function updatePromo(request, env, codeRaw, actor = 'admin') {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const reason = String(body.reason ?? '').trim();
  if (!reason) {
    return err('invalid_fields', 'Sửa mã cần có lý do ngắn.', 400);
  }
  const code = normalizeCode(codeRaw);
  const sets = [];
  const params = [];
  const changes = {};
  if (typeof body.enabled === 'boolean') {
    sets.push('enabled = ?'); params.push(body.enabled ? 1 : 0); changes.enabled = body.enabled;
  }
  if (body.days !== undefined) {
    const days = Number(body.days);
    if (!Number.isInteger(days) || days <= 0) {
      return err('invalid_fields', 'days phải là số nguyên > 0.', 400);
    }
    sets.push('days = ?'); params.push(days); changes.days = days;
  }
  if (body.max_uses !== undefined) {
    const maxUses = Number(body.max_uses);
    if (!Number.isInteger(maxUses) || maxUses < 0) {
      return err('invalid_fields', 'max_uses phải là số nguyên >= 0.', 400);
    }
    const granted = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM redemptions WHERE code = ? AND result = 'granted' AND revoked_at IS NULL"
    ).bind(code).first();
    if (maxUses < (granted ? granted.n : 0)) {
      return err('invalid_fields', 'max_uses không được nhỏ hơn số lượt đã đổi.', 400);
    }
    sets.push('max_uses = ?'); params.push(maxUses); changes.max_uses = maxUses;
  }
  if (body.starts_at !== undefined) {
    sets.push('starts_at = ?'); params.push(body.starts_at || null); changes.starts_at = body.starts_at || null;
  }
  if (body.expires_at !== undefined) {
    sets.push('expires_at = ?'); params.push(body.expires_at || null); changes.expires_at = body.expires_at || null;
  }
  if (body.campaign !== undefined) {
    const campaign = body.campaign ? String(body.campaign).trim() : null;
    sets.push('campaign = ?'); params.push(campaign); changes.campaign = campaign;
  }
  if (!sets.length) {
    return err('invalid_fields', 'Không có trường nào để sửa.', 400);
  }
  sets.push('updated_at = ?'); params.push(nowIso()); params.push(code);
  const res = await env.DB.prepare(
    'UPDATE promo_codes SET ' + sets.join(', ') + ' WHERE code = ?'
  ).bind(...params).run();
  if (res.meta.changes === 0) return err('not_found', `Không tìm thấy mã ${code}.`, 404);
  // Chỉ bật/tắt thì giữ action cũ để bộ lọc kiểm toán không đổi nghĩa.
  const onlyToggle = Object.keys(changes).length === 1 && 'enabled' in changes;
  await audit(env, actor, onlyToggle ? 'promo_toggle' : 'promo_update', code, { ...changes, reason });
  return json({ ok: true, code, ...changes });
}

// DELETE /api/promo/:code — xoá hẳn mã (chỉ admin).
// Lịch sử đổi mã trong bảng redemptions được GIỮ (không có khoá ngoại
// sang promo_codes) nên xoá mã không làm mất nhật ký đổi mã cũ;
// mã đã xoá thì app không đổi được nữa. Cần lý do, ghi kiểm toán.
export async function deletePromo(request, env, codeRaw, actor = 'admin') {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const reason = String(body.reason ?? '').trim();
  if (!reason) {
    return err('invalid_fields', 'Xoá mã cần có lý do ngắn.', 400);
  }
  const code = normalizeCode(codeRaw);
  const res = await env.DB.prepare(
    'DELETE FROM promo_codes WHERE code = ?'
  ).bind(code).run();
  if (res.meta.changes === 0) return err('not_found', `Không tìm thấy mã ${code}.`, 404);
  await audit(env, actor, 'promo_delete', code, { reason });
  return json({ ok: true, code, deleted: true });
}

// GET /api/promo/redemptions — nhật ký đổi mã gần nhất (quản trị).
export async function listRedemptions(env, url) {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100) || 100));
  const offsetRaw = Number(url.searchParams.get('offset') || 0);
  const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
  // Tra cứu theo SRS: theo mã, theo tài khoản, theo kết quả.
  const code = normalizeCode(url.searchParams.get('code') || '');
  const account = (url.searchParams.get('account') || '').trim();
  const result = (url.searchParams.get('result') || '').trim();
  const where = [];
  const params = [];
  if (code) { where.push('code = ?'); params.push(code); }
  if (account) { where.push('account_id LIKE ?'); params.push('%' + account + '%'); }
  if (result && ['granted', 'rejected', 'error'].includes(result)) {
    where.push('result = ?'); params.push(result);
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const totalRow = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM redemptions' + whereSql
  ).bind(...params).first();
  const sql = 'SELECT * FROM redemptions' + whereSql +
    ' ORDER BY redeemed_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return json({ ok: true, redemptions: results, total: totalRow?.n || 0, offset, limit });
}

// POST /api/admin/redemptions/:id/revoke — thu hồi một lượt đổi đã cấp
// (chỉ admin, lý do bắt buộc). Khác nút thu hồi theo tài khoản ở
// /api/entitlements/revoke (cắt Pro bất kể nguồn): nút này huỷ đúng
// lượt đổi đó, và chỉ cắt Pro khi quyền hiện tại đúng là từ lượt này.
// Một lần thu hồi làm 3 việc:
//   (a) Dòng lượt đổi được đánh dấu đã thu hồi (revoked_at/by/reason) —
//       lịch sử KHÔNG bị xoá, dòng thu hồi rồi thì bấm lại sẽ báo 409.
//   (b) Lượt dùng của mã được trả lại 1 (không trừ xuống âm; mã đã bị
//       xoá hẳn thì bỏ qua) và cửa chặn "đã dùng mã cùng đợt" bỏ qua
//       dòng đã thu hồi, nên tài khoản được đổi lại mã cùng đợt.
//   (c) Cắt Pro tặng về free CHỈ KHI: tài khoản đang pro_promo còn hạn,
//       lượt này là lượt cấp chưa thu hồi mới nhất của tài khoản, và hạn
//       tặng khớp ngày đổi + số ngày của mã (sai số 120 giây, vì
//       redeemed_at lấy giờ DB theo giây còn promo_until tính theo mili
//       giây). Tài khoản trả phí thật không bao giờ bị đụng; tài khoản đã
//       đổi mã khác sau đó thì giữ nguyên Pro hiện tại.
export async function revokeRedemption(request, env, actor, idRaw) {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const reason = String(body.reason ?? '').trim();
  if (!reason) return err('invalid_fields', 'Thu hồi lượt đổi cần có lý do.', 400);
  const id = Number(idRaw);
  if (!Number.isInteger(id)) return err('invalid_fields', 'ID lượt đổi không hợp lệ.', 400);
  const row = await env.DB.prepare('SELECT * FROM redemptions WHERE id = ?').bind(id).first();
  if (!row) return err('not_found', 'Không tìm thấy lượt đổi.', 404);
  if (row.result !== 'granted') {
    return err('invalid_state', 'Chỉ thu hồi được lượt đổi đã cấp thành công.', 400);
  }
  if (row.revoked_at) return err('already_revoked', 'Lượt đổi này đã bị thu hồi rồi.', 409);
  const now = nowIso();
  const account = await env.DB.prepare(
    'SELECT * FROM app_accounts WHERE revenuecat_app_user_id = ?'
  ).bind(row.account_id).first();
  const codeRow = await env.DB.prepare(
    'SELECT days FROM promo_codes WHERE code = ?'
  ).bind(row.code).first();
  let cut = false;
  if (account && account.plan_status === 'pro_promo' && account.promo_until && account.promo_until > now) {
    const latest = await env.DB.prepare(
      `SELECT id FROM redemptions
        WHERE account_id = ? AND result = 'granted' AND revoked_at IS NULL
        ORDER BY redeemed_at DESC, id DESC LIMIT 1`
    ).bind(row.account_id).first();
    if (latest && latest.id === row.id) {
      if (!codeRow) {
        cut = true;
      } else {
        const redeemedMs = Date.parse(String(row.redeemed_at).replace(' ', 'T') + 'Z');
        const expectedMs = redeemedMs + codeRow.days * 86400000;
        if (!Number.isNaN(redeemedMs) && Math.abs(Date.parse(account.promo_until) - expectedMs) < 120000) {
          cut = true;
        }
      }
    }
  }
  // Đánh dấu trước, kiểm tra changes để hai lần thu hồi cùng lúc không
  // trừ lượt dùng 2 lần.
  const mark = await env.DB.prepare(
    'UPDATE redemptions SET revoked_at = ?, revoked_by = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL'
  ).bind(now, actor, reason, id).run();
  if ((mark.meta?.changes ?? 0) === 0) {
    return err('already_revoked', 'Lượt đổi này đã bị thu hồi rồi.', 409);
  }
  const batch = [];
  if (codeRow) {
    batch.push(env.DB.prepare(
      'UPDATE promo_codes SET used_count = CASE WHEN used_count > 0 THEN used_count - 1 ELSE 0 END WHERE code = ?'
    ).bind(row.code));
  }
  if (cut) {
    batch.push(env.DB.prepare(
      `UPDATE app_accounts SET plan_status = 'free', promo_until = NULL, updated_at = ?
        WHERE revenuecat_app_user_id = ? AND plan_status = 'pro_promo'`
    ).bind(now, row.account_id));
  }
  batch.push(env.DB.prepare(
    'INSERT INTO admin_audit (actor, action, target, detail) VALUES (?, ?, ?, ?)'
  ).bind(actor, 'redemption_revoke', row.code, JSON.stringify({
    account_id: row.account_id, redemption_id: row.id, reason, entitlement_cut: cut,
  })));
  await env.DB.batch(batch);
  return json({
    ok: true, id: row.id, code: row.code, account_id: row.account_id, entitlement_cut: cut,
  });
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
// BẮT BUỘC tài khoản Google: app gửi Google ID token qua header
// Authorization Bearer hoặc body.id_token. Worker tự xác thực token với
// Google (xem lib/googleAuth.js); mọi kiểm tra dưới đây chạy trên anchor
// `google:<sub>`, KHÔNG dùng account_id do client gửi (bỏ qua hoàn toàn).
// Header X-Idempotency-Key (nếu có) được ưu tiên hơn body.
export async function redeem(request, env) {
  const body = await readJson(request);
  if (body.__invalid) return err('invalid_body', 'Body phải là JSON object.', 400);
  const code = normalizeCode(body.code);
  if (!code) {
    return err('missing_fields', 'Cần có code.', 400);
  }

  // Xác thực tài khoản TRƯỚC mọi kiểm tra khác — không có token hợp lệ
  // thì không có anchor để tra cứu, ghi nhật ký hay giới hạn tốc độ.
  const idToken = extractIdToken(request, body);
  if (!idToken) {
    return err(
      'account_required',
      'Cần đăng nhập bằng tài khoản Google để đổi mã khuyến mãi.',
      401
    );
  }
  const verified = await verifyGoogleIdToken(idToken);
  if (!verified.ok) {
    return err(
      'invalid_token',
      'Phiên đăng nhập Google không hợp lệ hoặc đã hết hạn — hãy đăng nhập lại.',
      401
    );
  }
  const accountId = googleAnchor(verified.sub);

  const idempotencyKey =
    request.headers.get('X-Idempotency-Key') || body.idempotency_key || null;

  // Tài khoản bị khoá thì không đổi được mã nào, mã KHÔNG bị tiêu
  // (kiểm tra trước cả bước chiếm lượt).
  const blocked = await env.DB.prepare(
    'SELECT 1 AS x FROM blocked_accounts WHERE account_id = ?'
  ).bind(accountId).first();
  if (blocked) {
    await insertRedemption(env, code, accountId, 'rejected', 'account_blocked', idempotencyKey);
    return err('account_blocked', 'Tài khoản này đã bị khoá, không đổi được mã.', 403);
  }

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

  // Giới hạn tốc độ: 10 lần / 60 giây / tài khoản (theo anchor đã xác thực).
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

  // (b) Mã tồn tại + đang bật + còn hạn.
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

  // (c) Tài khoản chưa từng dùng mã thuộc cùng đợt (campaign; mã không có campaign
  // thì mỗi mã là một đợt riêng).
  const prior = await env.DB.prepare(
    `SELECT r.id FROM redemptions r
       JOIN promo_codes p ON p.code = r.code
      WHERE r.account_id = ? AND r.result = 'granted' AND r.revoked_at IS NULL
        AND (p.campaign = ? OR (p.campaign IS NULL AND p.code = ?))
      LIMIT 1`
  ).bind(accountId, promo.campaign, promo.code).first();
  if (prior) {
    await insertRedemption(env, code, accountId, 'rejected', 'campaign_used', idempotencyKey);
    return err('campaign_used', 'Tài khoản này đã dùng một mã thuộc đợt này rồi.', 409);
  }

  // (d) Chiếm lượt NGUYÊN TỬ: chỉ một lệnh UPDATE duy nhất quyết định còn
  // lượt hay không — hai tài khoản đua cùng một mã 1 lượt không thể cùng
  // qua cửa (khác hẳn kiểu đếm COUNT rồi mới ghi, vốn chen ngang được).
  // max_uses = 0 → điều kiện used_count < 0 luôn sai → hết lượt (giữ đúng
  // hành vi cũ: used 0 >= 0 → hết lượt).
  const claim = await env.DB.prepare(
    'UPDATE promo_codes SET used_count = used_count + 1 ' +
    'WHERE code = ? AND used_count < max_uses'
  ).bind(code).run();
  if ((claim.meta?.changes ?? 0) === 0) {
    await insertRedemption(env, code, accountId, 'rejected', 'uses_exhausted', idempotencyKey);
    return err('uses_exhausted', 'Mã khuyến mãi đã hết lượt sử dụng.', 409);
  }
  // Từ đây lượt đã bị chiếm: mọi đường thất bại phía dưới PHẢI hoàn lượt
  // (used_count - 1) để mã không bị tiêu oan.
  const rollbackClaim = () =>
    env.DB.prepare(
      'UPDATE promo_codes SET used_count = used_count - 1 WHERE code = ? AND used_count > 0'
    ).bind(code).run();

  // (e) Cấp quyền lợi. RevenueCat nếu đã cấu hình secret; ngược lại cấp
  // NỘI BỘ vào app_accounts (pro_promo + promo_until) — không còn trả 503
  // not_configured như trước.
  let expiresAt;
  const grant = await grantPromotional(env, accountId, promo.entitlement, promo.days);
  if (grant.notConfigured) {
    expiresAt = new Date(Date.now() + promo.days * 24 * 60 * 60 * 1000).toISOString();
  } else if (!grant.ok) {
    await rollbackClaim();
    await insertRedemption(env, code, accountId, 'error', 'revenuecat_error', idempotencyKey);
    return err('revenuecat_error', 'Không cấp được quyền lợi từ RevenueCat. Vui lòng thử lại sau.', 502);
  } else {
    expiresAt = grant.expiresAt;
  }

  // Ghi lượt đổi + audit + cập nhật trạng thái tài khoản trong cùng một lần xử lý.
  // Batch lỗi sau khi đã cấp quyền (chỉ xảy ra với đường RevenueCat, vì cấp
  // nội bộ không có bước ngoài nào) thì hoàn lượt và báo lỗi — quyền lợi
  // RevenueCat trong trường hợp hiếm này cần quản trị viên thu hồi thủ công.
  try {
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
           (revenuecat_app_user_id, plan_status, promo_until, email, updated_at)
         VALUES (?, 'pro_promo', ?, ?, ?)
         ON CONFLICT(revenuecat_app_user_id) DO UPDATE SET
           plan_status = 'pro_promo', promo_until = excluded.promo_until,
           email = COALESCE(excluded.email, app_accounts.email),
           updated_at = excluded.updated_at`
      ).bind(accountId, expiresAt, verified.email, now),
    ]);
  } catch {
    await rollbackClaim();
    await insertRedemption(env, code, accountId, 'error', 'grant_error', idempotencyKey)
      .catch(() => {});
    return err('grant_error', 'Không ghi được lượt đổi mã. Vui lòng thử lại sau.', 502);
  }

  return json({
    ok: true,
    result: 'granted',
    entitlement: promo.entitlement,
    days: promo.days,
    expires_at: expiresAt,
  });
}

// GET /api/promo/status — trạng thái gói của tài khoản Google đã xác thực.
// BẮT BUỘC Google ID token (header Authorization Bearer). App gọi mỗi lần
// mở Cài đặt khi đã đăng nhập để ép gói theo máy chủ: còn hạn → pro, hết
// hạn hoặc chưa từng có quyền → free. Không token / token không hợp lệ → 401.
export async function getPromoStatus(request, env) {
  const idToken = extractIdToken(request, null);
  if (!idToken) {
    return err(
      'account_required',
      'Cần đăng nhập bằng tài khoản Google để kiểm tra trạng thái gói.',
      401
    );
  }
  const verified = await verifyGoogleIdToken(idToken);
  if (!verified.ok) {
    return err(
      'invalid_token',
      'Phiên đăng nhập Google không hợp lệ hoặc đã hết hạn — hãy đăng nhập lại.',
      401
    );
  }
  const anchor = googleAnchor(verified.sub);
  // Tài khoản bị khoá: app chỉ thấy gói free (không cần bản app mới,
  // app bỏ qua trường blocked thừa).
  const isBlocked = await env.DB.prepare(
    'SELECT 1 AS x FROM blocked_accounts WHERE account_id = ?'
  ).bind(anchor).first();
  if (isBlocked) {
    return json({ ok: true, plan: 'free', until: null, blocked: true });
  }
  const account = await env.DB.prepare(
    'SELECT * FROM app_accounts WHERE revenuecat_app_user_id = ?'
  ).bind(anchor).first();
  const now = nowIso();
  // Lưu email từ token Google (nếu có) để bảng tài khoản app hiện được
  // email thật — trước đây token trả email nhưng Worker bỏ qua nên cột
  // email luôn trống. Chỉ cập nhật khi dòng tài khoản đã tồn tại (kiểm
  // tra gói không tự tạo tài khoản mới).
  if (account && verified.email && account.email !== verified.email) {
    await env.DB.prepare(
      'UPDATE app_accounts SET email = ?, updated_at = ? WHERE revenuecat_app_user_id = ?'
    ).bind(verified.email, now, anchor).run();
    account.email = verified.email;
  }
  if (account) {
    if (account.plan_status === 'pro_paid' &&
        (!account.paid_until || account.paid_until > now)) {
      return json({ ok: true, plan: 'pro', until: account.paid_until || null });
    }
    if (account.plan_status === 'pro_promo' &&
        (!account.promo_until || account.promo_until > now)) {
      return json({ ok: true, plan: 'pro', until: account.promo_until || null });
    }
    if (account.plan_status === 'pro') {
      return json({ ok: true, plan: 'pro', until: null });
    }
  }
  return json({ ok: true, plan: 'free', until: null });
}
