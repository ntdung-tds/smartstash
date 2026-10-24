// SmartStash Admin — điểm vào của Cloudflare Worker.
//
// Phân quyền theo route:
//   CÔNG KHAI (không cần ADMIN_TOKEN):
//     GET  /api/health              — kiểm tra sống (cho uptime check)
//     GET  /api/config              — app đọc cờ cấu hình
//     POST /api/promo/redeem        — app đổi mã (giới hạn tốc độ riêng)
//     POST /api/webhooks/revenuecat — xác minh bằng REVENUECAT_WEBHOOK_SECRET
//   QUẢN TRỊ (bắt buộc header Authorization: Bearer <ADMIN_TOKEN>):
//     mọi route còn lại dưới /api/*
//   KHUNG (trả 503 cho tới khi adapter kích hoạt):
//     POST /api/backups/upload, GET /api/backups/download
//
// CORS: PWA quản trị chạy trên Pages (origin khác Worker) nên API trả
// Access-Control-Allow-Origin: * và xử lý OPTIONS. Bảo vệ thật sự là
// ADMIN_TOKEN (cho route quản trị) và Cloudflare Access đặt trước PWA;
// xem README mục "Bảo mật".

import { json, err } from './lib/http.js';
import { isAdmin } from './lib/auth.js';
import * as promoRoutes from './routes/promo.js';
import * as entitlementRoutes from './routes/entitlements.js';
import * as configRoutes from './routes/config.js';
import * as backupRoutes from './routes/backups.js';
import * as webhookRoutes from './routes/webhooks.js';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Idempotency-Key',
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
      } else if (path === '/api/webhooks/revenuecat' && method === 'POST') {
        response = await webhookRoutes.handleRevenueCatWebhook(request, env);
      } else if (path === '/api/backups/upload' && method === 'POST') {
        // Khung chưa kích hoạt — luôn 503 cho tới khi có adapter Drive.
        response = await backupRoutes.upload(env);
      } else if (path === '/api/backups/download' && method === 'GET') {
        response = await backupRoutes.download(env);
      } else {
        // --- Quản trị: mọi route còn lại dưới /api/* đều cần ADMIN_TOKEN ---
        if (!path.startsWith('/api/')) {
          response = err('not_found', 'Không tìm thấy route.', 404);
        } else if (!isAdmin(request, env)) {
          response = err('unauthorized', 'Thiếu hoặc sai ADMIN_TOKEN.', 401);
        } else {
          const seg = segments(path);
          if (path === '/api/promo' && method === 'GET') {
            response = await promoRoutes.listPromos(env);
          } else if (path === '/api/promo' && method === 'POST') {
            response = await promoRoutes.createPromo(request, env);
          } else if (path === '/api/promo/redemptions' && method === 'GET') {
            response = await promoRoutes.listRedemptions(env, url);
          } else if (seg[0] === 'api' && seg[1] === 'promo' && seg[3] === 'redemptions' && method === 'GET') {
            response = await promoRoutes.listRedemptionsForCode(env, decodeURIComponent(seg[2]));
          } else if (seg[0] === 'api' && seg[1] === 'promo' && seg.length === 3 && method === 'PATCH') {
            response = await promoRoutes.togglePromo(request, env, decodeURIComponent(seg[2]));
          } else if (path === '/api/entitlements/grant' && method === 'POST') {
            response = await entitlementRoutes.grant(request, env);
          } else if (path === '/api/entitlements/revoke' && method === 'POST') {
            response = await entitlementRoutes.revoke(request, env);
          } else if (path === '/api/config' && method === 'PUT') {
            response = await configRoutes.putFlags(request, env);
          } else if (path === '/api/backups/usage' && method === 'GET') {
            response = await backupRoutes.usage(env);
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
