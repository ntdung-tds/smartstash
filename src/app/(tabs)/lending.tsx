import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Share, TextInput, ScrollView,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  styles, Colors, ScreenHeader, SectionTitle, AppButton, ExtendLoanModal, TAB_BAR_CLEARANCE,
  SnoozePopup, ReturnQtyModal, LoanConvertModal, ConsignResolveModal, LoanActionBlock,
  type LoanConvertPayload, type LoanConvertType, type ConsignResolvePayload,
} from '@/components/ui';
import type { Loan } from '@/types';
import {
  listActiveLoans, listActiveConsignments, listReturnedLoans, returnLoan, setLoanAlertSnooze, extendLoanDue,
  outstandingOf, convertLoanPortion, convertLoanToConsignment, resolveConsignment,
} from '@/db/queries';
import { useAppStore } from '@/store/useAppStore';
import { formatDate, formatVND, daysUntil, getAlertTier, isAlertSnoozed, addDaysISO, localTodayISO, ALERT_TIER_RANK, pickRemindMessage } from '@/utils';
import { alertTierColor, alertTierIcon, statusColorFor, tint } from '@/theme';
import { getAlertSettings, ALERT_SETTINGS_DEFAULTS, type AlertSettings } from '@/services/alertSettings';
import { useT } from '@/i18n';
import { rescheduleAllReminders } from '@/services/notificationService';

type LoanRow = Loan & { item_name: string; item_unit?: string };

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
      </View>

      <FlatList
        data={filteredActive}
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
        ListEmptyComponent={<Text style={styles.empty}>{hasQuery ? t('lend.searchEmpty') : t('lend.empty')}</Text>}
        ListFooterComponent={
          <View style={{ marginTop: 20, gap: 20 }}>
            {/* Đang gửi bán: record CONSIGNMENT đang mở — ngã ngũ bằng
                Đã bán được / Lấy lại, hoặc nhắc người giữ qua Share.
                Khi đang tìm kiếm mà section không có kết quả khớp thì ẩn cả section */}
            {!(hasQuery && filteredConsignments.length === 0) && (
            <View style={{ gap: 10 }}>
              <SectionTitle title={t('consign.section')} color={statusColorFor('CONSIGNED')} />
              {filteredConsignments.length === 0 ? (
                <Text style={{ color: Colors.subtext, fontSize: 13 }}>{t('consign.empty')}</Text>
              ) : (
                <ScrollView style={{ maxHeight: 360 }} nestedScrollEnabled showsVerticalScrollIndicator>
                  <View style={{ gap: 10 }}>
                {filteredConsignments.map((rec) => {
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

            {filteredReturned.length > 0 && (
              <View style={{ gap: 10 }}>
                <SectionTitle title={t('lend.historyTitle')} subtitle={t('lend.historySubtitle')} color={Colors.orange} />
                <ScrollView style={{ maxHeight: 360 }} nestedScrollEnabled showsVerticalScrollIndicator>
                  <View style={{ gap: 10 }}>
                    {filteredReturned.map((loan) => (
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
