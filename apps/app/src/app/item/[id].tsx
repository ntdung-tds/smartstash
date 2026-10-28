import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Modal, TextInput, Share,
} from 'react-native';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  styles, Colors, PhotoGallery, StatusBadge, QtyBreakdown, LocationPickerModal, SectionTitle, IconTile, AppButton, AddTermModal, DateField, ExtendLoanModal,
  Field, QtyStepper, AppPopup, SnoozePopup, ReturnQtyModal, LoanConvertModal, ConsignResolveModal, LoanActionBlock,
  type LoanConvertPayload, type LoanConvertType, type ConsignResolvePayload,
} from '@/components/ui';
import {
  categoryColor, categoryIcon, categoryLabel, statusLabel, statusColorFor, statusIcon, conditionColor, conditionIcon, conditionLabel,
  ALERT_TIER_COLORS, alertTierColor, alertTierIcon, tint, getCurrentLang, type IconName,
} from '@/theme';
import { useT, translate } from '@/i18n';
import type { AlertTier, Item, Location, Loan, MediaFile, ItemHistory, ItemStatus } from '@/types';
import {
  getItem, getBreadcrumb, breadcrumbText, listMediaForOwner, listLoansForItem, getItemHistory,
  setItemStatus, moveItem, softDeleteItem, createLoan, getAvailableQuantity, returnLoan, listLocations,
  setItemAlertSnooze, setLoanAlertSnooze, extendLoanDue,
  outstandingOf, applyStatusWithQuantity, convertLoanPortion, convertLoanToConsignment, resolveConsignment,
  updateItem, updateMediaPin, softDeleteMedia, setPrimaryMedia,
} from '@/db/queries';
import { takePhoto, pickPhotos, processAndRegisterPhoto, type PickedPhoto } from '@/services/imageService';
import { getCurrentLimits } from '@/services/planService';
import { scheduleLoanReminder, rescheduleAllReminders } from '@/services/notificationService';
import { getAlertSettings, ALERT_SETTINGS_DEFAULTS, type AlertSettings } from '@/services/alertSettings';
import { useAppStore } from '@/store/useAppStore';
import {
  formatVND, formatDate, formatDateForLang, parseDisplayDate,
  daysUntil, getAlertTier, isAlertSnoozed, addDaysISO, localTodayISO, ALERT_TIER_RANK,
  pickRemindMessage, ALERT_SNOOZE_FOREVER_ISO,
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

/**
 * Dòng cảnh báo "tự đóng lượt mượn" trong các hộp thoại xác nhận thao tác
 * kết thúc/xoá: món đang có lượt mượn ACTIVE thì thao tác sẽ tự đóng các
 * lượt đó ở tầng dữ liệu — cảnh báo này đảm bảo việc đóng không bao giờ
 * diễn ra ngầm mà người dùng không biết.
 */
function AutoCloseWarnLine({ text }: { text: string }) {
  return (
    <View
      style={{
        flexDirection: 'row', gap: 7, alignItems: 'flex-start',
        backgroundColor: tint(Colors.orange, '16'), borderRadius: 12,
        paddingHorizontal: 10, paddingVertical: 8,
      }}
    >
      <Ionicons name="warning-outline" size={16} color={Colors.orange} style={{ marginTop: 1 }} />
      <Text style={{ flex: 1, fontSize: 12.5, lineHeight: 18, color: Colors.text }}>{text}</Text>
    </View>
  );
}

/**
 * Dòng cảnh báo VÀNG trong các form trạng thái có stepper số lượng: hiện
 * khi số lượng đang chọn = toàn bộ phần đang ở nhà — nhắc người dùng thao
 * tác này áp lên mọi cái ở nhà (khác với cảnh báo cam "tự đóng lượt mượn"
 * của các thao tác kết thúc).
 */
function AllQtyWarnLine({ text }: { text: string }) {
  return (
    <View
      style={{
        flexDirection: 'row', gap: 7, alignItems: 'flex-start',
        backgroundColor: tint(Colors.warning, '26'), borderRadius: 12,
        paddingHorizontal: 10, paddingVertical: 8,
      }}
    >
      <Ionicons name="warning-outline" size={16} color="#9A6B00" style={{ marginTop: 1 }} />
      <Text style={{ flex: 1, fontSize: 12.5, lineHeight: 18, color: Colors.text }}>{text}</Text>
    </View>
  );
}

/**
 * Chữ ghi chú hiển thị cạnh một dòng lịch sử: note JSON của các dòng
 * mượn/trả ({borrower, qty, note}) được dịch thành "Người mượn · SL {n} ·
 * ghi chú"; note thường (uiNote do UI soạn, tên người mượn của dòng tự
 * đóng…) hiện nguyên văn.
 */
function historyNoteText(h: ItemHistory): string | null {
  if (!h.note) return null;
  if (h.note.startsWith('{')) {
    try {
      const j = JSON.parse(h.note) as { borrower?: string; qty?: number; note?: string };
      const parts: string[] = [];
      if (j.borrower) parts.push(j.borrower);
      if (j.qty) parts.push(`${translate(getCurrentLang(), 'qty.sl')} ${j.qty}`);
      if (j.note) parts.push(j.note);
      return parts.length > 0 ? parts.join(' · ') : null;
    } catch {
      return h.note;
    }
  }
  return h.note;
}

/** Ô thao tác trong lưới "Thao tác" ở chi tiết đồ: nền tint + icon + nhãn màu theo trạng thái đích */
function ActionTile({
  label, icon, color, dashed, onPress,
}: {
  label: string;
  icon: IconName;
  color: string;
  /** Viền đứt nét + nền trong suốt (ô "Thêm trạng thái") */
  dashed?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={{
        // Mọi ô dùng flex: 1 (basis 0) — TUYỆT ĐỐI không dùng width % trong
        // hàng flex: ô width '100%' sẽ chiếm trọn bề ngang hàng cho riêng nó,
        // ô kề bên bị ép thành vệt hẹp và tổng bề ngang (100% + gap + ô kề)
        // tràn khỏi thẻ. Ô lẻ ở hàng cuối nằm một mình trong hàng nên flex: 1
        // tự nó đã trải hết bề ngang một cách an toàn.
        flex: 1, minWidth: 0,
        height: 56, borderRadius: 16, paddingHorizontal: 10,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        backgroundColor: dashed ? 'transparent' : tint(color, '1A'),
        borderWidth: 1.5, borderStyle: dashed ? 'dashed' : 'solid',
        borderColor: dashed ? color : tint(color, '55'),
      }}
    >
      <Ionicons name={icon} size={19} color={color} />
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.8}
        style={{ fontSize: 15, fontWeight: '700', lineHeight: 20, color, flexShrink: 1 }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

/** Cấu hình nội dung hộp thoại ghi chú cho từng trạng thái đích */
const STATUS_NOTE_CONFIG: Partial<Record<ItemStatus, { fieldKey: string; phKey: string; hintKey: string; confirmKey: string }>> = {
  GIFTED: { fieldKey: 'statusNote.fieldGift', phKey: 'statusNote.phGift', hintKey: 'statusNote.hintGift', confirmKey: 'statusNote.confirmGift' },
  DONATED: { fieldKey: 'statusNote.fieldDonate', phKey: 'statusNote.phDonate', hintKey: 'statusNote.hintDonate', confirmKey: 'statusNote.confirmDonate' },
  DAMAGED: { fieldKey: 'statusNote.fieldDamaged', phKey: 'statusNote.phDamaged', hintKey: 'statusNote.hintDamaged', confirmKey: 'statusNote.confirmDamaged' },
  DISPOSED: { fieldKey: 'statusNote.fieldDisposed', phKey: 'statusNote.phDisposed', hintKey: 'statusNote.hintDisposed', confirmKey: 'statusNote.confirmDisposed' },
  LOST: { fieldKey: 'statusNote.fieldLost', phKey: 'statusNote.phLost', hintKey: 'statusNote.hintLost', confirmKey: 'statusNote.confirmLost' },
  USED_UP: { fieldKey: 'statusNote.fieldUsedUp', phKey: 'statusNote.phUsedUp', hintKey: 'statusNote.hintUsedUp', confirmKey: 'statusNote.confirmUsedUp' },
  EXPIRED: { fieldKey: 'statusNote.fieldExpired', phKey: 'statusNote.phExpired', hintKey: 'statusNote.hintExpired', confirmKey: 'statusNote.confirmExpired' },
};

/**
 * MỌI trạng thái đích mở qua hộp thoại này đều có STEPPER SỐ LƯỢNG (khi
 * còn cái ở nhà): thao tác chỉ áp lên phần đang ở nhà — tầng dữ liệu giảm
 * kho (nhóm kết thúc) hoặc tách món (mọi trạng thái còn lại, kể cả TỰ TẠO,
 * STORED, IN_USE) — xem applyStatusWithQuantity. SOLD đi qua modal Bán
 * riêng (cũng có stepper).
 */

/** Cấu hình generic cho trạng thái TỰ TẠO — không có bộ key riêng theo trạng thái */
const STATUS_NOTE_GENERIC_CONFIG = {
  fieldKey: 'statusNote.fieldGeneric',
  phKey: 'statusNote.phGeneric',
  hintKey: 'statusNote.hintGeneric',
  confirmKey: 'common.confirm',
};

/**
 * Hộp thoại dùng chung khi đánh dấu một trạng thái kết thúc/hỏng (built-in)
 * hoặc một trạng thái TỰ TẠO: 1 ô ghi chú tuỳ chọn (nhãn/gợi ý/placeholder
 * riêng theo trạng thái; trạng thái tự tạo dùng bộ key generic) + nút xác
 * nhận nhuộm màu trạng thái đích. Tên/màu/icon của trạng thái đích đều qua
 * resolver (statusLabel/statusColorFor) nên trạng thái tự tạo hiển thị đúng.
 * Ghi chú được truyền vào setItemStatus làm note lịch sử.
 */
function StatusNoteModal({
  target, itemName, warnText, qtyAvailable, unit, onClose, onConfirm,
}: {
  target: string | null;
  itemName: string;
  /** Cảnh báo tự đóng lượt mượn (chỉ khi đích là trạng thái kết thúc và món còn lượt ACTIVE) */
  warnText?: string | null;
  /** Số cái đang ở nhà — trần của stepper số lượng (0 = không còn gì ở nhà, không hiện stepper) */
  qtyAvailable: number;
  unit: string;
  onClose: () => void;
  onConfirm: (status: string, note: string | null, qty: number) => void;
}) {
  const { t } = useT();
  // Ghi chú + số lượng làm mới mỗi lần mở: component được remount bằng key={target} ở nơi dùng
  const [note, setNote] = useState('');
  const [qty, setQty] = useState(qtyAvailable);
  const cfg = target ? STATUS_NOTE_CONFIG[target as ItemStatus] ?? STATUS_NOTE_GENERIC_CONFIG : undefined;
  if (!target || !cfg) return null;
  const color = statusColorFor(target);
  // Mọi trạng thái đích đều hiện stepper khi còn cái ở nhà (max = số ở nhà)
  const showQty = qtyAvailable > 0;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={[styles.card, styles.modalCard, { gap: 12 }]}>
          <View style={{ gap: 2 }}>
            <Text style={{ fontSize: 18, fontWeight: '800', color: Colors.text }}>
              {t('statusNote.title', { status: statusLabel(target) })}
            </Text>
            <Text style={{ fontSize: 13.5, color: Colors.subtext }}>{itemName}</Text>
          </View>
          {showQty && (
            <Field label={t('qty.applyQtyLabel')}>
              <QtyStepper value={qty} max={qtyAvailable} unit={unit} onChange={setQty} />
            </Field>
          )}
          {showQty && qty === qtyAvailable && (
            <AllQtyWarnLine text={t('qty.allWarn', { n: qtyAvailable })} />
          )}
          <View style={{ gap: 7 }}>
            <Text style={{ fontSize: 13, fontWeight: '800', letterSpacing: 0.4, color: Colors.text }}>{t(cfg.fieldKey)}</Text>
            <TextInput
              style={styles.input}
              placeholder={t(cfg.phKey)}
              value={note}
              onChangeText={setNote}
              autoFocus
            />
            <Text style={{ fontSize: 12.5, fontStyle: 'italic', color: Colors.subtext, lineHeight: 18 }}>{t(cfg.hintKey)}</Text>
          </View>
          {warnText ? <AutoCloseWarnLine text={warnText} /> : null}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <AppButton title={t('common.cancel')} variant="secondary" onPress={onClose} style={{ flex: 1 }} />
            <AppButton
              title={t(cfg.confirmKey)}
              onPress={() => onConfirm(target, note.trim() || null, showQty ? qty : qtyAvailable)}
              style={{ flex: 1, backgroundColor: color, shadowColor: color }}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const ACTION_KEYS: Record<string, string> = {
  CREATED: 'detail.action.created',
  MOVED: 'detail.action.moved',
  STATUS_CHANGED: 'detail.action.statusChanged',
  LENT: 'detail.action.lent',
  PARTIALLY_LENT: 'detail.action.partiallyLent',
  LOAN_RETURNED: 'detail.action.loanReturned',
  LOAN_CLOSED: 'history.loanClosed',
  SOLD: 'detail.action.sold',
  PARTIALLY_SOLD: 'detail.action.partiallySold',
  DISPOSED: 'detail.action.disposed',
  GIFTED: 'detail.action.gifted',
  DONATED: 'detail.action.donated',
  CONSIGNED: 'detail.action.consigned',
  SPLIT: 'detail.action.split',
  RETURNED: 'detail.action.takenBack',
  USED_UP: 'detail.action.usedUp',
  EXPIRED: 'detail.action.expired',
};

export default function ItemDetailScreen() {
  const { t, lang } = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [item, setItem] = useState<Item | null>(null);
  const [crumb, setCrumb] = useState('');
  const [media, setMedia] = useState<MediaFile[]>([]);
  // Key của ảnh vừa thêm ở mỗi block — truyền xuống PhotoGallery làm
  // focusKey để gallery tự nhảy tới hiển thị ngay ảnh mới ở khung lớn
  const [focusCloseupKey, setFocusCloseupKey] = useState<string | null>(null);
  const [focusSceneKey, setFocusSceneKey] = useState<string | null>(null);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [history, setHistory] = useState<ItemHistory[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [showMovePicker, setShowMovePicker] = useState(false);
  const [showLend, setShowLend] = useState(false);
  const [extendLoan, setExtendLoan] = useState<Loan | null>(null);
  const [showSell, setShowSell] = useState(false);
  const [noteTarget, setNoteTarget] = useState<string | null>(null);
  const [showAddStatus, setShowAddStatus] = useState(false);
  const [borrower, setBorrower] = useState('');
  const [borrowerPhone, setBorrowerPhone] = useState('');
  const [lendQty, setLendQty] = useState('1');
  const [lendNote, setLendNote] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [available, setAvailable] = useState(0);
  const [sellPrice, setSellPrice] = useState('');
  const [sellBuyer, setSellBuyer] = useState('');
  const [sellQty, setSellQty] = useState(1);
  const [returnTarget, setReturnTarget] = useState<Loan | null>(null);
  const [convertTarget, setConvertTarget] = useState<{ loan: Loan; type: LoanConvertType } | null>(null);
  const [resolveTarget, setResolveTarget] = useState<{ rec: Loan; mode: 'SOLD' | 'TAKEBACK' } | null>(null);
  const [showHandlePopup, setShowHandlePopup] = useState(false);
  const [showDeletePopup, setShowDeletePopup] = useState(false);
  const [snoozePopup, setSnoozePopup] = useState<{ kind: 'item' } | { kind: 'loan'; loan: Loan } | null>(null);
  // Popup thông báo/lỗi dùng chung (1 nút "Đã hiểu") thay hộp thoại hệ thống
  const [infoPopup, setInfoPopup] = useState<{ title: string; message?: string } | null>(null);
  const showInfo = (title: string, message?: string) => setInfoPopup({ title, message });
  const [alertCfg, setAlertCfg] = useState<AlertSettings>(ALERT_SETTINGS_DEFAULTS);
  const bump = useAppStore((s) => s.bump);
  const loadTaxonomy = useAppStore((s) => s.loadTaxonomy);
  const customStatuses = useAppStore((s) => s.customStatuses);

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

  // Hai block ảnh ở chi tiết (chế độ 'detail' của PhotoGallery): ảnh món
  // đồ và ảnh hiện trường (mỗi ảnh hiện trường mang ghim riêng trên
  // chính hàng media của nó, ghim được ngay tại trang này)
  const closeups = media.filter((m) => m.kind === 'ITEM_CLOSEUP');
  const scenePhotos = media.filter((m) => m.kind === 'ITEM_SCENE');
  const primaryCloseupId = closeups.find((m) => m.is_primary === 1)?.id ?? closeups[0]?.id;
  const isEnded = item.status === 'SOLD' || item.status === 'GIFTED' || item.status === 'DONATED' || item.status === 'DISPOSED' || item.status === 'LOST' || item.status === 'USED_UP' || item.status === 'EXPIRED';

  // ---- Record đang mở của món: tách lượt MƯỢN (kind LOAN) và GỬI BÁN (kind CONSIGNMENT) ----
  // Mọi record ACTIVE đều bị tự đóng khi món kết thúc/xoá nên cảnh báo dùng
  // openRecords (cả 2 kind); banner hạn trả và thẻ mượn chỉ dùng kind LOAN.
  const openRecords = loans.filter((l) => l.status === 'ACTIVE');
  const activeLoans = openRecords.filter((l) => l.kind !== 'CONSIGNMENT');
  const consignRecords = openRecords.filter((l) => l.kind === 'CONSIGNMENT');
  // Số đang ở ngoài chưa ngã ngũ — theo outstandingOf chuẩn (trừ cả phần đã
  // đóng), khớp getItemQuantities ở tầng dữ liệu
  const lentOut = activeLoans.reduce((s, l) => s + outstandingOf(l), 0);
  const consignedOut = consignRecords.reduce((s, l) => s + outstandingOf(l), 0);

  // ---- Banner cảnh báo: nguồn khẩn cấp nhất (hạn dùng / hạn trả), tôn trọng hoãn nhắc ----
  const activeLoan = activeLoans[0] ?? null;
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

  function snoozeItemAlert() {
    setSnoozePopup({ kind: 'item' });
  }

  function snoozeLoanAlert(loan: Loan) {
    setSnoozePopup({ kind: 'loan', loan });
  }

  /** Xác nhận ở SnoozePopup: áp số ngày đã chọn cho món hoặc lượt mượn tuỳ ngữ cảnh đã mở */
  async function handleSnoozePick(days: number) {
    if (!snoozePopup) return;
    if (snoozePopup.kind === 'item') {
      await setItemAlertSnooze(item!.id, addDaysISO(localTodayISO(), days));
    } else {
      await setLoanAlertSnooze(snoozePopup.loan.id, addDaysISO(localTodayISO(), days));
    }
    setSnoozePopup(null);
    refreshAfterAction();
  }

  /** "Không nhắc lại nữa" ở SnoozePopup: hoãn vĩnh viễn (mốc cực xa) qua cùng setter snooze */
  async function handleSnoozeNever() {
    if (!snoozePopup) return;
    if (snoozePopup.kind === 'item') {
      await setItemAlertSnooze(item!.id, ALERT_SNOOZE_FOREVER_ISO);
    } else {
      await setLoanAlertSnooze(snoozePopup.loan.id, ALERT_SNOOZE_FOREVER_ISO);
    }
    setSnoozePopup(null);
    refreshAfterAction();
  }

  /** Mở modal Bán với stepper khởi tạo = toàn bộ phần đang ở nhà */
  function openSell() {
    setSellQty(Math.max(1, available));
    setShowSell(true);
  }

  /**
   * Nhắc người mượn qua Share: mẫu tin do pickRemindMessage (utils) chọn
   * theo hạn trả so với ngưỡng soonDays — sắp/quá hạn thì nhắc hạn, chưa
   * tới hạn hoặc không có hạn thì hỏi thăm nhẹ. Dùng chung cho banner
   * cảnh báo và thẻ mượn trong block Cho mượn.
   */
  function remindBorrower(loan: Loan) {
    const { key, params } = pickRemindMessage({
      borrower: loan.borrower_name,
      item: item!.name,
      lentAt: loan.lent_at,
      due: loan.expected_return_date,
      soonDays: alertCfg.soonDays,
    });
    Share.share({ message: t(key, params) }).catch(() => {});
  }

  /** Xác nhận ở ExtendLoanModal: modal đã tính sẵn hạn mới theo quy tắc
      max(hạn hiện tại, hôm nay) + số ngày chọn (xem computeExtendedDue ở ui.tsx) */
  async function handleExtendConfirm(newIso: string) {
    if (!extendLoan) return;
    await extendLoanDue(extendLoan.id, newIso);
    setExtendLoan(null);
    refreshAfterAction();
  }

  async function doSetStatus(status: ItemStatus, note?: string, soldPrice?: number | null, soldTo?: string | null) {
    await setItemStatus(item!.id, status, { note, soldPrice, soldTo });
    bump();
    // Nếu thao tác vừa tự đóng lượt mượn (trạng thái kết thúc), lịch nhắc
    // hạn trả của các lượt đó phải được gỡ — đặt lại toàn bộ lịch nhắc
    rescheduleAllReminders().catch(() => {});
    load();
  }

  /**
   * Xác nhận ở hộp thoại ghi chú trạng thái:
   * - qty > 0 (còn cái ở nhà — MỌI trạng thái đích, kể cả tự tạo / STORED /
   *   IN_USE) → đi qua applyStatusWithQuantity (giảm kho / tách món / kết
   *   thúc đầy đủ ở tầng dữ liệu); lỗi chạm giới hạn tách món được báo lại
   *   bằng popup thông báo.
   * - qty = 0 (không còn gì ở nhà để áp số lượng — mọi cái đang ở ngoài
   *   hoặc món đã kết thúc) → setItemStatus trực tiếp như trước.
   */
  async function handleStatusNoteConfirm(status: string, note: string | null, qty: number) {
    setNoteTarget(null);
    if (qty > 0) {
      try {
        await applyStatusWithQuantity(item!.id, status, qty, {
          note,
          uiNote: note ?? t('qty.partialFallback', { status: statusLabel(status) }),
        });
      } catch (e) {
        showInfo(t('statusNote.title', { status: statusLabel(status) }), e instanceof Error ? e.message : String(e));
      }
      refreshAfterAction();
      return;
    }
    await setItemStatus(item!.id, status as ItemStatus, { note: note ?? undefined });
    refreshAfterAction();
  }

  /** Xác nhận xoá món ở AppPopup — tầng dữ liệu tự đóng mọi record đang mở trước khi xoá */
  async function handleDeleteConfirm() {
    await softDeleteItem(item!.id);
    bump();
    // Record vừa tự đóng có thể còn lịch nhắc hạn trả — đặt lại toàn bộ
    rescheduleAllReminders().catch(() => {});
    router.back();
  }

  /**
   * Xác nhận ở modal Bán: còn phần ở nhà thì đi qua applyStatusWithQuantity
   * (một phần → trừ kho, uiNote gồm người mua + giá; toàn bộ & không còn gì
   * ở ngoài → kết thúc SOLD đầy đủ với sold_to). Không còn gì ở nhà (mọi
   * cái đang ở ngoài) → bán trọn như cũ qua setItemStatus (tự đóng record).
   */
  async function handleSellConfirm() {
    setShowSell(false);
    const price = sellPrice ? parseInt(sellPrice.replace(/[^\d]/g, ''), 10) || null : null;
    const buyer = sellBuyer.trim() || null;
    if (available <= 0) {
      await doSetStatus('SOLD', 'Đã bán', price, buyer);
      return;
    }
    const parts: string[] = [];
    if (buyer) parts.push(t('qty.partialSoldNote', { buyer }));
    if (price) parts.push(formatVND(price));
    try {
      await applyStatusWithQuantity(item!.id, 'SOLD', sellQty, {
        note: 'Đã bán',
        price,
        buyer,
        uiNote: parts.join(' · ') || t('qty.partialFallback', { status: statusLabel('SOLD') }),
      });
    } catch (e) {
      showInfo(t('detail.sellTitle', { name: item!.name }), e instanceof Error ? e.message : String(e));
    }
    refreshAfterAction();
  }

  /** Xác nhận ở ReturnQtyModal: nhận lại qty cái kèm ghi chú (nếu có) */
  async function handleReturnConfirm(qty: number, note: string | null) {
    const loan = returnTarget;
    setReturnTarget(null);
    if (!loan) return;
    await returnLoan(loan.id, qty, { note });
    refreshAfterAction();
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
    refreshAfterAction();
  }

  // ---- Thêm ảnh ngay tại trang chi tiết: TÁI DÙNG đúng luồng của màn
  // Sửa (acquirePhotos + addPhotos trong item/edit.tsx) — cùng trần tách
  // bucket theo gói, cùng đăng ký media qua imageService; khác ở chỗ
  // thêm xong nạp lại bằng load() của chính trang chi tiết này ----

  /** Lấy ảnh mới theo nguồn: camera = 1 tấm; thư viện = chọn nhiều trong
   *  1 lần; trần theo bucket (đồ vật maxItemPhotos / hiện trường maxScenePhotos) */
  async function acquireDetailPhotos(
    source: 'camera' | 'library',
    bucketCount: number,
    bucketLimit: number,
    limitMsgKey: 'photos.limitMsg' | 'photos.sceneLimitMsg',
  ): Promise<PickedPhoto[]> {
    const remaining = bucketLimit - bucketCount;
    if (remaining <= 0) {
      showInfo(t('loc.limitTitle'), t(limitMsgKey, { n: bucketLimit }));
      return [];
    }
    if (source === 'camera') {
      const p = await takePhoto();
      return p ? [p] : [];
    }
    const all = await pickPhotos(remaining);
    // Một số máy bỏ qua selectionLimit: chỉ lấy đến trần và báo giới hạn
    if (all.length > remaining) {
      showInfo(t('loc.limitTitle'), t(limitMsgKey, { n: bucketLimit }));
    }
    return all.slice(0, remaining);
  }

  /** Thêm ảnh cho 1 bucket ngay tại chi tiết; TRẢ VỀ danh sách id của
   *  các media VỪA tạo (theo thứ tự thêm) để nơi gọi biết ảnh nào là mới.
   *  Sau khi nạp lại danh sách, đặt focusKey của block tương ứng = id
   *  ảnh mới đầu tiên → gallery tự nhảy tới hiển thị ngay ảnh đó */
  async function addDetailPhotos(kind: 'ITEM_CLOSEUP' | 'ITEM_SCENE', source: 'camera' | 'library'): Promise<string[]> {
    if (!item) return [];
    const isCloseup = kind === 'ITEM_CLOSEUP';
    const pickedList = await acquireDetailPhotos(
      source,
      isCloseup ? closeups.length : scenePhotos.length,
      isCloseup ? getCurrentLimits().maxItemPhotos : getCurrentLimits().maxScenePhotos,
      isCloseup ? 'photos.limitMsg' : 'photos.sceneLimitMsg',
    );
    if (pickedList.length === 0) return [];
    const newIds: string[] = [];
    if (isCloseup) {
      // Chưa có ảnh chính thì tấm thêm đầu tiên nhận vai trò đó (như màn Sửa)
      let needPrimary = !closeups.some((m) => m.is_primary === 1);
      for (const p of pickedList) {
        const reg = await processAndRegisterPhoto(p, 'ITEM', item.id, 'ITEM_CLOSEUP', needPrimary);
        newIds.push(reg.id);
        needPrimary = false;
      }
    } else {
      // scene_media_id luôn trỏ 1 tấm hiện trường chính; chưa có thì tấm
      // thêm đầu tiên nhận vai trò đó (như màn Sửa)
      let mainSceneId = item.scene_media_id;
      for (const p of pickedList) {
        const reg = await processAndRegisterPhoto(p, 'ITEM', item.id, 'ITEM_SCENE', false);
        newIds.push(reg.id);
        if (!mainSceneId) mainSceneId = reg.id;
      }
      if (mainSceneId !== item.scene_media_id) {
        await updateItem(item.id, { scene_media_id: mainSceneId });
      }
    }
    bump();
    await load();
    if (newIds.length > 0) {
      if (isCloseup) setFocusCloseupKey(newIds[0]);
      else setFocusSceneKey(newIds[0]);
    }
    return newIds;
  }

  /** Xoá ảnh đồ vật ngay tại chi tiết — ĐÚNG logic của màn Sửa
   *  (handleDeletePhoto ở item/edit.tsx): softDeleteMedia cho hàng
   *  media, tấm còn lại đầu tiên lên ảnh chính nếu vừa mất ảnh chính */
  async function handleDetailDeletePhoto(m: MediaFile) {
    if (!item) return;
    await softDeleteMedia(m.id);
    let list = await listMediaForOwner('ITEM', item.id);
    setMedia(list);
    const rest = list.filter((x) => x.kind === 'ITEM_CLOSEUP');
    if (rest.length > 0 && !rest.some((x) => x.is_primary === 1)) {
      await setPrimaryMedia('ITEM', item.id, rest[0].id);
      list = await listMediaForOwner('ITEM', item.id);
      setMedia(list);
    }
    bump();
  }

  /** Xoá ảnh hiện trường ngay tại chi tiết — ĐÚNG logic của màn Sửa
   *  (handleDeleteScenePhoto ở item/edit.tsx): softDeleteMedia cho
   *  hàng media; scene_media_id đang trỏ vào tấm bị xoá thì trỏ sang tấm hiện
   *  trường còn lại đầu tiên hoặc null; ghim của chính tấm bị xoá mất
   *  theo hàng media của nó (mỗi ảnh có ghim riêng) */
  async function handleDetailDeleteScenePhoto(m: MediaFile) {
    if (!item) return;
    await softDeleteMedia(m.id);
    const list = await listMediaForOwner('ITEM', item.id);
    setMedia(list);
    if (item.scene_media_id === m.id) {
      const nextId = list.find((x) => x.kind === 'ITEM_SCENE')?.id ?? null;
      await updateItem(item.id, { scene_media_id: nextId });
      setItem({ ...item, scene_media_id: nextId });
    }
    bump();
  }

  /** Ghim ngay tại chi tiết (block hiện trường): cập nhật state ngay +
   *  lưu ngay vào chính hàng media đó qua updateMediaPin — như ở màn Sửa */
  async function handleDetailPinChange(mediaId: string, p: { x: number; y: number }) {
    setMedia((prev) => prev.map((m) => (m.id === mediaId ? { ...m, pin_x: p.x, pin_y: p.y } : m)));
    await updateMediaPin(mediaId, p.x, p.y);
    bump();
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
    refreshAfterAction();
  }

  // ---- Lưới "Thao tác": các ô theo ngữ cảnh trạng thái hiện tại của món ----
  const actionTiles: { key: string; label: string; icon: IconName; color: string; dashed?: boolean; onPress: () => void }[] = [];
  if (isEnded) {
    // Món đã kết thúc vòng đời: chỉ còn đường đưa về Đang cất (LOST thì là
    // "Đã tìm thấy") — mở hộp thoại ghi chú (đích STORED) thay cho áp ngay,
    // thống nhất mọi thao tác đều qua xác nhận + ghi chú
    actionTiles.push({
      key: 'restore',
      label: item.status === 'LOST' ? t('detail.found') : t('detail.putBack'),
      icon: item.status === 'LOST' ? 'checkmark-done-outline' : 'archive-outline',
      color: statusColorFor('STORED'),
      onPress: () => setNoteTarget('STORED'),
    });
  } else {
    if (item.status === 'STORED') {
      actionTiles.push({ key: 'takeOut', label: t('detail.takeOut'), icon: 'exit-outline', color: statusColorFor('IN_USE'), onPress: () => setNoteTarget('IN_USE') });
    } else if (item.status === 'IN_USE') {
      actionTiles.push({ key: 'putBack', label: t('detail.putBack'), icon: 'archive-outline', color: statusColorFor('STORED'), onPress: () => setNoteTarget('STORED') });
    }
    actionTiles.push({ key: 'move', label: t('detail.move'), icon: 'location-outline', color: Colors.primary, onPress: () => setShowMovePicker(true) });
    if ((item.status === 'STORED' || item.status === 'IN_USE' || item.status === 'PARTIALLY_LENT') && available > 0) {
      actionTiles.push({ key: 'lend', label: t('detail.lendBtn', { n: available }), icon: 'people-outline', color: statusColorFor('LENT'), onPress: () => { setLendQty(String(Math.max(1, available))); setShowLend(true); } });
    }
    actionTiles.push({ key: 'sell', label: t('detail.soldBtn'), icon: statusIcon('SOLD'), color: statusColorFor('SOLD'), onPress: openSell });
    actionTiles.push({ key: 'gift', label: statusLabel('GIFTED'), icon: statusIcon('GIFTED'), color: statusColorFor('GIFTED'), onPress: () => setNoteTarget('GIFTED') });
    actionTiles.push({ key: 'donate', label: statusLabel('DONATED'), icon: statusIcon('DONATED'), color: statusColorFor('DONATED'), onPress: () => setNoteTarget('DONATED') });
    if (item.status !== 'DAMAGED') {
      actionTiles.push({ key: 'damaged', label: statusLabel('DAMAGED'), icon: statusIcon('DAMAGED'), color: statusColorFor('DAMAGED'), onPress: () => setNoteTarget('DAMAGED') });
    }
    actionTiles.push({ key: 'dispose', label: statusLabel('DISPOSED'), icon: statusIcon('DISPOSED'), color: statusColorFor('DISPOSED'), onPress: () => setNoteTarget('DISPOSED') });
    actionTiles.push({ key: 'lost', label: statusLabel('LOST'), icon: statusIcon('LOST'), color: statusColorFor('LOST'), onPress: () => setNoteTarget('LOST') });
    actionTiles.push({ key: 'usedUp', label: statusLabel('USED_UP'), icon: statusIcon('USED_UP'), color: statusColorFor('USED_UP'), onPress: () => setNoteTarget('USED_UP') });
    actionTiles.push({ key: 'expired', label: statusLabel('EXPIRED'), icon: statusIcon('EXPIRED'), color: statusColorFor('EXPIRED'), onPress: () => setNoteTarget('EXPIRED') });
    // Ô cho từng trạng thái TỰ TẠO (icon/màu qua resolver): bấm mở hộp thoại
    // ghi chú generic; ẩn ô của chính trạng thái món đang mang
    for (const ct of customStatuses) {
      if (item.status === ct.id) continue;
      actionTiles.push({
        key: `custom-${ct.id}`,
        label: ct.name,
        icon: statusIcon(ct.id),
        color: statusColorFor(ct.id),
        onPress: () => setNoteTarget(ct.id),
      });
    }
    // Ô cuối lưới: tạo trạng thái tự tạo mới ngay tại đây (viền đứt nét)
    actionTiles.push({
      key: 'add-status',
      label: t('detail.addStatus'),
      icon: 'add',
      color: Colors.primary,
      dashed: true,
      onPress: () => setShowAddStatus(true),
    });
  }
  // Ghép hàng 2 ô như cũ, NGOẠI TRỪ ô 'Cho mượn': nhãn của nó là
  // "Cho mượn ({n} có sẵn)" — dài nhất lưới — nên khi nằm nửa hàng bị
  // adjustsFontSizeToFit trong ActionTile co từ 15px xuống ~12px, nhỏ
  // hơn hẳn các ô anh em. Cho ô này TRỌN MỘT HÀNG (flex: 1 một mình):
  // bề ngang chữ khả dụng ~249dp so với nhãn ~143dp ở 15px nên không còn
  // bị co, chữ bằng đúng 15px như mọi ô hành động chính trong block.
  const actionTileRows: (typeof actionTiles)[] = [];
  {
    let pendingRow: typeof actionTiles = [];
    const flush = () => {
      if (pendingRow.length > 0) {
        actionTileRows.push(pendingRow);
        pendingRow = [];
      }
    };
    for (const tile of actionTiles) {
      if (tile.key === 'lend') {
        flush();
        actionTileRows.push([tile]);
      } else {
        pendingRow.push(tile);
        if (pendingRow.length === 2) flush();
      }
    }
    flush();
  }

  async function handleLend() {
    if (!borrower.trim()) {
      showInfo(t('detail.noBorrowerTitle'), t('detail.noBorrowerMsg'));
      return;
    }
    const qty = parseInt(lendQty, 10);
    if (!qty || qty < 1 || qty > available) {
      showInfo(t('lend.qtyInvalidTitle'), t('detail.qtyAvailableMsg', { n: available }));
      return;
    }
    const dueISO = expectedDate.trim() ? parseDisplayDate(expectedDate) : null;
    if (expectedDate.trim() && !dueISO) {
      showInfo(t('detail.badDueTitle'), t('qa.badDateMsg'));
      return;
    }
    try {
      await createLoan({
        item_id: item!.id,
        borrower_name: borrower.trim(),
        borrower_phone: borrowerPhone.trim() || null,
        quantity_lent: qty,
        expected_return_date: dueISO,
        note: lendNote.trim() || null,
      });
      if (dueISO) scheduleLoanReminder(item!.name, borrower.trim(), dueISO).catch(() => {});
      rescheduleAllReminders().catch(() => {});
      setShowLend(false);
      setBorrower(''); setBorrowerPhone(''); setLendQty('1'); setExpectedDate(''); setLendNote('');
      bump();
      load();
    } catch (e) {
      showInfo(t('detail.lendFailTitle'), e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingBottom: 40 }]}>
      <Text style={styles.title}>{item.name}</Text>

      <View
        style={{
          backgroundColor: Colors.deep, borderRadius: 24, padding: 18, gap: 10, overflow: 'hidden',
          shadowColor: Colors.deep, shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.3, shadowRadius: 20, elevation: 8,
        }}
      >
        <View pointerEvents="none" style={{ position: 'absolute', width: 150, height: 150, borderRadius: 75, backgroundColor: Colors.coral, opacity: 0.3, top: -80, right: -45 }} />
        <View pointerEvents="none" style={{ position: 'absolute', width: 100, height: 100, borderRadius: 50, backgroundColor: Colors.teal, opacity: 0.26, bottom: -55, left: -30 }} />
        {item.location_id ? (
          // Toàn bộ dải đường dẫn là nút bấm → tới trang chi tiết của vị
          // trí chứa món (push lên stack nên nút quay lại của trang vị
          // trí tự trở về đúng trang chi tiết đồ này); chevron ở cuối
          // dải là gợi ý thị giác cho biết bấm được
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => router.push(`/location/${item.location_id}`)}
            style={{ gap: 10 }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <Ionicons name="location" size={16} color={Colors.coral} />
              <Text style={{ fontSize: 12, fontWeight: '800', color: Colors.coral, letterSpacing: 1.2 }}>{t('detail.findHere')}</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ flex: 1, fontSize: 19, fontWeight: '800', color: '#fff', lineHeight: 26 }}>{crumb || t('detail.noLocation')}</Text>
              <Ionicons name="chevron-forward" size={20} color={Colors.coral} />
            </View>
          </TouchableOpacity>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <Ionicons name="location" size={16} color={Colors.coral} />
              <Text style={{ fontSize: 12, fontWeight: '800', color: Colors.coral, letterSpacing: 1.2 }}>{t('detail.findHere')}</Text>
            </View>
            <Text style={{ fontSize: 19, fontWeight: '800', color: '#fff', lineHeight: 26 }}>{crumb || t('detail.noLocation')}</Text>
          </>
        )}
        {!!item.position_note && <Text style={{ fontSize: 14, color: Colors.onDarkMuted }}>{item.position_note}</Text>}
        {media.length === 0 && (
          <Text style={{ color: Colors.onDarkMuted, fontSize: 13 }}>{t('detail.noScene')}</Text>
        )}
      </View>

      {/* ===== ẢNH: 2 block đầy đủ ở chế độ 'detail' — vuốt ngang để xem,
          thêm ảnh mới ngay tại đây (popup Chụp / Thư viện / Bỏ qua, trần
          theo gói; thêm xong gallery tự nhảy tới ảnh mới qua focusKey),
          xoá ảnh ngay tại đây qua nút thùng rác trên chính ảnh lớn
          (cùng logic hệ quả như màn Sửa), block hiện trường ghim được
          ngay tại đây; chỉ ĐẶT ẢNH CHÍNH là vẫn ở màn Sửa. Block rỗng
          vẫn render để thêm được ảnh đầu tiên từ chi tiết ===== */}
      <PhotoGallery
        card
        mode="detail"
        title={t('photos.item')}
        titleColor={Colors.coral}
        photos={closeups.map((m) => ({
          key: m.id,
          uri: m.thumbnail_uri,
          fullUri: m.local_uri,
          isPrimary: m.id === primaryCloseupId,
        }))}
        takeLabel={t('qa.takePhoto')}
        pickLabel={t('qa.pickPhoto')}
        onTake={() => { addDetailPhotos('ITEM_CLOSEUP', 'camera').catch(() => {}); }}
        onPick={() => { addDetailPhotos('ITEM_CLOSEUP', 'library').catch(() => {}); }}
        onRemove={(e) => {
          const m = closeups.find((x) => x.id === e.key);
          if (m) handleDetailDeletePhoto(m).catch(() => {});
        }}
        focusKey={focusCloseupKey ?? undefined}
        maxReached={closeups.length >= getCurrentLimits().maxItemPhotos}
        limitText={t('photos.limitMsg', { n: getCurrentLimits().maxItemPhotos })}
      />
      <PhotoGallery
        card
        mode="detail"
        title={t('photos.scene')}
        titleColor={Colors.teal}
        photos={scenePhotos.map((m) => ({
          key: m.id,
          uri: m.thumbnail_uri,
          fullUri: m.local_uri,
          pin: m.pin_x != null && m.pin_y != null ? { x: m.pin_x, y: m.pin_y } : null,
        }))}
        takeLabel={t('qa.takePhoto')}
        pickLabel={t('photos.addScene')}
        onTake={() => { addDetailPhotos('ITEM_SCENE', 'camera').catch(() => {}); }}
        onPick={() => { addDetailPhotos('ITEM_SCENE', 'library').catch(() => {}); }}
        onRemove={(e) => {
          const m = scenePhotos.find((x) => x.id === e.key);
          if (m) handleDetailDeleteScenePhoto(m).catch(() => {});
        }}
        focusKey={focusSceneKey ?? undefined}
        maxReached={scenePhotos.length >= getCurrentLimits().maxScenePhotos}
        limitText={t('photos.sceneLimitMsg', { n: getCurrentLimits().maxScenePhotos })}
        onPinChange={(e, p) => { handleDetailPinChange(e.key, p).catch(() => {}); }}
      />

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
                <BannerAction label={t('alerts.actRemind')} icon="chatbubble-ellipses-outline" color={bannerColor} filled onPress={() => remindBorrower(activeLoan)} />
                <BannerAction label={t('extend.btn')} icon="calendar-outline" color={bannerColor} onPress={() => setExtendLoan(activeLoan)} />
                <BannerAction label={t('detail.returnAll')} icon="checkmark-done-outline" color={bannerColor} onPress={() => setReturnTarget(activeLoan)} />
                <BannerAction label={t('alerts.actSnooze')} icon="notifications-off-outline" color={bannerColor} onPress={() => snoozeLoanAlert(activeLoan)} />
              </>
            ) : banner.tier === 'OVERDUE' ? (
              <>
                <BannerAction label={t('alerts.actHandle')} icon="hammer-outline" color={bannerColor} filled onPress={() => setShowHandlePopup(true)} />
                <BannerAction label={t('alerts.actSnooze')} icon="notifications-off-outline" color={bannerColor} onPress={snoozeItemAlert} />
              </>
            ) : (
              <>
                <BannerAction label={t('alerts.actSellGive')} icon="cash-outline" color={bannerColor} filled onPress={openSell} />
                <BannerAction label={t('alerts.actLend')} icon="people-outline" color={bannerColor} onPress={() => { setLendQty(String(Math.max(1, available))); setShowLend(true); }} />
                <BannerAction label={t('alerts.actSnooze')} icon="notifications-off-outline" color={bannerColor} onPress={snoozeItemAlert} />
              </>
            )}
          </View>
        </View>
      )}

      <View style={[styles.card, { gap: 8 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
          <IconTile icon={categoryIcon(item.category)} color={categoryColor(item.category)} size={46} iconSize={23} />
          <View style={{ flex: 1, gap: 5 }}>
            <StatusBadge status={item.status} lentInfo={item.status === 'PARTIALLY_LENT' ? `${lentOut}/${item.quantity}` : undefined} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Ionicons name={categoryIcon(item.category)} size={14} color={categoryColor(item.category)} />
              <Text style={{ color: Colors.subtext, fontSize: 13 }}>{categoryLabel(item.category)}</Text>
            </View>
            <QtyBreakdown total={item.quantity} unit={item.unit} lentOut={lentOut} consignedOut={consignedOut} size={13} />
          </View>
        </View>
        <View style={{ height: 1, backgroundColor: Colors.border, opacity: 0.8 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Ionicons name={conditionIcon(item.condition)} size={15} color={conditionColor(item.condition)} />
          <Text style={{ fontSize: 13, color: Colors.subtext }}>
            <Text style={{ fontWeight: '400' }}>{t('qa.conditionLabel')}:</Text>{' '}
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
        <Text style={{ fontSize: 13, color: Colors.subtext }}>{t('detail.createdAt')}: {formatDateForLang(item.created_at, lang)}</Text>
      </View>

      <View style={{ gap: 10 }}>
        <SectionTitle title={t('detail.actions')} color={Colors.primary} />
        <View style={[styles.card, { gap: 10 }]}>
          {actionTileRows.map((rowTiles, ri) => (
            <View key={ri} style={{ flexDirection: 'row', gap: 10 }}>
              {rowTiles.map((tile) => (
                <ActionTile
                  key={tile.key}
                  label={tile.label}
                  icon={tile.icon}
                  color={tile.color}
                  dashed={tile.dashed}
                  onPress={tile.onPress}
                />
              ))}
            </View>
          ))}
        </View>
      </View>

      {/* Thẻ Quản lý: Sửa + Xoá cạnh nhau — đặt ngay dưới Thao tác, TRƯỚC
          Cho mượn và Lịch sử để hai nút quản trị luôn gần đầu màn (mỗi hành
          động chỉ còn đúng 1 chỗ: Sửa trước đây ở cạnh tên món, Xoá trong Thao tác) */}
      <View style={{ gap: 10 }}>
        <SectionTitle title={t('detail.manageSection')} color={Colors.primary} />
        <View style={[styles.card, { gap: 10 }]}>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <ActionTile
              label={t('detail.edit')}
              icon="create-outline"
              color={Colors.primary}
              onPress={() => router.push(`/item/edit?id=${item.id}`)}
            />
            <ActionTile
              label={t('detail.deleteBtn')}
              icon="trash-outline"
              color={Colors.red}
              onPress={() => setShowDeletePopup(true)}
            />
          </View>
        </View>
      </View>

      {openRecords.length > 0 && (
        <View style={{ gap: 10 }}>
          <SectionTitle title={t('detail.lendSection')} color={Colors.orange} />
          {/* Dải tổng lượt: chỉ tính lượt MƯỢN (kind LOAN) đang mở — số
              người mượn KHÁC NHAU + tổng số món đang ở ngoài theo
              outstandingOf; số liệu in đậm bằng cách tách template
              lendSummary tại {n}/{m} (i18n không có rich text) */}
          {activeLoans.length > 0 && (() => {
            const borrowerCount = new Set(activeLoans.map((l) => l.borrower_name)).size;
            const [beforeN, restTpl] = t('detail.lendSummary').split('{n}');
            const [between, afterM] = (restTpl ?? '').split('{m}');
            return (
              <View
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 7,
                  backgroundColor: '#FFF7E8', borderWidth: 1, borderColor: '#FBE3B8',
                  borderRadius: 12, paddingHorizontal: 11, paddingVertical: 8,
                }}
              >
                <Ionicons name="people-outline" size={15} color="#B45309" />
                <Text style={{ flex: 1, fontSize: 13, color: '#7A5A12', lineHeight: 18 }}>
                  {beforeN}
                  <Text style={{ fontWeight: '800' }}>{borrowerCount}</Text>
                  {between}
                  <Text style={{ fontWeight: '800' }}>{lentOut}</Text>
                  {afterM}
                </Text>
              </View>
            );
          })()}
          {/* Danh sách dài thì cuộn trong block (tối đa ~300) thay vì đẩy cả trang */}
          <ScrollView style={{ maxHeight: 300 }} nestedScrollEnabled showsVerticalScrollIndicator>
            <View style={{ gap: 10 }}>
          {activeLoans.map((loan) => {
            const outstanding = outstandingOf(loan);
            return (
            <View key={loan.id} style={[styles.card, { gap: 4, borderColor: '#FBD9AE', backgroundColor: '#FFFBF4' }]}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: Colors.text }}>
                {t('loan.cardLine', { borrower: loan.borrower_name, out: outstanding, lent: loan.quantity_lent, unit: item.unit })}
              </Text>
              <Text style={{ fontSize: 12, color: Colors.subtext }}>
                {loan.expected_return_date
                  ? t('loan.dateLine', { d1: formatDate(loan.lent_at), d2: formatDate(loan.expected_return_date) })
                  : t('loan.dateLineNoDue', { d1: formatDate(loan.lent_at) })}
              </Text>
              {!!loan.note && (
                <View style={{ flexDirection: 'row', gap: 5, alignItems: 'flex-start' }}>
                  <Ionicons name="document-text-outline" size={13} color={Colors.subtext} style={{ marginTop: 1 }} />
                  <Text style={{ flex: 1, fontSize: 12.5, color: Colors.subtext, lineHeight: 17 }}>{loan.note}</Text>
                </View>
              )}
              <LoanActionBlock
                handlers={{
                  onReceive: () => setReturnTarget(loan),
                  onExtend: () => setExtendLoan(loan),
                  onRemind: () => remindBorrower(loan),
                  onSnooze: () => snoozeLoanAlert(loan),
                  onConvert: (type) => setConvertTarget({ loan, type }),
                }}
              />
            </View>
            );
          })}
          {consignRecords.map((rec) => {
            const outstanding = outstandingOf(rec);
            const consignColor = statusColorFor('CONSIGNED');
            return (
            <View key={rec.id} style={[styles.card, { gap: 4, borderColor: '#B9CDF5', backgroundColor: '#F4F8FF' }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 5,
                    backgroundColor: tint(consignColor), borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4,
                  }}
                >
                  <Ionicons name={statusIcon('CONSIGNED')} size={12} color={consignColor} />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: consignColor }}>{t('consign.pill')}</Text>
                </View>
                <Text style={{ flex: 1, fontSize: 14, fontWeight: '600', color: Colors.text }} numberOfLines={1}>
                  {rec.borrower_name}
                </Text>
              </View>
              <Text style={{ fontSize: 12.5, color: Colors.subtext }}>
                {t('consign.qtyLine', { n: outstanding, unit: item.unit })} · {t('consign.fromLine', { d: formatDate(rec.lent_at) })}
              </Text>
              {rec.expected_price != null && (
                <Text style={{ fontSize: 12.5, color: Colors.subtext }}>
                  {t('consign.priceLine', { price: formatVND(rec.expected_price) })}
                </Text>
              )}
              {!!rec.note && (
                <View style={{ flexDirection: 'row', gap: 5, alignItems: 'flex-start' }}>
                  <Ionicons name="document-text-outline" size={13} color={Colors.subtext} style={{ marginTop: 1 }} />
                  <Text style={{ flex: 1, fontSize: 12.5, color: Colors.subtext, lineHeight: 17 }}>{rec.note}</Text>
                </View>
              )}
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 6 }}>
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
            </View>
            );
          })}
            </View>
          </ScrollView>
        </View>
      )}

      {history.length > 0 && (
        <View style={{ gap: 10 }}>
          <SectionTitle title={t('detail.historySection')} color={Colors.sky} />
          {/* Timeline dài thì cuộn trong block (tối đa ~340); đường kẻ dọc nằm
              CÙNG vùng cuộn với các mốc để không bị đứt khi cuộn */}
          <ScrollView style={{ maxHeight: 340 }} nestedScrollEnabled showsVerticalScrollIndicator>
          <View style={{ position: 'relative' }}>
            {/* Đường timeline dọc nối các vòng icon (chỉ vẽ khi có từ 2 mốc) */}
            {history.length > 1 && (
              <View
                pointerEvents="none"
                style={{ position: 'absolute', left: 18, top: 15, bottom: 15, width: 2, borderRadius: 1, backgroundColor: Colors.border }}
              />
            )}
            <View style={{ gap: 10 }}>
              {history.map((h) => {
                const actionLabel = ACTION_KEYS[h.action_type] ? t(ACTION_KEYS[h.action_type]) : h.action_type;
                const noteText = historyNoteText(h);
                return (
                <View key={h.id} style={{ flexDirection: 'row', gap: 11, paddingHorizontal: 4, alignItems: 'flex-start' }}>
                  <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: Colors.chipBg, alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name="time-outline" size={16} color={Colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, color: Colors.text }}>
                      {actionLabel}
                      {/* Đoạn chuyển trạng thái chỉ in khi trạng thái THẬT SỰ
                          đổi (từ ≠ đến) — thao tác một phần giữ nguyên trạng
                          thái vòng đời nên old == new, in ra sẽ thành vòng lặp
                          vô nghĩa kiểu "Cho mượn một phần → Cho mượn một phần" */}
                      {h.old_status && h.new_status && h.old_status !== h.new_status ? ` · ${statusLabel(h.old_status)} → ${statusLabel(h.new_status)}` : ''}
                      {/* Note của dòng: JSON mượn/trả/chuyển đổi được dịch thành
                          "người · SL n · phụ"; note thường (tự đóng lượt, tách
                          món…) hiện nguyên văn. Note trùng hệt nhãn hành động
                          (dòng cũ của chuyển đổi bố thí không ghi người nhận)
                          thì bỏ qua để không lặp "Đã bố thí · … · Đã bố thí" */}
                      {noteText && noteText !== actionLabel ? ` · ${noteText}` : ''}
                    </Text>
                    <Text style={{ fontSize: 12, color: Colors.subtext }}>{formatDate(h.created_at)}</Text>
                  </View>
                </View>
                );
              })}
            </View>
          </View>
          </ScrollView>
        </View>
      )}

      <LocationPickerModal
        visible={showMovePicker}
        locations={locations}
        title={t('detail.move')}
        onClose={() => setShowMovePicker(false)}
        allowCreate
        onSelect={async (loc) => { await moveItem(item.id, loc.id); bump(); load(); }}
      />

      <AddTermModal
        visible={showAddStatus}
        kind="STATUS"
        onClose={() => setShowAddStatus(false)}
        onAdded={() => { loadTaxonomy(); }}
      />

      <Modal visible={showLend} transparent animationType="fade" onRequestClose={() => setShowLend(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.card, styles.modalCard, { gap: 12 }]}>
            <Text style={{ fontSize: 18, fontWeight: '800', color: Colors.text }}>{t('detail.lendTitle', { name: item.name })}</Text>
            <TextInput style={styles.input} placeholder={t('detail.borrowerPh')} value={borrower} onChangeText={setBorrower} autoFocus />
            <TextInput style={styles.input} placeholder={t('detail.phonePh')} keyboardType="phone-pad" value={borrowerPhone} onChangeText={setBorrowerPhone} />
            <TextInput style={styles.input} placeholder={t('detail.qtyPh', { n: available })} keyboardType="number-pad" value={lendQty} onChangeText={setLendQty} />
            <DateField value={expectedDate} onChangeText={setExpectedDate} placeholder={t('detail.duePh')} title={t('detail.duePh')} />
            <TextInput style={styles.input} placeholder={t('detail.lendNotePh')} value={lendNote} onChangeText={setLendNote} />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <AppButton title={t('common.cancel')} variant="secondary" onPress={() => setShowLend(false)} style={{ flex: 1 }} />
              <AppButton title={t('lend.title')} onPress={handleLend} style={{ flex: 1 }} />
            </View>
          </View>
        </View>
      </Modal>

      <ExtendLoanModal
        visible={!!extendLoan}
        borrowerName={extendLoan?.borrower_name ?? ''}
        currentDue={extendLoan?.expected_return_date ?? null}
        onClose={() => setExtendLoan(null)}
        onConfirm={(newIso) => { handleExtendConfirm(newIso).catch(() => {}); }}
      />

      <StatusNoteModal
        key={noteTarget ?? 'closed'}
        target={noteTarget}
        itemName={item.name}
        warnText={
          // Cảnh báo tự đóng record chỉ còn cần ở trường hợp KHÔNG còn gì
          // ở nhà (available = 0): hộp thoại không có stepper, xác nhận đi
          // đường setItemStatus kết thúc toàn bộ → tầng dữ liệu tự đóng
          // record. Khi còn phần ở nhà, thao tác áp số lượng (giảm kho /
          // tách món) không bao giờ đụng tới record đang mở. DAMAGED và
          // trạng thái tự tạo không bao giờ đóng.
          noteTarget && ['GIFTED', 'DONATED', 'DISPOSED', 'LOST', 'USED_UP', 'EXPIRED'].includes(noteTarget) && openRecords.length > 0 && available <= 0
            ? t('loan.autoCloseWarn', { n: openRecords.length })
            : null
        }
        qtyAvailable={available}
        unit={item.unit}
        onClose={() => setNoteTarget(null)}
        onConfirm={handleStatusNoteConfirm}
      />

      <Modal visible={showSell} transparent animationType="fade" onRequestClose={() => setShowSell(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.card, styles.modalCard, { gap: 12 }]}>
            <Text style={{ fontSize: 18, fontWeight: '800', color: Colors.text }}>{t('detail.sellTitle', { name: item.name })}</Text>
            {available > 0 && (
              <Field label={t('qty.applyQtyLabel')}>
                <QtyStepper value={sellQty} max={available} unit={item.unit} onChange={setSellQty} />
              </Field>
            )}
            {available > 0 && sellQty === available && (
              <AllQtyWarnLine text={t('qty.allWarn', { n: available })} />
            )}
            <TextInput style={styles.input} placeholder={t('detail.sellBuyerPh')} value={sellBuyer} onChangeText={setSellBuyer} />
            <TextInput style={styles.input} placeholder={t('detail.sellPricePh')} keyboardType="number-pad" value={sellPrice} onChangeText={setSellPrice} />
            {/* Bán chỉ còn là thao tác kết thúc toàn bộ khi không còn gì ở
                nhà — lúc đó record đang mở mới bị tự đóng, cảnh báo cam hiện */}
            {openRecords.length > 0 && available <= 0 && (
              <AutoCloseWarnLine text={t('loan.autoCloseWarn', { n: openRecords.length })} />
            )}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <AppButton title={t('common.cancel')} variant="secondary" onPress={() => setShowSell(false)} style={{ flex: 1 }} />
              <AppButton
                title={t('detail.soldBtn')}
                onPress={() => { handleSellConfirm().catch(() => {}); }}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
      </Modal>

      <ReturnQtyModal
        visible={!!returnTarget}
        itemName={item.name}
        borrowerName={returnTarget?.borrower_name ?? ''}
        outstanding={returnTarget ? outstandingOf(returnTarget) : 0}
        unit={item.unit}
        onClose={() => setReturnTarget(null)}
        onConfirm={(qty, note) => { handleReturnConfirm(qty, note).catch(() => {}); }}
      />

      <LoanConvertModal
        visible={!!convertTarget}
        itemName={item.name}
        borrowerName={convertTarget?.loan.borrower_name ?? ''}
        outstanding={convertTarget ? outstandingOf(convertTarget.loan) : 0}
        unit={item.unit}
        initialType={convertTarget?.type ?? 'GIFTED'}
        onClose={() => setConvertTarget(null)}
        onConvert={(payload) => { handleConvertConfirm(payload).catch(() => {}); }}
      />

      <ConsignResolveModal
        visible={!!resolveTarget}
        mode={resolveTarget?.mode ?? 'SOLD'}
        itemName={item.name}
        holderName={resolveTarget?.rec.borrower_name ?? ''}
        outstanding={resolveTarget ? outstandingOf(resolveTarget.rec) : 0}
        unit={item.unit}
        expectedPrice={resolveTarget?.rec.expected_price ?? null}
        onClose={() => setResolveTarget(null)}
        onConfirm={(payload) => { handleResolveConfirm(payload).catch(() => {}); }}
      />

      {/* "Đã xử lý" cho món quá hạn dùng: 3 kết cục dạng lựa chọn có icon +
          màu theo trạng thái đích, cảnh báo tự đóng record nằm trong popup */}
      <AppPopup
        visible={showHandlePopup}
        title={t('alerts.actHandle')}
        message={item.name}
        notice={openRecords.length > 0 ? t('loan.autoCloseWarn', { n: openRecords.length }) : null}
        options={[
          { label: t('alerts.actSell'), icon: statusIcon('SOLD'), color: statusColorFor('SOLD'), onPress: openSell },
          { label: t('alerts.actUsedUp'), icon: statusIcon('USED_UP'), color: statusColorFor('USED_UP'), onPress: () => setNoteTarget('USED_UP') },
          { label: t('alerts.actExpired'), icon: statusIcon('EXPIRED'), color: statusColorFor('EXPIRED'), onPress: () => setNoteTarget('EXPIRED') },
          { label: t('alerts.actDiscard'), icon: statusIcon('DISPOSED'), color: Colors.danger, onPress: () => setNoteTarget('DISPOSED') },
        ]}
        onClose={() => setShowHandlePopup(false)}
      />

      <AppPopup
        visible={showDeletePopup}
        title={t('detail.deleteTitle')}
        message={t('detail.deleteMsg')}
        notice={openRecords.length > 0 ? t('loan.autoCloseWarn', { n: openRecords.length }) : null}
        confirm={{ label: t('detail.deleteBtn'), danger: true, onConfirm: () => { handleDeleteConfirm().catch(() => {}); } }}
        onClose={() => setShowDeletePopup(false)}
      />

      <SnoozePopup
        visible={!!snoozePopup}
        onClose={() => setSnoozePopup(null)}
        onConfirm={(days) => { handleSnoozePick(days).catch(() => {}); }}
        onNever={() => { handleSnoozeNever().catch(() => {}); }}
      />

      <AppPopup
        visible={!!infoPopup}
        title={infoPopup?.title ?? ''}
        message={infoPopup?.message}
        okLabel={t('common.gotIt')}
        onClose={() => setInfoPopup(null)}
      />
    </ScrollView>
  );
}
