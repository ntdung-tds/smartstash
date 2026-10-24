/**
 * Cấu hình từ xa TỐI GIẢN (seam) — nơi DUY NHẤT app đọc các công tắc vận
 * hành cần đổi mà không phát hành bản mới (feature flag / kill switch,
 * theo Mảng 7 của Bản đồ vận hành).
 *
 * TODO(remote-config): hiện CHƯA nối nguồn cấu hình từ xa thật. Khi có
 * Firebase Remote Config hoặc máy chủ riêng: chỉ thay phần ĐỌC bên trong
 * loadRemoteConfig() bằng bản cấu hình tải về (và cache vào app_kv để khởi
 * động lạnh vẫn có giá trị gần nhất) — chữ ký hàm và các hàm đọc đồng bộ
 * bên dưới giữ nguyên, mọi điểm dùng không phải sửa.
 *
 * Nguyên tắc an toàn: nếu chưa nạp được cấu hình (mở app lần đầu, lỗi
 * mạng…) thì app dùng DEFAULT_FLAGS khai trong code — hành vi app không
 * bao giờ phụ thuộc vào việc tải cấu hình thành công.
 */
export interface RemoteFlags {
  /**
   * Công tắc ô NHẬP MÃ TỰ QUẢN (mã khuyến mãi do chủ app phát hành, đổi
   * qua promoService). Tắt cờ này = ẩn hẳn điểm nhập mã trong Cài đặt VÀ
   * promoService từ chối đổi mã (chặn ở cả service). Lối "Đổi mã Google
   * Play" KHÔNG thuộc cờ này và không bị ảnh hưởng.
   *
   * Chốt chặn trước production (Mảng 3): khi chưa có máy chủ kiểm tra mã
   * thật, bản production PHẢI tắt cờ này (lật mặc định dưới đây thành
   * false hoặc đặt qua cấu hình từ xa) để mã mô phỏng trong code không
   * thành đường mở Pro miễn phí.
   */
  selfPromoEnabled: boolean;
}

const DEFAULT_FLAGS: RemoteFlags = {
  // ⚠️ BẢN DEV/TEST: đang BẬT để chủ app tiếp tục kiểm thử luồng nhập mã
  // (mã WELCOME trong PROMO_CODE_SIM) như ở v61. BẢN PRODUCTION phải lật
  // thành false tại đây hoặc tắt qua cấu hình từ xa trước khi phát hành.
  selfPromoEnabled: true,
};

let cachedFlags: RemoteFlags = { ...DEFAULT_FLAGS };
let loaded = false;

/**
 * Nạp cấu hình từ xa vào cache — gọi khi app khởi động (cạnh loadPlan).
 * TODO(remote-config): thay thân hàm bằng fetch Firebase Remote Config /
 * cấu hình từ máy chủ; lỗi thì giữ nguyên DEFAULT_FLAGS, không ném lỗi.
 */
export async function loadRemoteConfig(): Promise<RemoteFlags> {
  // Chưa có nguồn từ xa: dùng mặc định trong code.
  cachedFlags = { ...DEFAULT_FLAGS };
  loaded = true;
  return cachedFlags;
}

/** Toàn bộ cờ hiện tại (đồng bộ, từ cache — nạp mặc định nếu chưa nạp) */
export function getRemoteFlagsSync(): RemoteFlags {
  return cachedFlags;
}

/** Đã nạp cấu hình trong phiên này chưa (chỉ để chẩn đoán/test) */
export function isRemoteConfigLoaded(): boolean {
  return loaded;
}

/**
 * Ô nhập mã tự quản đang BẬT hay không (đồng bộ). UI dùng để ẩn/hiện điểm
 * nhập mã; promoService dùng để chặn đổi mã ngay ở tầng service.
 */
export function isSelfPromoEnabled(): boolean {
  return cachedFlags.selfPromoEnabled;
}
