// Nhận webhook từ RevenueCat và đồng bộ trạng thái gói vào app_accounts.
//
// Xác thực: header Authorization phải khớp REVENUECAT_WEBHOOK_SECRET
// (xem src/lib/revenuecat.js). Chưa cấu hình secret thì từ chối —
// không xử lý webhook khi không xác minh được nguồn.
// Chống xử lý trùng: mỗi event id chỉ xử lý một lần (bảng webhook_events).
//
// Ánh xạ trạng thái (giữ đơn giản, theo sự kiện):
//   INITIAL_PURCHASE, RENEWAL, UNCANCELLATION -> pro_paid
//   EXPIRATION, CANCELLATION                 -> free (chỉ khi đang là pro_paid,
//                                               để không ghi đè quyền lợi tặng)
//   NON_RENEWING_PURCHASE                    -> pro_promo (quyền lợi tặng)
// Các loại sự kiện khác: ghi nhận event nhưng không đổi trạng thái.

import { json, err } from '../lib/http.js';
import { verifyWebhook } from '../lib/revenuecat.js';

function eventExpirationMs(ev) {
  const raw = ev.expiration_at_ms ?? ev.expirationAtMs ?? null;
  return raw ? new Date(Number(raw)).toISOString() : null;
}

export async function handleRevenueCatWebhook(request, env) {
  if (!verifyWebhook(request, env)) {
    return err('unauthorized', 'Webhook không xác minh được nguồn.', 401);
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return err('invalid_body', 'Body phải là JSON.', 400);
  }
  const ev = payload.event || payload;
  const eventId = ev.id || payload.id;
  const type = ev.type || payload.type;
  const appUserId = ev.app_user_id || ev.appUserId;
  if (!eventId || !type) {
    return err('invalid_event', 'Sự kiện thiếu id hoặc type.', 400);
  }

  const seen = await env.DB.prepare(
    'SELECT event_id FROM webhook_events WHERE event_id = ?'
  ).bind(eventId).first();
  if (seen) return json({ ok: true, duplicate: true });

  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(
      'INSERT INTO webhook_events (event_id, type) VALUES (?, ?)'
    ).bind(eventId, type),
  ];

  if (appUserId) {
    if (type === 'INITIAL_PURCHASE' || type === 'RENEWAL' || type === 'UNCANCELLATION') {
      statements.push(env.DB.prepare(
        `INSERT INTO app_accounts
           (revenuecat_app_user_id, plan_status, paid_until, updated_at)
         VALUES (?, 'pro_paid', ?, ?)
         ON CONFLICT(revenuecat_app_user_id) DO UPDATE SET
           plan_status = 'pro_paid', paid_until = excluded.paid_until,
           updated_at = excluded.updated_at`
      ).bind(appUserId, eventExpirationMs(ev), now));
    } else if (type === 'EXPIRATION' || type === 'CANCELLATION') {
      statements.push(env.DB.prepare(
        `UPDATE app_accounts SET plan_status = 'free', paid_until = NULL, updated_at = ?
          WHERE revenuecat_app_user_id = ? AND plan_status = 'pro_paid'`
      ).bind(now, appUserId));
    } else if (type === 'NON_RENEWING_PURCHASE') {
      statements.push(env.DB.prepare(
        `INSERT INTO app_accounts
           (revenuecat_app_user_id, plan_status, promo_until, updated_at)
         VALUES (?, 'pro_promo', ?, ?)
         ON CONFLICT(revenuecat_app_user_id) DO UPDATE SET
           plan_status = 'pro_promo', promo_until = excluded.promo_until,
           updated_at = excluded.updated_at`
      ).bind(appUserId, eventExpirationMs(ev), now));
    }
  }

  statements.push(env.DB.prepare(
    'INSERT INTO admin_audit (actor, action, target, detail) VALUES (?, ?, ?, ?)'
  ).bind('webhook', 'revenuecat_event', appUserId || null, JSON.stringify({ event_id: eventId, type })));

  await env.DB.batch(statements);
  return json({ ok: true, event_id: eventId, type });
}
