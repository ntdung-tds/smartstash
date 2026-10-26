// Xác thực tài khoản Google phía máy chủ cho luồng đổi mã khuyến mãi.
//
// NGUYÊN TẮC: máy chủ KHÔNG BAO GIỜ tin account_id do client gửi (chuỗi
// thô, ai cũng tự ghi được). App gửi kèm Google ID token lấy từ SDK
// Sign-In native; Worker tự kiểm tra token đó với Google rồi mới lấy
// định danh thật (sub) từ trong token. Anchor đổi mã từ đây là
// `google:<sub>` — bền qua gỡ app / đổi máy, khác hẳn UUID cục bộ trong
// app_kv vốn mất khi gỡ app.
//
// Client ID phải khớp đúng OAuth client của app — copy từ
// apps/app/src/config.ts (DRIVE_CLIENT_IDS), KHÔNG tự bịa:
//   web     = client Web (đăng nhập native cấu hình webClientId nên ID
//             token trả về mang aud này),
//   android = client Android (dự phòng, cùng Google Cloud project).
// Đổi client ID trong app thì phải đổi cả hai chỗ này cùng lúc.
export const GOOGLE_CLIENT_IDS = [
  '276230190448-pvkfnsm6m9tu06fm6falp04d994h5qbk.apps.googleusercontent.com',
  '276230190448-sk470fivveoeqnus89cear2bmfb5ume2.apps.googleusercontent.com',
];

const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

/**
 * Lấy ID token từ request: ưu tiên header Authorization Bearer, sau đó
 * tới body.id_token. Trả null khi không có.
 */
export function extractIdToken(request, body) {
  const header = request.headers.get('Authorization') || '';
  if (header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token) return token;
  }
  const fromBody = String(body?.id_token ?? '').trim();
  return fromBody || null;
}

/**
 * Kiểm tra Google ID token qua endpoint tokeninfo của Google.
 * Chỉ chấp nhận khi:
 *   - tokeninfo trả 200,
 *   - có sub (định danh tài khoản),
 *   - aud trùng một trong các OAuth client ID của app,
 *   - token còn hạn (expires_in > 0, khi Google trả trường này).
 * Trả { ok: true, sub, email } hoặc { ok: false, reason }.
 * Lưu ý: tokeninfo có giới hạn tốc độ của Google, nhưng luồng đổi mã có
 * lưu lượng thấp (người dùng đổi mã vài lần) nên chấp nhận được; không
 * dùng cho các API tần suất cao. Token KHÔNG BAO GIỜ ghi log.
 */
export async function verifyGoogleIdToken(idToken) {
  if (!idToken) return { ok: false, reason: 'missing_token' };
  let info;
  try {
    const res = await fetch(
      `${TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`
    );
    if (!res.ok) return { ok: false, reason: 'invalid_token' };
    info = await res.json();
  } catch {
    return { ok: false, reason: 'tokeninfo_error' };
  }
  const sub = String(info?.sub ?? '').trim();
  const aud = String(info?.aud ?? '').trim();
  if (!sub) return { ok: false, reason: 'invalid_token' };
  if (!GOOGLE_CLIENT_IDS.includes(aud)) {
    return { ok: false, reason: 'wrong_audience' };
  }
  if (info.expires_in !== undefined && Number(info.expires_in) <= 0) {
    return { ok: false, reason: 'expired_token' };
  }
  return { ok: true, sub, email: String(info?.email ?? '').trim() || null };
}

/** Anchor đổi mã của một tài khoản Google đã xác thực. */
export function googleAnchor(sub) {
  return `google:${sub}`;
}
