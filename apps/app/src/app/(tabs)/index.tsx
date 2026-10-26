import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity, RefreshControl, StyleSheet,
  Image, ScrollView, useWindowDimensions,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { styles, Colors, ItemCard, SectionTitle, AddTermModal, AppButton, AppPopup, TAB_BAR_CLEARANCE, type AppPopupOption } from '@/components/ui';
import { kvGet, kvSet } from '@/db/client';
import { takePhoto, pickPhoto, saveAvatarImage, removeAvatarImage } from '@/services/imageService';
import {
  categoryColor, categoryIcon, categoryLabel, statusColorFor, statusIcon, statusLabel, tint, darken,
  ALERT_TIER_COLORS, alertTierColor, alertTierIcon,
  STATUS_GROUPS,
  type IconName,
} from '@/theme';
import { useT } from '@/i18n';
import type { AlertTier, Item, ItemCategory, ItemStatus } from '@/types';
import { CATEGORY_LABELS, STATUS_LABELS } from '@/types';
import {
  searchItems, listItems, getBreadcrumb, breadcrumbText, listMediaForOwner,
  listActiveLoans, listActiveConsignments, outstandingOf, countActiveItems, countLocations,
  findItemByBarcode, findLocationByQrCode,
} from '@/db/queries';
import BarcodeScannerModal from '@/components/BarcodeScannerModal';
import { useAppStore } from '@/store/useAppStore';
import { getAlertTier, isAlertSnoozed, formatDateForLang } from '@/utils';
import { getAlertSettings, ALERT_SETTINGS_DEFAULTS, type AlertSettings } from '@/services/alertSettings';

/** Một dòng trong khối cảnh báo Trang chủ (hạn dùng của món hoặc hạn trả của khoản vay) */
interface HomeAlertRow {
  key: string;
  kind: 'expiry' | 'loan';
  tier: AlertTier;
  days: number;
  itemId: string;
  name: string;
  borrower?: string;
  date: string;
}

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/** Chữ huy hiệu ngắn theo mức (dùng cho cả dòng cảnh báo ở Trang chủ) */
function alertBadgeText(tt: TranslateFn, tier: AlertTier, days: number): string {
  if (tier === 'OVERDUE') return tt('alerts.badgeOverdue', { d: -days });
  if (tier === 'DUE') return tt('alerts.badgeDueToday');
  if (tier === 'SOON') return tt('alerts.badgeDaysLeft', { d: days });
  return tt('alerts.badgeWatch', { d: days });
}

/** Một dòng cảnh báo trong khối Trang chủ. Từ dòng thứ hai của nhóm trở đi có
    đường phân cách mảnh phía trên, lề trái thẳng hàng với phần chữ (icon 15 + gap 8 = 23) */
function AlertRowItem({ row, color, first }: { row: HomeAlertRow; color: string; first: boolean }) {
  const { t, lang } = useT();
  return (
    <>
      {!first && (
        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: Colors.border, marginLeft: 23 }} />
      )}
      <TouchableOpacity
        onPress={() => router.push(`/item/${row.itemId}`)}
        activeOpacity={0.75}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3 }}
      >
        <Ionicons name={row.kind === 'loan' ? 'swap-horizontal' : alertTierIcon(row.tier)} size={15} color={color} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: '600', color: Colors.text }}>{row.name}</Text>
          <Text numberOfLines={1} style={{ fontSize: 12, color: Colors.subtext }}>
            {row.kind === 'loan'
              ? t('alerts.rowLoan', { borrower: row.borrower ?? '', d: formatDateForLang(row.date, lang) })
              : t('alerts.rowExpiry', { d: formatDateForLang(row.date, lang) })}
          </Text>
        </View>
        <View style={{ backgroundColor: tint(color), borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 }}>
          <Text style={{ fontSize: 11, fontWeight: '800', color }}>{alertBadgeText(t, row.tier, row.days)}</Text>
        </View>
      </TouchableOpacity>
    </>
  );
}

/** Nút chữ nhỏ căn giữa ở cuối một nhóm cảnh báo: "Xem thêm {n} mục" / "Thu gọn" */
function AlertGroupToggle({
  expanded, hidden, color, onPress,
}: {
  expanded: boolean;
  hidden: number;
  color: string;
  onPress: () => void;
}) {
  const { t } = useT();
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 4 }}
    >
      <Text style={{ fontSize: 12, fontWeight: '700', color }}>
        {expanded ? t('home.showLess') : t('home.showMoreAlerts', { n: hidden })}
      </Text>
      <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={13} color={color} />
    </TouchableOpacity>
  );
}

const BUILTIN_CATS = Object.keys(CATEGORY_LABELS) as ItemCategory[];
const BUILTIN_STATUSES = Object.keys(STATUS_LABELS) as ItemStatus[];

/** Khe giữa các ô trong 2 hàng cuộn ngang Phân loại / Trạng thái (dp):
    6dp cho các ô sát nhau, đầy đặn (trước là 10dp, nhìn rời rạc). */
const CELL_ROW_GAP = 6;

/** Mốc thu gọn của thanh dọc THU GỌN ở danh sách đồ Trang chủ: bấm thanh
    là danh sách quay về đúng 15 món đầu (người dùng chốt 24/10). */
const COLLAPSE_TARGET = 15;

/**
 * Chip lọc trong HÀNG CUỘN NGANG 1 dòng (khối Trạng thái ở Trang chủ):
 * bề ngang CỐ ĐỊNH theo vị trí trong hàng (`cellWidthAt` — đúng 1/3 khổ
 * hàng như thẻ Phân loại, đã gồm phân bổ phần dư làm tròn) để 3 chip
 * đầu luôn hiện TRỌN, chip thứ 4 trở đi cuộn ngang xem tiếp. Nhãn
 * 12px căn giữa 1 dòng; icon mang màu trạng thái (bỏ chấm màu riêng —
 * icon đã mang màu, như bản lưới v48) để chừa bề ngang cho nhãn: ở màn
 * 360dp ô rộng 104, ngân sách nhãn = 104 − padding 10 − icon 13 − gap 4
 * = 77dp, vừa tự nhiên các nhãn dài nhất ('Đã cho mượn' ≈ 6,17em ≈ 74dp
 * ở 12px, 'Đang gửi bán' ≈ 73,8dp). adjustsFontSizeToFit (sàn 0,78) chỉ
 * là lưới an toàn cho nhãn dài bất thường (EN 'On consignment', trạng
 * thái tuỳ chỉnh tên dài) — co có kiểm soát thay vì cắt '…'. Huy hiệu
 * ghim nằm ở góc trên-phải dạng badge để không ăn bề ngang nhãn. Nhấn
 * giữ để ghim/bỏ ghim như cũ.
 * NHẬN DIỆN RIÊNG TỪNG TRẠNG THÁI (v56): chip chưa chọn không còn nền
 * trắng đồng loạt — nền TINT theo đúng màu của trạng thái đó (tint
 * '18'), viền tint đậm hơn ('4D'), icon màu trạng thái, CHỮ là màu
 * trạng thái đã sậm hoá bằng `darken` (cách sậm hoá nhất quán của
 * theme) để đọc rõ trên nền tint kể cả màu sáng. Chip đang chọn giữ
 * nền ĐẶC màu trạng thái + chữ/icon trắng như trước.
 */
function FilterChip({
  label, icon, color, active, pinned, dashed, cellW, onPress, onLongPress,
}: {
  label: string;
  icon?: IconName;
  color: string;
  active: boolean;
  pinned?: boolean;
  dashed?: boolean;
  cellW: number;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={300}
      style={{
        width: cellW, height: 34, paddingHorizontal: 5, borderRadius: 999,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
        backgroundColor: active ? color : tint(color, '18'),
        borderWidth: 1.5, borderStyle: dashed ? 'dashed' : 'solid',
        borderColor: active ? color : tint(color, '4D'),
      }}
    >
      {!!icon && <Ionicons name={icon} size={13} color={active ? '#fff' : color} />}
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.78}
        style={{ fontSize: 12, fontWeight: '700', textAlign: 'center', flexShrink: 1, color: active ? '#fff' : darken(color) }}
      >
        {label}
      </Text>
      {pinned && (
        <Ionicons
          name="pin"
          size={10}
          color={active ? '#fff' : Colors.coral}
          style={{ position: 'absolute', top: -2, right: 3 }}
        />
      )}
    </TouchableOpacity>
  );
}

/**
 * Ghi chú vuốt nhỏ ở bên phải hàng tiêu đề của các mục có hàng cuộn ngang
 * (Phân loại / Trạng thái): icon hoán đổi + chữ 'Vuốt xem thêm' muted
 * ~11.5px. Hiện CỐ ĐỊNH cho cả 2 mục vì danh sách của chúng luôn dài hơn
 * bề ngang khung (12+ phân loại, 12+ trạng thái) — không cần đo tràn.
 */
function SwipeHint() {
  const { t } = useT();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Ionicons name="swap-horizontal" size={13} color={Colors.faint} />
      <Text style={{ fontSize: 11.5, fontWeight: '600', color: Colors.faint }}>{t('home.swipeHint')}</Text>
    </View>
  );
}

function FilterGroupLabel({ icon, text }: { icon: IconName; text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Ionicons name={icon} size={14} color={Colors.primary} />
      <Text style={{ fontSize: 13, fontWeight: '800', color: Colors.subtext, letterSpacing: 0.3 }}>{text}</Text>
    </View>
  );
}

/** Ô thống kê "glass" nằm trong hero: nền trắng mờ + viền sáng, icon trong vòng tròn mờ */
function GlassStatCell({ value, label, iconColor, icon }: { value: number; label: string; iconColor: string; icon: IconName }) {
  return (
    <View
      style={{
        flex: 1, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 11, gap: 7,
        backgroundColor: 'rgba(255,255,255,0.10)',
        borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name={icon} size={14} color={iconColor} />
        </View>
        <Text style={{ fontSize: 20, fontWeight: '800', color: '#fff' }}>{value}</Text>
      </View>
      <Text style={{ fontSize: 11, fontWeight: '600', color: 'rgba(255,255,255,0.75)' }}>{label}</Text>
    </View>
  );
}

/**
 * Ô lớn trong hàng Phân loại: nền màu đặc, cao 112, bề ngang ĐỘNG theo
 * vị trí trong hàng (`cellWidthAt` — đúng 1/3 khổ hàng theo bề ngang
 * màn hình thực, khe giữa các ô chỉ 6dp cho sát nhau) trong hàng cuộn
 * ngang 1 dòng — 3 ô đầu luôn hiện TRỌN, ô thứ 4 trở đi cuộn xem tiếp.
 * Bấm để lọc / bấm lại để bỏ lọc.
 */
function CategoryExploreTile({
  label, icon, color, count, selected, width, onPress,
}: {
  label: string;
  icon: IconName;
  color: string;
  count: number;
  selected: boolean;
  width: number;
  onPress: () => void;
}) {
  const { t } = useT();
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={{
        width, height: 112, borderRadius: 22, padding: 12,
        backgroundColor: color, justifyContent: 'space-between',
        borderWidth: selected ? 2.5 : 0, borderColor: '#fff',
        shadowColor: color, shadowOffset: { width: 0, height: 6 },
        shadowOpacity: selected ? 0.5 : 0.25, shadowRadius: selected ? 12 : 8, elevation: selected ? 7 : 3,
      }}
    >
      <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={icon} size={24} color="#fff" />
      </View>
      <View>
        <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff', lineHeight: 17 }} numberOfLines={2}>{label}</Text>
        <Text style={{ fontSize: 11, fontWeight: '600', color: 'rgba(255,255,255,0.8)', marginTop: 2 }}>{t('home.itemsCount', { n: count })}</Text>
      </View>
    </TouchableOpacity>
  );
}

export default function HomeScreen() {
  const { t } = useT();
  const { width: windowWidth } = useWindowDimensions();
  // Khổ ô cho 2 hàng cuộn ngang 1 dòng (Phân loại + Trạng thái): bề
  // ngang ô = đúng 1/3 phần còn lại của khổ hàng (bề ngang màn hình −
  // padding trang 18×2 − 2 khe CELL_ROW_GAP) và PHẦN DƯ do làm tròn
  // xuống được cộng vào các ô đầu tiên (ô thứ i nhận +1dp khi i <
  // cellRem) để 3 ô + 2 khe LẤP ĐẦY CHÍNH XÁC khổ hàng — không còn
  // vệt trống thừa ở cuối hàng như công thức cũ (làm tròn xuống rồi bỏ
  // phần dư). Màn 360dp: khổ hàng 324 → ô 104+104+104 + 2×6 = 324 ✓.
  // Màn 412dp: khổ hàng 376 → ô 122+121+121 + 2×6 = 376 ✓. Sàn 84dp
  // cho máy rất hẹp (khi đó giữ hành vi cũ, không phân bổ phần dư).
  // 3 ô đầu luôn hiện TRỌN, ô thứ 4 trở đi cuộn ngang xem tiếp.
  const rowAvail = Math.floor(windowWidth) - 36;
  const cellRawBase = Math.floor((rowAvail - CELL_ROW_GAP * 2) / 3);
  const cellBase = Math.max(84, cellRawBase);
  const cellRem = cellRawBase >= 84 ? rowAvail - CELL_ROW_GAP * 2 - cellRawBase * 3 : 0;
  const cellWidthAt = useCallback(
    (i: number) => cellBase + (i < cellRem ? 1 : 0),
    [cellBase, cellRem],
  );
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [catFilter, setCatFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [showAddCat, setShowAddCat] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [crumbs, setCrumbs] = useState<Record<string, string>>({});
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
  const [alertGroups, setAlertGroups] = useState<Record<'OVERDUE' | 'DUE' | 'SOON', HomeAlertRow[]>>({ OVERDUE: [], DUE: [], SOON: [] });
  const [watchRows, setWatchRows] = useState<HomeAlertRow[]>([]);
  const [attentionCount, setAttentionCount] = useState(0);
  const [alertCfgState, setAlertCfgState] = useState<AlertSettings>(ALERT_SETTINGS_DEFAULTS);
  const [showWatch, setShowWatch] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [lentCount, setLentCount] = useState(0);
  // Cơ cấu đang ở ngoài theo món (cho ItemCard hiện "Tổng · Đang mượn · Ở nhà"
  // + phân số trên huy hiệu) — dựng từ chính listActiveLoans đã tải trong
  // load(), không thêm truy vấn nào.
  const [outMap, setOutMap] = useState<Record<string, { lentOut: number; consignedOut: number }>>({});
  const [totalActive, setTotalActive] = useState(0);
  const [locationCount, setLocationCount] = useState(0);
  // Avatar người dùng ở hero: URI bền trong thư mục ảnh của app, lưu ở
  // app_kv 'avatar_uri' nên tắt/mở app vẫn hiện lại đúng.
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [avatarMenu, setAvatarMenu] = useState(false);
  const [catCounts, setCatCounts] = useState<Record<string, number>>({});
  const [refreshing, setRefreshing] = useState(false);
  const listRef = useRef<FlatList<Item>>(null);
  // Vị trí Y của tiêu đề mục "Kho đồ của bạn" bên trong header của FlatList
  // (đo bằng onLayout, tương đối với đầu header) — thanh dọc THU GỌN dùng để
  // cuộn trang về đúng đầu mục danh sách đồ.
  const itemsSectionYRef = useRef(0);
  const refreshTick = useAppStore((s) => s.refreshTick);
  const customCategories = useAppStore((s) => s.customCategories);
  const customStatuses = useAppStore((s) => s.customStatuses);
  const pinnedCats = useAppStore((s) => s.pinnedCats);
  const pinnedStatuses = useAppStore((s) => s.pinnedStatuses);
  const pinnedOnly = useAppStore((s) => s.pinnedOnly);
  const loadTaxonomy = useAppStore((s) => s.loadTaxonomy);
  const togglePin = useAppStore((s) => s.togglePin);
  const setPinnedOnly = useAppStore((s) => s.setPinnedOnly);

  // Danh sách đồ hiển thị từng đợt: số món đang hiện chỉ có hiệu lực với đúng
  // "chữ ký" bộ lọc hiện tại (phân loại + trạng thái + tìm kiếm + nhịp làm mới);
  // chữ ký đổi thì tự quay về đợt đầu 10 món — không cần effect đồng bộ state.
  const filterSig = `${catFilter}|${statusFilter}|${debounced}|${refreshTick}`;
  const [pageState, setPageState] = useState<{ sig: string; count: number }>({ sig: '', count: 10 });
  const visibleCount = pageState.sig === filterSig ? pageState.count : 10;

  // Thanh dọc THU GỌN (Mẫu B, người dùng duyệt 24/10): trang đầu giữ nguyên
  // 10 món, mở rộng bằng nút "Xem thêm" +20 như cũ; mốc thu gọn chốt 15 —
  // thanh chỉ hiện khi số món THỰC ĐANG HIỂN THỊ vượt 15 (đã mở rộng quá
  // mốc), bấm vào là về đúng 15 món đầu + cuộn về đầu mục danh sách, và
  // thanh tự ẩn vì lúc đó không còn gì để thu gọn nữa.
  const shownCount = Math.min(visibleCount, items.length);
  const showCollapseRail = shownCount > COLLAPSE_TARGET;
  // v85: giữ nguyên chữ thường của i18n ('Thu gọn' / 'Show less'), KHÔNG
  // viết hoa toàn bộ nữa — chỉ bỏ khoảng trắng để xếp dọc từng ký tự.
  const collapseRailLabel = t('home.showLess').replace(/\s+/g, '').split('').join('\n');
  const handleCollapseItems = useCallback(() => {
    setPageState({ sig: filterSig, count: COLLAPSE_TARGET });
    // Offset nội dung của tiêu đề mục = paddingTop của contentContainer (8)
    // + Y đo trong header − 6dp đệm thở để tiêu đề không dính sát mép trên.
    const offset = Math.max(0, itemsSectionYRef.current + 8 - 6);
    listRef.current?.scrollToOffset({ offset, animated: true });
  }, [filterSig]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 150); // debounce 150ms (B.18)
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async () => {
    const alertCfg = await getAlertSettings();
    setAlertCfgState(alertCfg);
    const savedAvatar = await kvGet('avatar_uri');
    setAvatarUri(savedAvatar || null);
    let result: Item[];
    // Đang lọc theo MỘT trạng thái kết thúc đơn lẻ (SOLD/GIFTED/DISPOSED/LOST/USED_UP/EXPIRED)?
    const isEndStatus = (STATUS_GROUPS['grp:end'].members as string[]).includes(statusFilter);
    if (debounced.trim()) {
      result = await searchItems(debounced);
    } else if (isEndStatus) {
      // listItems() mặc định loại các trạng thái kết thúc nên hỏi DB tường
      // minh theo đúng trạng thái đó — đường truy vấn từng viết cho nhóm
      // 'grp:end', nay với mảng 1 phần tử — giữ thứ tự mặc định (mới sửa trước)
      const parts = await Promise.all(
        [statusFilter].map((m) => listItems({ statusFilter: m })),
      );
      result = parts.flat().sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    } else if (
      statusFilter !== 'ALL' && statusFilter !== 'grp:lent' && statusFilter !== 'LENT_ALL' && statusFilter !== 'EXPIRING'
    ) {
      // Trạng thái cụ thể còn lại (kể cả trạng thái tự tạo): hỏi thẳng DB
      result = await listItems({ statusFilter });
    } else {
      result = await listItems();
    }
    // Hai nhóm lọc kết hợp (AND), lọc phía client
    if (statusFilter === 'grp:lent' || statusFilter === 'LENT_ALL') {
      result = result.filter((i) => STATUS_GROUPS['grp:lent'].members.includes(i.status as ItemStatus));
    } else if (statusFilter === 'EXPIRING') {
      // Chip "Sắp hết hạn": giữ hành vi cũ nhưng theo mức — chỉ 3 mức khẩn của hạn dùng
      result = result.filter((i) => {
        if (i.status !== 'STORED' && i.status !== 'IN_USE') return false;
        if (isAlertSnoozed(i.alert_snoozed_until)) return false;
        const info = getAlertTier(i.expiry_date, alertCfg.soonDays, alertCfg.watchDays);
        return !!info && info.tier !== 'WATCH';
      });
    } else if (statusFilter !== 'ALL') {
      result = result.filter((i) => i.status === statusFilter);
    }
    if (catFilter !== 'ALL') {
      result = result.filter((i) => i.category === catFilter);
    }
    setItems(result);

    const crumbMap: Record<string, string> = {};
    const thumbMap: Record<string, string | null> = {};
    for (const item of result) {
      const chain = await getBreadcrumb(item.location_id);
      crumbMap[item.id] = breadcrumbText(chain);
      const media = await listMediaForOwner('ITEM', item.id);
      thumbMap[item.id] = media[0]?.thumbnail_uri ?? null;
    }
    setCrumbs(crumbMap);
    setThumbs(thumbMap);

    // Đếm số đồ theo phân loại từ TOÀN BỘ danh sách (không lọc) cho mục "Khám phá"
    const allItems = await listItems();
    const counts: Record<string, number> = {};
    for (const i of allItems) counts[i.category] = (counts[i.category] ?? 0) + 1;
    setCatCounts(counts);

    // listActiveLoans chỉ gồm kind LOAN (đếm "đang cho mượn" + dòng cảnh báo
    // hạn trả); cơ cấu ở ngoài của thẻ món cộng thêm record GỬI BÁN, mọi
    // phần đều theo outstandingOf chuẩn (lent − returned − closed)
    const loans = await listActiveLoans();
    const consignments = await listActiveConsignments();
    setLentCount(loans.length);
    const om: Record<string, { lentOut: number; consignedOut: number }> = {};
    for (const l of loans) {
      const entry = (om[l.item_id] ??= { lentOut: 0, consignedOut: 0 });
      entry.lentOut += outstandingOf(l);
    }
    for (const c of consignments) {
      const entry = (om[c.item_id] ??= { lentOut: 0, consignedOut: 0 });
      entry.consignedOut += outstandingOf(c);
    }
    setOutMap(om);
    setTotalActive(await countActiveItems());
    setLocationCount(await countLocations());

    // ---- Cảnh báo 4 mức: gom hạn dùng + hạn trả vào nhóm OVERDUE → DUE → SOON,
    // hạn dùng mức WATCH vào nhóm theo dõi riêng. Nguồn đang hoãn nhắc bị loại. ----
    const groups: Record<'OVERDUE' | 'DUE' | 'SOON', HomeAlertRow[]> = { OVERDUE: [], DUE: [], SOON: [] };
    const watch: HomeAlertRow[] = [];
    for (const i of allItems) {
      if (i.status !== 'STORED' && i.status !== 'IN_USE') continue;
      if (!i.expiry_date || isAlertSnoozed(i.alert_snoozed_until)) continue;
      const info = getAlertTier(i.expiry_date, alertCfg.soonDays, alertCfg.watchDays);
      if (!info) continue;
      const row: HomeAlertRow = { key: `exp-${i.id}`, kind: 'expiry', tier: info.tier, days: info.days, itemId: i.id, name: i.name, date: i.expiry_date };
      if (info.tier === 'WATCH') watch.push(row);
      else groups[info.tier].push(row);
    }
    for (const l of loans) {
      if (!l.expected_return_date || isAlertSnoozed(l.alert_snoozed_until)) continue;
      const info = getAlertTier(l.expected_return_date, alertCfg.soonDays, alertCfg.watchDays);
      if (!info || info.tier === 'WATCH') continue;
      groups[info.tier].push({
        key: `loan-${l.id}`, kind: 'loan', tier: info.tier, days: info.days,
        itemId: l.item_id, name: l.item_name, borrower: l.borrower_name, date: l.expected_return_date,
      });
    }
    (Object.keys(groups) as ('OVERDUE' | 'DUE' | 'SOON')[]).forEach((k) => groups[k].sort((a, b) => a.days - b.days));
    watch.sort((a, b) => a.days - b.days);
    setAlertGroups(groups);
    setWatchRows(watch);
    setAttentionCount(groups.OVERDUE.length + groups.DUE.length + groups.SOON.length);
  }, [debounced, catFilter, statusFilter]);

  useFocusEffect(
    useCallback(() => {
      loadTaxonomy();
      load();
    }, [load, refreshTick, loadTaxonomy]),
  );

  /** Đổi avatar từ popup hero: chụp / thư viện qua đúng pipeline chọn ảnh
      của app (imageService), lưu bền vào thư mục ảnh + app_kv, dọn file cũ */
  async function handleAvatarPick(source: 'camera' | 'library') {
    const photo = source === 'camera' ? await takePhoto() : await pickPhoto();
    if (!photo) return;
    const uri = await saveAvatarImage(photo);
    const old = avatarUri;
    await kvSet('avatar_uri', uri);
    setAvatarUri(uri);
    if (old && old !== uri) removeAvatarImage(old).catch(() => {});
  }

  /** Xoá avatar: gỡ đường dẫn khỏi app_kv + xoá file, quay về placeholder */
  async function handleAvatarRemove() {
    const old = avatarUri;
    await kvSet('avatar_uri', '');
    setAvatarUri(null);
    if (old) removeAvatarImage(old).catch(() => {});
  }

  /** Quét ở Trang chủ: trúng món -> chi tiết món; trúng vị trí -> chi tiết vị trí; còn lại -> tìm kiếm thường */
  async function handleHomeScanned(data: string) {
    const foundItem = await findItemByBarcode(data);
    if (foundItem) { router.push(`/item/${foundItem.id}`); return; }
    const foundLoc = await findLocationByQrCode(data);
    if (foundLoc) { router.push(`/location/${foundLoc.id}`); return; }
    setQuery(data);
  }

  const header = useMemo(
    () => {
      // Gộp built-in + tự tạo; phân loại ĐÃ GHIM lên đầu dãy Khám phá
      const allCats: { key: string; label: string; icon: IconName; color: string }[] = [
        ...BUILTIN_CATS.map((c) => ({ key: c as string, label: categoryLabel(c), icon: categoryIcon(c), color: categoryColor(c) })),
        ...customCategories.map((ct) => ({
          key: ct.id,
          label: ct.name,
          icon: (ct.icon in Ionicons.glyphMap ? ct.icon : 'cube-outline') as IconName,
          color: ct.color,
        })),
      ];
      const orderedCats = [
        ...pinnedCats
          .map((k) => allCats.find((c) => c.key === k))
          .filter((c): c is (typeof allCats)[number] => !!c),
        ...allCats.filter((c) => !pinnedCats.includes(c.key)),
      ];
      // Nhóm WATCH cũng giới hạn 3 dòng như các nhóm mức khác khi chưa mở rộng
      const watchVisibleRows = expandedGroups.WATCH ? watchRows : watchRows.slice(0, 3);

      // Chip lọc trạng thái theo thứ tự STATUS_LABELS: chỉ còn nhóm 'grp:lent'
      // gộp hiển thị — 1 chip nhóm tại vị trí LENT, PARTIALLY_LENT không có
      // chip riêng. Các trạng thái kết thúc (SOLD, GIFTED, DONATED, DISPOSED,
      // LOST, USED_UP, EXPIRED) có chip RIÊNG từng trạng thái (ghim/bỏ ghim theo khoá
      // của chính nó; lọc qua đường listItems tường minh nhờ grp:end), còn
      // CONSIGNED đứng chip đơn như các trạng thái đang quản lý khác;
      // trạng thái tự tạo nằm ở dãy riêng phía dưới.
      const statusChips: {
        key: string; label: string; icon: IconName; color: string;
        active: boolean; pinned: boolean; visible: boolean; onPress: () => void;
      }[] = [];
      for (const s of BUILTIN_STATUSES) {
        if (s === 'PARTIALLY_LENT') continue;
        if (s === 'LENT') {
          const g = STATUS_GROUPS['grp:lent'];
          statusChips.push({
            key: 'grp:lent',
            label: statusLabel('LENT'),
            icon: g.icon,
            color: g.color,
            active: statusFilter === 'grp:lent' || statusFilter === 'LENT_ALL',
            pinned: pinnedStatuses.includes('grp:lent'),
            visible: !pinnedOnly || pinnedStatuses.includes('grp:lent'),
            onPress: () => setStatusFilter('grp:lent'),
          });
          continue;
        }
        statusChips.push({
          key: s,
          label: statusLabel(s),
          icon: statusIcon(s),
          color: statusColorFor(s),
          active: statusFilter === s,
          pinned: pinnedStatuses.includes(s),
          visible: !pinnedOnly || pinnedStatuses.includes(s),
          onPress: () => setStatusFilter(s),
        });
      }
      // Danh sách chip trạng thái THỰC HIỂN (sau lọc ghim) + trạng thái
      // tự tạo thực hiện — tính sẵn để hàng chip gán bề ngang theo đúng
      // vị trí nối tiếp nhau (Tất cả = 0, rồi built-in, rồi tự tạo, rồi
      // EXPIRING) qua cellWidthAt.
      const visibleStatusChips = statusChips.filter((c) => c.visible);
      const visibleCustomStatuses = customStatuses.filter(
        (t) => !pinnedOnly || pinnedStatuses.includes(t.id),
      );
      return (
      <View style={{ gap: 14, marginBottom: 14 }}>
        <View>
          {/* Hero tím đậm — "gradient" giả lập bằng hình tròn màu mờ xếp lớp */}
          <View
            style={{
              backgroundColor: Colors.deep, borderRadius: 26, padding: 20, paddingBottom: 40, overflow: 'hidden',
              shadowColor: Colors.deep, shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.3, shadowRadius: 22, elevation: 9,
            }}
          >
            <View pointerEvents="none" style={{ position: 'absolute', width: 200, height: 200, borderRadius: 100, backgroundColor: Colors.coral, opacity: 0.32, top: -90, right: -55 }} />
            <View pointerEvents="none" style={{ position: 'absolute', width: 140, height: 140, borderRadius: 70, backgroundColor: Colors.teal, opacity: 0.3, bottom: -75, left: -35 }} />
            {/* Vòng tròn viền mảnh tạo chiều sâu (Aurora Glass) */}
            <View pointerEvents="none" style={{ position: 'absolute', width: 250, height: 250, borderRadius: 125, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.14)', top: -130, left: -90 }} />
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                {/* Avatar tròn — chạm để đổi (chụp / thư viện / xoá). Chưa có
                    avatar thì placeholder nền primary + icon person */}
                <TouchableOpacity
                  onPress={() => setAvatarMenu(true)}
                  activeOpacity={0.85}
                  style={{
                    width: 40, height: 40, borderRadius: 20, overflow: 'hidden',
                    backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center',
                    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.35)',
                  }}
                >
                  {avatarUri ? (
                    <Image source={{ uri: avatarUri }} style={{ width: 40, height: 40 }} />
                  ) : (
                    <Ionicons name="person" size={20} color="#fff" />
                  )}
                </TouchableOpacity>
                <Text style={{ color: Colors.onDarkMuted, fontSize: 14 }}>{t('home.greeting')}</Text>
              </View>
              <View
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 7,
                  backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 999, paddingHorizontal: 11, paddingVertical: 5,
                }}
              >
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: Colors.coral }} />
                <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 1.4 }}>{t('home.brand')}</Text>
              </View>
            </View>
            <Text style={{ fontSize: 32, fontWeight: '800', marginTop: 8 }}>
              <Text style={{ color: '#fff' }}>Smart</Text>
              <Text style={{ color: Colors.coral }}>Stash</Text>
            </Text>
            <Text style={{ color: Colors.onDarkMuted, fontSize: 14, lineHeight: 20, marginTop: 5 }}>
              {t('home.tagline')}
            </Text>

            {/* Hàng thống kê "glass" nằm cuối hero */}
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
              <GlassStatCell value={totalActive} label={t('home.statTotal')} iconColor="#B79CFF" icon="cube" />
              <GlassStatCell value={lentCount} label={t('home.statLent')} iconColor={Colors.orange} icon="swap-horizontal" />
              <GlassStatCell value={attentionCount} label={t('home.statAttention')} iconColor={Colors.coral} icon="alert-circle" />
            </View>
          </View>

          {/* Ô tìm kiếm pill nổi, chồng lên mép hero */}
          <View style={[styles.searchBar, { marginTop: -24, marginHorizontal: 10, zIndex: 3 }]}>
            <Ionicons name="search" size={21} color={Colors.primary} />
            <TextInput
              style={{ flex: 1, fontSize: 16, color: Colors.text }}
              placeholder={t('home.searchPlaceholder')}
              placeholderTextColor={Colors.faint}
              value={query}
              onChangeText={setQuery}
              returnKeyType="search"
            />
            {!!query && (
              <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
                <Ionicons name="close-circle" size={20} color={Colors.subtext} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={() => setShowScanner(true)}
              hitSlop={8}
              style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: tint(Colors.primary, '1C'), alignItems: 'center', justifyContent: 'center' }}
            >
              <Ionicons name="scan" size={22} color={Colors.primary} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Khối cảnh báo 4 mức: nhóm OVERDUE → DUE → SOON (hạn dùng + hạn trả),
            nhóm WATCH (hạn dùng trong watchDays) thu gọn ở cuối, bấm để mở */}
        {(attentionCount > 0 || watchRows.length > 0) && (
          <View style={[styles.card, { gap: 12, padding: 14 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
              <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: tint(Colors.red), alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="warning" size={17} color={Colors.red} />
              </View>
              <Text style={{ flex: 1, fontSize: 15.5, fontWeight: '800', color: Colors.text }}>{t('alerts.title')}</Text>
              {attentionCount > 0 && (
                <View style={{ backgroundColor: Colors.red, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 }}>
                  <Text style={{ fontSize: 12, fontWeight: '800', color: '#fff' }}>{attentionCount}</Text>
                </View>
              )}
            </View>
            {watchRows.length > 0 && (
              <Text style={{ fontSize: 12, color: Colors.subtext, marginTop: -6 }}>
                {t('alerts.watchLine', { n: watchRows.length, d: alertCfgState.watchDays })}
              </Text>
            )}

            {(['OVERDUE', 'DUE', 'SOON'] as ('OVERDUE' | 'DUE' | 'SOON')[]).map((tier) => {
              const rows = alertGroups[tier];
              if (rows.length === 0) return null;
              const color = alertTierColor(tier, rows[0].days);
              const expanded = !!expandedGroups[tier];
              const visibleRows = expanded ? rows : rows.slice(0, 3);
              return (
                <View key={tier} style={{ gap: 5 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    {/* Nhãn mức cảnh báo dạng pill tint theo màu mức (KHÔNG
                        gạch chân như trước): nền tint + chấm màu mức + chữ
                        sậm hoá bằng darken — từng mức phân biệt rõ bằng
                        chính màu của nó, số đếm nằm ngoài pill như cũ */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: tint(color, '1A'), borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 }}>
                      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
                      <Text style={{ fontSize: 12.5, fontWeight: '800', color: darken(color), letterSpacing: 0.4 }}>{t(`alerts.tier${tier}`)}</Text>
                    </View>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: Colors.faint }}>{rows.length}</Text>
                  </View>
                  {visibleRows.map((row, idx) => (
                    <AlertRowItem key={row.key} row={row} color={color} first={idx === 0} />
                  ))}
                  {rows.length > 3 && (
                    <AlertGroupToggle
                      expanded={expanded}
                      hidden={rows.length - visibleRows.length}
                      color={color}
                      onPress={() => setExpandedGroups((s) => ({ ...s, [tier]: !expanded }))}
                    />
                  )}
                </View>
              );
            })}

            {watchRows.length > 0 && (
              <View style={{ gap: 5 }}>
                <TouchableOpacity
                  onPress={() => setShowWatch(!showWatch)}
                  activeOpacity={0.75}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
                >
                  {/* Pill tint màu WATCH như các nhãn mức phía trên (bỏ
                      gạch chân); khoảng flex:1 đẩy số đếm + chevron về
                      mép phải như bố cục cũ */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: tint(ALERT_TIER_COLORS.WATCH, '1A'), borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 }}>
                    <Ionicons name="eye-outline" size={14} color={ALERT_TIER_COLORS.WATCH} />
                    <Text style={{ fontSize: 12.5, fontWeight: '800', color: darken(ALERT_TIER_COLORS.WATCH), letterSpacing: 0.4 }}>
                      {t('alerts.watchTitle', { d: alertCfgState.watchDays })}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }} />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: Colors.faint }}>{watchRows.length}</Text>
                  <Ionicons name={showWatch ? 'chevron-up' : 'chevron-down'} size={15} color={Colors.subtext} />
                </TouchableOpacity>
                {showWatch && watchVisibleRows.map((row, idx) => (
                  <AlertRowItem key={row.key} row={row} color={ALERT_TIER_COLORS.WATCH} first={idx === 0} />
                ))}
                {showWatch && watchRows.length > 3 && (
                  <AlertGroupToggle
                    expanded={!!expandedGroups.WATCH}
                    hidden={watchRows.length - watchVisibleRows.length}
                    color={ALERT_TIER_COLORS.WATCH}
                    onPress={() => setExpandedGroups((s) => ({ ...s, WATCH: !s.WATCH }))}
                  />
                )}
              </View>
            )}
          </View>
        )}

        {/* Phân loại: bộ lọc phân loại DUY NHẤT — ô màu lớn bề ngang
            ĐỘNG theo vị trí (1/3 khổ hàng, khe 6dp, lấp đầy chính xác
            khổ hàng) trong HÀNG CUỘN NGANG 1 dòng: 3 ô đầu hiện TRỌN,
            ô thứ 4 trở đi cuộn xem tiếp (bố cục 1 dòng theo phản hồi
            người dùng; lưới 3 cột của v48 đã huỷ). Hàng tiêu đề có ghi
            chú 'Vuốt xem thêm' bên phải để biết còn mục ngoài khung.
            Bấm để lọc / bấm lại để bỏ lọc; ô đã ghim đứng trước */}
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="compass-outline" size={15} color={Colors.teal} />
              <Text style={{ fontSize: 13, fontWeight: '800', color: Colors.subtext, letterSpacing: 0.3 }}>{t('home.explore')}</Text>
            </View>
            <SwipeHint />
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: CELL_ROW_GAP, paddingVertical: 2, paddingRight: 4 }}
          >
            <CategoryExploreTile
              label={t('filter.all')}
              icon="apps"
              color={Colors.deep}
              count={totalActive}
              selected={catFilter === 'ALL'}
              width={cellWidthAt(0)}
              onPress={() => setCatFilter('ALL')}
            />
            {orderedCats.map((c, i) => (
              <CategoryExploreTile
                key={c.key}
                label={c.label}
                icon={c.icon}
                color={c.color}
                count={catCounts[c.key] ?? 0}
                selected={catFilter === c.key}
                width={cellWidthAt(i + 1)}
                onPress={() => setCatFilter(catFilter === c.key ? 'ALL' : c.key)}
              />
            ))}
            {/* Ô Thêm phân loại: viền đứt nét, nền trắng — cùng khổ ô theo vị trí ×112 */}
            <TouchableOpacity
              onPress={() => setShowAddCat(true)}
              activeOpacity={0.85}
              style={{
                width: cellWidthAt(orderedCats.length + 1), height: 112, borderRadius: 22, padding: 12,
                backgroundColor: '#fff', justifyContent: 'space-between',
                borderWidth: 1.5, borderStyle: 'dashed', borderColor: Colors.primary,
              }}
            >
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: tint(Colors.primary), alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="add" size={24} color={Colors.primary} />
              </View>
              <Text style={{ fontSize: 13, fontWeight: '700', color: Colors.subtext, lineHeight: 17 }} numberOfLines={2}>
                {t('common.addCategory')}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </View>

        {/* Nhóm lọc: Trạng thái — 1 hàng chip duy nhất; công tắc 'Đã ghim'
            nằm gọn ở đầu phải của dòng nhãn, chỉ hiện khi đã có trạng thái ghim */}
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <FilterGroupLabel icon="flag-outline" text={t('home.groupStatus')} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <SwipeHint />
              {(pinnedStatuses.length > 0 || pinnedOnly) && (
                <TouchableOpacity
                  onPress={() => setPinnedOnly(!pinnedOnly)}
                  style={{
                    height: 28, paddingHorizontal: 10, borderRadius: 999,
                    flexDirection: 'row', alignItems: 'center', gap: 4,
                    backgroundColor: pinnedOnly ? Colors.coral : '#fff',
                    borderWidth: 1.5, borderColor: pinnedOnly ? Colors.coral : Colors.border,
                  }}
                >
                  <Ionicons name="pin" size={12} color={pinnedOnly ? '#fff' : Colors.coral} />
                  <Text style={{ fontSize: 12, fontWeight: '800', color: pinnedOnly ? '#fff' : Colors.primaryDark }}>{t('home.pinned')}</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
          {pinnedOnly && pinnedStatuses.length === 0 ? (
            <Text style={{ fontSize: 13, color: Colors.faint }}>{t('home.pinEmpty')}</Text>
          ) : (
            /* Hàng chip cuộn ngang 1 DÒNG (lưới 3 cột của v48 đã huỷ
               theo phản hồi người dùng): chip bề ngang CỐ ĐỊNH theo vị
               trí như thẻ Phân loại (cellWidthAt — khe 6dp, 3 chip đầu
               lấp đầy chính xác khổ hàng) — 3 chip đầu hiện TRỌN, chip
               thứ 4 trở đi cuộn xem tiếp; giữ nguyên lọc + nhấn giữ
               ghim/bỏ ghim. Hàng tiêu đề phía trên có ghi chú 'Vuốt xem
               thêm' bên phải. paddingVertical 4 để huy hiệu ghim ở góc
               chip không bị cắt. */
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: CELL_ROW_GAP, paddingVertical: 4, paddingRight: 4 }}
            >
              <FilterChip
                label={t('filter.all')}
                icon="apps-outline"
                color={Colors.primaryDark}
                active={statusFilter === 'ALL'}
                cellW={cellWidthAt(0)}
                onPress={() => setStatusFilter('ALL')}
              />
              {visibleStatusChips.map((c, i) => (
                <FilterChip
                  key={c.key}
                  label={c.label}
                  icon={c.icon}
                  color={c.color}
                  active={c.active}
                  pinned={c.pinned}
                  cellW={cellWidthAt(1 + i)}
                  onPress={c.onPress}
                  onLongPress={() => togglePin('STATUS', c.key)}
                />
              ))}
              {visibleCustomStatuses.map((t, j) => (
                <FilterChip
                  key={t.id}
                  label={t.name}
                  icon={(t.icon in Ionicons.glyphMap ? t.icon : 'bookmark-outline') as IconName}
                  color={t.color}
                  active={statusFilter === t.id}
                  pinned={pinnedStatuses.includes(t.id)}
                  cellW={cellWidthAt(1 + visibleStatusChips.length + j)}
                  onPress={() => setStatusFilter(t.id)}
                  onLongPress={() => togglePin('STATUS', t.id)}
                />
              ))}
              {(!pinnedOnly || pinnedStatuses.includes('EXPIRING')) && (
                <FilterChip
                  label={t('filter.expiring')}
                  icon="alarm-outline"
                  color={Colors.coral}
                  active={statusFilter === 'EXPIRING'}
                  pinned={pinnedStatuses.includes('EXPIRING')}
                  cellW={cellWidthAt(1 + visibleStatusChips.length + visibleCustomStatuses.length)}
                  onPress={() => setStatusFilter('EXPIRING')}
                  onLongPress={() => togglePin('STATUS', 'EXPIRING')}
                />
              )}
            </ScrollView>
          )}
          {/* Chú thích cho bộ lọc nhóm đang chọn — dòng phụ của nhóm gộp
              Cho mượn ('grp:lent') trong prototype */}
          {(statusFilter === 'grp:lent' || statusFilter === 'LENT_ALL') && (
            <Text style={{ fontSize: 12, color: Colors.subtext }}>{t('home.lentGroupNote')}</Text>
          )}
        </View>

        {/* Bọc onLayout để đo Y của đầu mục danh sách trong header —
            thanh dọc THU GỌN cuộn trang về đúng vị trí này. */}
        <View onLayout={(e) => { itemsSectionYRef.current = e.nativeEvent.layout.y; }}>
          <SectionTitle
            title={t('home.yourItems')}
            color={Colors.primary}
            right={(
              <Text style={{ fontSize: 13, fontWeight: '600', color: Colors.subtext }}>
                {t('home.itemsCount', { n: items.length })}
              </Text>
            )}
          />
        </View>
      </View>
      );
    },
    [
      alertGroups, watchRows, attentionCount, alertCfgState, showWatch, expandedGroups,
      lentCount, query, totalActive, catCounts,
      catFilter, statusFilter, customCategories, customStatuses,
      pinnedCats, pinnedStatuses, pinnedOnly, togglePin, setPinnedOnly, t, items,
      avatarUri, cellWidthAt,
    ],
  );

  // Chân trang của danh sách: nút xem thêm từng đợt + banner đóng trang
  const footer = useMemo(
    () => {
      const remaining = items.length - visibleCount;
      return (
        <View style={{ marginTop: 16 }}>
          {remaining > 0 && (
            <AppButton
              title={t('home.showMoreItems', { n: remaining })}
              icon="chevron-down"
              variant="secondary"
              onPress={() => setPageState({ sig: filterSig, count: visibleCount + 20 })}
            />
          )}

          {/* Banner chân trang tím đậm — cùng ngôn ngữ trang trí với hero */}
          <View
            style={{
              backgroundColor: Colors.deep, borderRadius: 24, paddingVertical: 20, paddingHorizontal: 16, overflow: 'hidden', marginTop: 8,
              shadowColor: Colors.deep, shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.25, shadowRadius: 18, elevation: 7,
            }}
          >
            <View pointerEvents="none" style={{ position: 'absolute', width: 170, height: 170, borderRadius: 85, backgroundColor: 'rgba(255,255,255,0.06)', top: -80, right: -45 }} />
            <View pointerEvents="none" style={{ position: 'absolute', width: 130, height: 130, borderRadius: 65, backgroundColor: 'rgba(255,90,118,0.16)', bottom: -70, left: -30 }} />

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: Colors.coral, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="cube" size={24} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 17, fontWeight: '800', color: '#fff' }}>SmartStash</Text>
                <Text style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.75)', marginTop: 1 }}>{t('home.footerSlogan')}</Text>
              </View>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14 }}>
              <Ionicons name="stats-chart" size={14} color={Colors.coral} />
              <Text style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.85)' }}>
                {t('home.footerStats', { items: totalActive, locations: locationCount, lent: lentCount })}
              </Text>
            </View>

            {/* Cặp nút chân trang dựng THỦ CÔNG đồng bộ, cân lại theo ảnh
                máy thật (bản chia flex 1:1 ở 16px bị 'g' của 'Lên đầu trang'
                sát viền phải): ngân sách chữ mỗi nút khi đó chỉ 137 − 24
                padding − 20 icon − 6 gap = 87dp, trong khi nhãn phải trên
                máy thật rộng ~125dp ở 16px (font máy rộng hơn ước lượng
                theo Roboto ~107dp). 16px KHÔNG thể vừa an toàn ở 360dp:
                tổng chữ cần ~203dp > ngân sách tối đa sau khi đã nới banner
                (292 − 10 gap − 2×40 chrome = 202dp) và không còn biên an
                toàn. Nay: banner padding ngang 20→16 (khổ trong 292), flex
                bất đối xứng theo độ dài nhãn 0,72:1, chrome mỗi nút gọn còn
                40 (padding 9×2 + icon 18 + gap 4), chữ 15/700 lh21 ĐỒNG BỘ:
                nút trái 282×0,72/1,72 ≈ 118 → chữ được 78 ≥ ~73 cần; nút
                phải ≈ 164 → chữ được 124 ≥ ~117 cần (bề ngang chữ ở 15px
                suy từ số đo máy thật ở 16px ×15/16); khoảng thở mỗi bên =
                padding 9 ≥ 8dp. adjustsFontSizeToFit sàn 0,92 chỉ là lưới
                an toàn, không kỳ vọng kích hoạt. */}
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity
                onPress={() => router.push('/(tabs)/quick-add')}
                activeOpacity={0.85}
                style={{
                  flex: 0.72, height: 52, borderRadius: 16, paddingHorizontal: 9,
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
                  backgroundColor: Colors.coral,
                  shadowColor: Colors.coral, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.28, shadowRadius: 12, elevation: 5,
                }}
              >
                <Ionicons name="add" size={18} color="#fff" />
                <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.92} style={{ fontSize: 15, fontWeight: '700', lineHeight: 21, flexShrink: 1, color: '#fff' }}>{t('home.footerAdd')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => listRef.current?.scrollToOffset({ offset: 0, animated: true })}
                activeOpacity={0.85}
                style={{
                  flex: 1, height: 52, borderRadius: 16, paddingHorizontal: 9,
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
                  borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.35)',
                }}
              >
                <Ionicons name="arrow-up" size={18} color="#fff" />
                <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.92} style={{ fontSize: 15, fontWeight: '700', lineHeight: 21, flexShrink: 1, color: '#fff' }}>{t('home.footerTop')}</Text>
              </TouchableOpacity>
            </View>

            <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', textAlign: 'center', marginTop: 14 }}>
              {t('home.footerVersion')}
            </Text>
          </View>
        </View>
      );
    },
    [items.length, visibleCount, filterSig, totalActive, lentCount, locationCount, t],
  );

  return (
    <View style={[styles.screen, { paddingTop: 46 }]}>
      <FlatList
        ref={listRef}
        data={items.slice(0, visibleCount)}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 8, paddingBottom: TAB_BAR_CLEARANCE }}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />
        }
        renderItem={({ item }) => (
          <ItemCard
            item={item}
            breadcrumb={crumbs[item.id] ?? ''}
            thumbUri={thumbs[item.id]}
            outInfo={outMap[item.id]}
            onPress={() => router.push(`/item/${item.id}`)}
          />
        )}
        ListEmptyComponent={
          debounced ? (
            <Text style={styles.empty}>{t('home.searchEmpty', { q: debounced })}</Text>
          ) : (
            <View style={{ alignItems: 'center', paddingTop: 36, paddingHorizontal: 24, gap: 8 }}>
              <View style={{ width: 76, height: 76, borderRadius: 38, backgroundColor: tint(Colors.primary), alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="cube-outline" size={34} color={Colors.primary} />
              </View>
              <Text style={{ fontSize: 16, fontWeight: '700', color: Colors.text, marginTop: 4 }}>{t('home.emptyTitle')}</Text>
              <Text style={{ fontSize: 13, color: Colors.subtext, textAlign: 'center', lineHeight: 19 }}>
                {t('home.emptyHint')}
              </Text>
            </View>
          )
        }
      />
      {/* Thanh dọc THU GỌN (Mẫu B): capsule nổi sát mép phải, neo khoảng
          giữa vùng danh sách (top 38% — đủ cao để khi cuộn tới đáy không
          đè banner chân trang chứa cặp nút Thêm mới/Lên đầu trang ở cuối
          nội dung). Hàng đồ không có nút bấm riêng ở mép phải (cả thẻ là
          một TouchableOpacity, chevron chỉ là icon trang trí) nên thanh
          chỉ phủ một dải hẹp ~22dp ở mép thẻ, đúng như mẫu đã duyệt.
          Chữ chạy dọc từng ký tự đứng thẳng ('Thu gọn' / 'Show less'
          bỏ khoảng trắng — giữ chữ thường, không viết hoa toàn bộ) —
          RN không có writing-mode nên xếp ký tự theo cột bằng '\n'. */}
      {showCollapseRail && (
        <TouchableOpacity
          onPress={handleCollapseItems}
          activeOpacity={0.85}
          accessibilityLabel={t('home.showLess')}
          style={{
            position: 'absolute', right: 0, top: '38%', zIndex: 10,
            // Trả về bản cũ (người dùng chốt 26/10/2026 sau khi thử mẫu C):
            // nền tím đậm, chữ + icon trắng, không viền.
            backgroundColor: Colors.primary,
            borderTopLeftRadius: 13, borderBottomLeftRadius: 13,
            paddingVertical: 12, paddingLeft: 7, paddingRight: 6,
            alignItems: 'center', gap: 6,
            shadowColor: Colors.primary, shadowOffset: { width: -3, height: 4 },
            shadowOpacity: 0.35, shadowRadius: 10, elevation: 8,
          }}
        >
          <Ionicons name="chevron-up" size={13} color="#fff" />
          {/* v86: font Be Vietnam Pro 700 (đã nạp ở _layout) thay font hệ
              thống — dấu tiếng Việt xếp dọc nhìn sạch hơn; bỏ fontWeight
              800 (font đã đậm sẵn, tránh đậm nhân tạo) + nới lineHeight
              lên 16 để dấu trên/dưới không bị chèn, bỏ letterSpacing. */}
          <Text style={{ fontFamily: 'BeVietnamPro_700Bold', fontSize: 10.5, lineHeight: 16, color: '#fff', textAlign: 'center' }}>
            {collapseRailLabel}
          </Text>
        </TouchableOpacity>
      )}
      <BarcodeScannerModal
        visible={showScanner}
        onClose={() => setShowScanner(false)}
        onScanned={(data) => { handleHomeScanned(data).catch(() => {}); }}
      />
      <AddTermModal
        visible={showAddCat}
        kind="CATEGORY"
        onClose={() => setShowAddCat(false)}
        onAdded={(term) => setCatFilter(term.id)}
      />
      {/* Popup đổi avatar từ hero: chụp / thư viện (+ xoá khi đang có avatar) */}
      <AppPopup
        visible={avatarMenu}
        title={t('home.avatarTitle')}
        options={[
          { label: t('home.avatarTake'), icon: 'camera-outline', onPress: () => { handleAvatarPick('camera').catch(() => {}); } },
          { label: t('home.avatarLibrary'), icon: 'images-outline', onPress: () => { handleAvatarPick('library').catch(() => {}); } },
          ...(avatarUri
            ? [{ label: t('home.avatarRemove'), icon: 'trash-outline', color: Colors.danger, onPress: () => { handleAvatarRemove().catch(() => {}); } } as AppPopupOption]
            : []),
        ]}
        onClose={() => setAvatarMenu(false)}
      />
    </View>
  );
}
