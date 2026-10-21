import { Ionicons } from '@expo/vector-icons';
import type { AlertTier, CustomTerm, ItemCategory, ItemCondition, ItemStatus, Location, LocationType, Lang } from './types';
import {
  CATEGORY_LABELS, STATUS_LABELS, LOCATION_TYPE_LABELS, CONDITION_LABELS,
  CATEGORY_LABELS_EN, STATUS_LABELS_EN, LOCATION_TYPE_LABELS_EN, CONDITION_LABELS_EN,
  CONDITION_ICONS, CONDITION_HINTS, CONDITION_HINTS_EN,
} from './types';

export type IconName = keyof typeof Ionicons.glyphMap;

/**
 * SmartStash design system — tím chủ đạo + accent nhiều màu.
 * "Gradient" được giả lập bằng các hình tròn màu mờ xếp lớp trên nền tím đậm,
 * không dùng thêm module native nào.
 */
export const Colors = {
  primary: '#6D28D9',
  primaryDark: '#241254',
  deep: '#241254',
  deep2: '#2A1666',
  accent: '#FF5A76',
  coral: '#FF5A76',
  orange: '#FF9F43',
  teal: '#0FB5A8',
  sky: '#38A8E8',
  pink: '#EC4899',
  yellow: '#F5B301',
  green: '#22A06B',
  red: '#E5484D',
  violetSoft: '#8B5CF6',
  bg: '#F6F4FC',
  card: '#FFFFFF',
  text: '#241E42',
  subtext: '#6E6890',
  faint: '#9A94B8',
  border: '#E3DEF5',
  chipBg: '#EFEAFB',
  warning: '#F5B301',
  danger: '#E5484D',
  onDark: '#FFFFFF',
  onDarkMuted: '#CFC8EE',
};

export const Radius = {
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  hero: 28,
  pill: 999,
};

export const Spacing = {
  screen: 20,
  gap: 14,
  gapLg: 16,
};

/** Shadow mềm tông tím dùng cho thẻ trắng */
export const cardShadow = {
  shadowColor: '#241254',
  shadowOffset: { width: 0, height: 6 },
  shadowOpacity: 0.1,
  shadowRadius: 14,
  elevation: 4,
} as const;

/** Shadow mạnh cho thanh tab nổi / ô tìm kiếm nổi */
export const floatingShadow = {
  shadowColor: '#241254',
  shadowOffset: { width: 0, height: 10 },
  shadowOpacity: 0.18,
  shadowRadius: 22,
  elevation: 12,
} as const;

export const heroShadow = {
  shadowColor: '#241254',
  shadowOffset: { width: 0, height: 12 },
  shadowOpacity: 0.28,
  shadowRadius: 24,
  elevation: 10,
} as const;

/** Nền tint nhạt (~11% màu gốc) cho ô icon / badge */
export function tint(color: string, alpha = '1C'): string {
  return `${color}${alpha}`;
}

export const CATEGORY_COLORS: Record<ItemCategory, string> = {
  ELECTRONICS: Colors.sky,
  MEDICINE: Colors.red,
  FOOD: Colors.orange,
  KITCHENWARE: Colors.teal,
  DOCUMENTS: Colors.yellow,
  CLOTHING: Colors.pink,
  TOOLS: Colors.green,
  KIDS: Colors.coral,
  HOUSEHOLD: '#6366F1',
  SPORTS: '#65A30D',
  BOOKS: '#B7791F',
  OTHER: Colors.primary,
};

export const CATEGORY_ICONS: Record<ItemCategory, IconName> = {
  ELECTRONICS: 'hardware-chip-outline',
  MEDICINE: 'medkit-outline',
  FOOD: 'fast-food-outline',
  KITCHENWARE: 'restaurant-outline',
  DOCUMENTS: 'document-text-outline',
  CLOTHING: 'shirt-outline',
  TOOLS: 'construct-outline',
  KIDS: 'happy-outline',
  HOUSEHOLD: 'tv-outline',
  SPORTS: 'football-outline',
  BOOKS: 'book-outline',
  OTHER: 'cube-outline',
};

// ---------- Ngôn ngữ hiện tại (store cập nhật khi đổi ngôn ngữ) ----------
// theme không import store (store import theme) nên giữ lang dạng biến module
// để các resolver thuần tra được mà không tạo vòng import.
let currentLang: Lang = 'vi';

export function setCurrentLang(lang: Lang): void {
  currentLang = lang;
}

export function getCurrentLang(): Lang {
  return currentLang;
}

// ---------- Resolver cho phân loại / trạng thái (built-in + tự tạo) ----------
// Registry runtime: store nạp các CustomTerm từ DB vào đây để các hàm thuần
// (không phải component) tra được tên/màu/icon của loại tự tạo ở mọi nơi.
let customTermRegistry: Record<string, CustomTerm> = {};

export function registerCustomTerms(terms: CustomTerm[]): void {
  const next: Record<string, CustomTerm> = {};
  for (const t of terms) next[t.id] = t;
  customTermRegistry = next;
}

export function getCustomTerm(key: string): CustomTerm | undefined {
  return customTermRegistry[key];
}

function validIcon(icon: string | undefined, fallback: IconName): IconName {
  return icon && icon in Ionicons.glyphMap ? (icon as IconName) : fallback;
}

export function categoryColor(category: string): string {
  return (CATEGORY_COLORS as Record<string, string>)[category]
    ?? customTermRegistry[category]?.color
    ?? Colors.primary;
}

export function categoryIcon(category: string): IconName {
  const builtin = (CATEGORY_ICONS as Record<string, IconName>)[category];
  if (builtin) return builtin;
  return validIcon(customTermRegistry[category]?.icon, 'cube-outline');
}

export function categoryLabel(category: string, lang: Lang = currentLang): string {
  if (lang === 'en') {
    return (CATEGORY_LABELS_EN as Record<string, string>)[category]
      ?? customTermRegistry[category]?.name
      ?? category;
  }
  return (CATEGORY_LABELS as Record<string, string>)[category]
    ?? customTermRegistry[category]?.name
    ?? category;
}

export const STATUS_COLORS: Record<ItemStatus, string> = {
  STORED: Colors.green,
  IN_USE: Colors.sky,
  LENT: Colors.orange,
  PARTIALLY_LENT: Colors.yellow,
  SOLD: Colors.primary,
  DISPOSED: Colors.subtext,
  LOST: Colors.red,
};

export const STATUS_ICONS: Record<ItemStatus, IconName> = {
  STORED: 'archive-outline',
  IN_USE: 'hand-left-outline',
  LENT: 'swap-horizontal',
  PARTIALLY_LENT: 'timer-outline',
  SOLD: 'cash-outline',
  DISPOSED: 'trash-outline',
  LOST: 'search-outline',
};

export function statusColorFor(status: string): string {
  return (STATUS_COLORS as Record<string, string>)[status]
    ?? customTermRegistry[status]?.color
    ?? Colors.subtext;
}

export function statusLabel(status: string, lang: Lang = currentLang): string {
  if (lang === 'en') {
    return (STATUS_LABELS_EN as Record<string, string>)[status]
      ?? customTermRegistry[status]?.name
      ?? status;
  }
  return (STATUS_LABELS as Record<string, string>)[status]
    ?? customTermRegistry[status]?.name
    ?? status;
}

/** Nhãn loại vị trí theo ngôn ngữ (chưa có resolver trước đây — các màn dùng trực tiếp) */
export function locationTypeLabel(type: LocationType, lang: Lang = currentLang): string {
  return lang === 'en' ? LOCATION_TYPE_LABELS_EN[type] : LOCATION_TYPE_LABELS[type];
}

export function statusIcon(status: string): IconName {
  const builtin = (STATUS_ICONS as Record<string, IconName>)[status];
  if (builtin) return builtin;
  return validIcon(customTermRegistry[status]?.icon, 'bookmark-outline');
}

export const CONDITION_COLORS: Record<ItemCondition, string> = {
  NEW: Colors.green,
  GOOD: Colors.teal,
  WORN: Colors.yellow,
  NEED_REPAIR: Colors.orange,
  BROKEN: Colors.red,
};

export function conditionColor(condition: string): string {
  return (CONDITION_COLORS as Record<string, string>)[condition]
    ?? customTermRegistry[condition]?.color
    ?? Colors.subtext;
}

export function conditionLabel(condition: string, lang: Lang = currentLang): string {
  if (lang === 'en') {
    return (CONDITION_LABELS_EN as Record<string, string>)[condition]
      ?? customTermRegistry[condition]?.name
      ?? condition;
  }
  return (CONDITION_LABELS as Record<string, string>)[condition]
    ?? customTermRegistry[condition]?.name
    ?? condition;
}

export function conditionIcon(condition: string): IconName {
  const icon = (CONDITION_ICONS as Record<string, string>)[condition];
  if (icon) return validIcon(icon, 'help-circle-outline');
  return validIcon(customTermRegistry[condition]?.icon, 'help-circle-outline');
}

/**
 * Mô tả cho tình trạng built-in. Tình trạng TỰ TẠO không có hint sẵn —
 * trả '' và form tự hiển thị chuỗi i18n 'condition.customHint' thay thế.
 */
export function conditionHint(condition: string, lang: Lang = currentLang): string {
  if (lang === 'en') {
    return (CONDITION_HINTS_EN as Record<string, string>)[condition] ?? '';
  }
  return (CONDITION_HINTS as Record<string, string>)[condition] ?? '';
}

// ---------- Cảnh báo 4 mức (màu CHỨC NĂNG, tách khỏi màu phân loại/trạng thái) ----------
export const ALERT_TIER_COLORS: Record<AlertTier, string> = {
  OVERDUE: '#DC2645',
  DUE: '#EA580C',
  SOON: '#D97706',
  WATCH: '#0284C7',
};

/** Đỏ đậm cho quá hạn lâu (>7 ngày) — leo thang thị giác, không nhấp nháy */
export const ALERT_OVERDUE_DEEP_COLOR = '#991B1B';

/** Màu hiển thị của một mức; quá hạn >7 ngày tự đậm lên */
export function alertTierColor(tier: AlertTier, days: number): string {
  if (tier === 'OVERDUE' && days < -7) return ALERT_OVERDUE_DEEP_COLOR;
  return ALERT_TIER_COLORS[tier];
}

export function alertTierIcon(tier: AlertTier): IconName {
  return tier === 'SOON' || tier === 'WATCH' ? 'time' : 'alert-circle';
}

export const LOCATION_TYPE_COLORS: Record<LocationType, string> = {
  PROPERTY: Colors.primary,
  ROOM: Colors.sky,
  FURNITURE: Colors.teal,
  CONTAINER: Colors.orange,
};

export const LOCATION_TYPE_ICONS: Record<LocationType, IconName> = {
  PROPERTY: 'home',
  ROOM: 'bed',
  FURNITURE: 'file-tray-stacked',
  CONTAINER: 'archive',
};

/**
 * Icon hiển thị của một vị trí: ưu tiên icon tự chọn (nếu còn hợp lệ trong
 * glyphMap), ngược lại icon mặc định theo loại vị trí.
 */
export function locationIconName(loc: Location): IconName {
  return validIcon(loc.icon ?? undefined, LOCATION_TYPE_ICONS[loc.type]);
}
