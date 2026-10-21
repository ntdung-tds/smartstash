import React, { useEffect, useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, Image, Animated, Modal, FlatList, Pressable, TextInput, Alert,
  ActivityIndicator, type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { CustomTerm, Item, Location } from '../types';
import { formatVND, getAlertTier, isAlertSnoozed } from '../utils';
import {
  Colors, Radius, cardShadow, floatingShadow, tint,
  categoryColor, categoryIcon, statusColorFor, statusLabel,
  alertTierColor, alertTierIcon,
  LOCATION_TYPE_COLORS, locationIconName,
  type IconName,
} from '../theme';
import { getCachedAlertSettings } from '../services/alertSettings';
import { useAppStore } from '../store/useAppStore';
import { translate, useT } from '../i18n';

export { Colors };
export type { IconName };

/**
 * Khoảng trống đáy (paddingBottom) cho vùng cuộn của các màn tab, để phần tử cuối
 * không bị thanh tab NỔI che. Số đo từ (tabs)/_layout.tsx: thanh tab cao 70 +
 * bottom 12 = mép trên ở 82px; nút giữa 62×62 với marginTop -22 nhô thêm ~22px
 * (điểm cao nhất ≈ 104px), cộng dự phòng inset thanh điều hướng của máy (~16)
 * và khoảng thở ~24 → 144.
 */
export const TAB_BAR_CLEARANCE = 144;

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingHorizontal: 18, paddingTop: 20, paddingBottom: 20, gap: 16 },
  title: { fontSize: 28, fontWeight: '800', color: Colors.text, letterSpacing: 0.2 },
  subtitle: { fontSize: 14, color: Colors.subtext, lineHeight: 20, marginTop: 3 },
  sectionTitle: { fontSize: 18, fontWeight: '800', color: Colors.text },
  card: {
    backgroundColor: Colors.card, borderRadius: Radius.lg, padding: 16,
    borderWidth: 1, borderColor: Colors.border,
    ...cardShadow,
  },
  input: {
    backgroundColor: '#FDFCFF', borderWidth: 1.5, borderColor: '#E7E2F6', borderRadius: 14,
    height: 52, paddingHorizontal: 14, fontSize: 15.5, color: Colors.text,
  },
  /** Ô nhập nhiều dòng (ghi chú): không cố định chiều cao như input, tối thiểu 76 */
  inputMultiline: {
    backgroundColor: '#FDFCFF', borderWidth: 1.5, borderColor: '#E7E2F6', borderRadius: 14,
    minHeight: 76, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12,
    fontSize: 15.5, color: Colors.text, textAlignVertical: 'top',
  },
  label: { fontSize: 15, fontWeight: '700', color: Colors.text, marginBottom: 7 },
  button: {
    backgroundColor: Colors.primary, borderRadius: Radius.pill, paddingVertical: 13, paddingHorizontal: 18,
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8,
    shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 10, elevation: 5,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700', lineHeight: 22 },
  buttonSecondary: {
    backgroundColor: '#fff', borderRadius: Radius.pill, paddingVertical: 12, paddingHorizontal: 16,
    borderWidth: 1.5, borderColor: Colors.border,
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8,
    ...cardShadow,
  },
  buttonSecondaryText: { color: Colors.primaryDark, fontSize: 15, fontWeight: '700', lineHeight: 21 },
  buttonDanger: {
    backgroundColor: '#FDECEC', borderRadius: Radius.pill, paddingVertical: 12, paddingHorizontal: 16,
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8,
  },
  buttonDangerText: { color: Colors.danger, fontSize: 15, fontWeight: '700', lineHeight: 21 },
  chip: {
    height: 34, paddingHorizontal: 13, borderRadius: Radius.pill,
    backgroundColor: '#fff', borderWidth: 1.5, borderColor: Colors.border, marginRight: 8,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  chipActive: { backgroundColor: Colors.primaryDark, borderColor: Colors.primaryDark },
  chipText: { fontSize: 13, color: Colors.primaryDark, fontWeight: '700' },
  chipTextActive: { color: '#fff' },
  /** Ô vuông nhỏ bọc icon trong chip (danh mục) — màu nền truyền inline theo trạng thái chọn */
  chipIconBox: {
    width: 26, height: 26, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
  },
  /** Hộp ghi chú động dưới bộ chọn tình trạng — màu nền truyền inline theo màu tình trạng */
  hintBox: {
    flexDirection: 'row', gap: 8, alignItems: 'flex-start',
    borderRadius: 14, padding: 12,
  },
  hintText: { flex: 1, fontSize: 12.5, lineHeight: 18, color: Colors.text },
  empty: { textAlign: 'center', color: Colors.subtext, fontSize: 15, lineHeight: 22, marginTop: 40, paddingHorizontal: 24 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(36,18,84,0.55)', justifyContent: 'center', padding: 20 },
  modalCard: { borderRadius: 26, padding: 20 },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#fff', borderRadius: Radius.pill, height: 54,
    paddingHorizontal: 18, ...floatingShadow,
  },
});

export function statusColor(status: string): string {
  return statusColorFor(status);
}

/** Ô icon 48×48 bo 16, nền tint + icon theo màu chủ đạo */
export function IconTile({
  icon, color, size = 48, iconSize = 24, bordered = false,
}: {
  icon: IconName;
  color: string;
  size?: number;
  iconSize?: number;
  bordered?: boolean;
}) {
  return (
    <View
      style={{
        width: size, height: size, borderRadius: size * 0.34,
        backgroundColor: tint(color), alignItems: 'center', justifyContent: 'center',
        ...(bordered ? { borderWidth: 1, borderColor: tint(color, '66') } : null),
      }}
    >
      <Ionicons name={icon} size={iconSize} color={color} />
    </View>
  );
}

/** Tiêu đề mục: thanh accent màu ở đầu + chữ 18 bold (+ phụ đề tuỳ chọn) */
export function SectionTitle({
  title, subtitle, color = Colors.primary, style, right,
}: {
  title: string;
  subtitle?: string;
  color?: string;
  style?: object;
  right?: React.ReactNode;
}) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 10 }, style]}>
      <View style={{ width: 5, height: 24, borderRadius: 3, backgroundColor: color }} />
      <View style={{ flex: 1 }}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {!!subtitle && <Text style={{ fontSize: 13, color: Colors.subtext, marginTop: 1 }}>{subtitle}</Text>}
      </View>
      {right}
    </View>
  );
}

/** Đầu màn hình: [nút quay lại tuỳ chọn] + ô icon màu + tiêu đề lớn + phụ đề */
export function ScreenHeader({
  title, subtitle, icon, color = Colors.primary, onBack,
}: {
  title: string;
  subtitle?: string;
  icon?: IconName;
  color?: string;
  onBack?: () => void;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      {!!onBack && (
        <TouchableOpacity
          onPress={onBack}
          hitSlop={8}
          style={{
            width: 40, height: 40, borderRadius: 20, backgroundColor: '#fff',
            alignItems: 'center', justifyContent: 'center', ...cardShadow,
          }}
        >
          <Ionicons name="chevron-back" size={22} color={Colors.primaryDark} />
        </TouchableOpacity>
      )}
      {icon ? (
        <IconTile icon={icon} color={color} size={46} iconSize={23} />
      ) : (
        <View style={{ width: 6, height: 46, borderRadius: 3, backgroundColor: color }} />
      )}
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, { fontSize: 25 }]}>{title}</Text>
        {!!subtitle && <Text style={[styles.subtitle, { fontSize: 13.5 }]}>{subtitle}</Text>}
      </View>
    </View>
  );
}

export function StatusBadge({ status, lentInfo }: { status: string; lentInfo?: string }) {
  const color = statusColor(status);
  return (
    <View
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 6,
        backgroundColor: tint(color), borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4,
        alignSelf: 'flex-start',
      }}
    >
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ color, fontSize: 12, fontWeight: '700' }}>
        {statusLabel(status)}{lentInfo ? ` ${lentInfo}` : ''}
      </Text>
    </View>
  );
}

export function ItemCard({
  item, breadcrumb, thumbUri, onPress,
}: {
  item: Item;
  breadcrumb: string;
  thumbUri?: string | null;
  onPress: () => void;
}) {
  const color = categoryColor(item.category);
  const lang = useAppStore((s) => s.lang);
  // Huy hiệu cảnh báo theo hạn dùng (4 mức). ItemCard không có dữ liệu khoản vay
  // nên huy hiệu hạn trả không dựng ở đây — hạn trả hiện ở Trang chủ / tab Cho mượn /
  // banner chi tiết đồ. Món đang hoãn nhắc hoặc không còn hoạt động thì ẩn huy hiệu.
  const alertCfg = getCachedAlertSettings();
  const expiryAlert =
    (item.status === 'STORED' || item.status === 'IN_USE') && !isAlertSnoozed(item.alert_snoozed_until)
      ? getAlertTier(item.expiry_date, alertCfg.soonDays, alertCfg.watchDays)
      : null;
  const alertColor = expiryAlert ? alertTierColor(expiryAlert.tier, expiryAlert.days) : null;
  return (
    <TouchableOpacity style={[styles.card, { flexDirection: 'row', gap: 11, alignItems: 'center', padding: 12 }]} onPress={onPress} activeOpacity={0.8}>
      {thumbUri ? (
        <Image source={{ uri: thumbUri }} style={{ width: 56, height: 56, borderRadius: 17, borderWidth: 1, borderColor: tint(color, '55') }} />
      ) : (
        <IconTile icon={categoryIcon(item.category)} color={color} size={56} iconSize={27} bordered />
      )}
      <View style={{ flex: 1, gap: 5 }}>
        <Text style={{ fontSize: 15, fontWeight: '700', color: Colors.text }} numberOfLines={1}>{item.name}</Text>
        {!!breadcrumb && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Ionicons name="location" size={13} color={color} />
            <Text style={{ fontSize: 13, color: Colors.subtext, flex: 1 }} numberOfLines={1}>{breadcrumb}</Text>
          </View>
        )}
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <StatusBadge status={item.status} />
          {item.quantity > 1 && <Text style={{ fontSize: 12, color: Colors.subtext, fontWeight: '600' }}>{translate(lang, 'common.qty', { n: item.quantity, unit: item.unit })}</Text>}
          {expiryAlert && alertColor && (
            <View
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 4,
                backgroundColor: tint(alertColor), borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3,
              }}
            >
              <Ionicons name={alertTierIcon(expiryAlert.tier)} size={11} color={alertColor} />
              <Text style={{ fontSize: 11.5, fontWeight: '800', color: alertColor }}>
                {expiryAlert.tier === 'OVERDUE'
                  ? translate(lang, 'alerts.badgeOverdue', { d: -expiryAlert.days })
                  : expiryAlert.tier === 'DUE'
                    ? translate(lang, 'alerts.badgeDueToday')
                    : expiryAlert.tier === 'SOON'
                      ? translate(lang, 'alerts.badgeDaysLeft', { d: expiryAlert.days })
                      : translate(lang, 'alerts.badgeWatch', { d: expiryAlert.days })}
              </Text>
            </View>
          )}
        </View>
      </View>
      <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: tint(color), alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name="chevron-forward" size={16} color={color} />
      </View>
    </TouchableOpacity>
  );
}

/** Ảnh hiện trường có chấm ghim nhấp nháy; cho phép chạm để đặt ghim khi editable */
export function SceneImage({
  uri, pin, editable, onPinChange, height = 260,
}: {
  uri: string;
  pin?: { x: number; y: number } | null;
  editable?: boolean;
  onPinChange?: (pin: { x: number; y: number }) => void;
  height?: number;
}) {
  const [pulse] = React.useState(() => new Animated.Value(1));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.7, duration: 800, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const [size, setSize] = React.useState({ w: 0, h: 0 });
  const lang = useAppStore((s) => s.lang);

  return (
    <Pressable
      style={{ borderRadius: 20, overflow: 'hidden', backgroundColor: '#000' }}
      onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      onPress={(e) => {
        if (!editable || !onPinChange || size.w === 0) return;
        const { locationX, locationY } = e.nativeEvent;
        onPinChange({
          x: Math.min(1, Math.max(0, locationX / size.w)),
          y: Math.min(1, Math.max(0, locationY / size.h)),
        });
      }}
    >
      <Image source={{ uri }} style={{ width: '100%', height }} resizeMode="cover" />
      {pin && size.w > 0 && (
        <View style={{ position: 'absolute', left: pin.x * size.w - 11, top: pin.y * size.h - 11, alignItems: 'center', justifyContent: 'center' }}>
          <Animated.View
            style={{
              position: 'absolute', width: 22, height: 22, borderRadius: 11,
              backgroundColor: 'rgba(255,90,118,0.4)', transform: [{ scale: pulse }],
            }}
          />
          <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: Colors.accent, borderWidth: 2, borderColor: '#fff' }} />
        </View>
      )}
      {editable && (
        <View style={{ position: 'absolute', bottom: 8, alignSelf: 'center', backgroundColor: 'rgba(36,18,84,0.65)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 }}>
          <Text style={{ color: '#fff', fontSize: 12 }}>{translate(lang, 'ui.tapToPin')}</Text>
        </View>
      )}
    </Pressable>
  );
}

export function LocationPickerModal({
  visible, locations, title, onClose, onSelect, excludeId,
}: {
  visible: boolean;
  locations: Location[];
  title: string;
  onClose: () => void;
  onSelect: (loc: Location) => void;
  excludeId?: string;
}) {
  const byParent = new Map<string | null, Location[]>();
  for (const l of locations) {
    const arr = byParent.get(l.parent_id) ?? [];
    arr.push(l);
    byParent.set(l.parent_id, arr);
  }
  const flat: { loc: Location; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const l of byParent.get(parentId) ?? []) {
      flat.push({ loc: l, depth });
      walk(l.id, depth + 1);
    }
  };
  walk(null, 0);
  const lang = useAppStore((s) => s.lang);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.screen, { paddingTop: 50 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, marginBottom: 8, gap: 12 }}>
          <View style={{ width: 5, height: 30, borderRadius: 3, backgroundColor: Colors.primary }} />
          <Text style={[styles.title, { flex: 1, fontSize: 24 }]}>{title}</Text>
          <TouchableOpacity
            onPress={onClose}
            hitSlop={10}
            style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: Colors.chipBg, alignItems: 'center', justifyContent: 'center' }}
          >
            <Ionicons name="close" size={22} color={Colors.primaryDark} />
          </TouchableOpacity>
        </View>
        <FlatList
          data={flat.filter(({ loc }) => loc.id !== excludeId)}
          keyExtractor={({ loc }) => loc.id}
          contentContainerStyle={{ padding: 18, gap: 10 }}
          renderItem={({ item: { loc, depth } }) => (
            <TouchableOpacity
              style={[styles.card, { marginLeft: depth * 16, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 }]}
              onPress={() => { onSelect(loc); onClose(); }}
            >
              <IconTile
                icon={locationIconName(loc)}
                color={LOCATION_TYPE_COLORS[loc.type]}
                size={44}
                iconSize={22}
              />
              <Text style={{ fontSize: 15, fontWeight: '600', color: Colors.text }}>{loc.name}</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={<Text style={styles.empty}>{translate(lang, 'ui.noLocations')}</Text>}
        />
      </View>
    </Modal>
  );
}

export function PriceText({ value }: { value: number | null }) {
  if (value == null) return null;
  return <Text style={{ fontSize: 13, color: Colors.subtext }}>{formatVND(value)}</Text>;
}

// ---------- Nút chuẩn v5 + Trường form chuẩn ----------

export type AppButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

/**
 * Nút chuẩn toàn app: cao 52, radius 16, icon + chữ luôn căn giữa tuyệt đối
 * (flexDirection row, alignItems/justifyContent center, gap 8, lineHeight rõ ràng).
 * `loading` là props mở rộng: hiện vòng xoay thay cho icon + chữ khi đang xử lý.
 */
export function AppButton({
  title, onPress, icon, variant = 'primary', disabled, loading, style,
}: {
  title: string;
  onPress?: () => void;
  icon?: IconName;
  variant?: AppButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle | ViewStyle[];
}) {
  const palette = {
    primary: {
      backgroundColor: Colors.primary, color: '#fff',
      shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.28, shadowRadius: 12, elevation: 5,
    },
    secondary: {
      backgroundColor: '#fff', color: Colors.primaryDark,
      borderWidth: 1.5, borderColor: Colors.border, ...cardShadow,
    },
    danger: { backgroundColor: tint(Colors.danger), color: Colors.danger },
    ghost: { backgroundColor: 'transparent', color: Colors.subtext },
  }[variant] as ViewStyle & { color: string };
  const { color, ...surface } = palette;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.85}
      style={[
        {
          height: 52, borderRadius: 16, paddingHorizontal: 18,
          flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
          opacity: disabled ? 0.55 : 1,
        },
        surface,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={color} />
      ) : (
        <>
          {!!icon && <Ionicons name={icon} size={20} color={color} style={{ lineHeight: 20 }} />}
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.75}
            style={{ color, fontSize: 16, fontWeight: '700', lineHeight: 22, flexShrink: 1 }}
          >
            {title}
          </Text>
        </>
      )}
    </TouchableOpacity>
  );
}

/** Trường form chuẩn: nhãn 13/800 phía trên, gợi ý nhỏ phía dưới, khoảng cách thống nhất */
export function Field({
  label, hint, children, style,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
}) {
  return (
    <View style={[{ gap: 7 }, style]}>
      <Text style={{ fontSize: 13, fontWeight: '800', letterSpacing: 0.4, color: Colors.text }}>{label}</Text>
      {children}
      {!!hint && <Text style={{ fontSize: 12, color: Colors.subtext, lineHeight: 17 }}>{hint}</Text>}
    </View>
  );
}

// ---------- Thêm phân loại / trạng thái / tình trạng tự tạo ----------

export const TERM_ICON_CHOICES: IconName[] = [
  'cube-outline', 'bulb-outline', 'tv-outline', 'shirt-outline', 'book-outline',
  'football-outline', 'game-controller-outline', 'musical-notes-outline',
  'car-outline', 'paw-outline', 'briefcase-outline', 'gift-outline',
  'heart-outline', 'star-outline',
];

export const TERM_COLOR_CHOICES: string[] = [
  Colors.primary, Colors.coral, Colors.orange, Colors.teal,
  Colors.sky, Colors.pink, Colors.yellow, Colors.green,
];

export type TermKind = 'CATEGORY' | 'STATUS' | 'CONDITION';

/**
 * Lưới chọn icon dùng chung (AddTermModal + chọn icon vị trí).
 * - value: icon đang chọn; null chỉ có nghĩa khi showDefaultOption = true.
 * - showDefaultOption: thêm ô đầu tiên "Mặc định theo loại" (giá trị null).
 * - color: màu nhấn cho trạng thái đang chọn (mặc định tím chủ đạo).
 */
export function IconPickerGrid({
  value, onChange, color = Colors.primary, showDefaultOption = false,
}: {
  value: IconName | null;
  onChange: (icon: IconName | null) => void;
  color?: string;
  showDefaultOption?: boolean;
}) {
  const lang = useAppStore((s) => s.lang);
  const cellStyle = (selected: boolean) => ({
    width: 44, height: 44, borderRadius: 14, alignItems: 'center' as const, justifyContent: 'center' as const,
    backgroundColor: selected ? tint(color) : '#fff',
    borderWidth: 1.5, borderColor: selected ? color : Colors.border,
  });
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {showDefaultOption && (
        <TouchableOpacity
          onPress={() => onChange(null)}
          style={[
            cellStyle(value === null),
            { width: undefined, paddingHorizontal: 12, flexDirection: 'row', gap: 6 },
          ]}
        >
          <Ionicons name="shapes-outline" size={20} color={value === null ? color : Colors.subtext} />
          <Text style={{ fontSize: 12.5, fontWeight: '700', color: value === null ? color : Colors.subtext }}>
            {translate(lang, 'locations.iconDefault')}
          </Text>
        </TouchableOpacity>
      )}
      {TERM_ICON_CHOICES.map((ic) => (
        <TouchableOpacity
          key={ic}
          onPress={() => onChange(ic)}
          style={cellStyle(value === ic)}
        >
          <Ionicons name={ic} size={22} color={value === ic ? color : Colors.subtext} />
        </TouchableOpacity>
      ))}
    </View>
  );
}

export function AddTermModal({
  visible, kind, onClose, onAdded,
}: {
  visible: boolean;
  kind: TermKind;
  onClose: () => void;
  onAdded?: (term: CustomTerm) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        {/* Bấm ra ngoài thẻ để đóng */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        {/* Form chỉ mount khi modal mở => state luôn mới, không cần reset bằng effect */}
        {visible && <AddTermForm kind={kind} onClose={onClose} onAdded={onAdded} />}
      </View>
    </Modal>
  );
}

function AddTermForm({
  kind, onClose, onAdded,
}: {
  kind: TermKind;
  onClose: () => void;
  onAdded?: (term: CustomTerm) => void;
}) {
  const { t } = useT();
  const addCategory = useAppStore((s) => s.addCategory);
  const addStatus = useAppStore((s) => s.addStatus);
  const addCondition = useAppStore((s) => s.addCondition);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<IconName>('cube-outline');
  const [color, setColor] = useState<string>(Colors.primary);
  const [saving, setSaving] = useState(false);

  const titleKey = kind === 'CATEGORY' ? 'addTerm.catTitle' : kind === 'STATUS' ? 'addTerm.statusTitle' : 'addTerm.condTitle';
  const placeholderKey = kind === 'CATEGORY' ? 'addTerm.catPlaceholder' : kind === 'STATUS' ? 'addTerm.statusPlaceholder' : 'addTerm.condPlaceholder';
  const noNameKey = kind === 'CATEGORY' ? 'addTerm.noCatName' : kind === 'STATUS' ? 'addTerm.noStatusName' : 'addTerm.noCondName';

  async function handleSave() {
    if (!name.trim()) {
      Alert.alert(t('addTerm.noNameTitle'), t(noNameKey));
      return;
    }
    setSaving(true);
    try {
      const term = kind === 'CATEGORY'
        ? await addCategory(name.trim(), icon, color)
        : kind === 'STATUS'
          ? await addStatus(name.trim(), icon, color)
          : await addCondition(name.trim(), icon, color);
      onAdded?.(term);
      onClose();
    } catch (e) {
      Alert.alert(t('addTerm.saveFailTitle'), e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
        <View style={[styles.card, styles.modalCard, { gap: 14 }]}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: Colors.text }}>
            {t(titleKey)}
          </Text>
          <TextInput
            style={styles.input}
            placeholder={t(placeholderKey)}
            placeholderTextColor={Colors.faint}
            value={name}
            onChangeText={setName}
            autoFocus
          />
          <View>
            <Text style={styles.label}>{t('addTerm.icon')}</Text>
            <IconPickerGrid
              value={icon}
              color={color}
              onChange={(ic) => { if (ic) setIcon(ic); }}
            />
          </View>
          <View>
            <Text style={styles.label}>{t('addTerm.color')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              {TERM_COLOR_CHOICES.map((c) => (
                <TouchableOpacity
                  key={c}
                  onPress={() => setColor(c)}
                  style={{
                    width: 34, height: 34, borderRadius: 17, backgroundColor: c,
                    borderWidth: color === c ? 3 : 0, borderColor: Colors.primaryDark,
                    alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  {color === c && <Ionicons name="checkmark" size={16} color="#fff" />}
                </TouchableOpacity>
              ))}
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <AppButton title={t('common.cancel')} variant="secondary" onPress={onClose} disabled={saving} style={{ flex: 1 }} />
            <AppButton title={t('common.save')} icon="checkmark-circle" onPress={handleSave} loading={saving} style={{ flex: 1 }} />
          </View>
        </View>
  );
}
