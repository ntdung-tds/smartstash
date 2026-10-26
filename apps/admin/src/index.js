// SmartStash Admin — điểm vào của Cloudflare Worker.
//
// Phân quyền theo route:
//   CÔNG KHAI (không cần đăng nhập):
//     GET  /api/health              — kiểm tra sống (cho uptime check)
//     GET  /api/config              — app đọc cờ cấu hình
//     POST /api/promo/redeem        — app đổi mã (giới hạn tốc độ riêng,
//                                     bắt buộc Google ID token đã xác thực)
//     GET  /api/promo/status        — app kiểm tra gói theo tài khoản Google
//                                     (cũng bắt buộc Google ID token)
//     POST /api/webhooks/revenuecat — xác minh bằng REVENUECAT_WEBHOOK_SECRET
//     GET  /api/auth/status         — PWA biết đã có tài khoản quản trị chưa
//     POST /api/auth/setup          — tạo tài khoản quản trị đầu tiên
//                                     (khoá bằng ADMIN_TOKEN, chỉ khi chưa
//                                     có tài khoản nào)
//     POST /api/auth/login          — đăng nhập, trả session token
//   MÂY CỦA TÔI (xác thực tài khoản TOFU, không cần đăng nhập quản trị):
//     POST /api/backups/upload, GET /api/backups/download,
//     GET  /api/backups/list, GET /api/backups/usage-account,
//     POST /api/backups/tier
//   (Trả 503 storage_not_configured khi Worker chưa bind R2.)
//   QUẢN TRỊ (bắt buộc phiên đăng nhập: Authorization: Bearer <session>):
//     mọi route còn lại dưới /api/*. Quyền tối thiểu từng route:
//       xem (viewer trở lên): GET /api/promo, GET /api/promo/redemptions,
//         GET /api/promo/:code/redemptions, GET /api/backups/usage
//       staff trở lên: POST /api/promo, PATCH /api/promo/:code
//       admin: DELETE /api/promo/:code, POST /api/admin/config/restore,
//         POST /api/admin/accounts/:id/block|unblock, DELETE /api/admin/accounts/:id
//       admin: POST /api/entitlements/grant|revoke, PUT /api/config,
//         mọi route /api/admin/users/*, PATCH /api/admin/backups/accounts/:id,
//         và các route phiên của chính mình
//         (/api/auth/logout, /api/auth/me, /api/auth/change-password).
//       xem (viewer trở lên): GET /api/admin/stats, /api/admin/audit,
//         /api/admin/accounts, /api/admin/accounts/:id, /api/admin/revenue,
//         /api/admin/backups/accounts.
//   ADMIN_TOKEN không còn mở được bất kỳ API quản trị nào sau khi đã có
//   tài khoản; nó chỉ dùng một lần cho /api/auth/setup.
//
// CORS: PWA quản trị chạy trên Pages (origin khác Worker) nên API trả
// Access-Control-Allow-Origin: * và xử lý OPTIONS. Bảo vệ thật sự là
// phiên đăng nhập + phân quyền ở đây; Cloudflare Access đặt trước PWA
// (nếu có) chỉ là lớp cộng thêm; xem README mục "Bảo mật".

import { json, err } from './lib/http.js';
import { getSessionUser, hasRole } from './lib/adminAuth.js';
import * as authRoutes from './routes/auth.js';
import * as userRoutes from './routes/users.js';
import * as adminRoutes from './routes/admin.js';
import * as promoRoutes from './routes/promo.js';
import * as entitlementRoutes from './routes/entitlements.js';
import * as configRoutes from './routes/config.js';
import * as backupRoutes from './routes/backups.js';
import * as webhookRoutes from './routes/webhooks.js';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Idempotency-Key, X-Account-Id, X-File-Name, X-Tier-Mb',
  };
}

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

function segments(pathname) {
  return pathname.split('/').filter(Boolean);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      let response = null;

      // --- Công khai ---
      if (path === '/api/health' && method === 'GET') {
        response = json({ ok: true, service: 'smartstash-admin' });
      } else if (path === '/api/config' && method === 'GET') {
        response = json(await configRoutes.getFlags(env));
      } else if (path === '/api/promo/redeem' && method === 'POST') {
        response = await promoRoutes.redeem(request, env);
      } else if (path === '/api/promo/status' && method === 'GET') {
        response = await promoRoutes.getPromoStatus(request, env);
      } else if (path === '/api/webhooks/revenuecat' && method === 'POST') {
        response = await webhookRoutes.handleRevenueCatWebhook(request, env);
      } else if (path === '/api/auth/status' && method === 'GET') {
        response = await authRoutes.status(env);
      } else if (path === '/api/auth/setup' && method === 'POST') {
        response = await authRoutes.setup(request, env);
      } else if (path === '/api/auth/login' && method === 'POST') {
        response = await authRoutes.login(request, env);
      } else if (path === '/api/backups/upload' && method === 'POST') {
        response = await backupRoutes.upload(request, env);
      } else if (path === '/api/backups/download' && method === 'GET') {
        response = await backupRoutes.download(request, env);
      } else if (path === '/api/backups/list' && method === 'GET') {
        response = await backupRoutes.list(request, env);
      } else if (path === '/api/backups/usage-account' && method === 'GET') {
        response = await backupRoutes.usageAccount(request, env);
      } else if (path === '/api/backups/tier' && method === 'POST') {
        response = await backupRoutes.setTier(request, env);
      } else if (path === '/api/backups/link' && method === 'POST') {
        response = await backupRoutes.linkAccount(request, env);
      } else if (!path.startsWith('/api/')) {
        response = err('not_found', 'Không tìm thấy route.', 404);
      } else {
        // --- Quản trị: cần phiên đăng nhập hợp lệ ---
        const user = await getSessionUser(request, env);
        if (!user) {
          response = err('unauthorized', 'Chưa đăng nhập hoặc phiên đã hết hạn.', 401);
        } else {
          const seg = segments(path);
          const need = (minRole) => {
            if (!hasRole(user, minRole)) {
              return err('forbidden', 'Tài khoản của bạn không có quyền này.', 403);
            }
            return null;
          };
          if (path === '/api/auth/logout' && method === 'POST') {
            response = await authRoutes.logout(request, env);
          } else if (path === '/api/auth/me' && method === 'GET') {
            response = await authRoutes.me(user);
          } else if (path === '/api/auth/change-password' && method === 'POST') {
            response = await authRoutes.changePassword(request, env, user);
          } else if (path === '/api/promo' && method === 'GET') {
            response = await promoRoutes.listPromos(env);
          } else if (path === '/api/promo' && method === 'POST') {
            response = need('staff') || await promoRoutes.createPromo(request, env, user.email);
          } else if (path === '/api/promo/redemptions' && method === 'GET') {
            response = await promoRoutes.listRedemptions(env, url);
          } else if (seg[0] === 'api' && seg[1] === 'promo' && seg[3] === 'redemptions' && method === 'GET') {
            response = await promoRoutes.listRedemptionsForCode(env, decodeURIComponent(seg[2]));
          } else if (seg[0] === 'api' && seg[1] === 'promo' && seg.length === 3 && method === 'PATCH') {
            response = need('staff') || await promoRoutes.updatePromo(request, env, decodeURIComponent(seg[2]), user.email);
          } else if (seg[0] === 'api' && seg[1] === 'promo' && seg.length === 3 && method === 'DELETE') {
            response = need('admin') || await promoRoutes.deletePromo(request, env, decodeURIComponent(seg[2]), user.email);
          } else if (seg[0] === 'api' && seg[1] === 'admin' && seg[2] === 'redemptions' && seg[4] === 'revoke' && method === 'POST') {
            response = need('admin') || await promoRoutes.revokeRedemption(request, env, user.email, seg[3]);
          } else if (path === '/api/entitlements/grant' && method === 'POST') {
            response = need('admin') || await entitlementRoutes.grant(request, env, user.email);
          } else if (path === '/api/entitlements/revoke' && method === 'POST') {
            response = need('admin') || await entitlementRoutes.revoke(request, env, user.email);
          } else if (path === '/api/config' && method === 'PUT') {
            response = need('admin') || await configRoutes.putFlags(request, env, user.email);
          } else if (path === '/api/backups/usage' && method === 'GET') {
            response = await backupRoutes.usage(env);
          } else if (path === '/api/admin/users' && method === 'GET') {
            response = need('admin') || await userRoutes.listUsers(env);
          } else if (path === '/api/admin/users' && method === 'POST') {
            response = need('admin') || await userRoutes.createUser(request, env, user);
          } else if (seg[0] === 'api' && seg[1] === 'admin' && seg[2] === 'users' && seg.length === 4 && method === 'PATCH') {
            response = need('admin') || await userRoutes.updateUser(request, env, user, decodeURIComponent(seg[3]));
          } else if (seg[0] === 'api' && seg[1] === 'admin' && seg[2] === 'users' && seg.length === 4 && method === 'DELETE') {
            response = need('admin') || await userRoutes.deleteUser(env, user, decodeURIComponent(seg[3]));
          } else if (seg[0] === 'api' && seg[1] === 'admin' && seg[2] === 'users' && seg[4] === 'reset-password' && seg.length === 5 && method === 'POST') {
            response = need('admin') || await userRoutes.resetPassword(request, env, user, decodeURIComponent(seg[3]));
          } else if (path === '/api/admin/health' && method === 'GET') {
            response = await adminRoutes.getSystemHealth(env);
          } else if (path === '/api/admin/login-logs' && method === 'GET') {
            response = need('admin') || await adminRoutes.listLoginLogs(env, url);
          } else if (path === '/api/admin/config/history' && method === 'GET') {
            response = await configRoutes.getHistory(env);
          } else if (path === '/api/admin/config/restore' && method === 'POST') {
            response = need('admin') || await configRoutes.restoreFlags(request, env, user.email);
          } else if (path === '/api/admin/stats' && method === 'GET') {
            response = await adminRoutes.getStats(env);
          } else if (path === '/api/admin/audit' && method === 'GET') {
            response = await adminRoutes.listAudit(env, url);
          } else if (path === '/api/admin/accounts' && method === 'GET') {
            response = await adminRoutes.listAppAccounts(env, url);
          } else if (seg[0] === 'api' && seg[1] === 'admin' && seg[2] === 'accounts' && seg.length === 4 && method === 'GET') {
            response = await adminRoutes.getAccountDetail(env, decodeURIComponent(seg[3]));
          } else if (seg[0] === 'api' && seg[1] === 'admin' && seg[2] === 'accounts' && seg[4] === 'block' && seg.length === 5 && method === 'POST') {
            response = need('admin') || await adminRoutes.blockAppAccount(request, env, user.email, decodeURIComponent(seg[3]));
          } else if (seg[0] === 'api' && seg[1] === 'admin' && seg[2] === 'accounts' && seg[4] === 'unblock' && seg.length === 5 && method === 'POST') {
            response = need('admin') || await adminRoutes.unblockAppAccount(request, env, user.email, decodeURIComponent(seg[3]));
          } else if (seg[0] === 'api' && seg[1] === 'admin' && seg[2] === 'accounts' && seg.length === 4 && method === 'DELETE') {
            response = need('admin') || await adminRoutes.deleteAppAccount(request, env, user.email, decodeURIComponent(seg[3]));
          } else if (path === '/api/admin/revenue' && method === 'GET') {
            response = await adminRoutes.getRevenue(env);
          } else if (path === '/api/admin/backups/accounts' && method === 'GET') {
            response = await adminRoutes.listBackupAccounts(env);
          } else if (seg[0] === 'api' && seg[1] === 'admin' && seg[2] === 'backups' && seg[3] === 'accounts' && seg.length === 5 && method === 'PATCH') {
            response = need('admin') || await adminRoutes.setBackupTier(request, env, user.email, decodeURIComponent(seg[4]));
          } else if (seg[0] === 'api' && seg[1] === 'admin' && seg[2] === 'backups' && seg[3] === 'accounts' && seg[5] === 'files' && seg.length === 6 && method === 'GET') {
            response = await adminRoutes.listBackupAccountFiles(env, decodeURIComponent(seg[4]));
          } else {
            response = err('not_found', 'Không tìm thấy route.', 404);
          }
        }
      }

      return withCors(response);
    } catch (e) {
      // Không bao giờ lộ stack trace hay bí mật ra ngoài.
      console.error('admin worker error:', e && e.message ? e.message : e);
      return withCors(err('internal_error', 'Lỗi máy chủ. Vui lòng thử lại sau.', 500));
    }
  },
};
