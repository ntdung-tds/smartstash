// PLAN_LIMITS — theo B.12 v2.1 (đã áp dụng V21-07: FAMILY kế thừa PRO)
export const PLAN_LIMITS = {
  FREE: {
    maxActiveItems: 30,
    maxLocations: 20,
    // Trần ảnh TÁCH theo bucket: ảnh đồ vật / ảnh hiện trường của mỗi món
    maxItemPhotos: 3,
    maxScenePhotos: 2,
    allowScenePinning: true,
    allowAutoCloudSync: false,
    allowQrPrintPdf: false,
    allowExpiryNotifications: true,
    allowLoanReminders: true,
    allowWarrantyNotifications: false,
    allowBasicExport: true,
    allowFullReport: false,
    allowFamilySharing: false,
  },
  PRO: {
    maxActiveItems: Infinity,
    maxLocations: Infinity,
    maxItemPhotos: 10,
    maxScenePhotos: 10,
    allowScenePinning: true,
    allowAutoCloudSync: true,
    allowQrPrintPdf: true,
    allowExpiryNotifications: true,
    allowLoanReminders: true,
    allowWarrantyNotifications: true,
    allowBasicExport: true,
    allowFullReport: true,
    allowFamilySharing: false,
  },
} as const;

export const FAMILY_LIMITS = {
  ...PLAN_LIMITS.PRO,
  allowFamilySharing: true,
  maxHouseholds: 1,
} as const;

/**
 * Mã khuyến mãi từ v78: KHÔNG còn bảng mã mô phỏng trong app.
 *
 * Mã thật do chủ app tạo trên trang quản trị và lưu ở máy chủ (Worker +
 * D1, bảng promo_codes). App chỉ gửi mã + Google ID token lên
 * POST {ADMIN_WORKER_URL}/api/promo/redeem; máy chủ tự xác thực token,
 * kiểm tra mã và cấp quyền — app không tự chứa danh sách mã và không tự
 * quyết định cấp quyền (xem src/services/promoService.ts). Đổi mã bắt
 * buộc đăng nhập Google (tái dùng phiên SDK của sao lưu Drive).
 *
 * Lịch sử: bảng PROMO_CODE_SIM cũ (gồm mã WELCOME, gỡ ở v77, và mã test
 * EXPIRED2025) đã xoá hẳn ở v78. Test nhánh "hết hạn" từ đây dùng mã tạo
 * trên trang quản trị (đặt expires_at quá khứ), không còn mã local.
 */

export type PlanKey = 'FREE' | 'PRO' | 'FAMILY';
export type PlanLimits = (typeof PLAN_LIMITS)[keyof typeof PLAN_LIMITS];

/**
 * Máy chủ quản trị (Cloudflare Worker) — nguồn cấu hình từ xa DUY NHẤT của
 * app. remoteConfigService fetch GET {ADMIN_WORKER_URL}/api/config (đọc công
 * khai, không cần đăng nhập) mỗi lần mở app và mỗi lần vào Cài đặt; lỗi mạng
 * thì dùng giá trị đã cache trong app_kv, rồi mới tới mặc định trong code.
 * App KHÔNG BAO GIỜ phụ thuộc vào việc tải cấu hình thành công (offline-first).
 */
export const ADMIN_WORKER_URL = 'https://smartstash-admin.iaict-platform.workers.dev';

/**
 * @deprecated Hai hằng này chỉ còn là giá trị mặc định khởi tạo. Từ Phase 6,
 * gói hiệu lực do src/services/planService.ts quyết định (getCurrentPlan /
 * getCurrentLimits) — KHÔNG import CURRENT_PLAN/CURRENT_LIMITS ở code mới.
 */
export const CURRENT_PLAN: PlanKey = 'FREE';
export const CURRENT_LIMITS = PLAN_LIMITS.FREE;

/**
 * OAuth Client ID cho sao lưu Google Drive của khách (BYOC — Phase 5).
 *
 * TODO(Drive): điền Client ID THẬT vào đây khi người dùng tạo xong project
 * trên Google Cloud Console (một OAuth client dạng Web + một dạng Android
 * cho package com.smartstash.app). Chưa có ID thì isDriveConfigured() = false
 * và mục Drive trong Cài đặt chỉ hiện trạng thái "đang chờ cấu hình" — toàn
 * bộ lớp Drive (driveService, UI) nằm yên, app chạy bình thường.
 * TUYỆT ĐỐI không bịa ID.
 */
export const DRIVE_CLIENT_IDS = {
  web: '276230190448-pvkfnsm6m9tu06fm6falp04d994h5qbk.apps.googleusercontent.com',
  android: '276230190448-sk470fivveoeqnus89cear2bmfb5ume2.apps.googleusercontent.com',
} as const;

/** Đã có ít nhất một Client ID để chạy luồng đăng nhập Google hay chưa */
export function isDriveConfigured(): boolean {
  return DRIVE_CLIENT_IDS.web.trim().length > 0 || DRIVE_CLIENT_IDS.android.trim().length > 0;
}
