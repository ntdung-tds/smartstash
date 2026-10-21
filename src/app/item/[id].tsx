import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Image, Alert, Modal, TextInput, Share,
} from 'react-native';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { styles, Colors, SceneImage, StatusBadge, LocationPickerModal, SectionTitle, IconTile, AppButton } from '@/components/ui';
import {
  categoryColor, categoryIcon, categoryLabel, statusLabel, conditionColor, conditionIcon, conditionLabel,
  ALERT_TIER_COLORS, alertTierColor, alertTierIcon, tint, type IconName,
} from '@/theme';
import { useT } from '@/i18n';
import type { AlertTier, Item, Location, Loan, MediaFile, ItemHistory, ItemStatus } from '@/types';
import {
  getItem, getBreadcrumb, breadcrumbText, listMediaForOwner, listLoansForItem, getItemHistory,
  setItemStatus, moveItem, softDeleteItem, createLoan, getAvailableQuantity, returnLoan, listLocations,
  setItemAlertSnooze, setLoanAlertSnooze, extendLoanDue,
} from '@/db/queries';
import { scheduleLoanReminder, rescheduleAllReminders } from '@/services/notificationService';
import { getAlertSettings, ALERT_SETTINGS_DEFAULTS, type AlertSettings } from '@/services/alertSettings';
import { useAppStore } from '@/store/useAppStore';
import {
  formatVND, formatDate, formatDateForLang, maskDateInput, parseDisplayDate,
  daysUntil, getAlertTier, isAlertSnoozed, addDaysISO, localTodayISO, ALERT_TIER_RANK,
  type AlertInfo,
} from '@/utils';

/** Nút hành động nhỏ trong banner cảnh báo (pill, icon + chữ căn giữa) */
function BannerAction({
  label, icon, color, filled, onPress,
}: {
  label: string;
  icon: IconName;
  color: string;
  filled?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={{
        height: 38, paddingHorizontal: 13, borderRadius: 999,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
        backgroundColor: filled ? color : '#fff',
        borderWidth: filled ? 0 : 1.5, borderColor: tint(color, '66'),
      }}
    >
      <Ionicons name={icon} size={15} color={filled ? '#fff' : color} />
      <Text style={{ fontSize: 13, fontWeight: '700', color: filled ? '#fff' : color }}>{label}</Text>
    </TouchableOpacity>
  );
}

const ACTION_KEYS: Record<string, string> = {
  CREATED: 'detail.action.created',
  MOVED: 'detail.action.moved',
  STATUS_CHANGED: 'detail.action.statusChanged',
  LENT: 'detail.action.lent',
  PARTIALLY_LENT: 'detail.action.partiallyLent',
  LOAN_RETURNED: 'detail.action.loanReturned',
  SOLD: 'detail.action.sold',
  PARTIALLY_SOLD: 'detail.action.partiallySold',
  DISPOSED: 'detail.action.disposed',
};

export default function ItemDetailScreen() {
  const { t, lang } = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [item, setItem] = useState<Item | null>(null);
  const [crumb, setCrumb] = useState('');
  const [media, setMedia] = useState<MediaFile[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [history, setHistory] = useState<ItemHistory[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [showMovePicker, setShowMovePicker] = useState(false);
  const [showLend, setShowLend] = useState(false);
  const [showSell, setShowSell] = useState(false);
  const [borrower, setBorrower] = useState('');
  const [borrowerPhone, setBorrowerPhone] = useState('');
  const [lendQty, setLendQty] = useState('1');
  const [expectedDate, setExpectedDate] = useState('');
  const [available, setAvailable] = useState(0);
  const [sellPrice, setSellPrice] = useState('');
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [alertCfg, setAlertCfg] = useState<AlertSettings>(ALERT_SETTINGS_DEFAULTS);
  const bump = useAppStore((s) => s.bump);
  const loadTaxonomy = useAppStore((s) => s.loadTaxonomy);

  const load = useCallback(async () => {
    if (!id) return;
    setAlertCfg(await getAlertSettings());
    const it = await getItem(id);
    setItem(it);
    if (it) {
      setCrumb(breadcrumbText(await getBreadcrumb(it.location_id)));
      setMedia(await listMediaForOwner('ITEM', it.id));
      setLoans(await listLoansForItem(it.id));
      setHistory(await getItemHistory(it.id));
      setAvailable(await getAvailableQuantity(it.id));
    }
    setLocations(await listLocations());
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      // Nạp registry phân loại/trạng thái/tình trạng tự tạo để các resolver hiển thị đúng tên/màu/icon
      loadTaxonomy();
      load();
    }, [load, loadTaxonomy]),
  );

  if (!item) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={styles.empty}>{t('detail.notFound')}</Text>
      </View>
    );
  }

  const sceneMedia = media.find((m) => m.id === item.scene_media_id) ?? media.find((m) => m.kind === 'ITEM_SCENE');
  const mainMedia = sceneMedia ?? media[0];
  // Ảnh đang xem lớn: ảnh người dùng bấm chọn ở dải thumbnail, mặc định là ảnh chính/cảnh
  const featuredMedia = media.find((m) => m.id === selectedMediaId) ?? mainMedia;
  const pin = item.pin_x != null && item.pin_y != null ? { x: item.pin_x, y: item.pin_y } : null;
  const isEnded = item.status === 'SOLD' || item.status === 'DISPOSED' || item.status === 'LOST';

  // ---- Banner cảnh báo: nguồn khẩn cấp nhất (hạn dùng / hạn trả), tôn trọng hoãn nhắc ----
  const activeLoan = loans.find((l) => l.status === 'ACTIVE') ?? null;
  const expiryInfo: AlertInfo | null = !isEnded && !isAlertSnoozed(item.alert_snoozed_until)
    ? getAlertTier(item.expiry_date, alertCfg.soonDays, alertCfg.watchDays)
    : null;
  const loanInfo: AlertInfo | null = activeLoan && !isAlertSnoozed(activeLoan.alert_snoozed_until)
    ? getAlertTier(activeLoan.expected_return_date, alertCfg.soonDays, alertCfg.watchDays)
    : null;
  // Trường hợp đặc biệt: đồ đang cho mượn nhưng hết hạn TRƯỚC ngày được trả
  const expiryBeforeReturn = !!expiryInfo && !!activeLoan?.expected_return_date && !!item.expiry_date
    && item.expiry_date < activeLoan.expected_return_date;
  type BannerState =
    | { kind: 'special'; tier: AlertTier; days: number }
    | { kind: 'expiry' | 'loan'; tier: AlertTier; days: number }
    | null;
  const banner: BannerState = (() => {
    if (expiryBeforeReturn && expiryInfo) return { kind: 'special', tier: expiryInfo.tier, days: expiryInfo.days };
    const cands: { kind: 'expiry' | 'loan'; tier: AlertTier; days: number }[] = [];
    if (expiryInfo) cands.push({ kind: 'expiry', tier: expiryInfo.tier, days: expiryInfo.days });
    if (loanInfo) cands.push({ kind: 'loan', tier: loanInfo.tier, days: loanInfo.days });
    // Mức khẩn nhất thắng; hoà mức thì ưu tiên hạn trả (nhiều hành động hơn)
    cands.sort((a, b) => ALERT_TIER_RANK[a.tier] - ALERT_TIER_RANK[b.tier] || (a.kind === 'loan' ? -1 : 1));
    return cands[0] ?? null;
  })();
  const bannerColor = banner ? (banner.kind === 'special' ? ALERT_TIER_COLORS.OVERDUE : alertTierColor(banner.tier, banner.days)) : null;

  async function refreshAfterAction() {
    bump();
    rescheduleAllReminders().catch(() => {});
    await load();
  }

  function snoozeOptions(onPick: (days: number) => Promise<void>) {
    Alert.alert(t('alerts.snoozeTitle'), '', [
      { text: t('alerts.snooze1'), onPress: () => { onPick(1).catch(() => {}); } },
      { text: t('alerts.snooze3'), onPress: () => { onPick(3).catch(() => {}); } },
      { text: t('alerts.snooze7'), onPress: () => { onPick(7).catch(() => {}); } },
      { text: t('common.cancel') },
    ]);
  }

  function snoozeItemAlert() {
    snoozeOptions(async (n) => {
      await setItemAlertSnooze(item!.id, addDaysISO(localTodayISO(), n));
      refreshAfterAction();
    });
  }

  function snoozeLoanAlert(loan: Loan) {
    snoozeOptions(async (n) => {
      await setLoanAlertSnooze(loan.id, addDaysISO(localTodayISO(), n));
      refreshAfterAction();
    });
  }

  /** "Đã xử lý" cho hạn dùng quá hạn: Bán / Đã dùng hết / Huỷ bỏ — đổi trạng thái qua setItemStatus */
  function handleProcessedExpired() {
    Alert.alert(t('alerts.actHandle'), item!.name, [
      { text: t('alerts.actSell'), onPress: () => setShowSell(true) },
      {
        text: t('alerts.actUsedUp'),
        onPress: async () => { await setItemStatus(item!.id, 'DISPOSED', { note: 'Đã dùng hết' }); refreshAfterAction(); },
      },
      {
        text: t('alerts.actDiscard'), style: 'destructive',
        onPress: async () => { await setItemStatus(item!.id, 'DISPOSED', { note: 'Đã vứt bỏ' }); refreshAfterAction(); },
      },
      { text: t('common.cancel') },
    ]);
  }

  function remindBorrower(loan: Loan, days: number) {
    const message = days < 0
      ? t('alerts.remindMsgOverdue', { item: item!.name, borrower: loan.borrower_name, days: -days })
      : t('alerts.remindMsgDue', { item: item!.name, borrower: loan.borrower_name });
    Share.share({ message }).catch(() => {});
  }

  async function extendActiveLoan(loan: Loan) {
    if (!loan.expected_return_date) return;
    await extendLoanDue(loan.id, addDaysISO(loan.expected_return_date, 7));
    refreshAfterAction();
  }

  async function receiveBackLoan(loan: Loan) {
    await returnLoan(loan.id, loan.quantity_lent - loan.quantity_returned);
    refreshAfterAction();
  }

  async function doSetStatus(status: ItemStatus, note?: string, soldPrice?: number | null) {
    await setItemStatus(item!.id, status, { note, soldPrice });
    bump();
    load();
  }

  async function handleLend() {
    if (!borrower.trim()) {
      Alert.alert(t('detail.noBorrowerTitle'), t('detail.noBorrowerMsg'));
      return;
    }
    const qty = parseInt(lendQty, 10);
    if (!qty || qty < 1 || qty > available) {
      Alert.alert(t('lend.qtyInvalidTitle'), t('detail.qtyAvailableMsg', { n: available }));
      return;
    }
    const dueISO = expectedDate.trim() ? parseDisplayDate(expectedDate) : null;
    if (expectedDate.trim() && !dueISO) {
      Alert.alert(t('detail.badDueTitle'), t('qa.badDateMsg'));
      return;
    }
    try {
      await createLoan({
        item_id: item!.id,
        borrower_name: borrower.trim(),
        borrower_phone: borrowerPhone.trim() || null,
        quantity_lent: qty,
        expected_return_date: dueISO,
      });
      if (dueISO) scheduleLoanReminder(item!.name, borrower.trim(), dueISO).catch(() => {});
      rescheduleAllReminders().catch(() => {});
      setShowLend(false);
      setBorrower(''); setBorrowerPhone(''); setLendQty('1'); setExpectedDate('');
      bump();
      load();
    } catch (e) {
      Alert.alert(t('detail.lendFailTitle'), e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingBottom: 40 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
        <Text style={[styles.title, { flex: 1 }]}>{item.name}</Text>
        <TouchableOpacity style={[styles.buttonSecondary, { paddingVertical: 8, paddingHorizontal: 12 }]} onPress={() => router.push(`/item/edit?id=${item.id}`)}>
          <Ionicons name="pencil" size={15} color={Colors.primaryDark} />
          <Text style={[styles.buttonSecondaryText, { fontSize: 13 }]}>{t('detail.edit')}</Text>
        </TouchableOpacity>
      </View>

      <View
        style={{
          backgroundColor: Colors.deep, borderRadius: 24, padding: 18, gap: 10, overflow: 'hidden',
          shadowColor: Colors.deep, shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.3, shadowRadius: 20, elevation: 8,
        }}
      >
        <View pointerEvents="none" style={{ position: 'absolute', width: 150, height: 150, borderRadius: 75, backgroundColor: Colors.coral, opacity: 0.3, top: -80, right: -45 }} />
        <View pointerEvents="none" style={{ position: 'absolute', width: 100, height: 100, borderRadius: 50, backgroundColor: Colors.teal, opacity: 0.26, bottom: -55, left: -30 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <Ionicons name="location" size={16} color={Colors.coral} />
          <Text style={{ fontSize: 12, fontWeight: '800', color: Colors.coral, letterSpacing: 1.2 }}>{t('detail.findHere')}</Text>
        </View>
        <Text style={{ fontSize: 19, fontWeight: '800', color: '#fff', lineHeight: 26 }}>{crumb || t('detail.noLocation')}</Text>
        {!!item.position_note && <Text style={{ fontSize: 14, color: Colors.onDarkMuted }}>{item.position_note}</Text>}
        {featuredMedia ? (
          <SceneImage uri={featuredMedia.local_uri} pin={featuredMedia.id === sceneMedia?.id ? pin : null} height={220} />
        ) : (
          <Text style={{ color: Colors.onDarkMuted, fontSize: 13 }}>{t('detail.noScene')}</Text>
        )}
        {media.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {media.map((m) => (
                <TouchableOpacity key={m.id} onPress={() => setSelectedMediaId(m.id)} activeOpacity={0.85}>
                  <Image
                    source={{ uri: m.thumbnail_uri }}
                    style={{
                      width: 64, height: 64, borderRadius: 14,
                      borderWidth: featuredMedia?.id === m.id ? 2.5 : 0,
                      borderColor: Colors.coral,
                    }}
                  />
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
        )}
      </View>

      {banner && bannerColor && (
        <View
          style={{
            backgroundColor: tint(bannerColor, '14'), borderWidth: 1, borderColor: tint(bannerColor, '55'),
            borderRadius: 18, padding: 14, gap: 9,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Ionicons name={banner.kind === 'special' ? 'alert-circle' : alertTierIcon(banner.tier)} size={19} color={bannerColor} />
            <Text style={{ flex: 1, fontSize: 15, fontWeight: '800', color: bannerColor }}>
              {banner.kind === 'special' ? t('alerts.expiryBeforeReturn') : t(`alerts.tier${banner.tier}`)}
            </Text>
          </View>
          <Text style={{ fontSize: 13, color: Colors.text, lineHeight: 19 }}>
            {banner.kind === 'loan' && activeLoan
              ? t('alerts.bannerLoanSub', {
                borrower: activeLoan.borrower_name,
                d: formatDateForLang(activeLoan.expected_return_date, lang),
                rel: banner.days < 0
                  ? t('alerts.badgeOverdue', { d: -banner.days })
                  : banner.days === 0
                    ? t('alerts.badgeDueToday')
                    : t('alerts.badgeDaysLeft', { d: banner.days }),
              })
              : `${t('detail.expiry')}: ${formatDateForLang(item.expiry_date, lang)} — ${banner.days < 0
                ? t('alerts.badgeOverdue', { d: -banner.days })
                : banner.days === 0
                  ? t('alerts.badgeDueToday')
                  : t('alerts.badgeDaysLeft', { d: banner.days })}`}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {(banner.kind === 'loan' || banner.kind === 'special') && activeLoan ? (
              <>
                <BannerAction label={t('alerts.actRemind')} icon="chatbubble-ellipses-outline" color={bannerColor} filled onPress={() => remindBorrower(activeLoan, banner.kind === 'special' ? (loanInfo?.days ?? 0) : banner.days)} />
                {!!activeLoan.expected_return_date && (
                  <BannerAction label={t('alerts.actExtend7')} icon="calendar-outline" color={bannerColor} onPress={() => { extendActiveLoan(activeLoan).catch(() => {}); }} />
                )}
                <BannerAction label={t('alerts.actReceived')} icon="checkmark-done-outline" color={bannerColor} onPress={() => { receiveBackLoan(activeLoan).catch(() => {}); }} />
                <BannerAction label={t('alerts.actSnooze')} icon="notifications-off-outline" color={bannerColor} onPress={() => snoozeLoanAlert(activeLoan)} />
              </>
            ) : banner.tier === 'OVERDUE' ? (
              <>
                <BannerAction label={t('alerts.actHandle')} icon="hammer-outline" color={bannerColor} filled onPress={handleProcessedExpired} />
                <BannerAction label={t('alerts.actSnooze')} icon="notifications-off-outline" color={bannerColor} onPress={snoozeItemAlert} />
              </>
            ) : (
              <>
                <BannerAction label={t('alerts.actSellGive')} icon="cash-outline" color={bannerColor} filled onPress={() => setShowSell(true)} />
                <BannerAction label={t('alerts.actLend')} icon="people-outline" color={bannerColor} onPress={() => { setLendQty(String(Math.max(1, available))); setShowLend(true); }} />
                <BannerAction label={t('alerts.actSnooze')} icon="notifications-off-outline" color={bannerColor} onPress={snoozeItemAlert} />
              </>
            )}
          </View>
        </View>
      )}

      <View style={[styles.card, { gap: 7 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
          <IconTile icon={categoryIcon(item.category)} color={categoryColor(item.category)} size={46} iconSize={23} />
          <View style={{ flex: 1, gap: 5 }}>
            <StatusBadge status={item.status} lentInfo={item.status === 'PARTIALLY_LENT' ? `${item.quantity - available}/${item.quantity}` : undefined} />
            <Text style={{ color: Colors.subtext, fontSize: 13 }}>{categoryLabel(item.category)} · {t('common.qtyPlain', { n: item.quantity, unit: item.unit })}</Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Ionicons name={conditionIcon(item.condition)} size={15} color={conditionColor(item.condition)} />
          <Text style={{ fontSize: 13, color: Colors.subtext }}>
            {t('qa.conditionLabel')}:{' '}
            <Text style={{ color: conditionColor(item.condition), fontWeight: '700' }}>{conditionLabel(item.condition)}</Text>
          </Text>
        </View>
        {!!item.condition_note && (
          <View style={{ gap: 2 }}>
            <Text style={{ fontSize: 12.5, fontWeight: '700', color: Colors.text }}>{t('condition.noteLabel')}</Text>
            <Text style={{ fontSize: 13, color: Colors.subtext, lineHeight: 19 }}>{item.condition_note}</Text>
          </View>
        )}
        {!!item.purchase_price && <Text style={{ fontSize: 13, color: Colors.subtext }}>{t('detail.purchase')}: {formatVND(item.purchase_price)}{item.purchase_date ? ` · ${formatDateForLang(item.purchase_date, lang)}` : ''}{item.purchase_place ? ` · ${item.purchase_place}` : ''}</Text>}
        {!!item.expiry_date && <Text style={{ fontSize: 13, color: Colors.subtext }}>{t('detail.expiry')}: {formatDateForLang(item.expiry_date, lang)}</Text>}
        {!!item.warranty_expiry_date && (() => {
          const wDays = daysUntil(item.warranty_expiry_date) ?? 0;
          // Đã hết bảo hành: nhãn xám trung tính, không nhuộm màu cảnh báo
          if (wDays < 0) {
            return (
              <Text style={{ fontSize: 13, color: Colors.subtext }}>
                {t('detail.warrantyExpired')}: {formatDateForLang(item.warranty_expiry_date, lang)}
              </Text>
            );
          }
          const wInfo = getAlertTier(item.warranty_expiry_date, alertCfg.soonDays, alertCfg.watchDays);
          return (
            <Text style={{ fontSize: 13, color: Colors.subtext }}>
              {t('detail.warranty')}:{' '}
              {wInfo ? (
                <Text style={{ color: alertTierColor(wInfo.tier, wInfo.days), fontWeight: '700' }}>
                  {formatDateForLang(item.warranty_expiry_date, lang)}
                </Text>
              ) : (
                formatDateForLang(item.warranty_expiry_date, lang)
              )}
            </Text>
          );
        })()}
      </View>

      {!isEnded && (
        <View style={{ gap: 10 }}>
          <SectionTitle title={t('detail.actions')} color={Colors.primary} />
          <View style={[styles.card, { gap: 10 }]}>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {item.status === 'IN_USE' ? (
              <AppButton title={t('detail.storeBack')} icon="archive-outline" onPress={() => doSetStatus('STORED')} style={{ flex: 1 }} />
            ) : (
              <AppButton title={t('detail.takeOut')} icon="exit-outline" onPress={() => doSetStatus('IN_USE')} style={{ flex: 1 }} />
            )}
            <AppButton title={t('detail.move')} variant="secondary" icon="swap-horizontal-outline" onPress={() => setShowMovePicker(true)} style={{ flex: 1 }} />
          </View>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <AppButton title={t('detail.lendBtn', { n: available })} variant="secondary" icon="people-outline" onPress={() => { setLendQty(String(Math.max(1, available))); setShowLend(true); }} style={{ flex: 1 }} />
            <AppButton title={t('detail.soldBtn')} variant="secondary" icon="cash-outline" onPress={() => setShowSell(true)} style={{ flex: 1 }} />
          </View>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <AppButton title={t('detail.disposeBtn')} variant="danger" onPress={() => Alert.alert(t('detail.disposeTitle'), '', [{ text: t('common.cancel') }, { text: t('detail.disposeBtn'), style: 'destructive', onPress: () => doSetStatus('DISPOSED', 'Đã vứt bỏ') }])} style={{ flex: 1 }} />
            <AppButton title={t('detail.lostBtn')} variant="danger" onPress={() => Alert.alert(t('detail.lostTitle'), '', [{ text: t('common.cancel') }, { text: t('detail.lostBtn'), style: 'destructive', onPress: () => doSetStatus('LOST', 'Đánh dấu thất lạc') }])} style={{ flex: 1 }} />
            <AppButton
              title={t('detail.deleteBtn')}
              variant="danger"
              onPress={() => Alert.alert(t('detail.deleteTitle'), t('detail.deleteMsg'), [
                { text: t('common.cancel') },
                { text: t('detail.deleteBtn'), style: 'destructive', onPress: async () => { await softDeleteItem(item.id); bump(); router.back(); } },
              ])}
              style={{ flex: 1 }}
            />
          </View>
          </View>
        </View>
      )}

      {loans.length > 0 && (
        <View style={{ gap: 10 }}>
          <SectionTitle title={t('detail.lendSection')} color={Colors.orange} />
          {loans.map((loan) => (
            <View key={loan.id} style={[styles.card, { gap: 4, borderColor: loan.status === 'ACTIVE' ? '#FBD9AE' : Colors.border, backgroundColor: loan.status === 'ACTIVE' ? '#FFFBF4' : Colors.card }]}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: Colors.text }}>
                {loan.borrower_name} · {loan.quantity_lent} {item.unit}
                {loan.status === 'ACTIVE' && loan.quantity_returned > 0 ? ` ${t('detail.returnedPart', { n: loan.quantity_returned })}` : ''}
              </Text>
              <Text style={{ fontSize: 12, color: Colors.subtext }}>
                {t('detail.borrowedOn', { d: formatDate(loan.lent_at) })}
                {loan.expected_return_date ? t('detail.duePart', { d: formatDate(loan.expected_return_date) }) : ''}
                {loan.returned_at ? t('detail.returnedPartDate', { d: formatDate(loan.returned_at) }) : ''}
              </Text>
              {loan.status === 'ACTIVE' && (
                <AppButton
                  title={t('detail.returnAll')}
                  icon="checkmark-done-outline"
                  onPress={async () => { await returnLoan(loan.id, loan.quantity_lent - loan.quantity_returned); bump(); rescheduleAllReminders().catch(() => {}); load(); }}
                  style={{ marginTop: 6 }}
                />
              )}
            </View>
          ))}
        </View>
      )}

      {history.length > 0 && (
        <View style={{ gap: 10 }}>
          <SectionTitle title={t('detail.historySection')} color={Colors.sky} />
          <View style={{ position: 'relative' }}>
            {/* Đường timeline dọc nối các vòng icon (chỉ vẽ khi có từ 2 mốc) */}
            {history.length > 1 && (
              <View
                pointerEvents="none"
                style={{ position: 'absolute', left: 18, top: 15, bottom: 15, width: 2, borderRadius: 1, backgroundColor: Colors.border }}
              />
            )}
            <View style={{ gap: 10 }}>
              {history.map((h) => (
                <View key={h.id} style={{ flexDirection: 'row', gap: 11, paddingHorizontal: 4, alignItems: 'flex-start' }}>
                  <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: Colors.chipBg, alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name="time-outline" size={16} color={Colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, color: Colors.text }}>
                      {ACTION_KEYS[h.action_type] ? t(ACTION_KEYS[h.action_type]) : h.action_type}
                      {h.old_status && h.new_status ? ` · ${statusLabel(h.old_status)} → ${statusLabel(h.new_status)}` : ''}
                    </Text>
                    <Text style={{ fontSize: 12, color: Colors.subtext }}>{formatDate(h.created_at)}</Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        </View>
      )}

      <LocationPickerModal
        visible={showMovePicker}
        locations={locations}
        title={t('detail.move')}
        onClose={() => setShowMovePicker(false)}
        onSelect={async (loc) => { await moveItem(item.id, loc.id); bump(); load(); }}
      />

      <Modal visible={showLend} transparent animationType="fade" onRequestClose={() => setShowLend(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.card, styles.modalCard, { gap: 12 }]}>
            <Text style={{ fontSize: 18, fontWeight: '800', color: Colors.text }}>{t('detail.lendTitle', { name: item.name })}</Text>
            <TextInput style={styles.input} placeholder={t('detail.borrowerPh')} value={borrower} onChangeText={setBorrower} autoFocus />
            <TextInput style={styles.input} placeholder={t('detail.phonePh')} keyboardType="phone-pad" value={borrowerPhone} onChangeText={setBorrowerPhone} />
            <TextInput style={styles.input} placeholder={t('detail.qtyPh', { n: available })} keyboardType="number-pad" value={lendQty} onChangeText={setLendQty} />
            <TextInput style={styles.input} placeholder={t('detail.duePh')} keyboardType="number-pad" value={expectedDate} onChangeText={(v) => setExpectedDate(maskDateInput(v))} />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <AppButton title={t('common.cancel')} variant="secondary" onPress={() => setShowLend(false)} style={{ flex: 1 }} />
              <AppButton title={t('lend.title')} onPress={handleLend} style={{ flex: 1 }} />
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={showSell} transparent animationType="fade" onRequestClose={() => setShowSell(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.card, styles.modalCard, { gap: 12 }]}>
            <Text style={{ fontSize: 18, fontWeight: '800', color: Colors.text }}>{t('detail.sellTitle', { name: item.name })}</Text>
            <TextInput style={styles.input} placeholder={t('detail.sellPricePh')} keyboardType="number-pad" value={sellPrice} onChangeText={setSellPrice} autoFocus />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <AppButton title={t('common.cancel')} variant="secondary" onPress={() => setShowSell(false)} style={{ flex: 1 }} />
              <AppButton
                title={t('detail.soldBtn')}
                onPress={() => { setShowSell(false); doSetStatus('SOLD', 'Đã bán', sellPrice ? parseInt(sellPrice.replace(/[^\d]/g, ''), 10) || null : null); }}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}
