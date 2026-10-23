// PLAN_LIMITS — theo B.12 v2.1 (đã áp dụng V21-07: FAMILY kế thừa PRO)
export const PLAN_LIMITS = {
  FREE: {
    maxActiveItems: 50,
    maxLocations: 30,
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

export type PlanKey = 'FREE' | 'PRO' | 'FAMILY';
export type PlanLimits = (typeof PLAN_LIMITS)[keyof typeof PLAN_LIMITS];

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
