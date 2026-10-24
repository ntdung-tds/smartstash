import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Share, TextInput, ScrollView,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  styles, Colors, ScreenHeader, SectionTitle, AppButton, ExtendLoanModal, TAB_BAR_CLEARANCE,
  SnoozePopup, ReturnQtyModal, LoanConvertModal, ConsignResolveModal, LoanActionBlock,
  type LoanConvertPayload, type LoanConvertType, type ConsignResolvePayload, type IconName,
} from '@/components/ui';
import { CATEGORY_LABELS, type Loan } from '@/types';
import {
  listActiveLoans, listActiveConsignments, listReturnedLoans, returnLoan, setLoanAlertSnooze, extendLoanDue,
  outstandingOf, convertLoanPortion, convertLoanToConsignment, resolveConsignment,
} from '@/db/queries';
import { useAppStore } from '@/store/useAppStore';
import { formatDate, formatVND, daysUntil, getAlertTier, isAlertSnoozed, addDaysISO, localTodayISO, ALERT_TIER_RANK, pickRemindMessage, ALERT_SNOOZE_FOREVER_ISO } from '@/utils';
import { alertTierColor, alertTierIcon, categoryColor, categoryIcon, categoryLabel, statusColorFor, tint } from '@/theme';
import { getAlertSettings, ALERT_SETTINGS_DEFAULTS, type AlertSettings } from '@/services/alertSettings';
import { useT } from '@/i18n';
import { rescheduleAllReminders } from '@/services/notificationService';

type LoanRow = Loan & { item_name: string; item_unit?: string; item_category: string };

/** Chiều phân loại của hàng chip lọc ở tab Cho mượn (theo kind + quá hạn) */
type LendFilter = 'ALL' | 'LOAN' | 'CONSIGN' | 'OVERDUE';

/**
 * Chip lọc của tab Cho mượn — cùng khuôn với FilterChip ở Trang chủ:
 * cao 34, pill, trạng thái chọn = nền màu đặc + chữ/icon trắng; chưa chọn =
 * nền trắng, viền Colors.border, nhãn primaryDark, icon theo màu chip.
 */
function LendFilterChip({
  label, icon, color, active, onPress,
}: {
  label: string;
  icon: IconName;
  color: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={{
        height: 34, paddingHorizontal: 13, borderRadius: 999,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
        backgroundColor: active ? color : '#fff',
        borderWidth: 1.5, borderColor: active ? color : Colors.border,
      }}
    >
      <Ionicons name={icon} size={15} color={active ? '#fff' : color} />
      <Text style={{ fontSize: 13, fontWeight: '700', color: active ? '#fff' : Colors.primaryDark }}>{label}</Text>
    </TouchableOpacity>
  );
}

/**
 * Chip phân loại theo DANH MỤC món — bản NHỎ GỌN của LendFilterChip cho
 * hàng thứ hai: cao 30, icon 13, chữ 12, padding gọn. Trạng thái chọn =
 * nền đặc theo MÀU CỦA PHÂN LOẠI (cùng quy ước chip ở Trang chủ và hàng
 * chip loại lượt phía trên).
 */
function LendCatChip({
  label, icon, color, active, onPress,
}: {
  label: string;
  icon: IconName;
  color: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={{
        height: 30, paddingHorizontal: 10, borderRadius: 999,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
        backgroundColor: active ? color : '#fff',
        borderWidth: 1.5, borderColor: active ? color : Colors.border,
      }}
    >
      <Ionicons name={icon} size={13} color={active ? '#fff' : color} />
      <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#fff' : Colors.primaryDark }}>{label}</Text>
    </TouchableOpacity>
  );
}

const AVATAR_COLORS = [Colors.primary, Colors.coral, Colors.orange, Colors.teal, Colors.sky];

/** Màu avatar ổn định theo tên người mượn (hash đơn giản) */
function borrowerColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** Chuẩn hoá để tìm kiếm không phân biệt hoa thường + không cần dấu tiếng Việt */
function stripVi(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');
}

export default function LendingScreen() {
  const { t } = useT();
  const [active, setActive] = useState<LoanRow[]>([]);
  const [consignments, setConsignments] = useState<LoanRow[]>([]);
  const [returned, setReturned] = useState<LoanRow[]>([]);
  const [returnTarget, setReturnTarget] = useState<LoanRow | null>(null);
  const [convertTarget, setConvertTarget] = useState<{ loan: LoanRow; type: LoanConvertType } | null>(null);
  const [resolveTarget, setResolveTarget] = useState<{ rec: LoanRow; mode: 'SOLD' | 'TAKEBACK' } | null>(null);
  const [snoozeTarget, setSnoozeTarget] = useState<LoanRow | null>(null);
  const [extendTarget, setExtendTarget] = useState<LoanRow | null>(null);
  const [alertCfg, setAlertCfg] = useState<AlertSettings>(ALERT_SETTINGS_DEFAULTS);
  const [query, setQuery] = useState('');
  const [lendFilter, setLendFilter] = useState<LendFilter>('ALL');
  // Lọc theo danh mục của món (hàng chip thứ hai); null = Tất cả
  const [catFilter, setCatFilter] = useState<string | null>(null);
  const customCategories = useAppStore((s) => s.customCategories);
  const refreshTick = useAppStore((s) => s.refreshTick);
  const bump = useAppStore((s) => s.bump);

  // Lọc cả 3 danh sách theo từ khoá: khớp tên món hoặc tên người mượn/người giữ,
  // không phân biệt hoa thường và không cần dấu tiếng Việt
  const hasQuery = query.trim().length > 0;
  const qNorm = stripVi(query.trim());
  const matchesQuery = (l: LoanRow) =>
    !qNorm || stripVi(l.item_name).includes(qNorm) || stripVi(l.borrower_name).includes(qNorm);
  const filteredActive = active.filter(matchesQuery);
  const filteredConsignments = consignments.filter(matchesQuery);
  const filteredReturned = returned.filter(matchesQuery);

  // ----- Hàng chip phân loại (Tất cả · Cho mượn · Ký gửi · Quá hạn) -----
  // Áp LÊN TRÊN kết quả đã lọc theo ô tìm kiếm (hai bộ lọc chạy cùng nhau):
  // - LOAN: chỉ danh sách lượt mượn đang mở (ẩn section gửi bán + lịch sử)
  // - CONSIGN: chỉ section gửi bán ở chân trang (danh sách chính để trống)
  // - OVERDUE: chỉ các lượt mượn quá hạn — quá hạn tính ĐÚNG quy tắc thẻ
  //   đang dùng: có hạn trả + chưa hoãn nhắc + getAlertTier ra mức OVERDUE
  //   (record gửi bán không có hạn trả nên không thuộc nhóm này)
  // - ALL: mọi section như trước; lịch sử đã trả chỉ hiện ở ALL.
  const isOverdueLoan = (l: LoanRow) =>
    !!l.expected_return_date
    && !isAlertSnoozed(l.alert_snoozed_until)
    && getAlertTier(l.expected_return_date, alertCfg.soonDays, alertCfg.watchDays)?.tier === 'OVERDUE';
  const visibleActive =
    lendFilter === 'OVERDUE'
      ? filteredActive.filter(isOverdueLoan)
      : lendFilter === 'CONSIGN'
        ? []
        : filteredActive;
  const showConsignSection = lendFilter === 'ALL' || lendFilter === 'CONSIGN';
  const showReturnedSection = lendFilter === 'ALL' && filteredReturned.length > 0;

  // ----- Hàng chip phân loại theo DANH MỤC của món (hàng thứ hai) -----
  // Chỉ hiện các phân loại ĐANG CÓ trong các danh sách sẽ hiển thị (sau
  // khi đã lọc theo ô tìm kiếm + chip loại lượt): phần cho mượn đang thấy
  // + section ký gửi (khi hiện) + lịch sử đã trả (khi hiện). Thứ tự theo
  // taxonomy như Trang chủ: built-in theo CATEGORY_LABELS rồi tới tự tạo.
  const catPresenceSource: LoanRow[] = [
    ...visibleActive,
    ...(showConsignSection ? filteredConsignments : []),
    ...(showReturnedSection ? filteredReturned : []),
  ];
  const presentCats = [
    ...Object.keys(CATEGORY_LABELS),
    ...customCategories.map((ct) => ct.id),
  ]
    .filter((key) => catPresenceSource.some((l) => l.item_category === key))
    .map((key) => ({ key, label: categoryLabel(key), icon: categoryIcon(key), color: categoryColor(key) }));
  // Phân loại đang chọn mà không còn trong danh sách hiển thị (vd vừa trả
  // món cuối của loại đó) thì coi như bỏ lọc — chip Tất cả sáng trở lại.
  const effectiveCat = catFilter && presentCats.some((c) => c.key === catFilter) ? catFilter : null;
  const byCat = (l: LoanRow) => !effectiveCat || l.item_category === effectiveCat;
  const finalActive = visibleActive.filter(byCat);
  const finalConsignments = filteredConsignments.filter(byCat);
  const finalReturned = filteredReturned.filter(byCat);
  const showReturnedFinal = lendFilter === 'ALL' && finalReturned.length > 0;

  const load = useCallback(async () => {
    const cfg = await getAlertSettings();
    setAlertCfg(cfg);
    const act = await listActiveLoans();
    // Sắp xếp theo mức cảnh báo hạn trả: OVERDUE → DUE → SOON → WATCH → chưa đặt hạn,
    // cùng mức thì hạn gần hơn lên trước (khoản đang hoãn nhắc xếp như không có mức)
    const rankOf = (l: LoanRow): number => {
      if (!l.expected_return_date || isAlertSnoozed(l.alert_snoozed_until)) return 5;
      const info = getAlertTier(l.expected_return_date, cfg.soonDays, cfg.watchDays);
      return info ? ALERT_TIER_RANK[info.tier] : 4;
    };
    act.sort((a, b) => {
      const r = rankOf(a) - rankOf(b);
      if (r !== 0) return r;
      const da = a.expected_return_date ?? '9999-12-31';
      const db = b.expected_return_date ?? '9999-12-31';
      return da < db ? -1 : da > db ? 1 : 0;
    });
    setActive(act);
    setConsignments(await listActiveConsignments());
    setReturned(await listReturnedLoans());
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load, refreshTick]),
  );

  /**
   * Nhắc người mượn qua Share: mẫu tin do pickRemindMessage (utils) chọn
   * theo hạn trả so với ngưỡng soonDays — cùng quy tắc với banner/thẻ ở
   * chi tiết đồ (sắp/quá hạn → nhắc hạn; còn lại → hỏi thăm nhẹ).
   */
  function remindBorrower(loan: LoanRow) {
    const { key, params } = pickRemindMessage({
      borrower: loan.borrower_name,
      item: loan.item_name,
      lentAt: loan.lent_at,
      due: loan.expected_return_date,
      soonDays: alertCfg.soonDays,
    });
    Share.share({ message: t(key, params) }).catch(() => {});
  }

  /** Xác nhận ở ReturnQtyModal dùng chung: nhận lại qty cái kèm ghi chú (nếu có) */
  async function handleReturnConfirm(qty: number, note: string | null) {
    if (!returnTarget) return;
    await returnLoan(returnTarget.id, qty, { note });
    setReturnTarget(null);
    bump();
    rescheduleAllReminders().catch(() => {});
    load();
  }

  /** Xác nhận ở LoanConvertModal: CONSIGN tạo record gửi bán mới; 3 loại còn lại đóng phần tại record */
  async function handleConvertConfirm(payload: LoanConvertPayload) {
    const target = convertTarget;
    setConvertTarget(null);
    if (!target) return;
    if (payload.type === 'CONSIGN') {
      await convertLoanToConsignment(target.loan.id, {
        qty: payload.qty,
        expectedPrice: payload.price,
        note: payload.note,
        uiNote: payload.uiNote,
        histExtra: payload.histExtra,
      });
    } else {
      await convertLoanPortion(target.loan.id, {
        type: payload.type,
        qty: payload.qty,
        price: payload.price,
        uiNote: payload.uiNote,
        histWho: payload.histWho,
        histExtra: payload.histExtra,
      });
    }
    bump();
    rescheduleAllReminders().catch(() => {});
    load();
  }

  /** Xác nhận ở ConsignResolveModal: ngã ngũ record gửi bán (bán được / lấy lại) */
  async function handleResolveConfirm(payload: ConsignResolvePayload) {
    const target = resolveTarget;
    setResolveTarget(null);
    if (!target) return;
    await resolveConsignment(target.rec.id, {
      mode: payload.mode,
      qty: payload.qty,
      price: payload.price,
      uiNote: payload.uiNote,
    });
    bump();
    rescheduleAllReminders().catch(() => {});
    load();
  }

  /** Nhắc người giữ hộ món gửi bán qua Share (mẫu tin nhắn sẵn trong i18n) */
  function remindHolder(rec: LoanRow) {
    const days = Math.max(0, -(daysUntil(rec.lent_at) ?? 0));
    Share.share({
      message: t('consign.remindMsg', {
        item: rec.item_name,
        holder: rec.borrower_name,
        qty: outstandingOf(rec),
        days,
      }),
    }).catch(() => {});
  }

  /** Xác nhận ở ExtendLoanModal: modal đã tính sẵn hạn mới theo quy tắc
      max(hạn hiện tại, hôm nay) + số ngày chọn (xem computeExtendedDue ở ui.tsx) */
  async function handleExtendConfirm(newIso: string) {
    if (!extendTarget) return;
    await extendLoanDue(extendTarget.id, newIso);
    setExtendTarget(null);
    bump();
    rescheduleAllReminders().catch(() => {});
    load();
  }

  /** Xác nhận ở SnoozePopup: áp số ngày đã chọn cho khoản vay đang chọn */
  async function handleSnoozePick(days: number) {
    if (!snoozeTarget) return;
    await setLoanAlertSnooze(snoozeTarget.id, addDaysISO(localTodayISO(), days));
    setSnoozeTarget(null);
    bump();
    rescheduleAllReminders().catch(() => {});
    load();
  }

  /** "Không nhắc lại nữa" ở SnoozePopup: hoãn vĩnh viễn (mốc cực xa) qua cùng setter snooze */
  async function handleSnoozeNever() {
    if (!snoozeTarget) return;
    await setLoanAlertSnooze(snoozeTarget.id, ALERT_SNOOZE_FOREVER_ISO);
    setSnoozeTarget(null);
    bump();
    rescheduleAllReminders().catch(() => {});
    load();
  }

  return (
    <View style={[styles.screen, { paddingTop: 54 }]}>
      <View style={{ paddingHorizontal: 18, marginBottom: 10 }}>
        <ScreenHeader title={t('lend.title')} subtitle={t('lend.subtitle', { n: active.length })} icon="swap-horizontal" color={Colors.orange} />
        {/* Ô tìm kiếm luôn hiển thị: lọc đồng thời lượt mượn, gửi bán và lịch sử đã trả */}
        <View style={[styles.searchBar, { marginTop: 12 }]}>
          <Ionicons name="search" size={21} color={Colors.primary} />
          <TextInput
            style={{ flex: 1, fontSize: 16, color: Colors.text }}
            placeholder={t('lend.searchPh')}
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
        </View>
        {/* Hàng chip phân loại theo kind + quá hạn, phong cách chip Trang chủ */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ marginTop: 10 }}
          contentContainerStyle={{ gap: 8, paddingRight: 4 }}
        >
          <LendFilterChip
            label={t('filter.all')}
            icon="apps-outline"
            color={Colors.primaryDark}
            active={lendFilter === 'ALL'}
            onPress={() => setLendFilter('ALL')}
          />
          <LendFilterChip
            label={t('lend.title')}
            icon="swap-horizontal"
            color={Colors.orange}
            active={lendFilter === 'LOAN'}
            onPress={() => setLendFilter('LOAN')}
          />
          <LendFilterChip
            label={t('lend.filterConsign')}
            icon="storefront-outline"
            color={statusColorFor('CONSIGNED')}
            active={lendFilter === 'CONSIGN'}
            onPress={() => setLendFilter('CONSIGN')}
          />
          <LendFilterChip
            label={t('alerts.tierOVERDUE')}
            icon="alert-circle-outline"
            color={Colors.red}
            active={lendFilter === 'OVERDUE'}
            onPress={() => setLendFilter('OVERDUE')}
          />
        </ScrollView>
        {/* Hàng chip thứ hai (nhỏ gọn): lọc theo DANH MỤC của món — chỉ
            gồm các phân loại đang có trong danh sách hiển thị; 'Tất cả'
            ở đầu để bỏ lọc. Chạy đồng thời với chip loại lượt + tìm kiếm */}
        {presentCats.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ marginTop: 8 }}
            contentContainerStyle={{ gap: 6, paddingRight: 4 }}
          >
            <LendCatChip
              label={t('filter.all')}
              icon="apps-outline"
              color={Colors.primaryDark}
              active={effectiveCat === null}
              onPress={() => setCatFilter(null)}
            />
            {presentCats.map((c) => (
              <LendCatChip
                key={c.key}
                label={c.label}
                icon={c.icon}
                color={c.color}
                active={effectiveCat === c.key}
                onPress={() => setCatFilter(effectiveCat === c.key ? null : c.key)}
              />
            ))}
          </ScrollView>
        )}
      </View>

      <FlatList
        data={finalActive}
        keyExtractor={(l) => l.id}
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 6, paddingBottom: TAB_BAR_CLEARANCE }}
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        renderItem={({ item: loan }) => {
          const info = loan.expected_return_date && !isAlertSnoozed(loan.alert_snoozed_until)
            ? getAlertTier(loan.expected_return_date, alertCfg.soonDays, alertCfg.watchDays)
            : null;
          const tierColor = info ? alertTierColor(info.tier, info.days) : null;
          const overdue = info?.tier === 'OVERDUE';
          const remaining = outstandingOf(loan);
          return (
            <View style={[styles.card, { gap: 7, borderColor: overdue ? '#F6C6CE' : Colors.border, backgroundColor: overdue ? '#FFF5F6' : Colors.card }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                <View
                  style={{
                    width: 44, height: 44, borderRadius: 22,
                    backgroundColor: borrowerColor(loan.borrower_name),
                    alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <Text style={{ color: '#fff', fontSize: 17, fontWeight: '800' }}>
                    {(loan.borrower_name.trim().charAt(0) || '?').toUpperCase()}
                  </Text>
                </View>
                <TouchableOpacity style={{ flex: 1 }} onPress={() => router.push(`/item/${loan.item_id}`)} activeOpacity={0.75}>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: Colors.text }}>{loan.item_name}</Text>
                </TouchableOpacity>
                {info && tierColor && (
                  <View style={{ backgroundColor: tint(tierColor), borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Ionicons name={alertTierIcon(info.tier)} size={11} color={tierColor} />
                    <Text style={{ color: tierColor, fontSize: 12, fontWeight: '700' }}>
                      {info.tier === 'OVERDUE'
                        ? t('alerts.badgeOverdue', { d: -info.days })
                        : info.tier === 'DUE'
                          ? t('alerts.badgeDueToday')
                          : info.tier === 'SOON'
                            ? t('alerts.badgeDaysLeft', { d: info.days })
                            : t('alerts.badgeWatch', { d: info.days })}
                    </Text>
                  </View>
                )}
              </View>
              <Text style={{ color: Colors.subtext, fontSize: 13 }}>
                {t('loan.cardLine', { borrower: loan.borrower_name, out: remaining, lent: loan.quantity_lent, unit: loan.item_unit ?? '' })}
              </Text>
              <Text style={{ color: Colors.subtext, fontSize: 13 }}>
                {loan.expected_return_date
                  ? t('loan.dateLine', { d1: formatDate(loan.lent_at), d2: formatDate(loan.expected_return_date) })
                  : t('loan.dateLineNoDue', { d1: formatDate(loan.lent_at) })}
              </Text>
              {!!loan.note && (
                <View style={{ flexDirection: 'row', gap: 5, alignItems: 'flex-start' }}>
                  <Ionicons name="document-text-outline" size={13} color={Colors.subtext} style={{ marginTop: 1 }} />
                  <Text style={{ flex: 1, color: Colors.subtext, fontSize: 12.5, lineHeight: 17 }}>{loan.note}</Text>
                </View>
              )}
              <LoanActionBlock
                handlers={{
                  onReceive: () => setReturnTarget(loan),
                  onExtend: () => setExtendTarget(loan),
                  onRemind: () => remindBorrower(loan),
                  onSnooze: () => setSnoozeTarget(loan),
                  onConvert: (type) => setConvertTarget({ loan, type }),
                  onViewItem: () => router.push(`/item/${loan.item_id}`),
                }}
              />
            </View>
          );
        }}
        ListEmptyComponent={
          // Đang lọc Ký gửi thì nội dung nằm ở section chân trang — không
          // hiện dòng "trống" gây hiểu nhầm ở danh sách chính. Ngoại lệ:
          // đang lọc thêm theo phân loại mà section ký gửi không còn gì
          // thì báo trống theo phân loại ngay tại đây.
          lendFilter === 'CONSIGN' && !(effectiveCat && finalConsignments.length === 0) ? <View /> : (
            <Text style={styles.empty}>
              {hasQuery
                ? t('lend.searchEmpty')
                : effectiveCat
                  ? t('lend.filterCatEmpty')
                  : lendFilter === 'OVERDUE'
                    ? t('lend.filterOverdueEmpty')
                    : t('lend.empty')}
            </Text>
          )
        }
        ListFooterComponent={
          <View style={{ marginTop: 20, gap: 20 }}>
            {/* Đang gửi bán: record CONSIGNMENT đang mở — ngã ngũ bằng
                Đã bán được / Lấy lại, hoặc nhắc người giữ qua Share.
                Chỉ hiện khi chip phân loại là Tất cả/Ký gửi; khi đang tìm
                kiếm mà section không có kết quả khớp thì ẩn cả section */}
            {showConsignSection && !((hasQuery || !!effectiveCat) && finalConsignments.length === 0) && (
            <View style={{ gap: 10 }}>
              <SectionTitle title={t('consign.section')} color={statusColorFor('CONSIGNED')} />
              {finalConsignments.length === 0 ? (
                <Text style={{ color: Colors.subtext, fontSize: 13 }}>{t('consign.empty')}</Text>
              ) : (
                <ScrollView style={{ maxHeight: 360 }} nestedScrollEnabled showsVerticalScrollIndicator>
                  <View style={{ gap: 10 }}>
                {finalConsignments.map((rec) => {
                  const outstanding = outstandingOf(rec);
                  const consignColor = statusColorFor('CONSIGNED');
                  return (
                    <View key={rec.id} style={[styles.card, { gap: 5 }]}>
                      <TouchableOpacity onPress={() => router.push(`/item/${rec.item_id}`)} activeOpacity={0.75}>
                        <Text style={{ fontSize: 15.5, fontWeight: '700', color: Colors.text }}>{rec.item_name}</Text>
                      </TouchableOpacity>
                      <Text style={{ color: Colors.subtext, fontSize: 13 }}>
                        {t('consign.holderLine', { name: rec.borrower_name })} · {t('consign.qtyLine', { n: outstanding, unit: rec.item_unit ?? '' })}
                      </Text>
                      <Text style={{ color: Colors.subtext, fontSize: 13 }}>
                        {t('consign.fromLine', { d: formatDate(rec.lent_at) })}
                        {rec.expected_price != null ? ` · ${t('consign.priceLine', { price: formatVND(rec.expected_price) })}` : ''}
                      </Text>
                      {!!rec.note && (
                        <View style={{ flexDirection: 'row', gap: 5, alignItems: 'flex-start' }}>
                          <Ionicons name="document-text-outline" size={13} color={Colors.subtext} style={{ marginTop: 1 }} />
                          <Text style={{ flex: 1, color: Colors.subtext, fontSize: 12.5, lineHeight: 17 }}>{rec.note}</Text>
                        </View>
                      )}
                      <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
                        <AppButton
                          title={t('consign.soldBtn')}
                          icon="cash-outline"
                          onPress={() => setResolveTarget({ rec, mode: 'SOLD' })}
                          style={{ flex: 1, backgroundColor: consignColor, shadowColor: consignColor }}
                        />
                        <AppButton
                          title={t('consign.takebackBtn')}
                          icon="arrow-undo-outline"
                          variant="secondary"
                          onPress={() => setResolveTarget({ rec, mode: 'TAKEBACK' })}
                          style={{ flex: 1 }}
                        />
                      </View>
                      <AppButton
                        title={t('consign.remindBtn')}
                        icon="chatbubble-ellipses-outline"
                        variant="ghost"
                        onPress={() => remindHolder(rec)}
                      />
                    </View>
                  );
                })}
                  </View>
                </ScrollView>
              )}
            </View>
            )}

            {showReturnedFinal && (
              <View style={{ gap: 10 }}>
                <SectionTitle title={t('lend.historyTitle')} subtitle={t('lend.historySubtitle')} color={Colors.orange} />
                <ScrollView style={{ maxHeight: 360 }} nestedScrollEnabled showsVerticalScrollIndicator>
                  <View style={{ gap: 10 }}>
                    {finalReturned.map((loan) => (
                      <View key={loan.id} style={[styles.card, { gap: 3 }]}>
                        <Text style={{ fontSize: 14, fontWeight: '600', color: Colors.text }}>{loan.item_name} — {loan.borrower_name}</Text>
                        <Text style={{ fontSize: 12, color: Colors.subtext }}>
                          {t('lend.historyLine', { d1: formatDate(loan.lent_at), d2: formatDate(loan.returned_at), n: loan.quantity_lent })}
                        </Text>
                      </View>
                    ))}
                  </View>
                </ScrollView>
              </View>
            )}
          </View>
        }
      />

      <ReturnQtyModal
        visible={!!returnTarget}
        itemName={returnTarget?.item_name ?? ''}
        borrowerName={returnTarget?.borrower_name ?? ''}
        outstanding={returnTarget ? outstandingOf(returnTarget) : 0}
        unit={returnTarget?.item_unit ?? ''}
        onClose={() => setReturnTarget(null)}
        onConfirm={(qty, note) => { handleReturnConfirm(qty, note).catch(() => {}); }}
      />

      <LoanConvertModal
        visible={!!convertTarget}
        itemName={convertTarget?.loan.item_name ?? ''}
        borrowerName={convertTarget?.loan.borrower_name ?? ''}
        outstanding={convertTarget ? outstandingOf(convertTarget.loan) : 0}
        unit={convertTarget?.loan.item_unit ?? ''}
        initialType={convertTarget?.type ?? 'GIFTED'}
        onClose={() => setConvertTarget(null)}
        onConvert={(payload) => { handleConvertConfirm(payload).catch(() => {}); }}
      />

      <ConsignResolveModal
        visible={!!resolveTarget}
        mode={resolveTarget?.mode ?? 'SOLD'}
        itemName={resolveTarget?.rec.item_name ?? ''}
        holderName={resolveTarget?.rec.borrower_name ?? ''}
        outstanding={resolveTarget ? outstandingOf(resolveTarget.rec) : 0}
        unit={resolveTarget?.rec.item_unit ?? ''}
        expectedPrice={resolveTarget?.rec.expected_price ?? null}
        onClose={() => setResolveTarget(null)}
        onConfirm={(payload) => { handleResolveConfirm(payload).catch(() => {}); }}
      />

      <SnoozePopup
        visible={!!snoozeTarget}
        onClose={() => setSnoozeTarget(null)}
        onConfirm={(days) => { handleSnoozePick(days).catch(() => {}); }}
        onNever={() => { handleSnoozeNever().catch(() => {}); }}
      />

      <ExtendLoanModal
        visible={!!extendTarget}
        borrowerName={extendTarget?.borrower_name ?? ''}
        currentDue={extendTarget?.expected_return_date ?? null}
        onClose={() => setExtendTarget(null)}
        onConfirm={(newIso) => { handleExtendConfirm(newIso).catch(() => {}); }}
      />
    </View>
  );
}
