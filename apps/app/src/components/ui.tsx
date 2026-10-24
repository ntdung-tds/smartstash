import React, { useCallback, useEffect, useRef, useState } from "react";
import { Image as ExpoImage } from 'expo-image';
import {
  View, Text, StyleSheet, TouchableOpacity, Image, Animated, Modal, FlatList, Pressable, TextInput,
  ActivityIndicator, ScrollView, useWindowDimensions, type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { CustomTerm, Item, Location, LocationType } from '../types';
import { LOCATION_TYPE_BY_DEPTH } from '../types';
import {
  formatVND, getAlertTier, isAlertSnoozed,
  parseDisplayDate, formatDisplayDate, formatDateForLang, addDaysISO, localTodayISO, maskDateInput,
} from '../utils';
import {
  Colors, Radius, cardShadow, floatingShadow, tint,
  categoryColor, categoryIcon, statusColorFor, statusIcon, statusLabel,
  alertTierColor, alertTierIcon,
  LOCATION_TYPE_COLORS, locationIconName, locationTypeLabel,
  type IconName,
} from '../theme';
import { getCachedAlertSettings } from '../services/alertSettings';
import { createLocation, countLocations } from '../db/queries';
import { getCurrentLimits } from '../services/planService';
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
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '700', lineHeight: 21 },
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
        {statusLabel(status)}
        {!!lentInfo && (
          <Text style={{ fontWeight: '800' }}>{` ${lentInfo}`}</Text>
        )}
      </Text>
    </View>
  );
}

/**
 * Cụm số lượng có phân cấp chữ: NHÃN mờ thường, SỐ đậm màu chữ chính.
 * - Bình thường: "SL {total} {đơn vị}".
 * - Có phần đang ở ngoài (lentOut/consignedOut > 0): hiện đủ cơ cấu
 *   "Tổng {total} {đơn vị} · Đang mượn {lentOut} · Đang gửi bán {consignedOut}
 *   (chỉ khi > 0) · Ở nhà {available}".
 * Dùng chung cho thẻ món (ItemCard) và đầu màn chi tiết đồ để nhất quán.
 */
export function QtyBreakdown({
  total, unit, lentOut = 0, consignedOut = 0, size = 13,
}: {
  total: number;
  unit: string;
  lentOut?: number;
  consignedOut?: number;
  size?: number;
}) {
  const lang = useAppStore((s) => s.lang);
  const out = lentOut + consignedOut;
  const num = (n: number) => (
    <Text style={{ color: Colors.text, fontWeight: '800' }}>{n}</Text>
  );
  if (out <= 0) {
    return (
      <Text style={{ fontSize: size, color: Colors.subtext, lineHeight: size + 6 }}>
        {translate(lang, 'qty.sl')} {num(total)} {unit}
      </Text>
    );
  }
  const available = Math.max(0, total - out);
  return (
    <Text style={{ fontSize: size, color: Colors.subtext, lineHeight: size + 6 }}>
      {translate(lang, 'qty.total')} {num(total)} {unit}
      {lentOut > 0 && (
        <Text>
          {' · '}{translate(lang, 'qty.lentOut')} {num(lentOut)}
        </Text>
      )}
      {consignedOut > 0 && (
        <Text>
          {' · '}{translate(lang, 'qty.consignedOut')} {num(consignedOut)}
        </Text>
      )}
      <Text>
        {' · '}{translate(lang, 'qty.atHome')} {num(available)}
      </Text>
    </Text>
  );
}

export function ItemCard({
  item, breadcrumb, thumbUri, onPress, outInfo,
}: {
  item: Item;
  breadcrumb: string;
  thumbUri?: string | null;
  onPress: () => void;
  /**
   * Cơ cấu đang ở ngoài của món, do màn cha tính từ loans ACTIVE đã tải sẵn
   * (không truyền thì thẻ chỉ hiện tổng số — vd màn chi tiết vị trí không
   * tải loans). consignedOut chỉ > 0 khi mô hình dữ liệu có gửi bán.
   */
  outInfo?: { lentOut: number; consignedOut: number } | null;
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
        {/* Dòng vị trí: LUÔN chiếm chỗ (mọi món đều có vị trí) để thẻ đồng đều */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Ionicons name="location" size={13} color={color} />
          <Text style={{ fontSize: 13, color: Colors.subtext, flex: 1 }} numberOfLines={1}>{breadcrumb}</Text>
        </View>
        {/* Dòng số lượng: LUÔN hiển thị ở mọi thẻ, chiếm 1 dòng cố định —
            SL 1 hiện "SL 1 {đơn vị}", có phần ở ngoài hiện cơ cấu đầy đủ */}
        <QtyBreakdown
          total={item.quantity}
          unit={item.unit}
          lentOut={outInfo?.lentOut ?? 0}
          consignedOut={outInfo?.consignedOut ?? 0}
          size={12.5}
        />
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <StatusBadge
            status={item.status}
            lentInfo={item.status === 'PARTIALLY_LENT' && outInfo && outInfo.lentOut > 0 ? `${outInfo.lentOut}/${item.quantity}` : undefined}
          />
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

/**
 * Form tạo vị trí DÙNG CHUNG mở từ các màn chọn vị trí (LocationPickerModal):
 * cùng một khuôn với form tạo ở tab Vị trí — tên bắt buộc, icon tự chọn
 * (IconPickerGrid), loại vị trí suy từ độ sâu của vị trí cha
 * (LOCATION_TYPE_BY_DEPTH), trần số vị trí theo gói, lỗi/trần gói báo qua
 * AppPopup và GIỮ NGUYÊN form để sửa tiếp. Khác biệt duy nhất: vị trí cha
 * được CHỌN ngay trong form này (ở tab Vị trí, cha đến từ nút "+" của đúng
 * hàng đó); cấp sâu nhất (Vật chứa) không nhận con nên không hiện trong
 * danh sách cha. Tạo xong trả vị trí mới qua onCreated để nơi gọi tự chọn
 * ngay — không rời khỏi luồng đang làm dở.
 */
export function CreateLocationModal({
  visible, locations, onClose, onCreated,
}: {
  visible: boolean;
  locations: Location[];
  onClose: () => void;
  onCreated: (loc: Location) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<IconName | null>(null);
  const [parentId, setParentId] = useState<string | null>(null);
  const [parentOpen, setParentOpen] = useState(false);
  const [info, setInfo] = useState<{ title: string; message?: string } | null>(null);
  const [creating, setCreating] = useState(false);
  // State làm mới mỗi lần mở nhờ nơi dùng remount bằng key (như StatusNoteModal)
  // TỰ FOCUS ô Tên mỗi khi modal mở: autoFocus trên TextInput mới chỉ
  // chạy ở lần mount đầu; ref + effect theo visible đảm bảo mọi lần mở
  // (kể cả nơi dùng không remount) bàn phím đều sẵn sàng ở ô Tên
  const nameInputRef = useRef<React.ElementRef<typeof TextInput>>(null);
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => nameInputRef.current?.focus(), 150);
    return () => clearTimeout(timer);
  }, [visible]);

  // Cây vị trí phẳng kèm độ sâu (cùng cách duyệt của LocationPickerModal)
  const byParent = new Map<string | null, Location[]>();
  for (const l of locations) {
    const arr = byParent.get(l.parent_id) ?? [];
    arr.push(l);
    byParent.set(l.parent_id, arr);
  }
  const flat: { loc: Location; depth: number }[] = [];
  const walk = (pid: string | null, depth: number) => {
    for (const l of byParent.get(pid) ?? []) {
      flat.push({ loc: l, depth });
      walk(l.id, depth + 1);
    }
  };
  walk(null, 0);
  const parent = parentId ? locations.find((l) => l.id === parentId) ?? null : null;
  const parentDepth = parent ? flat.find((f) => f.loc.id === parent.id)?.depth ?? 0 : -1;
  const derivedType: LocationType = LOCATION_TYPE_BY_DEPTH[Math.min(3, parentDepth + 1)];
  const parentOptions = flat.filter(({ depth }) => depth <= 2);

  async function handleCreate() {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const total = await countLocations();
      if (total >= getCurrentLimits().maxLocations) {
        setInfo({ title: t('loc.limitTitle'), message: t('loc.limitLocMsg', { n: getCurrentLimits().maxLocations }) });
        return;
      }
      const created = await createLocation({
        name: name.trim(),
        type: derivedType,
        parent_id: parent?.id ?? null,
        icon,
      });
      onCreated(created);
    } catch (e) {
      setInfo({ title: t('loc.createFail'), message: e instanceof Error ? e.message : String(e) });
    } finally {
      setCreating(false);
    }
  }

  const parentRow = (loc: Location | null, depth: number) => {
    const selected = (loc?.id ?? null) === parentId;
    return (
      <TouchableOpacity
        key={loc?.id ?? 'root'}
        onPress={() => { setParentId(loc?.id ?? null); setParentOpen(false); }}
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 10,
          paddingVertical: 9, paddingHorizontal: 12, marginLeft: depth * 14,
          backgroundColor: selected ? tint(Colors.primary) : 'transparent',
        }}
      >
        <Ionicons
          name={loc ? locationIconName(loc) : 'home-outline'}
          size={18}
          color={loc ? LOCATION_TYPE_COLORS[loc.type] : Colors.primary}
        />
        <Text style={{ flex: 1, fontSize: 14.5, fontWeight: selected ? '700' : '500', color: Colors.text }}>
          {loc ? loc.name : t('loc.parentRoot')}
        </Text>
        {selected && <Ionicons name="checkmark" size={18} color={Colors.primary} />}
      </TouchableOpacity>
    );
  };

  return (
    <>
      <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
        <View style={styles.modalOverlay}>
          <View style={[styles.card, styles.modalCard, { maxHeight: '92%' }]}>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 14 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: Colors.text }}>
                {parent ? t('loc.modalIn', { name: parent.name }) : t('loc.modalNew')}
              </Text>
              <TextInput ref={nameInputRef} style={styles.input} placeholder={t('loc.namePlaceholder')} value={name} onChangeText={setName} autoFocus />
              <View>
                <Text style={styles.label}>{t('loc.parentLabel')}</Text>
                <TouchableOpacity
                  style={[styles.input, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}
                  onPress={() => setParentOpen((v) => !v)}
                >
                  <Text style={{ fontSize: 15.5, color: parent ? Colors.text : Colors.faint }}>
                    {parent ? parent.name : t('loc.parentRoot')}
                  </Text>
                  <Ionicons name={parentOpen ? 'chevron-up' : 'chevron-down'} size={18} color={Colors.subtext} />
                </TouchableOpacity>
                {parentOpen && (
                  <View style={{ marginTop: 8, borderWidth: 1.5, borderColor: '#E7E2F6', borderRadius: 14, overflow: 'hidden' }}>
                    <ScrollView nestedScrollEnabled style={{ maxHeight: 216 }}>
                      {parentRow(null, 0)}
                      {parentOptions.map(({ loc, depth }) => parentRow(loc, depth))}
                    </ScrollView>
                  </View>
                )}
                <Text style={{ fontSize: 12.5, color: Colors.subtext, marginTop: 6 }}>
                  {locationTypeLabel(derivedType)}
                </Text>
              </View>
              <View>
                <Text style={styles.label}>{t('locations.iconLabel')}</Text>
                <IconPickerGrid value={icon} onChange={setIcon} showDefaultOption />
              </View>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <TouchableOpacity style={[styles.buttonSecondary, { flex: 1 }]} onPress={onClose}>
                  <Text style={styles.buttonSecondaryText}>{t('common.cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.button, { flex: 1 }]} onPress={() => { handleCreate().catch(() => {}); }}>
                  <Text style={styles.buttonText}>{t('common.create')}</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
      <AppPopup
        visible={!!info}
        title={info?.title ?? ''}
        message={info?.message}
        okLabel={t('common.gotIt')}
        onClose={() => setInfo(null)}
      />
    </>
  );
}

export function LocationPickerModal({
  visible, locations, title, onClose, onSelect, excludeId, allowCreate,
}: {
  visible: boolean;
  locations: Location[];
  title: string;
  onClose: () => void;
  onSelect: (loc: Location) => void;
  excludeId?: string;
  /** Hiện mục "＋ Thêm vị trí mới" ở đầu danh sách: tạo xong TỰ CHỌN vị trí mới và đóng picker */
  allowCreate?: boolean;
}) {
  const [showCreate, setShowCreate] = useState(false);
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
    <>
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
            ListHeaderComponent={allowCreate ? (
              <TouchableOpacity
                onPress={() => setShowCreate(true)}
                activeOpacity={0.85}
                style={{
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
                  borderWidth: 1.5, borderStyle: 'dashed', borderColor: Colors.primary,
                  backgroundColor: tint(Colors.primary), borderRadius: 16, paddingVertical: 14,
                }}
              >
                <Ionicons name="add-circle-outline" size={21} color={Colors.primary} />
                <Text style={{ fontSize: 15.5, fontWeight: '700', color: Colors.primary }}>{translate(lang, 'loc.addNew')}</Text>
              </TouchableOpacity>
            ) : undefined}
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
      {allowCreate && (
        <CreateLocationModal
          key={showCreate ? 'create-open' : 'create-closed'}
          visible={showCreate}
          locations={locations}
          onClose={() => setShowCreate(false)}
          onCreated={(loc) => { setShowCreate(false); onSelect(loc); onClose(); }}
        />
      )}
    </>
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
 * THANG CHỮ NÚT TOÀN APP (neo theo component này): nút chính/phụ 15px/700;
 * nút nhỏ/gọn 13.5px; chip/pill lọc ≥ 12px — cùng một vai trò thì cùng một
 * cỡ ở mọi màn, không tự chế cỡ riêng.
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
            style={{ color, fontSize: 15, fontWeight: '700', lineHeight: 21, flexShrink: 1 }}
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

// ---------- Ô nhập số lượng cho form đồ vật (thêm/sửa) ----------

/**
 * Ô nhập số lượng của form thêm/sửa đồ vật. Số lượng là trường BẮT BUỘC
 * nên component này KHÁC QtyStepper của các luồng mượn (cái đó luôn kẹp
 * 1..max, không có trạng thái trống): ở đây giá trị là chuỗi thô do form
 * giữ, '' = chưa nhập (không mặc định 1 im lặng), CHỈ một ô nhập số trực
 * tiếp (bàn phím số, tự lọc chỉ giữ chữ số khi gõ — không còn nút − / +
 * hai bên theo phản hồi người dùng). Việc chặn lưu + báo lỗi khi trống/0
 * là của form gọi: form truyền invalid để viền ô đỏ và tự render dòng lỗi
 * cạnh trường.
 */
export function QtyInput({
  value, onChangeText, placeholder, invalid, inputRef,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  invalid?: boolean;
  /** Ref tới ô nhập bên trong — form dùng để TỰ FOCUS khi validate lỗi tại trường này */
  inputRef?: React.Ref<React.ElementRef<typeof TextInput>>;
}) {
  return (
    <TextInput
      ref={inputRef}
      style={[styles.input, { textAlign: 'center' }, invalid ? { borderColor: Colors.danger } : null]}
      keyboardType="number-pad"
      value={value}
      onChangeText={(v) => onChangeText(v.replace(/\D/g, '').slice(0, 6))}
      placeholder={placeholder}
      placeholderTextColor={Colors.faint}
    />
  );
}

// ---------- Bản đồ xem trước OpenStreetMap (dùng chung) ----------

const OSM_TILE_SIZE = 256;

/**
 * Bản đồ xem trước bằng ảnh ô gạch OpenStreetMap (slippy map — không cần
 * API key, không thêm thư viện native như react-native-maps). Component
 * dùng chung, trích từ trang chi tiết vị trí; trang giới thiệu cũng dùng:
 * - Toạ độ được đổi sang toạ độ ô gạch PHÂN SỐ ở mức zoom:
 *   x = (lng + 180) / 360 · 2^z;
 *   y = (1 − ln(tan φ + sec φ) / π) / 2 · 2^z  (φ = vĩ độ theo radian).
 * - Điểm neo: điểm toạ độ được đặt ĐÚNG GIỮA khung — mỗi ô gạch (tx, ty)
 *   được đặt tuyệt đối tại left = (tx − xFloat)·256 + bềRộngKhung/2,
 *   top = (ty − yFloat)·256 + chiềuCaoKhung/2. Tập ô được dựng là tập
 *   TỐI THIỂU giao với cửa sổ nhìn để khung luôn kín, không lộ khoảng
 *   trống ở mép khi điểm toạ độ ở gần biên ô.
 * - Ô gạch x được bọc modulo 2^z (qua kinh tuyến 180°), y ngoài
 *   [0, 2^z) thì bỏ (gần cực không có ô).
 * - Ô nào tải lỗi (mất mạng…) thì ẩn CẢ khung (trả null) — nơi dùng tự
 *   quyết định hiển thị dự phòng. Cha remount bằng key theo lat/lng nếu
 *   muốn dựng lại khi toạ độ đổi.
 * - Mặc định (không truyền thêm prop): khung cao 190, zoom 16, có ghim
 *   giữa, bấm vào = onPress — ĐÚNG hành vi gốc ở chi tiết vị trí.
 *   `showPin={false}` khi nơi dùng tự vẽ ghim riêng (vd ghim động ở
 *   trang giới thiệu); `interactive={false}` khi chỉ để ngắm.
 */
export function OsmMapPreview({
  lat, lng, onPress, height = 190, zoom = 16, showPin = true, interactive = true,
}: {
  lat: number;
  lng: number;
  onPress?: () => void;
  /** Chiều cao khung (mặc định 190 như ở chi tiết vị trí) */
  height?: number;
  /** Mức zoom slippy map (mặc định 16) */
  zoom?: number;
  /** Hiện ghim ở chính giữa khung (mặc định có) */
  showPin?: boolean;
  /** false = chỉ hiển thị, không bắt chạm (vd trang giới thiệu) */
  interactive?: boolean;
}) {
  const [frameW, setFrameW] = useState(0);
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  const n = 2 ** zoom;
  const xFloat = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yFloat = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const tiles: { key: string; url: string; left: number; top: number }[] = [];
  if (frameW > 0) {
    const xFrom = Math.floor(xFloat - frameW / 2 / OSM_TILE_SIZE);
    const xTo = Math.floor(xFloat + frameW / 2 / OSM_TILE_SIZE);
    const yFrom = Math.floor(yFloat - height / 2 / OSM_TILE_SIZE);
    const yTo = Math.floor(yFloat + height / 2 / OSM_TILE_SIZE);
    for (let tx = xFrom; tx <= xTo; tx++) {
      for (let ty = yFrom; ty <= yTo; ty++) {
        if (ty < 0 || ty >= n) continue;
        const wrappedX = ((tx % n) + n) % n;
        tiles.push({
          key: `${tx}:${ty}`,
          url: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${ty}.png`,
          left: (tx - xFloat) * OSM_TILE_SIZE + frameW / 2,
          top: (ty - yFloat) * OSM_TILE_SIZE + height / 2,
        });
      }
    }
  }
  const content = (
    <>
      {tiles.map((tile) => (
        <Image
          key={tile.key}
          source={{ uri: tile.url, headers: { 'User-Agent': 'SmartStash/0.1 (personal item tracker)' } }}
          style={{ position: 'absolute', left: tile.left, top: tile.top, width: OSM_TILE_SIZE, height: OSM_TILE_SIZE }}
          onError={() => setFailed(true)}
        />
      ))}
      {/* Ghim ở chính giữa khung = đúng điểm toạ độ (đầu nhọn của icon
          chạm vào điểm giữa: icon 26px, nhọn ở gần đáy) */}
      {showPin && (
        <View pointerEvents="none" style={{ position: 'absolute', left: '50%', top: '50%', marginLeft: -13, marginTop: -24 }}>
          <Ionicons name="location" size={26} color={Colors.coral} />
        </View>
      )}
      {/* Ghi nguồn bắt buộc theo giấy phép OpenStreetMap */}
      <View pointerEvents="none" style={{ position: 'absolute', right: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.78)', paddingHorizontal: 5, paddingVertical: 1 }}>
        <Text style={{ fontSize: 9.5, color: '#555' }}>© OpenStreetMap contributors</Text>
      </View>
    </>
  );
  const frameStyle = { height, borderRadius: 16, overflow: 'hidden' as const, backgroundColor: Colors.chipBg };
  if (!interactive) {
    return (
      <View onLayout={(e) => setFrameW(e.nativeEvent.layout.width)} style={frameStyle}>
        {content}
      </View>
    );
  }
  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={onPress}
      onLayout={(e) => setFrameW(e.nativeEvent.layout.width)}
      style={frameStyle}
    >
      {content}
    </TouchableOpacity>
  );
}

// ---------- Trình xem ảnh dùng chung (Thêm nhanh + Sửa đồ + Chi tiết) ----------

export interface PhotoGalleryEntry {
  key: string;
  /** URI cho thumbnail ở dải dưới */
  uri: string;
  /** URI độ phân giải đầy đủ cho khung ảnh lớn (thiếu thì dùng uri) */
  fullUri?: string;
  isPrimary?: boolean;
  /**
   * Ghim vị trí riêng của CHÍNH tấm ảnh này (chỉ bucket hiện trường mới
   * truyền): undefined = ảnh không thuộc bucket ghim; null = chưa ghim.
   * Mỗi ảnh hiện trường có một ghim độc lập, lưu trên chính hàng media đó.
   */
  pin?: { x: number; y: number } | null;
}

/** Chiều cao cố định của khung ảnh lớn — khung LUÔN có kích thước xác định
 *  trong ScrollView, không phụ thuộc việc ảnh đã tải xong hay chưa. */
const PHOTO_VIEWER_HEIGHT = 264;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Trình xem ảnh chuẩn cho cả 2 form (quick-add, edit), trang chi tiết
 * (mode 'detail') và cả 2 loại ảnh (đồ vật / hiện trường). Mỗi block là một
 * khối độc lập, không lồng chung container với block còn lại:
 * - Ảnh xem trước LỚN là một PAGER vuốt ngang (FlatList pagingEnabled):
 *   vuốt để chuyển ảnh, bấm thumbnail thì pager cuộn tới ảnh đó; thumbnail
 *   đang chọn + dòng chú thích luôn chạy theo ảnh đang xem. Khung cao cố
 *   định (PHOTO_VIEWER_HEIGHT), mỗi trang rộng đúng bề rộng khung đo bằng
 *   onLayout (getItemLayout), overflow hidden cắt mọi tràn. Vì mượt: chỉ
 *   ~3 trang quanh trang đang xem được dựng (windowSize /
 *   initialNumToRender / maxToRenderPerBatch = 3, removeClippedSubviews),
 *   mỗi trang là PhotoPage bọc React.memo với các callback ổn định
 *   (useCallback), đồng bộ lựa chọn chỉ chạy ở onMomentumScrollEnd, và
 *   ảnh lớn nạp qua expo-image (cache memory-disk, transition mờ 150ms)
 *   thay RN Image để giải mã không chặn cú vuốt.
 * - Dải thumbnail ngang bên dưới: mỗi ô có kích thước hộp cố định (không
 *   suy từ ảnh bên trong), ô đang chọn viền Colors.primary, nút ✕ đỏ ở
 *   góc trên phải — bấm mở AppPopup xác nhận rồi mới gọi onRemove (CHỈ ở
 *   chế độ 'edit'). Ở 'detail', thumbnail KHÔNG có nút xoá — xoá bằng
 *   nút THÙNG RÁC trên chính ảnh lớn (xem dưới).
 * - Thêm ảnh ở chế độ 'edit': HAI nút nét đứt nằm ở hàng CỐ ĐỊNH ngay
 *   DƯỚI dải thumbnail (luôn nhìn thấy, không phải cuộn ngang mới thấy
 *   như khi chúng là ô cuối dải): [Chụp ảnh] chạy onTake ngay, [Thêm từ
 *   thư viện] chạy onPick ngay (không qua popup trung gian), mang nhãn
 *   đầy đủ do call-site truyền (takeLabel/pickLabel); chạm trần thì hàng
 *   nút thay bằng dòng báo giới hạn của bucket.
 * - Chưa có ảnh (chế độ 'edit'): hai nút nét đứt cạnh nhau (Chụp / Chọn
 *   từ thư viện), bấm thẳng không popup.
 * - Ảnh đồ vật (có onSetPrimary): huy hiệu "Chính" trên ảnh chính (cả ảnh
 *   lớn lẫn thumbnail); chạm vào ẢNH LỚN mở popup "Đặt làm ảnh chính / Xoá".
 * - Ảnh hiện trường (entry có trường pin): MỖI ảnh có ghim riêng — chạm
 *   lên ảnh nào là đặt/di chuyển ghim của chính tấm đó (onPinChange),
 *   marker nhấp nháy vẽ theo ghim của từng tấm, huy hiệu ghim trên
 *   thumbnail của tấm đã ghim, chú thích "đã ghim / chưa ghim" theo tấm
 *   đang xem.
 * - Phân biệt CHẠM (ghim/mở popup) với VUỐT (chuyển ảnh) trong pager:
 *   FlatList chiếm cử chỉ ngay khi người dùng bắt đầu kéo — press của
 *   Pressable bị huỷ (responder terminated) nên onPress chỉ chạy cho cú
 *   chạm đứng yên, không bao giờ chạy giữa một cú vuốt.
 * - Ba chế độ qua prop `mode`:
 *   + 'edit' (form quick-add / edit): đầy đủ — ✕ xoá, popup Đặt ảnh
 *     chính/Xoá khi chạm ảnh lớn, hàng 2 nút thêm ảnh dưới dải, ghim
 *     (bucket hiện trường) chạm là đặt.
 *   + 'detail' (trang chi tiết đồ): KHÔNG đặt ảnh chính, nhưng XOÁ
 *     được ngay tại đây qua NÚT THÙNG RÁC TRÒN KÍNH TỐI (Mẫu B: nền
 *     rgba(24,17,52,0.44), viền trắng mờ, glyph trắng) ở góc trên phải
 *     của chính ẢNH LỚN trong pager — vuốt tới ảnh nào thì bấm
 *     thùng rác trên ảnh đó (popup xác nhận → onRemove, cùng logic hệ
 *     quả như màn Sửa do call-site đảm nhiệm); dưới dải
 *     thumbnail có nút "Thêm ảnh mới" mở AppPopup 2 lựa chọn (Chụp ảnh /
 *     Từ thư viện) rồi chạy onTake/onPick của call-site — thoát popup
 *     bằng nút ✕ góc trên-phải của AppPopup, không có lựa chọn "Bỏ qua";
 *     bucket
 *     hiện trường GHIM ĐƯỢC ngay tại đây qua onPinChange như ở form.
 *     Ở 'detail', huy hiệu ghim của bucket hiện trường dùng ĐÚNG chất
 *     liệu kính tối của nút thùng rác, nằm ở góc trên TRÁI, cùng hàng
 *     (top 10, cao 26) với nút tròn bên phải thành một cặp đồng bộ.
 *     Block rỗng vẫn render (khung trống + nút Thêm ảnh mới) để thêm
 *     được ảnh đầu tiên từ chi tiết. Call-site truyền focusKey = key của
 *     ảnh vừa thêm để gallery tự nhảy tới hiển thị ngay ảnh đó.
 *   + 'view' (chỉ xem thuần): ẩn mọi điều khiển sửa/xoá — chỉ xem;
 *     block rỗng không render.
 * - XEM TOÀN MÀN HÌNH (mọi chế độ có khung lớn): nút PHÓNG TO kính tối
 *   26px ở góc dưới-phải của mỗi trang pager mở Modal nền đen xem ảnh
 *   khổ lớn (vuốt ngang qua lại trong cùng block, chỉ số n/N, nút ✕
 *   đóng; trong viewer CHỈ xem — không nút sửa/xoá/ghim nào). Ngoài
 *   nút đó, CHẠM vào ảnh lớn cũng mở viewer ở những bề mặt mà cú chạm
 *   chưa gán thao tác khác (mode 'view'; ảnh đồ ở quick-add; ảnh đồ ở
 *   trang chi tiết) — bề mặt đã có thao tác chạm (ghim ảnh hiện
 *   trường, popup Đặt chính/Xoá ở form) GIỮ NGUYÊN thao tác đó và đi
 *   qua nút phóng to.
 */
export type PhotoGalleryMode = 'edit' | 'detail' | 'view';

/**
 * Một TRANG của pager ảnh lớn — tách ra component riêng bọc React.memo
 * để khi gallery render lại (đổi ảnh đang chọn, call-site render lại…)
 * các trang KHÔNG render lại nếu props không đổi: vuốt không bị khựng vì
 * phải dựng lại cây ảnh lớn giữa chừng. Mọi callback truyền xuống đều ổn
 * định (useCallback ở PhotoGallery), props còn lại là nguyên thuỷ/chuỗi.
 * Ảnh lớn dùng expo-image (cache memory-disk + transition mờ ngắn) cho
 * giải mã mượt hơn RN Image; các lớp phủ (ghim, huy hiệu, thùng rác) đều
 * pointerEvents="none" trừ chính nút thùng rác là touchable có chủ đích
 * — không lớp phủ nào chặn gesture vuốt của pager.
 */
const PhotoPage = React.memo(function PhotoPage({
  entry, frameW, mode, pulse, pinEnabled, canDelete,
  primaryLabel, pinnedLabel, tapToPinLabel, deleteLabel, expandLabel,
  onPressPage, onDeletePress, onExpandPress,
}: {
  entry: PhotoGalleryEntry;
  frameW: number;
  mode: PhotoGalleryMode;
  pulse: Animated.Value;
  pinEnabled: boolean;
  canDelete: boolean;
  primaryLabel: string;
  pinnedLabel: string;
  tapToPinLabel: string;
  deleteLabel: string;
  expandLabel: string;
  onPressPage: (entry: PhotoGalleryEntry, locationX: number, locationY: number) => void;
  onDeletePress: (entry: PhotoGalleryEntry) => void;
  onExpandPress: (entry: PhotoGalleryEntry) => void;
}) {
  return (
    <Pressable
      style={{ width: frameW, height: PHOTO_VIEWER_HEIGHT }}
      onPress={(e) => onPressPage(entry, e.nativeEvent.locationX, e.nativeEvent.locationY)}
    >
      <ExpoImage
        source={{ uri: entry.fullUri ?? entry.uri }}
        style={{ width: '100%', height: '100%' }}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={150}
      />
      {/* Marker ghim của CHÍNH tấm này (nếu có) */}
      {!!entry.pin && (
        <View
          pointerEvents="none"
          style={{ position: 'absolute', left: entry.pin.x * frameW - 11, top: entry.pin.y * PHOTO_VIEWER_HEIGHT - 11, alignItems: 'center', justifyContent: 'center' }}
        >
          <Animated.View
            style={{
              position: 'absolute', width: 22, height: 22, borderRadius: 11,
              backgroundColor: 'rgba(255,90,118,0.4)', transform: [{ scale: pulse }],
            }}
          />
          <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: Colors.accent, borderWidth: 2, borderColor: '#fff' }} />
        </View>
      )}
      {!!entry.isPrimary && (
        <View pointerEvents="none" style={{ position: 'absolute', left: 10, bottom: 10, backgroundColor: Colors.primary, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 }}>
          <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800', lineHeight: 15 }}>{primaryLabel}</Text>
        </View>
      )}
      {pinEnabled && entry.pin !== undefined && (
        <View
          pointerEvents="none"
          style={mode === 'detail' ? {
            // 'detail' — MẪU B đã chốt: pill KÍNH TỐI ở góc trên TRÁI,
            // ĐÚNG chất liệu của nút thùng rác tròn bên phải (cùng nền
            // rgba(24,17,52,0.44), cùng viền trắng mờ, cùng bóng, cùng
            // top 10 và cùng chiều cao 26) → tâm dọc hai bên trùng nhau,
            // thành một cặp đồng bộ trên một hàng; chữ trắng, icon ghim
            // coral nhạt #FF8FA3
            position: 'absolute', top: 10, left: 10, height: 26,
            flexDirection: 'row', alignItems: 'center', gap: 3,
            backgroundColor: 'rgba(24,17,52,0.44)',
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.30)',
            borderRadius: 999, paddingHorizontal: 8,
            shadowColor: '#0A051E', shadowOpacity: 0.28, shadowRadius: 8,
            shadowOffset: { width: 0, height: 2 }, elevation: 3,
          } : {
            // 'edit'/'view': huy hiệu cũ ở góc phải, giữ nguyên
            position: 'absolute', top: 10, right: 10,
            flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(36,18,84,0.65)', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3,
          }}
        >
          <Ionicons name="location" size={11} color={mode === 'detail' ? '#FF8FA3' : '#fff'} />
          <Text style={mode === 'detail'
            ? { color: '#fff', fontSize: 11, fontWeight: '700', lineHeight: 14 }
            : { color: '#fff', fontSize: 10.5, fontWeight: '700', lineHeight: 14 }}>
            {entry.pin ? pinnedLabel : tapToPinLabel}
          </Text>
        </View>
      )}
      {/* Nút XOÁ ngay tại chi tiết (CHỈ mode 'detail') — MẪU B đã chốt:
          NÚT TRÒN KÍNH TỐI đường kính 26px ở góc trên phải của chính ẢNH
          LỚN (top 10 / right 10), nền rgba(24,17,52,0.44), viền 1px
          rgba(255,255,255,0.30), bóng mềm, glyph thùng rác TRẮNG 15px;
          vuốt tới ảnh nào thì ảnh đó có sẵn nút này trên nó. Hình ảnh nút
          chỉ 26px nhưng vùng chạm hiệu dụng ~42px nhờ hitSlop (không
          phóng to hình nút). Là touchable con vẽ SAU CÙNG trong Pressable
          của trang (zIndex 10, cao hơn lớp chạm ghim) nên riêng vùng nút
          nhận chạm xoá, phần còn lại của ảnh vẫn ghim/chạm như thường;
          bấm mở AppPopup xác nhận rồi xoá đúng tấm đang hiển thị qua
          onRemove của gallery */}
      {canDelete && (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => onDeletePress(entry)}
          accessibilityLabel={deleteLabel}
          hitSlop={8}
          style={{
            position: 'absolute', top: 10, right: 10, width: 26, height: 26, borderRadius: 13,
            backgroundColor: 'rgba(24,17,52,0.44)',
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.30)',
            shadowColor: '#0A051E', shadowOpacity: 0.28, shadowRadius: 8,
            shadowOffset: { width: 0, height: 2 }, elevation: 3,
            alignItems: 'center', justifyContent: 'center', zIndex: 10,
          }}
        >
          <Ionicons name="trash-outline" size={15} color="#fff" />
        </TouchableOpacity>
      )}
      {/* Nút PHÓNG TO mở trình xem toàn màn hình (MỌI chế độ có khung
          lớn): tròn kính tối 26px ở góc dưới PHẢI — cùng chất liệu/cỡ
          với cặp Mẫu B phía trên; đặc biệt cần ở các bề mặt mà CHẠM vào
          ảnh đã gán thao tác khác (ghim ở ảnh hiện trường, popup Đặt
          chính/Xoá ở form) nên chạm ảnh không mở xem full được. Là
          touchable con vẽ cuối cùng (zIndex 10) như nút thùng rác:
          riêng vùng nút nhận chạm mở viewer, không lọt sang thao tác
          ghim/popup của cả trang */}
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => onExpandPress(entry)}
        accessibilityLabel={expandLabel}
        hitSlop={8}
        style={{
          position: 'absolute', bottom: 10, right: 10, width: 26, height: 26, borderRadius: 13,
          backgroundColor: 'rgba(24,17,52,0.44)',
          borderWidth: 1, borderColor: 'rgba(255,255,255,0.30)',
          shadowColor: '#0A051E', shadowOpacity: 0.28, shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 }, elevation: 3,
          alignItems: 'center', justifyContent: 'center', zIndex: 10,
        }}
      >
        <Ionicons name="expand-outline" size={14} color="#fff" />
      </TouchableOpacity>
    </Pressable>
  );
});

export function PhotoGallery({
  photos, takeLabel = '', pickLabel = '', onTake, onPick, onRemove, onSetPrimary, maxReached, limitText,
  title, titleColor, card = false, thumbSize = 76,
  onPinChange, captionSuffix, mode = 'edit', focusKey,
}: {
  photos: PhotoGalleryEntry[];
  takeLabel?: string;
  pickLabel?: string;
  onTake?: () => void;
  onPick?: () => void;
  onRemove?: (entry: PhotoGalleryEntry) => void;
  onSetPrimary?: (entry: PhotoGalleryEntry) => void;
  maxReached: boolean;
  limitText: string;
  /** Tiêu đề riêng của block */
  title?: string;
  titleColor?: string;
  /** Bọc block trong thẻ styles.card (khi block đứng riêng một thẻ, vd ở edit) */
  card?: boolean;
  thumbSize?: number;
  /** Bề mặt ghim (chỉ bucket hiện trường ở form): chạm lên ảnh = đặt ghim cho chính tấm đó */
  onPinChange?: (entry: PhotoGalleryEntry, pin: { x: number; y: number }) => void;
  /** Hậu tố chú thích (vd "ảnh mới, sẽ lưu khi bấm Lưu" ở quick-add) */
  captionSuffix?: string;
  /**
   * Chế độ hiển thị: 'edit' = form (xoá + đặt chính + hàng 2 nút thêm
   * ảnh), 'detail' = chi tiết đồ (nút Thêm ảnh mới + popup chọn nguồn +
   * nút thùng rác xoá trên ảnh lớn + ghim nếu có onPinChange), 'view' =
   * chỉ xem thuần. Mặc định 'edit'.
   */
  mode?: PhotoGalleryMode;
  /**
   * Key của ảnh cần được chọn/hiển thị ngay (vd ảnh vừa thêm ở trang
   * chi tiết): mỗi khi focusKey ĐỔI sang một key có trong danh sách,
   * gallery tự chọn đúng ảnh đó và pager cuộn tới bằng cơ chế đồng bộ
   * sẵn có. Không truyền = hành vi như cũ.
   */
  focusKey?: string;
}) {
  const { t } = useT();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [optionsFor, setOptionsFor] = useState<PhotoGalleryEntry | null>(null);
  const [deleteFor, setDeleteFor] = useState<PhotoGalleryEntry | null>(null);
  // Popup chọn nguồn ảnh (chế độ 'detail': Chụp ảnh / Từ thư viện)
  const [showAddSource, setShowAddSource] = useState(false);
  // Trình xem ảnh TOÀN MÀN HÌNH: viewerKey = key của ảnh được mở xem
  // (null = đang đóng); viewerIdx = trang đang xem TRONG viewer (đi
  // theo cú vuốt tại đó, độc lập với lựa chọn của pager chính bên ngoài)
  const [viewerKey, setViewerKey] = useState<string | null>(null);
  const [viewerIdx, setViewerIdx] = useState(0);
  const [prevViewerKey, setPrevViewerKey] = useState<string | null>(null);
  const viewerListRef = useRef<FlatList<PhotoGalleryEntry>>(null);
  const { width: winW, height: winH } = useWindowDimensions();
  const [frameW, setFrameW] = useState(0);
  const pagerRef = useRef<FlatList<PhotoGalleryEntry>>(null);
  // Danh sách key của lần render trước — chỉ dùng bởi khối "điều chỉnh
  // state trong lúc render" ở dưới để nhận biết ảnh đang chọn vừa bị xoá
  const [prevKeys, setPrevKeys] = useState<string[]>([]);

  // Marker ghim nhấp nháy — cùng nhịp và style với SceneImage
  const [pulse] = useState(() => new Animated.Value(1));
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

  // focusKey đã áp dụng gần nhất — áp dụng focusKey cũng nằm trong
  // khối điều chỉnh state trong lúc render ngay dưới (KHÔNG dùng
  // effect: lint cấm setState đồng bộ trong effect)
  const [appliedFocus, setAppliedFocus] = useState<string | undefined>(undefined);

  // Điều chỉnh state trong lúc render (mẫu React chính thức cho state
  // suy ra từ props — React render lại ngay trước khi commit nên người
  // dùng không thấy khung hình trung gian bị sai):
  // - focusKey ĐỔI sang một key có trong danh sách (ảnh vừa thêm ở
  //   call-site) → chọn ngay ảnh đó, pager tự cuộn tới qua effect đồng
  //   bộ selIndex ở dưới. appliedFocus đảm bảo mỗi giá trị focusKey chỉ
  //   áp dụng ĐÚNG một lần — mảng photos được tạo lại cũng không giật
  //   lựa chọn của người dùng về; key chưa kịp có trong danh sách thì
  //   áp dụng ở lần danh sách đổi kế tiếp khi nó xuất hiện.
  // - Danh sách key ĐỔI so với lần render trước → lưu danh sách mới;
  //   nếu ảnh đang chọn vừa bị XOÁ (không còn trong danh sách mới) thì
  //   chọn ngay ảnh KỀ của nó — ảnh nay đứng đúng vị trí cũ (kẹp về
  //   ảnh cuối khi xoá ở cuối danh sách), không có vị trí cũ thì về
  //   ảnh chính/ảnh đầu.
  const curKeys = photos.map((p) => p.key);
  const keysChanged = curKeys.length !== prevKeys.length || curKeys.some((k, i) => k !== prevKeys[i]);
  const focusPending = !!focusKey && focusKey !== appliedFocus && curKeys.includes(focusKey);
  if (keysChanged || focusPending) {
    if (focusPending) {
      setSelectedKey(focusKey);
      setAppliedFocus(focusKey);
    } else if (selectedKey && !curKeys.includes(selectedKey) && curKeys.length > 0) {
      const oldIdx = prevKeys.indexOf(selectedKey);
      let nextIdx = oldIdx >= 0 ? Math.min(oldIdx, curKeys.length - 1) : -1;
      if (nextIdx < 0) {
        const pi = photos.findIndex((p) => p.isPrimary);
        nextIdx = pi >= 0 ? pi : 0;
      }
      setSelectedKey(curKeys[nextIdx]);
    }
    if (keysChanged) setPrevKeys(curKeys);
  }

  // Vừa mở trình xem (viewerKey đổi sang một key mới): trang bắt đầu
  // của viewer = đúng vị trí của ảnh đó trong danh sách — cùng mẫu
  // điều chỉnh state trong lúc render như focusKey ở trên (áp dụng
  // một lần cho mỗi lần mở; các cú vuốt trong viewer tự cập nhật
  // viewerIdx qua onMomentumScrollEnd nên không bị giật về)
  if (viewerKey !== prevViewerKey) {
    setPrevViewerKey(viewerKey);
    if (viewerKey) {
      const idx = photos.findIndex((p) => p.key === viewerKey);
      setViewerIdx(idx >= 0 ? idx : 0);
    }
  }
  const viewerSafeIdx = photos.length === 0 ? 0 : Math.min(viewerIdx, photos.length - 1);

  const pickedIndex = photos.findIndex((p) => p.key === selectedKey);
  const primaryIndex = photos.findIndex((p) => p.isPrimary);
  const selIndex = photos.length === 0
    ? -1
    : pickedIndex >= 0
      ? pickedIndex
      : primaryIndex >= 0
        ? primaryIndex
        : 0;
  const selected = selIndex >= 0 ? photos[selIndex] : undefined;

  // Đồng bộ pager khi ảnh đang chọn thay đổi ngoài pager (bấm thumbnail,
  // danh sách ảnh thay đổi). Vuốt trong pager cũng đổi selIndex về đúng
  // trang đang đứng nên lần cuộn đồng bộ này là no-op.
  useEffect(() => {
    if (frameW > 0 && selIndex >= 0) {
      pagerRef.current?.scrollToIndex({ index: selIndex, animated: true });
    }
  }, [selIndex, frameW]);

  // ----- Dòng chú thích dưới ảnh lớn (theo chính tấm đang xem) -----
  let caption = '';
  if (selected) {
    if (selected.pin !== undefined) {
      // Bucket hiện trường: trạng thái ghim của chính tấm đang xem
      caption = selected.pin
        ? t('photos.captionPinned', { x: selIndex + 1, n: photos.length })
        : mode === 'view'
          ? t('photos.captionUnpinnedView', { x: selIndex + 1, n: photos.length })
          : t('photos.captionUnpinned', { x: selIndex + 1, n: photos.length });
    } else {
      caption = t('photos.counter', { x: selIndex + 1, n: photos.length });
      if (selected.isPrimary) caption += ` — ${t('photos.mainPhoto')}`;
    }
    if (captionSuffix) caption += ` (${captionSuffix})`;
  }

  // Các callback của pager đều bọc useCallback để ỔN ĐỊNH danh tính
  // giữa các lần render — điều kiện cần cho React.memo của PhotoPage
  // phát huy tác dụng (trang không dựng lại khi vuốt/đổi lựa chọn).
  const handlePagePress = useCallback((entry: PhotoGalleryEntry, locationX: number, locationY: number) => {
    if (mode === 'view') {
      // Chỉ-xem thuần: chạm ảnh lớn không có thao tác nào khác → mở
      // thẳng trình xem toàn màn hình
      setViewerKey(entry.key);
      return;
    }
    if (frameW === 0) return;
    if (onPinChange && entry.pin !== undefined) {
      // Ảnh hiện trường: ghim thuộc về chính tấm vừa chạm (cả ở form lẫn
      // trang chi tiết — chi tiết lưu ngay qua onPinChange của call-site).
      // GIỮ NGUYÊN thao tác ghim này — xem full đi qua nút phóng to
      // riêng trên khung (xem PhotoPage)
      onPinChange(entry, {
        x: clamp01(locationX / frameW),
        y: clamp01(locationY / PHOTO_VIEWER_HEIGHT),
      });
      return;
    }
    // Popup "Đặt làm ảnh chính / Xoá" chỉ có ở form — chi tiết không đặt chính
    if (mode === 'edit' && onSetPrimary) {
      setOptionsFor(entry);
      return;
    }
    // Mọi bề mặt còn lại, chạm vào ảnh lớn chưa gán thao tác nào (ảnh
    // đồ ở quick-add không có onSetPrimary, ảnh đồ ở trang chi tiết):
    // chạm = mở trình xem toàn màn hình
    setViewerKey(entry.key);
  }, [mode, frameW, onPinChange, onSetPrimary]);

  const handleDeletePress = useCallback((entry: PhotoGalleryEntry) => {
    setDeleteFor(entry);
  }, []);

  const handleExpandPress = useCallback((entry: PhotoGalleryEntry) => {
    setViewerKey(entry.key);
  }, []);

  const renderPage = useCallback(({ item: entry }: { item: PhotoGalleryEntry }) => (
    <PhotoPage
      entry={entry}
      frameW={frameW}
      mode={mode}
      pulse={pulse}
      pinEnabled={!!onPinChange}
      canDelete={mode === 'detail' && !!onRemove}
      primaryLabel={t('photos.primary')}
      pinnedLabel={t('photos.pinnedBadge')}
      tapToPinLabel={t('photos.tapToPinBadge')}
      deleteLabel={t('photos.delete')}
      expandLabel={t('photos.viewFullscreen')}
      onPressPage={handlePagePress}
      onDeletePress={handleDeletePress}
      onExpandPress={handleExpandPress}
    />
  ), [frameW, mode, pulse, onPinChange, onRemove, t, handlePagePress, handleDeletePress, handleExpandPress]);

  const optionRows: AppPopupOption[] = [];
  if (optionsFor) {
    if (onSetPrimary && !optionsFor.isPrimary) {
      optionRows.push({
        label: t('photos.setPrimary'),
        icon: 'star-outline',
        color: Colors.primary,
        onPress: () => { onSetPrimary(optionsFor); },
      });
    }
    optionRows.push({
      label: t('photos.delete'),
      icon: 'trash-outline',
      color: Colors.danger,
      onPress: () => { setDeleteFor(optionsFor); },
    });
  }

  const limitBox = (
    <View style={{ flexDirection: 'row', gap: 7, alignItems: 'flex-start', backgroundColor: tint(Colors.orange, '16'), borderRadius: 12, paddingHorizontal: 10, paddingVertical: 8 }}>
      <Ionicons name="information-circle-outline" size={16} color={Colors.orange} style={{ marginTop: 1 }} />
      <Text style={{ flex: 1, fontSize: 12.5, lineHeight: 18, color: Colors.text }}>{limitText}</Text>
    </View>
  );

  // Nút trong HÀNG thêm ảnh cố định dưới dải thumbnail (chế độ 'edit'):
  // 2 nút cạnh nhau, nhãn đầy đủ do call-site truyền (takeLabel/pickLabel).
  // CHỐNG TRÀN (giữ nguyên bộ khoá này khi sửa): nút flex:1 + minWidth:0 +
  // paddingHorizontal; nhãn flexShrink:1 + minWidth:0 + căn giữa + tối đa
  // 2 dòng + co chữ có kiểm soát (adjustsFontSizeToFit ở JSX). Thiếu các
  // khoá đó, Yoga giữ bề ngang nguyên bản 1 dòng của Text — nhóm icon+chữ
  // rộng hơn khung nút và justifyContent 'center' đẩy tràn đều 2 phía:
  // icon lòi khỏi mép trái, chữ tràn qua mép phải đè lên nút bên cạnh.
  const addRowBtnStyle = {
    flex: 1, minWidth: 0, borderWidth: 1.5, borderStyle: 'dashed' as const, borderColor: Colors.primary,
    backgroundColor: tint(Colors.primary, '10'), borderRadius: 16,
    paddingVertical: 12, paddingHorizontal: 10, flexDirection: 'row' as const,
    alignItems: 'center' as const, justifyContent: 'center' as const, gap: 6,
  };
  const addRowLabelStyle = {
    fontSize: 14.5, fontWeight: '700' as const, color: Colors.primary,
    flexShrink: 1, minWidth: 0, textAlign: 'center' as const,
  };

  // Nút "Thêm ảnh mới" (chế độ 'detail'): mở popup chọn nguồn ảnh
  const addNewButton = (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() => setShowAddSource(true)}
      style={{
        height: 48, borderRadius: 16, borderWidth: 1.5, borderStyle: 'dashed', borderColor: Colors.primary,
        backgroundColor: tint(Colors.primary, '10'), paddingHorizontal: 12,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
      }}
    >
      <Ionicons name="add-circle-outline" size={20} color={Colors.primary} />
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.85}
        style={{ fontSize: 15, fontWeight: '700', color: Colors.primary, flexShrink: 1, textAlign: 'center' }}
      >
        {t('photos.addNew')}
      </Text>
    </TouchableOpacity>
  );

  // Chế độ chỉ-xem thuần mà block không có ảnh thì ẩn hẳn block
  if (mode === 'view' && photos.length === 0) return null;

  return (
    <View style={[card ? styles.card : null, { gap: 10 }]}>
      {!!title && <SectionTitle title={title} color={titleColor ?? Colors.primary} />}

      {photos.length === 0 ? (
        mode === 'detail' ? (
          // Chi tiết: block rỗng VẪN render — khung trống + nút Thêm ảnh
          // mới để thêm được ảnh đầu tiên ngay tại trang chi tiết
          <>
            <View
              style={{
                height: 150, borderRadius: 20, borderWidth: 1.5, borderStyle: 'dashed',
                borderColor: Colors.border, backgroundColor: tint(Colors.primary, '08'),
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              <Ionicons name="image-outline" size={36} color={Colors.faint} />
            </View>
            {maxReached ? limitBox : addNewButton}
          </>
        ) : maxReached ? limitBox : (
          // Chưa có ảnh: 2 nút nét đứt cạnh nhau — Chụp / Chọn từ thư viện,
          // bấm là chạy thẳng, không qua popup chọn kiểu
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={onTake}
              style={{
                flex: 1, minWidth: 0, borderWidth: 1.5, borderStyle: 'dashed', borderColor: Colors.primary,
                backgroundColor: tint(Colors.primary, '14'), borderRadius: 20,
                paddingVertical: 22, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center', gap: 6,
              }}
            >
              <Ionicons name="camera-outline" size={28} color={Colors.primary} />
              <Text
                numberOfLines={2}
                adjustsFontSizeToFit
                minimumFontScale={0.85}
                style={{ fontSize: 15, fontWeight: '700', color: Colors.text, flexShrink: 1, alignSelf: 'stretch', textAlign: 'center' }}
              >
                {takeLabel}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={onPick}
              style={{
                flex: 1, minWidth: 0, borderWidth: 1.5, borderStyle: 'dashed', borderColor: Colors.primary,
                backgroundColor: tint(Colors.primary, '14'), borderRadius: 20,
                paddingVertical: 22, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center', gap: 6,
              }}
            >
              <Ionicons name="images-outline" size={28} color={Colors.primary} />
              <Text
                numberOfLines={2}
                adjustsFontSizeToFit
                minimumFontScale={0.85}
                style={{ fontSize: 15, fontWeight: '700', color: Colors.text, flexShrink: 1, alignSelf: 'stretch', textAlign: 'center' }}
              >
                {pickLabel}
              </Text>
            </TouchableOpacity>
          </View>
        )
      ) : (
        <>
          {/* Ảnh lớn: PAGER vuốt ngang trong khung cao cố định — mỗi trang
              rộng đúng bề rộng khung, tràn bị cắt ngay trong khung */}
          <View
            style={{ height: PHOTO_VIEWER_HEIGHT, borderRadius: 20, overflow: 'hidden', backgroundColor: '#000' }}
            onLayout={(e) => setFrameW(e.nativeEvent.layout.width)}
          >
            {frameW > 0 && (
              <FlatList
                ref={pagerRef}
                data={photos}
                horizontal
                pagingEnabled
                nestedScrollEnabled
                showsHorizontalScrollIndicator={false}
                keyExtractor={(p) => p.key}
                getItemLayout={(_, index) => ({ length: frameW, offset: frameW * index, index })}
                initialScrollIndex={selIndex > 0 ? selIndex : 0}
                onScrollToIndexFailed={(info) => {
                  pagerRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true });
                }}
                onMomentumScrollEnd={(e) => {
                  const idx = Math.round(e.nativeEvent.contentOffset.x / frameW);
                  const target = photos[idx];
                  if (target && target.key !== selectedKey) setSelectedKey(target.key);
                }}
                windowSize={3}
                initialNumToRender={3}
                maxToRenderPerBatch={3}
                removeClippedSubviews
                renderItem={renderPage}
              />
            )}
          </View>

          {!!caption && (
            <Text style={{ fontSize: 12.5, fontStyle: 'italic', color: Colors.subtext, lineHeight: 18 }}>{caption}</Text>
          )}

          {/* Dải thumbnail ngang: mỗi ô có kích thước hộp cố định; chạm vào
              ô để CHỌN xem (pager cuộn tới), ✕ đỏ ở góc trên phải để xoá
              (CHỈ chế độ 'edit' — ở 'detail' xoá bằng nút thùng rác trên
              ẢNH LỚN, thumbnail không có nút xoá). Thao tác thêm ảnh nằm ở
              hàng riêng ngay dưới dải này — xem dưới ScrollView */}
          <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingTop: 8, paddingRight: 8 }}>
            {photos.map((p, i) => {
              const isSel = i === selIndex;
              return (
                <View key={p.key} style={{ width: thumbSize, height: thumbSize }}>
                  <TouchableOpacity activeOpacity={0.85} onPress={() => setSelectedKey(p.key)} style={{ flex: 1 }}>
                    <Image
                      source={{ uri: p.uri }}
                      style={{
                        width: '100%', height: '100%', borderRadius: 16,
                        borderWidth: isSel ? 2.5 : 0, borderColor: Colors.primary,
                      }}
                    />
                  </TouchableOpacity>
                  {!!p.isPrimary && (
                    <View pointerEvents="none" style={{ position: 'absolute', left: 5, bottom: 5, backgroundColor: Colors.primary, borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1 }}>
                      <Text style={{ color: '#fff', fontSize: 9.5, fontWeight: '800', lineHeight: 13 }}>{t('photos.primary')}</Text>
                    </View>
                  )}
                  {!!p.pin && (
                    <View pointerEvents="none" style={{ position: 'absolute', left: 5, top: 5, width: 18, height: 18, borderRadius: 9, backgroundColor: Colors.accent, borderWidth: 1.5, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' }}>
                      <Ionicons name="location" size={10} color="#fff" />
                    </View>
                  )}
                  {mode === 'edit' && (
                    <TouchableOpacity
                      onPress={() => setDeleteFor(p)}
                      hitSlop={6}
                      accessibilityLabel={t('photos.delete')}
                      style={{
                        position: 'absolute', top: -7, right: -7, width: 22, height: 22, borderRadius: 11,
                        backgroundColor: Colors.danger, alignItems: 'center', justifyContent: 'center',
                        borderWidth: 1.5, borderColor: '#fff',
                      }}
                    >
                      <Ionicons name="close" size={13} color="#fff" />
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}
          </ScrollView>

          {mode === 'edit' && (maxReached ? limitBox : (
            // Hàng nút thêm ảnh CỐ ĐỊNH ngay dưới dải thumbnail: luôn nhìn
            // thấy không cần cuộn ngang; nhãn đầy đủ từ call-site
            // (takeLabel = "Chụp ảnh", pickLabel = "Thêm từ thư viện"…),
            // bấm là chạy thẳng onTake/onPick, không qua popup trung gian
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity activeOpacity={0.85} onPress={onTake} style={addRowBtnStyle}>
                <Ionicons name="camera-outline" size={22} color={Colors.primary} />
                <Text numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.78} style={addRowLabelStyle}>{takeLabel}</Text>
              </TouchableOpacity>
              <TouchableOpacity activeOpacity={0.85} onPress={onPick} style={addRowBtnStyle}>
                <Ionicons name="images-outline" size={22} color={Colors.primary} />
                <Text numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.78} style={addRowLabelStyle}>{pickLabel}</Text>
              </TouchableOpacity>
            </View>
          ))}

          {mode === 'detail' && (maxReached ? limitBox : addNewButton)}
        </>
      )}

      {mode === 'edit' && (
        <AppPopup
          visible={!!optionsFor}
          title={t('photos.title')}
          options={optionRows}
          onClose={() => setOptionsFor(null)}
        />
      )}

      {/* Popup xác nhận xoá dùng chung cho 'edit' (✕ ở thumbnail hoặc
          chọn Xoá trong popup tuỳ chọn) và 'detail' (nút thùng rác trên
          ảnh lớn) */}
      {mode !== 'view' && (
        <AppPopup
          visible={!!deleteFor}
          title={t('photos.delete')}
          message={t('photos.deleteConfirm')}
          confirm={{
            label: t('photos.delete'),
            danger: true,
            onConfirm: () => { if (deleteFor) onRemove?.(deleteFor); },
          }}
          onClose={() => setDeleteFor(null)}
        />
      )}

      {mode === 'detail' && (
        // Popup chọn nguồn khi bấm "Thêm ảnh mới" ở trang chi tiết:
        // Chụp ảnh / Từ thư viện chạy thẳng onTake/onPick của call-site;
        // thoát bằng nút ✕ của AppPopup — KHÔNG có tuỳ chọn "Bỏ qua"
        <AppPopup
          visible={showAddSource}
          title={t('photos.addNew')}
          options={[
            { label: takeLabel, icon: 'camera-outline', color: Colors.primary, onPress: () => { onTake?.(); } },
            { label: pickLabel, icon: 'images-outline', color: Colors.teal, onPress: () => { onPick?.(); } },
          ]}
          onClose={() => setShowAddSource(false)}
        />
      )}

      {/* Trình xem ảnh TOÀN MÀN HÌNH: Modal nền đen, ảnh khổ lớn
          contain toàn màn, vuốt ngang qua lại GIỮA CÁC ẢNH CỦA CÙNG
          BLOCK, chỉ số n/N góc trên trái, nút ✕ đóng góc trên phải.
          Bên trong CHỈ ĐỂ XEM — cố ý không có nút sửa/xoá/ghim nào.
          FlatList chỉ dựng khi đang mở (viewerKey khác null) để
          initialScrollIndex luôn là đúng ảnh vừa được mở */}
      <Modal
        visible={viewerKey !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setViewerKey(null)}
      >
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          {viewerKey !== null && photos.length > 0 && winW > 0 && (
            <FlatList
              ref={viewerListRef}
              data={photos}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              keyExtractor={(p) => p.key}
              getItemLayout={(_, index) => ({ length: winW, offset: winW * index, index })}
              initialScrollIndex={viewerSafeIdx}
              onScrollToIndexFailed={(info) => {
                viewerListRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
              }}
              onMomentumScrollEnd={(e) => {
                const idx = Math.round(e.nativeEvent.contentOffset.x / winW);
                if (idx >= 0 && idx < photos.length && idx !== viewerIdx) setViewerIdx(idx);
              }}
              windowSize={3}
              initialNumToRender={3}
              maxToRenderPerBatch={3}
              renderItem={({ item: entry }) => (
                <View style={{ width: winW, height: winH, alignItems: 'center', justifyContent: 'center' }}>
                  <ExpoImage
                    source={{ uri: entry.fullUri ?? entry.uri }}
                    style={{ width: '100%', height: '100%' }}
                    contentFit="contain"
                    cachePolicy="memory-disk"
                  />
                </View>
              )}
            />
          )}
          {/* Chỉ số ảnh đang xem (cùng key đếm với chú thích dưới pager) */}
          <View
            pointerEvents="none"
            style={{
              position: 'absolute', top: 48, left: 16,
              backgroundColor: 'rgba(24,17,52,0.55)', borderRadius: 999,
              paddingHorizontal: 11, paddingVertical: 5,
            }}
          >
            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700', lineHeight: 18 }}>
              {t('photos.counter', { x: viewerSafeIdx + 1, n: photos.length })}
            </Text>
          </View>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => setViewerKey(null)}
            accessibilityLabel={t('photos.closeViewer')}
            hitSlop={8}
            style={{
              position: 'absolute', top: 42, right: 16, width: 40, height: 40, borderRadius: 20,
              backgroundColor: 'rgba(24,17,52,0.55)',
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.30)',
              alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Ionicons name="close" size={22} color="#fff" />
          </TouchableOpacity>
        </View>
      </Modal>
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

/**
 * Bộ icon riêng cho TRẠNG THÁI tự tạo — mang nghĩa vòng đời/trạng thái của
 * món đồ (đang dùng, chờ, đã xong, hỏng, đã tặng…) thay vì hình đồ vật.
 * Mọi tên đã kiểm chứng có trong glyphMap Ionicons đang cài.
 * (Tên STATUS_ICON_CHOICES để tránh trùng STATUS_ICONS của theme.ts —
 * đó là Record ánh xạ trạng thái built-in → icon.)
 */
export const STATUS_ICON_CHOICES: IconName[] = [
  'checkmark-circle-outline', 'time-outline', 'hourglass-outline', 'calendar-outline',
  'construct-outline', 'build-outline', 'hammer', 'gift-outline',
  'trash-outline', 'battery-dead-outline', 'flag-outline', 'alert-circle-outline',
  'warning-outline', 'pause-circle-outline', 'play-circle-outline', 'swap-horizontal',
  'archive-outline', 'cube-outline', 'home-outline', 'eye-off-outline',
  'heart-outline', 'star-outline', 'lock-closed-outline', 'sync-outline',
];

/**
 * Bộ icon riêng cho TÌNH TRẠNG tự tạo — mang nghĩa trạng thái vật lý/chất
 * lượng của món đồ (mới, tốt, trầy, ẩm, lạnh…). Mọi tên đã kiểm chứng có
 * trong glyphMap Ionicons. (Đặt tên CONDITION_ICON_CHOICES để tránh trùng
 * CONDITION_ICONS của types/index.ts — Record của các tình trạng built-in.)
 */
export const CONDITION_ICON_CHOICES: IconName[] = [
  'sparkles-outline', 'thumbs-up-outline', 'bandage-outline', 'construct-outline',
  'hammer', 'alert-circle-outline', 'warning-outline', 'shield-checkmark-outline',
  'water-outline', 'snow-outline', 'sunny-outline', 'leaf-outline',
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
 * - icons: bộ icon hiển thị (mặc định TERM_ICON_CHOICES — bộ đồ vật cho
 *   phân loại; AddTermModal truyền bộ riêng theo kind cho trạng thái/tình trạng).
 */
export function IconPickerGrid({
  value, onChange, color = Colors.primary, showDefaultOption = false, icons = TERM_ICON_CHOICES,
}: {
  value: IconName | null;
  onChange: (icon: IconName | null) => void;
  color?: string;
  showDefaultOption?: boolean;
  icons?: IconName[];
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
      {icons.map((ic) => (
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
  // Mỗi kind một bộ icon + icon mặc định riêng: phân loại = đồ vật,
  // trạng thái = vòng đời (mặc định lá cờ), tình trạng = chất lượng (mặc định lấp lánh)
  const iconChoices = kind === 'STATUS' ? STATUS_ICON_CHOICES : kind === 'CONDITION' ? CONDITION_ICON_CHOICES : TERM_ICON_CHOICES;
  const defaultIcon: IconName = kind === 'STATUS' ? 'flag-outline' : kind === 'CONDITION' ? 'sparkles-outline' : 'cube-outline';
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<IconName>(defaultIcon);
  const [color, setColor] = useState<string>(Colors.primary);
  const [saving, setSaving] = useState(false);
  // Popup thông báo/lỗi ngay trong form (thay hộp thoại hệ thống)
  const [infoPopup, setInfoPopup] = useState<{ title: string; message: string } | null>(null);

  const titleKey = kind === 'CATEGORY' ? 'addTerm.catTitle' : kind === 'STATUS' ? 'addTerm.statusTitle' : 'addTerm.condTitle';
  const placeholderKey = kind === 'CATEGORY' ? 'addTerm.catPlaceholder' : kind === 'STATUS' ? 'addTerm.statusPlaceholder' : 'addTerm.condPlaceholder';
  const noNameKey = kind === 'CATEGORY' ? 'addTerm.noCatName' : kind === 'STATUS' ? 'addTerm.noStatusName' : 'addTerm.noCondName';

  async function handleSave() {
    if (!name.trim()) {
      setInfoPopup({ title: t('addTerm.noNameTitle'), message: t(noNameKey) });
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
      setInfoPopup({ title: t('addTerm.saveFailTitle'), message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
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
              icons={iconChoices}
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
        <AppPopup
          visible={!!infoPopup}
          title={infoPopup?.title ?? ''}
          message={infoPopup?.message}
          okLabel={t('common.gotIt')}
          onClose={() => setInfoPopup(null)}
        />
    </>
  );
}

// ---------- Lịch chọn ngày (thuần TS, không thêm thư viện native) ----------

/** 'YYYY-MM-DD' theo lịch địa phương từ một Date */
function isoOfDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Modal lịch tháng chọn ngày: đầu tuần là Thứ 2, tiêu đề tháng/năm và nhãn
 * thứ theo ngôn ngữ hiện tại (Intl). Ngày thuộc tháng khác hiện mờ (bấm vẫn
 * chọn đúng ngày đó), hôm nay khoanh viền, ngày đang chọn tô tím. Chân
 * modal: Xoá ngày / Huỷ / Hôm nay (chọn hôm nay ngay). Mọi trường ngày của
 * app hiện đều tuỳ chọn nên nút Xoá luôn hiện.
 * valueIso: 'YYYY-MM-DD' (hoặc ISO đầy đủ) / null = chưa có ngày.
 */
export function DatePickerModal({
  visible, title, valueIso, onClose, onSelect, onClear,
}: {
  visible: boolean;
  title?: string;
  valueIso: string | null;
  onClose: () => void;
  onSelect: (iso: string) => void;
  onClear: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        {/* Card chỉ mount khi modal mở => tháng đang xem luôn khởi tạo mới từ valueIso */}
        {visible && (
          <DatePickerCard title={title} valueIso={valueIso} onClose={onClose} onSelect={onSelect} onClear={onClear} />
        )}
      </View>
    </Modal>
  );
}

function DatePickerCard({
  title, valueIso, onClose, onSelect, onClear,
}: {
  title?: string;
  valueIso: string | null;
  onClose: () => void;
  onSelect: (iso: string) => void;
  onClear: () => void;
}) {
  const { t, lang } = useT();
  const locale = lang === 'en' ? 'en-US' : 'vi-VN';
  const todayIso = localTodayISO();
  const selectedIso = valueIso ? valueIso.slice(0, 10) : null;
  const parsed = selectedIso ? new Date(`${selectedIso}T00:00:00`) : null;
  const seed = parsed && !isNaN(parsed.getTime()) ? parsed : new Date();
  const [viewYear, setViewYear] = useState(seed.getFullYear());
  const [viewMonth, setViewMonth] = useState(seed.getMonth());

  const monthTitle = (() => {
    try {
      const raw = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(new Date(viewYear, viewMonth, 1));
      return raw.charAt(0).toUpperCase() + raw.slice(1);
    } catch {
      return `${viewMonth + 1}/${viewYear}`;
    }
  })();

  // Nhãn thứ Thứ 2 → Chủ nhật theo locale, neo vào tuần bắt đầu 01/01/2024 (Thứ 2)
  const weekdayLabels = (() => {
    try {
      const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
      return Array.from({ length: 7 }, (_, i) => {
        const label = fmt.format(new Date(2024, 0, 1 + i));
        return label.charAt(0).toUpperCase() + label.slice(1);
      });
    } catch {
      return ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
    }
  })();

  // Lưới cố định 6 tuần × 7 ngày; ô đầu là Thứ 2 của tuần chứa ngày 1 của tháng
  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const leadDays = (firstOfMonth.getDay() + 6) % 7;
  const gridStart = new Date(viewYear, viewMonth, 1 - leadDays);
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    return { date: d, iso: isoOfDate(d), inMonth: d.getMonth() === viewMonth };
  });
  const weeks: (typeof cells)[] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  function shiftMonth(delta: number) {
    const next = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
  }

  const navBtnStyle = {
    width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.chipBg,
    alignItems: 'center' as const, justifyContent: 'center' as const,
  };

  return (
    <View style={[styles.card, styles.modalCard, { gap: 10 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 18, fontWeight: '800', color: Colors.text }}>
          {title ?? t('datePicker.title')}
        </Text>
        <TouchableOpacity onPress={() => shiftMonth(-1)} hitSlop={6} style={navBtnStyle}>
          <Ionicons name="chevron-back" size={20} color={Colors.primaryDark} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => shiftMonth(1)} hitSlop={6} style={navBtnStyle}>
          <Ionicons name="chevron-forward" size={20} color={Colors.primaryDark} />
        </TouchableOpacity>
      </View>
      <Text style={{ fontSize: 15, fontWeight: '700', color: Colors.primaryDark }}>{monthTitle}</Text>
      <View>
        <View style={{ flexDirection: 'row' }}>
          {weekdayLabels.map((w, i) => (
            <View key={i} style={{ flex: 1, alignItems: 'center', paddingVertical: 4 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: i === 6 ? Colors.coral : Colors.subtext }}>{w}</Text>
            </View>
          ))}
        </View>
        {weeks.map((week, wi) => (
          <View key={wi} style={{ flexDirection: 'row' }}>
            {week.map((cell) => {
              const selected = selectedIso != null && cell.iso === selectedIso;
              const isToday = cell.iso === todayIso;
              return (
                <TouchableOpacity
                  key={cell.iso}
                  style={{ flex: 1, alignItems: 'center', paddingVertical: 2 }}
                  onPress={() => onSelect(cell.iso)}
                  activeOpacity={0.7}
                >
                  <View
                    style={{
                      width: 38, height: 38, borderRadius: 19,
                      alignItems: 'center', justifyContent: 'center',
                      backgroundColor: selected ? Colors.primary : 'transparent',
                      borderWidth: isToday && !selected ? 1.5 : 0, borderColor: Colors.primary,
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 14.5,
                        fontWeight: selected || isToday ? '800' : '500',
                        color: selected ? '#fff' : cell.inMonth ? Colors.text : Colors.faint,
                      }}
                    >
                      {cell.date.getDate()}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <AppButton title={t('datePicker.clear')} variant="danger" onPress={onClear} style={{ flex: 1, paddingHorizontal: 6 }} />
        <AppButton title={t('common.cancel')} variant="secondary" onPress={onClose} style={{ flex: 1, paddingHorizontal: 6 }} />
        <AppButton title={t('datePicker.today')} icon="today-outline" onPress={() => onSelect(todayIso)} style={{ flex: 1, paddingHorizontal: 6 }} />
      </View>
    </View>
  );
}

/**
 * Ô nhập ngày chuẩn toàn app: TextInput gõ tay (mask DD/MM/YYYY như cũ) +
 * nút lịch ở cuối ô mở DatePickerModal cho đúng ô đó. Chọn từ lịch → điền
 * lại DD/MM/YYYY qua formatDisplayDate; "Xoá ngày" → xoá trắng ô.
 * value/onChangeText trao đổi chuỗi HIỂN THỊ 'DD/MM/YYYY' như các form
 * đang dùng (nội bộ tự áp mask khi gõ).
 */
export function DateField({
  value, onChangeText, placeholder, title,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  /** Tiêu đề modal lịch — truyền nhãn của trường cho rõ ngữ cảnh */
  title?: string;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const currentIso = value.trim() ? parseDisplayDate(value) : null;
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <TextInput
        style={[styles.input, { flex: 1 }]}
        keyboardType="number-pad"
        placeholder={placeholder}
        placeholderTextColor={Colors.faint}
        value={value}
        onChangeText={(v) => onChangeText(maskDateInput(v))}
      />
      <TouchableOpacity
        onPress={() => setShowPicker(true)}
        activeOpacity={0.8}
        style={{
          width: 52, height: 52, borderRadius: 14, backgroundColor: '#FDFCFF',
          borderWidth: 1.5, borderColor: '#E7E2F6',
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Ionicons name="calendar-outline" size={22} color={Colors.primary} />
      </TouchableOpacity>
      <DatePickerModal
        visible={showPicker}
        title={title}
        valueIso={currentIso}
        onClose={() => setShowPicker(false)}
        onSelect={(iso) => { onChangeText(formatDisplayDate(iso)); setShowPicker(false); }}
        onClear={() => { onChangeText(''); setShowPicker(false); }}
      />
    </View>
  );
}

// ---------- Gia hạn cho mượn ----------

const EXTEND_PRESETS = [3, 7, 14, 30];

/**
 * Hạn trả mới khi gia hạn: cộng số ngày vào mốc LỚN HƠN giữa hạn hiện tại
 * và hôm nay — lượt đã quá hạn thì tính từ hôm nay (không cộng vào ngày cũ
 * đã qua); chưa có hạn trả → hôm nay + số ngày.
 */
export function computeExtendedDue(currentDue: string | null | undefined, days: number): string {
  const today = localTodayISO();
  const due = currentDue ? currentDue.slice(0, 10) : null;
  const base = due && due > today ? due : today;
  return addDaysISO(base, days);
}

/**
 * Modal gia hạn hạn trả dùng chung (chi tiết đồ + tab Cho mượn): hiện người
 * mượn + hạn trả hiện tại, chip mức nhanh 3/7/14/30 ngày (mặc định 7), ô
 * nhập số ngày tuỳ ý 1–365 (nhập vào thì bỏ chọn chip), dòng xem trước hạn
 * trả mới. Thuần hiển thị — nơi gọi tự thực hiện extendLoanDue(loanId,
 * newIso) trong onConfirm rồi bump + rescheduleAllReminders như các flow
 * mượn/trả hiện tại.
 */
export function ExtendLoanModal({
  visible, borrowerName, currentDue, onClose, onConfirm,
}: {
  visible: boolean;
  borrowerName: string;
  currentDue: string | null;
  onClose: () => void;
  onConfirm: (newIso: string) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        {/* Card chỉ mount khi modal mở => lựa chọn ngày luôn khởi tạo mới (mặc định 7) */}
        {visible && (
          <ExtendLoanCard borrowerName={borrowerName} currentDue={currentDue} onClose={onClose} onConfirm={onConfirm} />
        )}
      </View>
    </Modal>
  );
}

function ExtendLoanCard({
  borrowerName, currentDue, onClose, onConfirm,
}: {
  borrowerName: string;
  currentDue: string | null;
  onClose: () => void;
  onConfirm: (newIso: string) => void;
}) {
  const { t, lang } = useT();
  const [preset, setPreset] = useState(7);
  const [custom, setCustom] = useState('');
  const today = localTodayISO();
  const due = currentDue ? currentDue.slice(0, 10) : null;
  const customNum = parseInt(custom, 10);
  const customValid = custom.trim() !== '' && !isNaN(customNum) && customNum >= 1 && customNum <= 365;
  const days: number | null = custom.trim() !== '' ? (customValid ? customNum : null) : preset;
  const newDue = days != null ? computeExtendedDue(due, days) : null;
  const overdue = !!due && due < today;

  return (
    <View style={[styles.card, styles.modalCard, { gap: 13 }]}>
      <View style={{ gap: 2 }}>
        <Text style={{ fontSize: 18, fontWeight: '800', color: Colors.text }}>{t('extend.title')}</Text>
        <Text style={{ fontSize: 13.5, color: Colors.subtext }}>{borrowerName}</Text>
      </View>
      <Text style={{ fontSize: 14, color: Colors.text }}>
        {t('extend.currentDue', { d: due ? formatDateForLang(due, lang) : t('lend.notSet') })}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {EXTEND_PRESETS.map((n) => {
          const activeChip = custom.trim() === '' && preset === n;
          return (
            <TouchableOpacity
              key={n}
              onPress={() => { setPreset(n); setCustom(''); }}
              activeOpacity={0.8}
              style={[styles.chip, { flex: 1, marginRight: 0, height: 40 }, activeChip ? styles.chipActive : null]}
            >
              <Text style={[styles.chipText, activeChip ? styles.chipTextActive : null]}>
                {t('extend.chipDays', { n })}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <View style={{ gap: 7 }}>
        <Text style={{ fontSize: 13, fontWeight: '800', letterSpacing: 0.4, color: Colors.text }}>
          {t('extend.customDays')}
        </Text>
        <TextInput
          style={styles.input}
          keyboardType="number-pad"
          placeholder={t('extend.customPh')}
          placeholderTextColor={Colors.faint}
          value={custom}
          onChangeText={(v) => setCustom(v.replace(/\D/g, '').slice(0, 3))}
        />
      </View>
      {!!newDue && (
        <View style={{ gap: 2 }}>
          <Text style={{ fontSize: 14.5, fontWeight: '700', color: Colors.primaryDark }}>
            {t('extend.newDue', { d: formatDateForLang(newDue, lang) })}
          </Text>
          {overdue && (
            <Text style={{ fontSize: 12.5, fontStyle: 'italic', color: Colors.subtext }}>
              {t('extend.fromTodayNote')}
            </Text>
          )}
        </View>
      )}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <AppButton title={t('common.cancel')} variant="secondary" onPress={onClose} style={{ flex: 1 }} />
        <AppButton
          title={t('extend.confirm')}
          icon="calendar-outline"
          disabled={days == null}
          onPress={() => { if (newDue) onConfirm(newDue); }}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}

// ---------- Bộ chọn số lượng dùng chung ----------

/**
 * Stepper số lượng chuẩn cho mọi form có ngữ cảnh "áp lên bao nhiêu cái":
 * - Hàng chính: nút [−] / [+], ở giữa là Ô NHẬP gõ số trực tiếp (blur /
 *   submit thì kẹp về 1..max) + đơn vị, kèm chip "Tất cả" (chỉ hiện khi
 *   max > 1) để nhảy thẳng tới max.
 * - Khi max >= 10: thêm THANH KÉO thuần JS (responder props của View,
 *   không thư viện native) ngay dưới hàng chính — chạm/kéo trên track để
 *   đặt giá trị theo tỉ lệ vị trí; max nhỏ hơn thì − / + + gõ tay là đủ,
 *   giữ form gọn.
 * Nơi gọi tự quyết định mặc định (thường = max) và tự hiện cảnh báo khi
 * value = max.
 */
export function QtyStepper({
  value, max, unit, onChange,
}: {
  value: number;
  max: number;
  unit: string;
  onChange: (n: number) => void;
}) {
  const { t } = useT();
  const cap = Math.max(1, max);
  const current = Math.min(Math.max(1, value), cap);
  // Ô nhập: khi KHÔNG focus thì hiển thị thẳng giá trị hiện tại (suy ra từ
  // props, không cần effect đồng bộ); khi focus thì hiển thị chuỗi đang gõ
  // trong state text (khởi tạo lúc focus) và chỉ chốt khi blur/submit
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);

  const clampQty = (n: number) => Math.min(cap, Math.max(1, n));
  function commitText(raw: string) {
    const n = parseInt(raw.replace(/\D/g, ''), 10);
    if (!isNaN(n)) onChange(clampQty(n));
  }

  const stepBtn = (icon: IconName, delta: number, disabled: boolean) => (
    <TouchableOpacity
      onPress={() => onChange(clampQty(current + delta))}
      disabled={disabled}
      activeOpacity={0.8}
      style={{
        width: 44, height: 44, borderRadius: 14,
        backgroundColor: disabled ? Colors.chipBg : tint(Colors.primary),
        alignItems: 'center', justifyContent: 'center',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <Ionicons name={icon} size={20} color={disabled ? Colors.faint : Colors.primary} />
    </TouchableOpacity>
  );

  // ---- Thanh kéo (chỉ khi cap >= 10): track đo bằng onLayout, ánh xạ
  // pageX của ngón tay → tỉ lệ 0..1 trên bề ngang track → giá trị 1..cap.
  const showSlider = cap >= 10;
  const [trackW, setTrackW] = useState(0);
  const trackRef = useRef<React.ElementRef<typeof View>>(null);
  // Ref song song với state trackW + pageX của track: handler kéo đọc ref
  // (đo 1 lần ở onLayout) thay vì measureInWindow ở mỗi sự kiện di chuyển
  const trackWRef = useRef(0);
  const trackPageX = useRef(0);
  const applyPageX = (pageX: number) => {
    const w = trackWRef.current;
    if (w <= 0) return;
    const ratio = Math.min(1, Math.max(0, (pageX - trackPageX.current) / w));
    onChange(clampQty(1 + Math.round(ratio * (cap - 1))));
  };
  // Cử chỉ kéo gắn thẳng qua responder props của View track:
  // grant/move đều ánh xạ pageX → giá trị như nhau
  // Vị trí núm theo px (trackW đo từ onLayout); cap >= 10 nên cap - 1 > 0
  const fillRatio = showSlider ? (current - 1) / (cap - 1) : 0;
  const knobX = fillRatio * trackW;

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {stepBtn('remove-outline', -1, current <= 1)}
        <View style={{ minWidth: 74, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 4 }}>
          <TextInput
            style={{
              minWidth: 40, textAlign: 'center', fontSize: 16, fontWeight: '800', color: Colors.text,
              paddingVertical: 2, paddingHorizontal: 2,
            }}
            keyboardType="number-pad"
            value={focused ? text : String(current)}
            onChangeText={(v) => setText(v.replace(/\D/g, '').slice(0, 6))}
            onFocus={() => { setText(String(current)); setFocused(true); }}
            onBlur={() => { setFocused(false); commitText(text); }}
            onSubmitEditing={() => commitText(text)}
            selectTextOnFocus
          />
          <Text style={{ fontSize: 16, fontWeight: '800', color: Colors.text }}>{unit}</Text>
        </View>
        {stepBtn('add-outline', 1, current >= cap)}
        {cap > 1 && (
          <TouchableOpacity
            onPress={() => onChange(cap)}
            activeOpacity={0.8}
            style={[
              styles.chip, { marginRight: 0, height: 36 },
              current === cap ? styles.chipActive : null,
            ]}
          >
            <Text style={[styles.chipText, current === cap ? styles.chipTextActive : null]}>
              {t('qty.all')}
            </Text>
          </TouchableOpacity>
        )}
      </View>
      {showSlider && (
        <View
          ref={trackRef}
          onLayout={(e) => {
            trackWRef.current = e.nativeEvent.layout.width;
            setTrackW(e.nativeEvent.layout.width);
            // Ghi lại pageX của track để handler kéo tính tỉ lệ theo vị trí ngón tay
            trackRef.current?.measureInWindow((x) => { trackPageX.current = x; });
          }}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderTerminationRequest={() => false}
          onResponderGrant={(e) => applyPageX(e.nativeEvent.pageX)}
          onResponderMove={(e) => applyPageX(e.nativeEvent.pageX)}
          style={{ height: 28, justifyContent: 'center' }}
        >
          <View style={{ height: 6, borderRadius: 3, backgroundColor: Colors.chipBg, overflow: 'hidden' }}>
            <View style={{ height: 6, borderRadius: 3, backgroundColor: Colors.primary, width: trackW > 0 ? knobX : 0 }} />
          </View>
          <View
            pointerEvents="none"
            style={{
              position: 'absolute', left: trackW > 0 ? knobX - 13 : -13, top: 1,
              width: 26, height: 26, borderRadius: 13, backgroundColor: Colors.primary,
              borderWidth: 2.5, borderColor: '#fff',
              shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4, elevation: 3,
            }}
          />
        </View>
      )}
    </View>
  );
}

// ---------- Popup theo phong cách app (thay hộp thoại hệ thống cho xác nhận / lựa chọn) ----------

export interface AppPopupOption {
  label: string;
  icon?: IconName;
  color?: string;
  description?: string;
  onPress: () => void;
}

/**
 * Popup dùng chung thay cho hộp thoại hệ thống ở các điểm xác nhận / lựa
 * chọn / thông báo: thẻ bo góc giữa màn trên nền mờ (bấm ra ngoài hoặc nút
 * × ở góc trên phải để đóng — × LUÔN có). Ba chế độ:
 * - options: mỗi lựa chọn là 1 hàng bấm lớn (ô icon nhuộm màu + nhãn +
 *   mô tả tuỳ chọn) — cho các điểm nhiều lựa chọn như "Đã xử lý".
 * - confirm: 2 nút — nút phụ "Để sau" (đóng, không làm gì) + nút xác nhận
 *   (danger = nền đỏ đặc) — cho các điểm xác nhận xoá / thao tác kết thúc.
 * - okLabel: popup thông báo/lỗi thuần — 1 nút chính duy nhất mang nhãn
 *   này (vd "Đã hiểu") để đóng; không truyền thì rơi về nút phụ "Để sau"
 *   như hành vi cũ.
 * notice: dòng cảnh báo phụ hiển thị trong hộp cam (vd cảnh báo tự đóng
 * lượt mượn của thao tác kết thúc).
 */
export function AppPopup({
  visible, title, message, notice, options, confirm, okLabel, onClose,
}: {
  visible: boolean;
  title: string;
  message?: string;
  notice?: string | null;
  options?: AppPopupOption[];
  confirm?: { label: string; danger?: boolean; onConfirm: () => void };
  okLabel?: string;
  onClose: () => void;
}) {
  const { t } = useT();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.card, styles.modalCard, { gap: 13 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
            <Text style={{ flex: 1, fontSize: 18, fontWeight: '800', color: Colors.text, lineHeight: 24 }}>{title}</Text>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={8}
              style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: Colors.chipBg, alignItems: 'center', justifyContent: 'center' }}
            >
              <Ionicons name="close" size={19} color={Colors.primaryDark} />
            </TouchableOpacity>
          </View>
          {!!message && (
            <Text style={{ fontSize: 14, color: Colors.subtext, lineHeight: 20 }}>{message}</Text>
          )}
          {!!notice && (
            <View
              style={{
                flexDirection: 'row', gap: 7, alignItems: 'flex-start',
                backgroundColor: tint(Colors.orange, '16'), borderRadius: 12,
                paddingHorizontal: 10, paddingVertical: 8,
              }}
            >
              <Ionicons name="warning-outline" size={16} color={Colors.orange} style={{ marginTop: 1 }} />
              <Text style={{ flex: 1, fontSize: 12.5, lineHeight: 18, color: Colors.text }}>{notice}</Text>
            </View>
          )}
          {!!options && options.length > 0 && (
            <View style={{ gap: 9 }}>
              {options.map((opt) => {
                const color = opt.color ?? Colors.primary;
                return (
                  <TouchableOpacity
                    key={opt.label}
                    onPress={() => { onClose(); opt.onPress(); }}
                    activeOpacity={0.85}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 11,
                      borderRadius: 16, paddingHorizontal: 12, paddingVertical: 11,
                      backgroundColor: tint(color, '14'),
                      borderWidth: 1.5, borderColor: tint(color, '40'),
                    }}
                  >
                    {!!opt.icon && (
                      <View style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: tint(color, '26'), alignItems: 'center', justifyContent: 'center' }}>
                        <Ionicons name={opt.icon} size={20} color={color} />
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontWeight: '700', color }}>{opt.label}</Text>
                      {!!opt.description && (
                        <Text style={{ fontSize: 12.5, color: Colors.subtext, marginTop: 1 }}>{opt.description}</Text>
                      )}
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={color} />
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
          {confirm ? (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <AppButton title={t('popup.later')} variant="secondary" onPress={onClose} style={{ flex: 1 }} />
              <AppButton
                title={confirm.label}
                onPress={() => { onClose(); confirm.onConfirm(); }}
                style={confirm.danger
                  ? { flex: 1, backgroundColor: Colors.danger, shadowColor: Colors.danger }
                  : { flex: 1 }}
              />
            </View>
          ) : !options || options.length === 0 ? (
            <AppButton
              title={okLabel ?? t('popup.later')}
              variant={okLabel ? 'primary' : 'secondary'}
              onPress={onClose}
            />
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

// ---------- Hoãn nhắc: chọn số ngày (mức sẵn + tuỳ chọn) ----------

const SNOOZE_PRESETS: { days: number; labelKey: string }[] = [
  { days: 1, labelKey: 'alerts.snooze1' },
  { days: 3, labelKey: 'alerts.snooze3' },
  { days: 7, labelKey: 'alerts.snooze7' },
  { days: 14, labelKey: 'alerts.snooze14' },
  { days: 30, labelKey: 'alerts.snooze30' },
];

/**
 * Popup hoãn nhắc dùng chung (tab Cho mượn + chi tiết đồ, cho cả lượt mượn
 * và món): radio các mức 1/3/7/14/30 ngày (mặc định chọn 3) + hàng "Tuỳ
 * chọn" kèm stepper nhỏ 1–90 ngày (mặc định 5). KHÁC AppPopup dạng options
 * (chọn là áp dụng ngay): ở đây chỉ khi bấm nút xác nhận "Hoãn nhắc" mới
 * gọi onConfirm(days); bấm × / nền ngoài là huỷ, không áp gì cả. Nơi gọi
 * tự chạy setLoanAlertSnooze / setItemAlertSnooze rồi đóng popup.
 * Thêm hàng "Không nhắc lại nữa" khi nơi gọi truyền onNever: bấm là áp
 * NGAY (như một lựa chọn dứt điểm, không qua nút xác nhận) — nơi gọi ghi
 * mốc hoãn vĩnh viễn ALERT_SNOOZE_FOREVER_ISO qua chính setter snooze.
 * (QtyStepper của form số lượng món không dùng lại được ở đây vì nó gắn
 * chip "Tất cả" + đơn vị món — stepper ngày này làm riêng, nhỏ gọn.)
 */
export function SnoozePopup({
  visible, onClose, onConfirm, onNever,
}: {
  visible: boolean;
  onClose: () => void;
  onConfirm: (days: number) => void;
  onNever?: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        {/* Card chỉ mount khi popup mở => lựa chọn luôn khởi tạo mới (mặc định 3 ngày) */}
        {visible && <SnoozePopupCard onClose={onClose} onConfirm={onConfirm} onNever={onNever} />}
      </View>
    </Modal>
  );
}

function SnoozePopupCard({
  onClose, onConfirm, onNever,
}: {
  onClose: () => void;
  onConfirm: (days: number) => void;
  onNever?: () => void;
}) {
  const { t } = useT();
  /** Mức đang chọn: số ngày preset, hoặc null = đang chọn hàng Tuỳ chọn */
  const [preset, setPreset] = useState<number | null>(3);
  const [customDays, setCustomDays] = useState(5);
  const days = preset ?? customDays;

  const radioDot = (active: boolean) => (
    <View
      style={{
        width: 20, height: 20, borderRadius: 10,
        borderWidth: 2, borderColor: active ? Colors.primary : Colors.border,
        backgroundColor: active ? Colors.primary : 'transparent',
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      {active && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' }} />}
    </View>
  );
  const rowStyle = (active: boolean) => ({
    flexDirection: 'row' as const, alignItems: 'center' as const, gap: 11,
    borderRadius: 14, paddingHorizontal: 13, paddingVertical: 11,
    borderWidth: 1.5,
    borderColor: active ? Colors.primary : Colors.border,
    backgroundColor: active ? tint(Colors.primary, '10') : '#fff',
  });
  const optionLabel = (active: boolean) => ({
    fontSize: 15,
    fontWeight: (active ? '800' : '600') as '800' | '600',
    color: active ? Colors.primary : Colors.text,
  });
  const stepperBtn = (icon: IconName, delta: number, disabled: boolean) => (
    <TouchableOpacity
      onPress={() => { setPreset(null); setCustomDays((d) => Math.min(90, Math.max(1, d + delta))); }}
      disabled={disabled}
      activeOpacity={0.8}
      style={{
        width: 30, height: 30, borderRadius: 15,
        borderWidth: 1.5, borderColor: Colors.primary,
        alignItems: 'center', justifyContent: 'center',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Ionicons name={icon} size={15} color={Colors.primary} />
    </TouchableOpacity>
  );

  return (
    <View style={[styles.card, styles.modalCard, { gap: 13 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <Text style={{ flex: 1, fontSize: 18, fontWeight: '800', color: Colors.text, lineHeight: 24 }}>
          {t('alerts.snoozeTitle')}
        </Text>
        <TouchableOpacity
          onPress={onClose}
          hitSlop={8}
          style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: Colors.chipBg, alignItems: 'center', justifyContent: 'center' }}
        >
          <Ionicons name="close" size={19} color={Colors.primaryDark} />
        </TouchableOpacity>
      </View>
      <View style={{ gap: 8 }}>
        {SNOOZE_PRESETS.map(({ days: d, labelKey }) => {
          const active = preset === d;
          return (
            <TouchableOpacity key={d} onPress={() => setPreset(d)} activeOpacity={0.85} style={rowStyle(active)}>
              {radioDot(active)}
              <Text style={[{ flex: 1 }, optionLabel(active)]}>{t(labelKey)}</Text>
            </TouchableOpacity>
          );
        })}
        <View style={rowStyle(preset === null)}>
          <TouchableOpacity
            onPress={() => setPreset(null)}
            activeOpacity={0.85}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 11, flex: 1 }}
          >
            {radioDot(preset === null)}
            <Text style={optionLabel(preset === null)}>{t('alerts.snoozeCustom')}</Text>
          </TouchableOpacity>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
            {stepperBtn('remove-outline', -1, customDays <= 1)}
            <Text style={{ minWidth: 52, textAlign: 'center', fontSize: 14, fontWeight: '800', color: Colors.text }}>
              {t('alerts.snoozeDays', { n: customDays })}
            </Text>
            {stepperBtn('add-outline', 1, customDays >= 90)}
          </View>
        </View>
        {!!onNever && (
          <TouchableOpacity onPress={onNever} activeOpacity={0.85} style={rowStyle(false)}>
            <Ionicons name="notifications-off" size={19} color={Colors.danger} />
            <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: Colors.danger }}>
              {t('alerts.snoozeNever')}
            </Text>
          </TouchableOpacity>
        )}
      </View>
      <AppButton
        title={t('alerts.snoozeConfirm')}
        icon="notifications-off-outline"
        onPress={() => onConfirm(days)}
      />
    </View>
  );
}

// ---------- Nhận lại đồ (một phần / toàn bộ) ----------

/**
 * Modal nhận lại đồ dùng chung (chi tiết đồ + tab Cho mượn): đây là đường
 * nhận lại DUY NHẤT của nút chính "Đã nhận lại" ở mọi nơi — stepper chọn
 * số lượng nhận lại 1..outstanding (mặc định = outstanding, tức tất cả) +
 * ghi chú tuỳ chọn; trả một phần hay toàn bộ chỉ khác nhau ở số đã chọn.
 * Nơi gọi tự thực hiện returnLoan(loanId, qty, { note }) trong onConfirm.
 */
export function ReturnQtyModal({
  visible, itemName, borrowerName, outstanding, unit, onClose, onConfirm,
}: {
  visible: boolean;
  itemName: string;
  borrowerName: string;
  outstanding: number;
  unit: string;
  onClose: () => void;
  onConfirm: (qty: number, note: string | null) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        {visible && (
          <ReturnQtyCard
            itemName={itemName}
            borrowerName={borrowerName}
            outstanding={outstanding}
            unit={unit}
            onClose={onClose}
            onConfirm={onConfirm}
          />
        )}
      </View>
    </Modal>
  );
}

function ReturnQtyCard({
  itemName, borrowerName, outstanding, unit, onClose, onConfirm,
}: {
  itemName: string;
  borrowerName: string;
  outstanding: number;
  unit: string;
  onClose: () => void;
  onConfirm: (qty: number, note: string | null) => void;
}) {
  const { t } = useT();
  const [qty, setQty] = useState(Math.max(1, outstanding));
  const [note, setNote] = useState('');
  return (
    <View style={[styles.card, styles.modalCard, { gap: 13 }]}>
      <View style={{ gap: 2 }}>
        <Text style={{ fontSize: 18, fontWeight: '800', color: Colors.text }}>{t('detail.returnAll')}</Text>
        <Text style={{ fontSize: 13.5, color: Colors.subtext, lineHeight: 19 }}>
          {t('lend.returnQuestion', { item: itemName, borrower: borrowerName, n: outstanding })}
        </Text>
      </View>
      <Field label={t('loan.receiveQtyLabel')}>
        <QtyStepper value={qty} max={outstanding} unit={unit} onChange={setQty} />
      </Field>
      <Field label={t('common.noteOptional')}>
        <TextInput
          style={styles.input}
          placeholder={t('return.notePh')}
          placeholderTextColor={Colors.faint}
          value={note}
          onChangeText={setNote}
        />
      </Field>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <AppButton title={t('common.cancel')} variant="secondary" onPress={onClose} style={{ flex: 1 }} />
        <AppButton
          title={t('common.confirm')}
          icon="checkmark-done-outline"
          onPress={() => onConfirm(qty, note.trim() || null)}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}

/** Nút nhỏ dạng pill cho 4 kết cục chuyển đổi trên thẻ mượn (Tặng / Bán / Gửi bán / Bố thí) */
function ConvertChip({
  label, icon, color, onPress,
}: {
  label: string;
  icon: IconName;
  color: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={{
        flex: 1, minWidth: 0, height: 36, borderRadius: 999, paddingHorizontal: 6,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
        backgroundColor: tint(color, '16'), borderWidth: 1.5, borderColor: tint(color, '45'),
      }}
    >
      <Ionicons name={icon} size={14} color={color} />
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={{ fontSize: 12.5, fontWeight: '700', color, flexShrink: 1 }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

/** Các handler cho khối thao tác chuẩn trên thẻ mượn — màn hình gọi tự nối tới modal / cơ chế hoãn của mình */
export interface LoanActionHandlers {
  /** Mở ReturnQtyModal: chọn số lượng nhận lại (mặc định = tất cả) + ghi chú — đường nhận lại duy nhất */
  onReceive: () => void;
  /** Mở ExtendLoanModal */
  onExtend: () => void;
  /** Nhắc người mượn qua Share */
  onRemind: () => void;
  /** Mở SnoozePopup chọn số ngày hoãn */
  onSnooze: () => void;
  /** Mở LoanConvertModal theo kết cục đã chọn */
  onConvert: (type: LoanConvertType) => void;
  /** Mở chi tiết món — chỉ tab Cho mượn truyền; ở chi tiết đồ thì đang ngay tại trang món nên không truyền */
  onViewItem?: () => void;
}

/**
 * Khối nút thao tác CHUẨN cho thẻ mượn — dùng chung ở tab Cho mượn và block
 * Cho mượn trong chi tiết đồ để hai nơi giống hệt nhau:
 * Thanh NÉN 1 hàng duy nhất gồm các ô ĐỀU nhau (mỗi ô flex:1, icon trên /
 * chữ dưới): ô chính [Đã nhận] nền tím chữ trắng — cùng kích thước các ô
 * khác (mở ReturnQtyModal chọn số lượng/tất cả kèm ghi chú; không còn nút
 * "Trả một phần" riêng) + các ô phụ (Gia hạn · Nhắc người mượn · Nhắc lại
 * sau · Xem chi tiết — Xem chi tiết chỉ có khi caller truyền onViewItem,
 * tức ở tab) → ngay dưới là hàng chuyển đổi Tặng / Bán / Gửi bán / Bố thí
 * (giữ nguyên như thiết kế trước).
 */
export function LoanActionBlock({ handlers }: { handlers: LoanActionHandlers }) {
  const { t } = useT();
  const onViewItem = handlers.onViewItem;
  const cells: { key: string; icon: IconName; label: string; onPress: () => void; primary?: boolean }[] = [
    { key: 'receive', icon: 'checkmark-done-outline', label: t('detail.returnAll'), onPress: handlers.onReceive, primary: true },
    { key: 'extend', icon: 'calendar-outline', label: t('extend.btn'), onPress: handlers.onExtend },
    { key: 'remind', icon: 'chatbubble-ellipses-outline', label: t('alerts.actRemind'), onPress: handlers.onRemind },
    { key: 'snooze', icon: 'notifications-off-outline', label: t('alerts.actSnooze'), onPress: handlers.onSnooze },
    ...(onViewItem
      ? [{ key: 'view', icon: 'eye-outline' as IconName, label: t('lend.viewItem'), onPress: onViewItem }]
      : []),
  ];
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 7, alignItems: 'stretch' }}>
        {cells.map((cell) => (
          <TouchableOpacity
            key={cell.key}
            onPress={cell.onPress}
            activeOpacity={0.85}
            style={{
              // Không khoá chiều cao cố định: icon 20 + tối đa 2 dòng chữ
              // 12/15 không vừa ô 62px (cắt dấu tiếng Việt) — sizing theo
              // padding, minHeight giữ nhịp cũ khi nhãn chỉ 1 dòng
              flex: 1, minHeight: 62, borderRadius: 16, paddingHorizontal: 2, paddingVertical: 8,
              alignItems: 'center', justifyContent: 'center', gap: 2,
              ...(cell.primary
                ? {
                    backgroundColor: Colors.primary,
                    shadowColor: Colors.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.28, shadowRadius: 12, elevation: 5,
                  }
                : { backgroundColor: Colors.chipBg, borderWidth: 1, borderColor: Colors.border }),
            }}
          >
            <Ionicons name={cell.icon} size={20} color={cell.primary ? '#fff' : Colors.primaryDark} />
            <Text
              numberOfLines={2}
              style={{
                fontSize: 12, fontWeight: '700', lineHeight: 15, textAlign: 'center',
                color: cell.primary ? '#fff' : Colors.text,
              }}
            >
              {cell.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {/* Chuyển đổi ngay tại record: phần người mượn đang giữ ngã ngũ tại chỗ */}
      <View style={{ marginTop: 2, gap: 7 }}>
        <Text style={{ fontSize: 12, fontWeight: '800', letterSpacing: 0.4, color: Colors.subtext }}>
          {t('convert.label')}
        </Text>
        <View style={{ flexDirection: 'row', gap: 7 }}>
          <ConvertChip label={t('convert.gift')} icon={statusIcon('GIFTED')} color={statusColorFor('GIFTED')} onPress={() => handlers.onConvert('GIFTED')} />
          <ConvertChip label={t('convert.sell')} icon={statusIcon('SOLD')} color={statusColorFor('SOLD')} onPress={() => handlers.onConvert('SOLD')} />
          <ConvertChip label={t('convert.consign')} icon={statusIcon('CONSIGNED')} color={statusColorFor('CONSIGNED')} onPress={() => handlers.onConvert('CONSIGN')} />
          <ConvertChip label={t('convert.donate')} icon={statusIcon('DONATED')} color={statusColorFor('DONATED')} onPress={() => handlers.onConvert('DONATED')} />
        </View>
      </View>
    </View>
  );
}

// ---------- Chuyển đổi phần đang cho mượn ----------

export type LoanConvertType = 'GIFTED' | 'SOLD' | 'DONATED' | 'CONSIGN';

export interface LoanConvertPayload {
  type: LoanConvertType;
  qty: number;
  /** Giá bán (SOLD) hoặc giá mong muốn (CONSIGN); null nếu không nhập */
  price: number | null;
  /** Ghi chú người dùng — chỉ CONSIGN dùng làm loans.note của record gửi bán mới */
  note: string | null;
  /** Note đã soạn sẵn theo ngôn ngữ hiện tại — tầng dữ liệu dùng làm sold_note khi món kết thúc hẳn tại record */
  uiNote: string;
  /** Người nhận phía LỊCH SỬ (JSON note): người mượn; riêng Bố thí là nơi/người nhận bố thí */
  histWho: string;
  /** Phần phụ phía LỊCH SỬ (giá đã định dạng / ghi chú), gộp sẵn theo ngôn ngữ hiện tại */
  histExtra: string | null;
}

const CONVERT_TYPES: { type: LoanConvertType; labelKey: string; statusKey: string }[] = [
  { type: 'GIFTED', labelKey: 'convert.gift', statusKey: 'GIFTED' },
  { type: 'SOLD', labelKey: 'convert.sell', statusKey: 'SOLD' },
  { type: 'CONSIGN', labelKey: 'convert.consign', statusKey: 'CONSIGNED' },
  { type: 'DONATED', labelKey: 'convert.donate', statusKey: 'DONATED' },
];

/**
 * Modal chuyển đổi phần đang cho mượn ngay tại record: chọn 1 trong 4 kết
 * cục (Tặng / Bán / Gửi bán / Bố thí), stepper số lượng (tối đa = phần còn
 * nợ), trường riêng theo loại (SOLD: giá + người mua cố định là người mượn;
 * CONSIGN: giá mong muốn; DONATED: nơi/người nhận; GIFTED: ghi chú).
 * Modal chỉ soạn payload + uiNote; nơi gọi chạy convertLoanPortion /
 * convertLoanToConsignment theo payload.type.
 */
export function LoanConvertModal({
  visible, itemName, borrowerName, outstanding, unit, initialType, onClose, onConvert,
}: {
  visible: boolean;
  itemName: string;
  borrowerName: string;
  outstanding: number;
  unit: string;
  initialType: LoanConvertType;
  onClose: () => void;
  onConvert: (payload: LoanConvertPayload) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        {visible && (
          <LoanConvertCard
            itemName={itemName}
            borrowerName={borrowerName}
            outstanding={outstanding}
            unit={unit}
            initialType={initialType}
            onClose={onClose}
            onConvert={onConvert}
          />
        )}
      </View>
    </Modal>
  );
}

function LoanConvertCard({
  itemName, borrowerName, outstanding, unit, initialType, onClose, onConvert,
}: {
  itemName: string;
  borrowerName: string;
  outstanding: number;
  unit: string;
  initialType: LoanConvertType;
  onClose: () => void;
  onConvert: (payload: LoanConvertPayload) => void;
}) {
  const { t } = useT();
  const [type, setType] = useState<LoanConvertType>(initialType);
  const [qty, setQty] = useState(Math.max(1, outstanding));
  const [priceText, setPriceText] = useState('');
  const [note, setNote] = useState('');
  const [recipient, setRecipient] = useState('');
  const price = priceText.trim() ? parseInt(priceText.replace(/[^\d]/g, ''), 10) || null : null;

  function buildPayload(): LoanConvertPayload {
    const noteText = note.trim();
    let uiNote: string;
    if (type === 'GIFTED') {
      uiNote = t('convert.histGifted', { borrower: borrowerName });
    } else if (type === 'SOLD') {
      uiNote = t('convert.histSold', { borrower: borrowerName }) + (price ? ` · ${formatVND(price)}` : '');
    } else if (type === 'DONATED') {
      uiNote = recipient.trim()
        ? t('convert.histDonated', { to: recipient.trim() })
        : t('detail.action.donated');
    } else {
      uiNote = t('convert.histConsigned', { borrower: borrowerName }) + (price ? ` · ${formatVND(price)}` : '');
    }
    if (type !== 'DONATED' && noteText) uiNote += ` · ${noteText}`;
    // Người nhận + phần phụ cho note lịch sử dạng JSON (timeline đọc một
    // khuôn "người · SL n · phụ" như các dòng mượn/trả): Bố thí lấy
    // nơi/người nhận (trống thì lấy người đang giữ), các loại còn lại lấy
    // người mượn; phần phụ là giá / ghi chú đã gộp.
    const histWho = type === 'DONATED' ? recipient.trim() || borrowerName : borrowerName;
    const histParts: string[] = [];
    if ((type === 'SOLD' || type === 'CONSIGN') && price) histParts.push(formatVND(price));
    if (type !== 'DONATED' && type !== 'CONSIGN' && noteText) histParts.push(noteText);
    return {
      type,
      qty,
      price,
      note: type === 'CONSIGN' ? noteText || null : null,
      uiNote,
      histWho,
      histExtra: histParts.length > 0 ? histParts.join(' · ') : null,
    };
  }

  return (
    <View style={[styles.card, styles.modalCard, { gap: 13 }]}>
      <View style={{ gap: 2 }}>
        <Text style={{ fontSize: 18, fontWeight: '800', color: Colors.text }}>{t('convert.title')}</Text>
        <Text style={{ fontSize: 13.5, color: Colors.subtext, lineHeight: 19 }}>
          {itemName} · {t('convert.contextLine', { borrower: borrowerName, n: outstanding, unit })}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {CONVERT_TYPES.map(({ type: ty, labelKey, statusKey }) => {
          const color = statusColorFor(statusKey);
          const activeType = type === ty;
          return (
            <TouchableOpacity
              key={ty}
              onPress={() => setType(ty)}
              activeOpacity={0.85}
              style={{
                width: '48%', flexGrow: 1, height: 46, borderRadius: 14,
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
                backgroundColor: activeType ? color : tint(color, '14'),
                borderWidth: 1.5, borderColor: activeType ? color : tint(color, '40'),
              }}
            >
              <Ionicons name={statusIcon(statusKey)} size={17} color={activeType ? '#fff' : color} />
              <Text style={{ fontSize: 14, fontWeight: '700', color: activeType ? '#fff' : color }}>
                {t(labelKey)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Field label={t('convert.qtyLabel')}>
        <QtyStepper value={qty} max={outstanding} unit={unit} onChange={setQty} />
      </Field>
      {type === 'SOLD' && (
        <>
          <Text style={{ fontSize: 13.5, color: Colors.subtext }}>
            {t('convert.buyerFixed', { name: borrowerName })}
          </Text>
          <Field label={t('convert.priceLabel')}>
            <TextInput
              style={styles.input}
              keyboardType="number-pad"
              placeholder={t('detail.sellPricePh')}
              placeholderTextColor={Colors.faint}
              value={priceText}
              onChangeText={setPriceText}
            />
          </Field>
        </>
      )}
      {type === 'CONSIGN' && (
        <Field label={t('convert.expectedPriceLabel')}>
          <TextInput
            style={styles.input}
            keyboardType="number-pad"
            placeholder={t('convert.expectedPricePh')}
            placeholderTextColor={Colors.faint}
            value={priceText}
            onChangeText={setPriceText}
          />
        </Field>
      )}
      {type === 'DONATED' ? (
        <Field label={t('convert.recipientLabel')}>
          <TextInput
            style={styles.input}
            placeholder={t('convert.recipientPh')}
            placeholderTextColor={Colors.faint}
            value={recipient}
            onChangeText={setRecipient}
          />
        </Field>
      ) : (
        <Field label={t('common.noteOptional')}>
          <TextInput
            style={styles.input}
            placeholder={t('convert.notePh')}
            placeholderTextColor={Colors.faint}
            value={note}
            onChangeText={setNote}
          />
        </Field>
      )}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <AppButton title={t('common.cancel')} variant="secondary" onPress={onClose} style={{ flex: 1 }} />
        <AppButton
          title={t('common.confirm')}
          icon="checkmark-circle"
          onPress={() => onConvert(buildPayload())}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}

// ---------- Ngã ngũ một record gửi bán ----------

export interface ConsignResolvePayload {
  mode: 'SOLD' | 'TAKEBACK';
  qty: number;
  /** Giá bán thực tế (chỉ SOLD) */
  price: number | null;
  uiNote: string;
}

/**
 * Modal ngã ngũ record gửi bán: ĐÃ BÁN ĐƯỢC (stepper + giá bán thực tế,
 * điền sẵn giá mong muốn nếu có) hoặc LẤY LẠI (chỉ stepper). Dùng chung
 * cho tab Cho mượn và chi tiết đồ; nơi gọi chạy resolveConsignment.
 */
export function ConsignResolveModal({
  visible, mode, itemName, holderName, outstanding, unit, expectedPrice, onClose, onConfirm,
}: {
  visible: boolean;
  mode: 'SOLD' | 'TAKEBACK';
  itemName: string;
  holderName: string;
  outstanding: number;
  unit: string;
  expectedPrice?: number | null;
  onClose: () => void;
  onConfirm: (payload: ConsignResolvePayload) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        {visible && (
          <ConsignResolveCard
            mode={mode}
            itemName={itemName}
            holderName={holderName}
            outstanding={outstanding}
            unit={unit}
            expectedPrice={expectedPrice ?? null}
            onClose={onClose}
            onConfirm={onConfirm}
          />
        )}
      </View>
    </Modal>
  );
}

function ConsignResolveCard({
  mode, itemName, holderName, outstanding, unit, expectedPrice, onClose, onConfirm,
}: {
  mode: 'SOLD' | 'TAKEBACK';
  itemName: string;
  holderName: string;
  outstanding: number;
  unit: string;
  expectedPrice: number | null;
  onClose: () => void;
  onConfirm: (payload: ConsignResolvePayload) => void;
}) {
  const { t } = useT();
  const [qty, setQty] = useState(Math.max(1, outstanding));
  const [priceText, setPriceText] = useState(expectedPrice ? String(expectedPrice) : '');
  const price = priceText.trim() ? parseInt(priceText.replace(/[^\d]/g, ''), 10) || null : null;

  function handleConfirm() {
    const uiNote = mode === 'SOLD'
      ? t('consign.histSold', { holder: holderName }) + (price ? ` · ${formatVND(price)}` : '')
      : t('consign.histTakeback', { holder: holderName });
    onConfirm({ mode, qty, price: mode === 'SOLD' ? price : null, uiNote });
  }

  return (
    <View style={[styles.card, styles.modalCard, { gap: 13 }]}>
      <View style={{ gap: 2 }}>
        <Text style={{ fontSize: 18, fontWeight: '800', color: Colors.text }}>
          {mode === 'SOLD'
            ? t('consign.resolveSoldTitle', { item: itemName })
            : t('consign.resolveTakebackTitle', { item: itemName })}
        </Text>
        <Text style={{ fontSize: 13.5, color: Colors.subtext }}>
          {t('consign.holderLine', { name: holderName })}
        </Text>
      </View>
      <Field label={t('convert.qtyLabel')}>
        <QtyStepper value={qty} max={outstanding} unit={unit} onChange={setQty} />
      </Field>
      {mode === 'SOLD' && (
        <Field label={t('consign.priceLabel')}>
          <TextInput
            style={styles.input}
            keyboardType="number-pad"
            placeholder={t('detail.sellPricePh')}
            placeholderTextColor={Colors.faint}
            value={priceText}
            onChangeText={setPriceText}
          />
        </Field>
      )}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <AppButton title={t('common.cancel')} variant="secondary" onPress={onClose} style={{ flex: 1 }} />
        <AppButton
          title={t('common.confirm')}
          icon="checkmark-circle"
          onPress={handleConfirm}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}
