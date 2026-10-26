// API "mây của tôi" — sao lưu mã hoá zero-knowledge qua Worker.
//
// Xác thực tài khoản (TOFU — trust on first use):
// - App tự tạo account_id (UUID ngẫu nhiên) + token (32 byte hex), lưu ở
//   app_kv trên máy người dùng, gửi kèm mọi request (X-Account-Id +
//   Authorization: Bearer <token>).
// - Lần đầu gặp account_id, server bind hash SHA-256 của token vào bảng
//   backup_accounts; các lần sau phải khớp hash mới được phục vụ.
// - Entitlement phía máy chủ (chốt 27/10/2026): tier_mb KHÔNG còn do client
//   khai báo — upload chỉ dùng tier_mb đã lưu cho tài khoản (mặc định gói
//   nhỏ nhất khi tạo tài khoản, đổi gói chỉ qua quản trị viên bằng route
//   PATCH /api/admin/backups/accounts/:id). Route POST /api/backups/tier
//   (client tự đổi gói) đã gỡ cùng ngày; app v101 đổi gói qua popup liên
//   hệ quản trị viên thay vì gọi route đó.
//
// Chính sách đã chốt (24/10/2026, số bản giữ lại thành cờ từ xa 25/10/2026):
// - Giữ N bản mới nhất cho mỗi tài khoản (xoay vòng phía máy chủ sau mỗi
//   lần upload thành công), N = cờ cloud_keep_backups (mặc định 2).
// - Hạn mức theo gói: 100 / 200 / 500 / 1000 MB. Upload bị từ chối 413 khi
//   dung lượng sau khi xoay (bản mới + bản mới nhất còn lại) vượt gói.
// - File .ssbak đã mã hoá phía client — Worker không bao giờ thấy dữ liệu
//   thật, chỉ thấy bytes mã hoá.

import { json, err, readJson, nowIso } from '../lib/http.js';
import { timingSafeEqual } from '../lib/auth.js';
import { getStorageAdapter } from '../lib/storage.js';
import { verifyGoogleIdToken, googleAnchor } from '../lib/googleAuth.js';

export const STORAGE_TIERS_MB = [100, 200, 500, 1000];
export const MAX_VERSIONS = 2;
const MB = 1000 * 1000;

// Bảng gói lưu trữ mặc định (chốt 25/10/2026 — khớp cờ storage_plans trong
// routes/config.js). Bảng thật đọc từ KV CONFIG mỗi request; hỏng KV thì
// dùng bảng này để không chặn sao lưu.
export const DEFAULT_STORAGE_PLANS = [
  { size_mb: 100, price_vnd: 299000 },
  { size_mb: 200, price_vnd: 349000 },
  { size_mb: 500, price_vnd: 449000 },
  { size_mb: 1000, price_vnd: 599000 },
];

/** Bảng gói lưu trữ hiện hành (từ cờ storage_plans, đã xếp tăng dần). */
export async function getStoragePlans(env) {
  try {
    const stored = await env.CONFIG?.get('flags', { type: 'json' });
    const plans = stored?.storage_plans;
    if (Array.isArray(plans) && plans.length > 0 &&
        plans.every((p) => p && Number.isInteger(p.size_mb) && p.size_mb >= 1 &&
          Number.isInteger(p.price_vnd) && p.price_vnd >= 0)) {
      const sorted = [...plans].sort((a, b) => a.size_mb - b.size_mb);
      if (new Set(sorted.map((p) => p.size_mb)).size === sorted.length) return sorted;
    }
  } catch {
    // dùng mặc định
  }
  return DEFAULT_STORAGE_PLANS;
}

/** Danh sách dung lượng (MB) được phép, theo bảng gói hiện hành. */
export async function getTierSizes(env) {
  return (await getStoragePlans(env)).map((p) => p.size_mb);
}

function sanitizeFileName(raw) {
  const base = String(raw ?? '').split('/').pop().split('\\').pop().trim();
  if (!base || base === '.' || base === '..') return null;
  return base.slice(0, 200);
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Xác thực TOFU, trả { account_id, tier_mb } hoặc null (kèm response lỗi).
async function authenticate(env, request) {
  const accountId = (request.headers.get('X-Account-Id') || '').trim();
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!accountId || accountId.length > 128 || accountId.includes('/') || !token) {
    return { error: err('unauthorized', 'Thiếu X-Account-Id hoặc Bearer token.', 401) };
  }
  const row = await env.DB.prepare(
    'SELECT account_id, token_hash, tier_mb FROM backup_accounts WHERE account_id = ?'
  ).bind(accountId).first();
  if (!row) {
    // Tài khoản mới: gói mặc định = gói nhỏ nhất trong bảng hiện hành.
    const defaultTier = (await getStoragePlans(env))[0].size_mb;
    const tokenHash = await sha256Hex(token);
    await env.DB.prepare(
      'INSERT INTO backup_accounts (account_id, token_hash, tier_mb) VALUES (?, ?, ?)'
    ).bind(accountId, tokenHash, defaultTier).run();
    return { account_id: accountId, tier_mb: defaultTier };
  }
  const presentedHash = await sha256Hex(token);
  if (!timingSafeEqual(presentedHash, row.token_hash)) {
    return { error: err('unauthorized', 'Sai token tài khoản.', 401) };
  }
  return { account_id: row.account_id, tier_mb: row.tier_mb };
}

async function listFiles(env, accountId) {
  const res = await env.DB.prepare(
    'SELECT file_name, size_bytes, updated_at FROM backup_files WHERE account_id = ? ORDER BY updated_at DESC'
  ).bind(accountId).all();
  return res.results ?? [];
}

// Số bản mây giữ lại: đọc từ cờ cấu hình (KV CONFIG, khoá 'flags').
// Lỗi/mất KV thì giữ mặc định cũ MAX_VERSIONS — xoay vòng không bao giờ
// vì lỗi đọc cờ mà xoá sạch hay giữ vô hạn.
async function getCloudKeepBackups(env) {
  try {
    const stored = await env.CONFIG?.get('flags', { type: 'json' });
    const n = stored?.cloud_keep_backups;
    if (Number.isInteger(n) && n >= 1 && n <= 10) return n;
  } catch {
    // dùng mặc định
  }
  return MAX_VERSIONS;
}

// Xoay vòng: chỉ giữ số bản theo cờ cloud_keep_backups (theo updated_at).
async function rotate(env, adapter, accountId) {
  const files = await listFiles(env, accountId);
  const keep = await getCloudKeepBackups(env);
  const extras = files.slice(keep);
  for (const f of extras) {
    await adapter.remove(accountId, f.file_name);
    await env.DB.prepare(
      'DELETE FROM backup_files WHERE account_id = ? AND file_name = ?'
    ).bind(accountId, f.file_name).run();
  }
}

// GET /api/backups/usage — quản trị viên (giữ nguyên hành vi cũ).
export async function usage(env) {
  const adapter = getStorageAdapter(env);
  const stats = await env.DB.prepare(
    'SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM backup_files'
  ).first();
  const adapterUsage = await adapter.usage();
  return json({
    ok: true,
    storage: adapterUsage.configured ? 'r2' : 'not_configured',
    files: stats?.files ?? 0,
    bytes: stats?.bytes ?? 0,
  });
}

// POST /api/backups/upload — app (xác thực tài khoản).
// Headers: X-Account-Id, Authorization: Bearer <token>,
//          X-File-Name, X-Tier-Mb (một dung lượng trong bảng gói, tuỳ chọn).
// Body: bytes file .ssbak đã mã hoá.
export async function upload(request, env) {
  const auth = await authenticate(env, request);
  if (auth.error) return auth.error;
  const adapter = getStorageAdapter(env);
  const adapterUsage = await adapter.usage();
  if (!adapterUsage.configured) {
    return err('storage_not_configured', 'Kho lưu trữ chưa được cấu hình (chưa bind R2).', 503);
  }

  const fileName = sanitizeFileName(request.headers.get('X-File-Name'));
  if (!fileName) return err('invalid_name', 'Thiếu hoặc sai tên file (X-File-Name).', 400);

  // 27/10/2026: hạn mức LUÔN lấy theo tier_mb đã lưu cho tài khoản — header
  // X-Tier-Mb do client gửi (nếu có) bị bỏ qua, không còn tự nâng gói.
  const tierMb = auth.tier_mb;

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return err('empty_file', 'File sao lưu rỗng.', 400);

  // Hạn mức: dung lượng sau khi xoay = bản mới + bản mới nhất còn lại.
  const existing = await listFiles(env, auth.account_id);
  const projected = bytes.byteLength + (existing[0]?.size_bytes ?? 0);
  if (projected > tierMb * MB) {
    return err(
      'quota_exceeded',
      `Vượt hạn mức gói ${tierMb}MB (cần ${projected} byte sau khi xoay).`,
      413
    );
  }

  const putRes = await adapter.put(auth.account_id, fileName, bytes);
  if (!putRes.ok) return err(putRes.error, putRes.message ?? 'Lưu trữ thất bại.', 503);

  await env.DB.prepare(
    `INSERT INTO backup_files (account_id, file_name, size_bytes, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, file_name) DO UPDATE SET
       size_bytes = excluded.size_bytes, updated_at = excluded.updated_at`
  ).bind(auth.account_id, fileName, bytes.byteLength, nowIso()).run();

  await rotate(env, adapter, auth.account_id);
  const kept = await listFiles(env, auth.account_id);
  return json({
    ok: true,
    name: fileName,
    size: bytes.byteLength,
    tier_mb: tierMb,
    files: kept.map((f) => ({ name: f.file_name, size: f.size_bytes, updatedAt: f.updated_at })),
  });
}

// GET /api/backups/download?name=... — app (xác thực tài khoản + sở hữu).
export async function download(request, env) {
  const auth = await authenticate(env, request);
  if (auth.error) return auth.error;
  const adapter = getStorageAdapter(env);
  const adapterUsage = await adapter.usage();
  if (!adapterUsage.configured) {
    return err('storage_not_configured', 'Kho lưu trữ chưa được cấu hình (chưa bind R2).', 503);
  }
  const url = new URL(request.url);
  const fileName = sanitizeFileName(url.searchParams.get('name'));
  if (!fileName) return err('invalid_name', 'Thiếu tham số name.', 400);
  const owned = await env.DB.prepare(
    'SELECT 1 FROM backup_files WHERE account_id = ? AND file_name = ?'
  ).bind(auth.account_id, fileName).first();
  if (!owned) return err('not_found', 'Không tìm thấy file sao lưu của tài khoản này.', 404);
  const res = await adapter.get(auth.account_id, fileName);
  if (!res.ok) return err(res.error, res.message ?? 'Tải xuống thất bại.', res.error === 'not_found' ? 404 : 503);
  return new Response(res.bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fileName.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store',
    },
  });
}

// GET /api/backups/list — app (xác thực tài khoản).
export async function list(request, env) {
  const auth = await authenticate(env, request);
  if (auth.error) return auth.error;
  const files = await listFiles(env, auth.account_id);
  return json({
    ok: true,
    tier_mb: auth.tier_mb,
    files: files.map((f) => ({ name: f.file_name, size: f.size_bytes, updatedAt: f.updated_at })),
  });
}

// GET /api/backups/usage-account — app (xác thực tài khoản).
export async function usageAccount(request, env) {
  const auth = await authenticate(env, request);
  if (auth.error) return auth.error;
  const files = await listFiles(env, auth.account_id);
  const used = files.reduce((sum, f) => sum + (f.size_bytes ?? 0), 0);
  return json({
    ok: true,
    tier_mb: auth.tier_mb,
    quota_bytes: auth.tier_mb * MB,
    used_bytes: used,
    files: files.map((f) => ({ name: f.file_name, size: f.size_bytes, updatedAt: f.updated_at })),
  });
}

// POST /api/backups/link — app nối tài khoản sao lưu với tài khoản app.
// Xác thực kép: (1) TOFU của tài khoản sao lưu (X-Account-Id + Bearer
// token, như mọi route sao lưu) và (2) Google ID token của tài khoản
// Google đang đăng nhập trong app (header X-Google-Id-Token, Worker tự
// kiểm tra với Google). Ghi app_account_id (anchor google:<sub>) vào
// backup_accounts để trang quản trị thấy "khách này dùng bao nhiêu".
// - Gọi lại nhiều lần với cùng tài khoản Google thì không đổi gì (luỹ đẳng).
// - Tài khoản sao lưu đã nối với tài khoản Google KHÁC thì từ chối 409 —
//   không cho chiếm tài khoản sao lưu của người khác, và app phải bỏ qua
//   lỗi này trong im lặng (không chặn sao lưu).
// - Đồng thời lưu email vào app_accounts (tạo dòng nếu chưa có, chỉ ghi
//   email — không đụng plan_status) để bảng tài khoản app hiện email
//   ngay cả với khách chưa từng đổi mã.
// App gọi fire-and-forget sau mỗi lần sao lưu thành công; lỗi nối không
// được làm hỏng sao lưu.
export async function linkAccount(request, env) {
  const auth = await authenticate(env, request);
  if (auth.error) return auth.error;
  const idToken = (request.headers.get('X-Google-Id-Token') || '').trim();
  const verified = await verifyGoogleIdToken(idToken);
  if (!verified.ok) {
    return err('invalid_token', 'Phiên đăng nhập Google không hợp lệ — hãy đăng nhập lại.', 401);
  }
  const anchor = googleAnchor(verified.sub);
  const row = await env.DB.prepare(
    'SELECT app_account_id FROM backup_accounts WHERE account_id = ?'
  ).bind(auth.account_id).first();
  if (!row) return err('not_found', 'Không tìm thấy tài khoản sao lưu.', 404);
  if (row.app_account_id && row.app_account_id !== anchor) {
    return err('already_linked', 'Tài khoản sao lưu này đã nối với tài khoản Google khác.', 409);
  }
  const now = nowIso();
  await env.DB.prepare(
    'UPDATE backup_accounts SET app_account_id = ?, updated_at = ? WHERE account_id = ?'
  ).bind(anchor, now, auth.account_id).run();
  if (verified.email) {
    await env.DB.prepare(
      `INSERT INTO app_accounts (revenuecat_app_user_id, email, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(revenuecat_app_user_id) DO UPDATE SET
         email = COALESCE(excluded.email, app_accounts.email),
         updated_at = excluded.updated_at`
    ).bind(anchor, verified.email, now).run();
  }
  return json({ ok: true, account_id: auth.account_id, app_account_id: anchor });
}

// Route POST /api/backups/tier đã gỡ ngày 27/10/2026 (client tự đổi gói
// = tự nâng hạn mức — không chấp nhận được khi mở cho người dùng thật).
// Đổi gói lưu trữ chỉ qua quản trị viên: PATCH /api/admin/backups/accounts/:id.
