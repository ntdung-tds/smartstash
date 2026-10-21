// PLAN_LIMITS — theo B.12 v2.1 (đã áp dụng V21-07: FAMILY kế thừa PRO)
export const PLAN_LIMITS = {
  FREE: {
    maxActiveItems: 50,
    maxLocations: 30,
    maxPhotosPerItem: 3,
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
    maxPhotosPerItem: 10,
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
export const CURRENT_PLAN: PlanKey = 'FREE';
export const CURRENT_LIMITS = PLAN_LIMITS.FREE;
