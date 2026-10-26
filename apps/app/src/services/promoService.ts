import { ADMIN_WORKER_URL } from '../config';
import { getGoogleIdToken } from './driveService';
import { getPlanSync, setSimPro } from './planService';
import { isSelfPromoEnabled } from './remoteConfigService';

/**
 * Đổi MÃ KHUYẾN MÃI qua máy chủ của chủ app (v78 — bắt buộc tài khoản Google).
 *
 * Luồng mới, khác hẳn seam mô phỏng cũ (tra bảng PROMO_CODE_SIM trong app):
 * - Người dùng phải đăng nhập Google trước (v82: luồng đổi mã dùng phiên
 *   SDK scope cơ bản riêng, KHÔNG còn dùng chung phiên Drive — Drive
 *   đang tạm dừng ở UI cho tới khi xác minh OAuth xong).
 * - App gửi mã + Google ID token lên Worker; Worker tự xác thực token với
 *   Google rồi mới lấy định danh thật (anchor `google:<sub>`) để kiểm tra
 *   mã và cấp quyền. App không tự quyết định gì, không gửi account_id tự ghi.
 * - Gói từ máy chủ là nguồn sự thật khi online + đã đăng nhập: syncPlan
 *   ghi đè cờ local. Offline hoặc chưa đăng nhập thì GIỮ NGUYÊN cờ local,
 *   không tự hạ cấp.
 *
 * Mã GOOGLE PLAY thì ngược lại: app KHÔNG ĐƯỢC tự kiểm tra. Việc đổi mã
 * do Google xử lý tại https://play.google.com/redeem — UI chỉ mở liên kết
 * đó (xem khu vực "Đổi mã Google Play" trong modal nhập mã ở Cài đặt).
 */
export type PromoRedeemResult =
  | { status: 'success'; code: string }
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'not_started' }
  | { status: 'disabled' }
  | { status: 'uses_exhausted' }
  | { status: 'campaign_used' }
  | { status: 'paid_active' }
  | { status: 'rate_limited' }
  /** Chưa đăng nhập Google nên không có ID token để gửi lên máy chủ */
  | { status: 'account_required' }
  /** Token hết hạn / không hợp lệ — UI bảo người dùng đăng nhập lại */
  | { status: 'invalid_token' }
  /** Lỗi mạng hoặc máy chủ không trả JSON hợp lệ */
  | { status: 'network' };

/** Chuẩn hoá mã người dùng nhập trước khi gửi: cắt khoảng trắng + viết hoa */
export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** ID token Google hiện tại, null khi chưa đăng nhập (để UI hiện nút đăng nhập) */
export async function getPromoIdToken(): Promise<string | null> {
  try {
    return await getGoogleIdToken();
  } catch {
    return null;
  }
}

type ServerRedeemBody = {
  ok?: boolean;
  error?: string;
  result?: string;
  entitlement?: string;
  days?: number;
  expires_at?: string;
};

function mapServerError(error: string | undefined): PromoRedeemResult {
  switch (error) {
    case 'not_found':
      return { status: 'not_found' };
    case 'expired':
      return { status: 'expired' };
    case 'not_started':
      return { status: 'not_started' };
    case 'disabled':
      return { status: 'disabled' };
    case 'uses_exhausted':
      return { status: 'uses_exhausted' };
    case 'campaign_used':
      return { status: 'campaign_used' };
    case 'paid_active':
      return { status: 'paid_active' };
    case 'rate_limited':
      return { status: 'rate_limited' };
    case 'account_required':
      return { status: 'account_required' };
    case 'invalid_token':
      return { status: 'invalid_token' };
    default:
      return { status: 'network' };
  }
}

/**
 * Đổi một mã khuyến mãi qua máy chủ. Trả về kết quả PHÂN LOẠI rõ ràng để
 * UI báo lỗi tại chỗ đúng từng trường hợp. Thành công → cấp Pro qua cờ
 * của planService (giống cơ chế cũ, chỉ khác nguồn quyết định là máy chủ).
 */
export async function redeemPromoCodeViaServer(
  rawCode: string,
  idToken: string | null
): Promise<PromoRedeemResult> {
  // Chốt chặn ở TẦNG SERVICE (không chỉ ẩn giao diện): công tắc cấu hình
  // từ xa tắt ô nhập mã tự quản thì từ chối đổi mọi mã ngay tại đây.
  if (!isSelfPromoEnabled()) {
    return { status: 'disabled' };
  }
  if (!idToken) {
    return { status: 'account_required' };
  }
  const code = normalizePromoCode(rawCode);
  let res: Response;
  try {
    res = await fetch(`${ADMIN_WORKER_URL}/api/promo/redeem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ code }),
    });
  } catch {
    return { status: 'network' };
  }
  let body: ServerRedeemBody;
  try {
    body = (await res.json()) as ServerRedeemBody;
  } catch {
    return { status: 'network' };
  }
  if (res.ok && body.ok) {
    await setSimPro(true);
    return { status: 'success', code };
  }
  return mapServerError(body.error);
}

/**
 * Đồng bộ gói từ máy chủ (nguồn sự thật khi online + đã đăng nhập).
 * - Đã đăng nhập + máy chủ trả pro → setSimPro(true); trả free → setSimPro(false).
 * - Chưa đăng nhập, lỗi mạng, hoặc token hết hạn → GIỮ NGUYÊN gói local,
 *   trả về gói hiện tại, không ném lỗi (điểm gọi trong Cài đặt nuốt im lặng).
 */
export async function syncPlanFromServer(): Promise<'PRO' | 'FREE'> {
  try {
    const idToken = await getGoogleIdToken();
    if (!idToken) return getPlanSync();
    const res = await fetch(`${ADMIN_WORKER_URL}/api/promo/status`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) return getPlanSync();
    const body = (await res.json()) as { ok?: boolean; plan?: string };
    if (!body.ok) return getPlanSync();
    if (body.plan === 'pro') return setSimPro(true);
    if (body.plan === 'free') return setSimPro(false);
    return getPlanSync();
  } catch {
    return getPlanSync();
  }
}
