import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Switch, Modal, Pressable, TextInput, Linking } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { styles, Colors, IconTile, ScreenHeader, SectionTitle, AppButton, AppPopup, TAB_BAR_CLEARANCE, type AppPopupOption } from '@/components/ui';
import type { Item } from '@/types';
import {
  countActiveItems, countLocations, listItems, listDeletedItems, restoreItem, getBreadcrumb, breadcrumbText,
} from '@/db/queries';
import { ftsAvailable, kvGet, kvSet } from '@/db/client';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import { rescheduleAllReminders } from '@/services/notificationService';
import { getLimits, getPlanSync, loadPlan, setSimPro, type PlanId } from '@/services/planService';
import { redeemPromoCode } from '@/services/promoService';
import {
  getLockConfig, hasPin as lockHasPin, isBiometricAvailable, setLockConfig, setPin, verifyPin,
  LOCK_TIMEOUT_CHOICES, type LockConfig,
} from '@/services/appLockService';
import { getAlertSettings, setAlertSetting, type AlertSettings } from '@/services/alertSettings';
import { seedDemoData, clearDemoData } from '@/services/demoData';
import { exportBackup, importBackup, BackupError } from '@/services/backupService';
import { isDriveConfigured } from '@/config';
import {
  checkDriveBackupMissing, connectDrive, createDriveBackup, disconnectDrive, DriveError,
  getDriveConnectionInfo, hasDriveMasterKey, listDriveBackups, restoreFromDrive,
  setupDriveMasterKey, type DriveBackupFile,
} from '@/services/driveService';
import { getRemoteFlagsSync, loadRemoteConfig } from '@/services/remoteConfigService';
import { categoryLabel, statusLabel, tint } from '@/theme';
import { SCHEMA_VERSION } from '@/db/schema';

/** Segmented chọn số ngày (dùng cho 2 ngưỡng cảnh báo) */
function DaySegmented({
  value, options, onPick, labelFor,
}: {
  value: number;
  options: number[];
  onPick: (n: number) => void;
  labelFor: (n: number) => string;
}) {
  return (
    <View style={{ flexDirection: 'row', backgroundColor: Colors.chipBg, borderRadius: 12, padding: 4, gap: 4 }}>
      {options.map((n) => {
        const selected = value === n;
        return (
          <TouchableOpacity
            key={n}
            onPress={() => onPick(n)}
            activeOpacity={0.8}
            style={{
              flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, borderRadius: 9,
              backgroundColor: selected ? Colors.primary : 'transparent',
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: '700', color: selected ? '#fff' : Colors.subtext }}>{labelFor(n)}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

/**
 * Ô nhập bí mật (PIN / mật khẩu) kèm nút MẮT hiện–ẩn nội dung. Một công tắc
 * `visible` dùng chung cho mọi ô trong cùng modal để người dùng đối chiếu
 * các ô nhập lại ngay trên một màn hình.
 */
function SecretField({
  label, value, onChangeText, visible, onToggleVisible, toggleLabel, numeric, autoFocus,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  visible: boolean;
  onToggleVisible: () => void;
  toggleLabel: string;
  numeric?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <>
      <Text style={[styles.label, { marginTop: 10 }]}>{label}</Text>
      <View>
        <TextInput
          style={[styles.input, { paddingRight: 54 }]}
          value={value}
          onChangeText={numeric ? (v) => onChangeText(v.replace(/[^\d]/g, '').slice(0, 6)) : onChangeText}
          secureTextEntry={!visible}
          keyboardType={numeric ? 'number-pad' : 'default'}
          maxLength={numeric ? 6 : undefined}
          autoFocus={autoFocus}
          placeholder="••••••"
          placeholderTextColor={Colors.subtext}
        />
        <TouchableOpacity
          style={{ position: 'absolute', right: 4, top: 0, height: 52, width: 46, alignItems: 'center', justifyContent: 'center' }}
          onPress={onToggleVisible}
          hitSlop={6}
          accessibilityLabel={toggleLabel}
        >
          <Ionicons name={visible ? 'eye-off-outline' : 'eye-outline'} size={21} color={Colors.subtext} />
        </TouchableOpacity>
      </View>
    </>
  );
}

/** Khối cảnh báo hổ phách: nhắc lưu kỹ mật khẩu (quên = mất bản sao lưu) */
function PasswordWarnBox({ text }: { text: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8, backgroundColor: tint(Colors.orange, '26'), borderRadius: 12, padding: 10, marginTop: 10 }}>
      <Ionicons name="alert-circle-outline" size={19} color={Colors.orange} />
      <Text style={{ flex: 1, fontSize: 12.5, lineHeight: 18, color: Colors.text }}>{text}</Text>
    </View>
  );
}

/**
 * Nút "Kết nối Google Drive": gọi connectDrive() của driveService — đăng
 * nhập NATIVE qua Google Play Services (hộp thoại chọn tài khoản của hệ
 * thống, không mở trình duyệt). Người dùng huỷ chọn tài khoản thì im lặng
 * (không popup lỗi); lỗi thật (thiếu Play Services, lỗi native) mới báo
 * qua onError để màn hình map sang thông điệp i18n.
 */
/**
 * Nhường 1 nhịp render (~50ms) để trạng thái bận của nút xác nhận kịp vẽ
 * lên màn hình TRƯỚC khi chạy tác vụ mã hoá — người dùng thấy phản hồi
 * ngay khi bấm, không có cảm giác app "đứng hình" lúc xử lý mật khẩu.
 */
function yieldUiTick(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 50); });
}

function DriveConnectButton({ onConnected, onError }: { onConnected: () => void; onError: (e: unknown) => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);

  async function handleConnect() {
    setBusy(true);
    try {
      const res = await connectDrive();
      if (res.status === 'cancelled') return;
      onConnected();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppButton
      title={t('drive.connectBtn')}
      variant="secondary"
      icon="logo-google"
      loading={busy}
      disabled={busy}
      onPress={() => { handleConnect().catch(() => {}); }}
    />
  );
}

export default function SettingsScreen() {
  const { t } = useT();
  const langMode = useAppStore((s) => s.langMode);
  const setLangMode = useAppStore((s) => s.setLangMode);
  const [activeCount, setActiveCount] = useState(0);
  const [locCount, setLocCount] = useState(0);
  const [trash, setTrash] = useState<Item[]>([]);
  const [exporting, setExporting] = useState(false);
  const [demoExists, setDemoExists] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [showClearDemoPopup, setShowClearDemoPopup] = useState(false);
  // Popup thông báo/lỗi dùng chung (1 nút "Đã hiểu") thay hộp thoại hệ thống
  const [infoPopup, setInfoPopup] = useState<{ title: string; message?: string } | null>(null);
  const showInfo = (title: string, message?: string) => setInfoPopup({ title, message });
  const [alertCfgState, setAlertCfgState] = useState<AlertSettings | null>(null);
  // Sao lưu & khôi phục (Phase 5 lõi): mật khẩu chỉ sống trong state tạm,
  // xoá ngay sau khi dùng — KHÔNG lưu vào DB/kv/file
  const [backupBusy, setBackupBusy] = useState(false);
  const [pwModal, setPwModal] = useState<{ mode: 'export' | 'import' } | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwValue, setPwValue] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwShow, setPwShow] = useState(false);
  const [pendingImportUri, setPendingImportUri] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<{ uri: string; password: string } | null>(null);
  const [showOverwriteConfirm, setShowOverwriteConfirm] = useState(false);
  // Gói hiện tại (Phase 6 — khung Pro): đọc qua planService, đổi qua cờ giả lập
  const [planId, setPlanId] = useState<PlanId>('FREE');
  // Mã khuyến mãi tự quản của chủ app: mã chỉ sống trong state tạm của modal;
  // kiểm tra + cấp quyền qua promoService (seam — TODO backend/RevenueCat ở đó)
  const [promoOpen, setPromoOpen] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const [promoBusy, setPromoBusy] = useState(false);
  const [promoError, setPromoError] = useState<string | null>(null);
  // Công tắc cấu hình từ xa cho ô nhập mã tự quản (remoteConfigService):
  // tắt → ẩn hẳn điểm nhập mã, promoService cũng từ chối đổi mã ở service
  const [selfPromoEnabled, setSelfPromoEnabled] = useState(true);
  // Cảnh báo mất sao lưu Drive (Mảng 8): phát hiện bởi checkDriveBackupMissing
  // trong driveService — mỗi lần mất chỉ hiện đúng 1 lần
  const [driveMissingWarn, setDriveMissingWarn] = useState(false);
  // Bảo mật / khoá app (Phase 6): cấu hình ở app_kv, PIN ở SecureStore.
  // Modal PIN là form MỘT màn hình: các ô (cũ/mới/nhập lại) hiện cùng lúc,
  // có nút mắt hiện mã và lỗi kiểm tra hiện tại chỗ dưới các ô.
  const [lockCfg, setLockCfg] = useState<LockConfig | null>(null);
  const [pinExists, setPinExists] = useState(false);
  const [bioAvail, setBioAvail] = useState(false);
  const [pinModal, setPinModal] = useState<{ mode: 'setup' | 'change' | 'disable' } | null>(null);
  const [pinOld, setPinOld] = useState('');
  const [pinNew, setPinNew] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinShow, setPinShow] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  // Google Drive của khách (BYOC): phiên đăng nhập do SDK Google Sign-In
  // giữ, khoá chính ở SecureStore — đều qua driveService; state ở đây chỉ
  // là bản chụp để render + trạng thái thao tác
  const driveConfigured = isDriveConfigured();
  const [driveEmail, setDriveEmail] = useState<string | null>(null);
  const [driveConnectedState, setDriveConnectedState] = useState(false);
  const [driveHasKey, setDriveHasKey] = useState(false);
  const [driveLastAt, setDriveLastAt] = useState<string | null>(null);
  const [driveLastStatus, setDriveLastStatus] = useState<string | null>(null);
  const [driveAuto, setDriveAuto] = useState(false);
  const [driveBusy, setDriveBusy] = useState(false);
  const [drivePwModal, setDrivePwModal] = useState<{ mode: 'setup' | 'unlock'; fileId?: string } | null>(null);
  const [drivePwBusy, setDrivePwBusy] = useState(false);
  const [drivePw, setDrivePw] = useState('');
  const [drivePwConfirm, setDrivePwConfirm] = useState('');
  const [drivePwShow, setDrivePwShow] = useState(false);
  const [drivePwError, setDrivePwError] = useState<string | null>(null);
  const [driveRestoreList, setDriveRestoreList] = useState<DriveBackupFile[] | null>(null);
  const [pendingDriveRestore, setPendingDriveRestore] = useState<DriveBackupFile | null>(null);
  const refreshTick = useAppStore((s) => s.refreshTick);
  const bump = useAppStore((s) => s.bump);

  const load = useCallback(async () => {
    setActiveCount(await countActiveItems());
    setLocCount(await countLocations());
    setTrash(await listDeletedItems());
    setDemoExists(!!(await kvGet('demo_seed_ids')));
    setAlertCfgState(await getAlertSettings());
    await loadPlan();
    setPlanId(getPlanSync());
    setLockCfg(await getLockConfig());
    setPinExists(await lockHasPin());
    setBioAvail(await isBiometricAvailable());
    const conn = await getDriveConnectionInfo();
    setDriveConnectedState(conn.connected);
    setDriveEmail(conn.email);
    setDriveHasKey(await hasDriveMasterKey());
    setDriveLastAt(await kvGet('drive_last_at'));
    setDriveLastStatus(await kvGet('drive_last_status'));
    setDriveAuto((await kvGet('drive_auto')) === '1');
    await loadRemoteConfig().catch(() => {});
    setSelfPromoEnabled(getRemoteFlagsSync().selfPromoEnabled);
    // Phát hiện sao lưu Drive bị mất (Mảng 8): chỉ khi đang kết nối; hàm
    // tự chống nhắc lại (1 lần/lần mất) và không bao giờ đụng dữ liệu máy
    if (conn.connected) {
      const missing = await checkDriveBackupMissing().catch(() => false);
      if (missing) setDriveMissingWarn(true);
    }
  }, []);

  /** Đổi một tuỳ chọn cảnh báo: lưu alert_cfg + đặt lại lịch nhắc + báo các màn khác tải lại */
  async function changeAlert<K extends keyof AlertSettings>(key: K, value: AlertSettings[K]) {
    const next = await setAlertSetting(key, value);
    setAlertCfgState(next);
    rescheduleAllReminders().catch(() => {});
    bump();
  }

  /** Bật/tắt giả lập Pro: ghi cờ qua planService rồi bump để toàn app áp lại giới hạn + cổng */
  async function handleSimToggle(enabled: boolean) {
    const next = await setSimPro(enabled);
    setPlanId(next);
    bump();
  }

  /** Mở modal nhập mã khuyến mãi: xoá trắng ô + lỗi mỗi lần mở */
  function openPromoModal() {
    setPromoCode('');
    setPromoError(null);
    setPromoBusy(false);
    setPromoOpen(true);
  }

  /**
   * Áp dụng mã khuyến mãi: lỗi phân loại của promoService hiện TẠI CHỖ trong
   * modal (không đóng modal); thành công thì đóng modal, làm mới hiển thị
   * gói ngay (planService đã cấp qua cùng cơ chế gói) và báo quyền lợi đã nhận.
   */
  async function handlePromoApply() {
    if (!promoCode.trim()) {
      setPromoError(t('promo.empty'));
      return;
    }
    setPromoBusy(true);
    setPromoError(null);
    try {
      const res = await redeemPromoCode(promoCode);
      if (res.status === 'success') {
        setPromoOpen(false);
        setPlanId(getPlanSync());
        bump();
        showInfo(t('promo.successTitle'), t('promo.successMsg'));
      } else if (res.status === 'disabled') {
        setPromoError(t('promo.disabled'));
      } else if (res.status === 'not_found') {
        setPromoError(t('promo.notFound'));
      } else if (res.status === 'already_used') {
        setPromoError(t('promo.used'));
      } else {
        setPromoError(t('promo.expired'));
      }
    } finally {
      setPromoBusy(false);
    }
  }

  /** Mã Google Play do Google xử lý — app chỉ mở trang đổi mã chính thức */
  function openGooglePlayRedeem() {
    Linking.openURL('https://play.google.com/redeem').catch(() => {});
  }

  /** Công tắc khoá app: bật lần đầu phải đặt PIN trước; tắt phải xác nhận bằng PIN hiện tại */
  async function handleToggleLock(enabled: boolean) {
    if (enabled) {
      if (!pinExists) {
        openPinModal('setup');
        return;
      }
      setLockCfg(await setLockConfig({ lockEnabled: true }));
      return;
    }
    openPinModal('disable');
  }

  /** Mở modal PIN một màn hình: xoá trắng các ô + lỗi, ẩn mã mặc định */
  function openPinModal(mode: 'setup' | 'change' | 'disable') {
    setPinOld('');
    setPinNew('');
    setPinConfirm('');
    setPinShow(false);
    setPinError(null);
    setPinModal({ mode });
  }

  function pinModalTitle(): string {
    if (!pinModal) return '';
    if (pinModal.mode === 'setup') return t('lock.setupTitle');
    if (pinModal.mode === 'change') return t('settings.changePin');
    return t('settings.lockApp');
  }

  /**
   * Kiểm tra form PIN ngay trong modal (lỗi hiện tại chỗ, không đóng modal):
   * setup = mới + nhập lại; change = cũ + mới + nhập lại; disable = cũ.
   * Chỉ khi mọi ô hợp lệ mới thực thi (đặt/đổi/tắt) và đóng modal.
   */
  async function handlePinSubmit() {
    if (!pinModal) return;
    const { mode } = pinModal;
    if (mode === 'change' || mode === 'disable') {
      const ok = await verifyPin(pinOld);
      if (!ok) {
        setPinError(t('lock.wrongPin'));
        return;
      }
    }
    if (mode === 'disable') {
      setLockCfg(await setLockConfig({ lockEnabled: false }));
      setPinModal(null);
      showInfo(t('settings.securityTitle'), t('lock.disabled'));
      return;
    }
    if (!/^\d{4,6}$/.test(pinNew)) {
      setPinError(t('lock.pinInvalid'));
      return;
    }
    if (pinConfirm !== pinNew) {
      setPinError(t('lock.pinMismatch'));
      return;
    }
    const value = pinNew;
    setPinModal(null);
    await setPin(value);
    setPinExists(true);
    if (mode === 'setup') {
      // Bật khoá + mặc định cho dùng sinh trắc khi thiết bị hỗ trợ
      setLockCfg(await setLockConfig({ lockEnabled: true, biometricEnabled: bioAvail }));
      showInfo(t('settings.securityTitle'), t('lock.pinSet'));
    } else {
      showInfo(t('settings.securityTitle'), t('lock.pinChanged'));
    }
  }

  async function handleSeedDemo() {
    setDemoBusy(true);
    try {
      const res = await seedDemoData();
      if (res.skipped) {
        showInfo(t('settings.demoTitle'), t('settings.demoExists'));
      } else {
        showInfo(t('settings.demoTitle'), t('settings.demoCreated', { items: res.items, locations: res.locations }));
      }
      setDemoExists(!!(await kvGet('demo_seed_ids')));
      bump();
    } catch (e) {
      showInfo(t('settings.demoTitle'), e instanceof Error ? e.message : String(e));
    } finally {
      setDemoBusy(false);
    }
  }

  /** Xác nhận ở AppPopup xoá dữ liệu mẫu: chỉ xoá đúng các id đã seed, không đụng đồ thật */
  async function handleClearDemoConfirm() {
    setDemoBusy(true);
    try {
      await clearDemoData();
      setDemoExists(false);
      bump();
      showInfo(t('settings.demoTitle'), t('settings.demoDeleted'));
    } catch (e) {
      showInfo(t('settings.demoTitle'), e instanceof Error ? e.message : String(e));
    } finally {
      setDemoBusy(false);
    }
  }

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load, refreshTick]),
  );

  /** Mở modal mật khẩu sao lưu (tạo mới hoặc nhập để khôi phục) */
  function openPwModal(mode: 'export' | 'import') {
    setPwValue('');
    setPwConfirm('');
    setPwShow(false);
    setPwModal({ mode });
  }

  /** Xác nhận mật khẩu ở modal → tạo file .ssbak mã hoá và mở chia sẻ */
  async function handleExportSubmit() {
    if (pwValue.length < 6) {
      showInfo(t('backup.title'), t('backup.pwTooShort'));
      return;
    }
    if (pwValue !== pwConfirm) {
      showInfo(t('backup.title'), t('backup.pwMismatch'));
      return;
    }
    const pw = pwValue;
    // Nút xác nhận chuyển trạng thái bận + nhường 1 nhịp render rồi mới
    // đóng modal và chạy tác vụ mã hoá (exportBackup) ở dưới
    setPwBusy(true);
    await yieldUiTick();
    setPwBusy(false);
    setPwModal(null);
    setPwValue('');
    setPwConfirm('');
    setBackupBusy(true);
    try {
      const res = await exportBackup(pw);
      if (res.shared) {
        showInfo(t('backup.doneTitle'), t('backup.exportDone'));
      } else {
        showInfo(t('set.fileCreated'), res.path);
      }
    } catch (e) {
      showInfo(t('backup.title'), e instanceof Error ? e.message : String(e));
    } finally {
      setBackupBusy(false);
    }
  }

  /** Chọn file .ssbak từ máy → mở modal nhập mật khẩu */
  async function handlePickImportFile() {
    const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
    if (result.canceled || !result.assets?.[0]) return;
    setPendingImportUri(result.assets[0].uri);
    openPwModal('import');
  }

  /** Có mật khẩu + file → chuyển sang AppPopup xác nhận ghi đè (danger) */
  async function handleImportPwSubmit() {
    if (!pendingImportUri) return;
    if (!pwValue) {
      showInfo(t('backup.title'), t('backup.pwEmpty'));
      return;
    }
    const pending = { uri: pendingImportUri, password: pwValue };
    // Phản hồi bận ngay trên nút xác nhận trước khi chuyển bước
    setPwBusy(true);
    await yieldUiTick();
    setPwBusy(false);
    setPendingImport(pending);
    setPwModal(null);
    setPwValue('');
    setShowOverwriteConfirm(true);
  }

  /** Sau xác nhận ghi đè: khôi phục toàn bộ, đặt lại lịch nhắc, tải lại màn */
  async function handleImportConfirm() {
    if (!pendingImport) return;
    setBackupBusy(true);
    // Để popup đóng + trạng thái bận kịp vẽ trước khi giải mã (importBackup)
    await yieldUiTick();
    try {
      await importBackup(pendingImport.uri, pendingImport.password);
      rescheduleAllReminders().catch(() => {});
      bump();
      await load();
      showInfo(t('backup.doneTitle'), t('backup.restoreDone'));
    } catch (e) {
      if (e instanceof BackupError && e.code === 'WRONG_PASSWORD') {
        showInfo(t('backup.title'), t('backup.wrongPw'));
      } else if (e instanceof BackupError) {
        showInfo(t('backup.title'), t('backup.invalidFile'));
      } else {
        showInfo(t('backup.title'), e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBackupBusy(false);
      setPendingImport(null);
      setPendingImportUri(null);
    }
  }

  /* ---------------- Google Drive của khách (BYOC) ---------------- */

  /** Bản đồ mã lỗi DriveError → thông điệp hiển thị cho người dùng */
  function driveErrorMessage(e: unknown): string {
    if (e instanceof BackupError && e.code === 'WRONG_PASSWORD') return t('backup.wrongPw');
    if (e instanceof BackupError) return t('backup.invalidFile');
    if (e instanceof DriveError) {
      if (e.code === 'NOT_CONNECTED') return t('drive.notConnectedErr');
      if (e.code === 'NO_MASTER_KEY') return t('drive.noKeyErr');
      if (e.code === 'AUTH') return t('drive.authErr');
      if (e.code === 'PLAY_SERVICES') return t('drive.playServicesErr');
      if (e.code === 'NOT_CONFIGURED') return t('drive.notConfigured');
    }
    return e instanceof Error ? e.message : String(e);
  }

  /** Sao lưu ngay lên Drive: mã hoá v2 bằng khoá chính rồi tải lên + xoay vòng 5 bản */
  async function handleDriveBackupNow() {
    setDriveBusy(true);
    try {
      const res = await createDriveBackup();
      setDriveLastAt(await kvGet('drive_last_at'));
      setDriveLastStatus('ok');
      showInfo(t('backup.doneTitle'), t('drive.backupDone', { name: res.name }));
    } catch (e) {
      setDriveLastStatus(await kvGet('drive_last_status'));
      showInfo(t('drive.title'), driveErrorMessage(e));
    } finally {
      setDriveBusy(false);
    }
  }

  /** Mở danh sách các bản sao lưu trên Drive để chọn khôi phục */
  async function handleDriveRestoreOpen() {
    setDriveBusy(true);
    try {
      const files = await listDriveBackups();
      if (files.length === 0) {
        showInfo(t('drive.title'), t('drive.noBackups'));
        return;
      }
      setDriveRestoreList(files);
    } catch (e) {
      showInfo(t('drive.title'), driveErrorMessage(e));
    } finally {
      setDriveBusy(false);
    }
  }

  /** Thử khôi phục 1 bản Drive; thiếu mật khẩu (máy mới) → mở modal xin mật khẩu */
  async function attemptDriveRestore(fileId: string, password?: string) {
    setDriveBusy(true);
    try {
      await restoreFromDrive(fileId, password);
      rescheduleAllReminders().catch(() => {});
      bump();
      await load();
      showInfo(t('backup.doneTitle'), t('backup.restoreDone'));
    } catch (e) {
      if (e instanceof DriveError && e.code === 'PASSWORD_REQUIRED') {
        setDrivePw('');
        setDrivePwError(null);
        setDrivePwShow(false);
        setDrivePwModal({ mode: 'unlock', fileId });
        return;
      }
      showInfo(t('drive.title'), driveErrorMessage(e));
    } finally {
      setDriveBusy(false);
    }
  }

  /** Nút trong modal mật khẩu Drive: đặt mật khẩu lần đầu HOẶC mở khoá khôi phục */
  async function handleDrivePwSubmit() {
    if (!drivePwModal) return;
    if (drivePwModal.mode === 'setup') {
      if (drivePw.length < 6) {
        setDrivePwError(t('backup.pwTooShort'));
        return;
      }
      if (drivePw !== drivePwConfirm) {
        setDrivePwError(t('backup.pwMismatch'));
        return;
      }
      const pw = drivePw;
      // Nút xác nhận báo bận + nhường 1 nhịp render trước khi chạy mã hoá khoá
      setDrivePwBusy(true);
      await yieldUiTick();
      setDrivePwBusy(false);
      setDrivePwModal(null);
      setDrivePw('');
      setDrivePwConfirm('');
      setDriveBusy(true);
      try {
        await setupDriveMasterKey(pw);
        setDriveHasKey(true);
        showInfo(t('drive.title'), t('drive.keySet'));
      } catch (e) {
        showInfo(t('drive.title'), driveErrorMessage(e));
      } finally {
        setDriveBusy(false);
      }
      return;
    }
    // mode 'unlock': mật khẩu mở khoá chính của bản sao lưu trên máy mới
    const fileId = drivePwModal.fileId;
    const pw = drivePw;
    if (!pw) {
      setDrivePwError(t('backup.pwEmpty'));
      return;
    }
    setDrivePwBusy(true);
    await yieldUiTick();
    setDrivePwBusy(false);
    setDrivePwModal(null);
    setDrivePw('');
    if (fileId) await attemptDriveRestore(fileId, pw);
  }

  /** Ngắt kết nối Drive: SDK thu hồi quyền + đăng xuất — khoá chính giữ lại (xem driveService) */
  async function handleDriveDisconnect() {
    await disconnectDrive();
    setDriveConnectedState(false);
    setDriveEmail(null);
    showInfo(t('drive.title'), t('drive.disconnected'));
  }

  /** Công tắc tự động sao lưu Drive: ghi cờ app_kv drive_auto */
  async function handleDriveAutoToggle(enabled: boolean) {
    setDriveAuto(enabled);
    try {
      await kvSet('drive_auto', enabled ? '1' : '0');
    } catch {
      // best-effort: state trên màn vẫn phản ánh lựa chọn trong phiên này
    }
  }

  async function handleExportCsv() {
    setExporting(true);
    try {
      const items = await listItems();
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [t('set.csvHeader')];
      for (const i of items) {
        const chain = await getBreadcrumb(i.location_id);
        lines.push([i.name, categoryLabel(i.category), statusLabel(i.status), breadcrumbText(chain), i.position_note ?? '', i.quantity, i.purchase_price ?? '', i.expiry_date ?? ''].map(esc).join(','));
      }
      const path = (FileSystem.cacheDirectory ?? '') + 'smartstash-export.csv';
      await FileSystem.writeAsStringAsync(path, '\uFEFF' + lines.join('\n'), { encoding: FileSystem.EncodingType.UTF8 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(path, { mimeType: 'text/csv', dialogTitle: t('set.exportDialog') });
      } else {
        showInfo(t('set.fileCreated'), path);
      }
    } catch (e) {
      showInfo(t('set.exportFail'), e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <ScrollView style={[styles.screen, { paddingTop: 54 }]} contentContainerStyle={[styles.content, { paddingBottom: TAB_BAR_CLEARANCE }]}>
      <ScreenHeader title={t('set.title')} subtitle={t('set.subtitle')} icon="settings" color={Colors.primary} />

      {/* Thẻ gói SmartStash (Phase 6 — khung Pro): gói hiện tại + quyền lợi + giả lập kiểm tra */}
      <View
        style={{
          backgroundColor: Colors.deep, borderRadius: 24, padding: 18, gap: 8, overflow: 'hidden',
          shadowColor: Colors.deep, shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.3, shadowRadius: 20, elevation: 8,
        }}
      >
        <View pointerEvents="none" style={{ position: 'absolute', width: 150, height: 150, borderRadius: 75, backgroundColor: Colors.coral, opacity: 0.3, top: -75, right: -40 }} />
        <View pointerEvents="none" style={{ position: 'absolute', width: 100, height: 100, borderRadius: 50, backgroundColor: Colors.teal, opacity: 0.28, bottom: -55, left: -25 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
          <View style={{ width: 46, height: 46, borderRadius: 16, backgroundColor: Colors.coral, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="gift" size={23} color="#fff" />
          </View>
          <Text style={{ fontSize: 17, fontWeight: '800', color: '#fff' }}>
            {planId === 'PRO' ? t('plan.namePro') : t('set.planName')}
          </Text>
        </View>
        <Text style={{ color: Colors.onDarkMuted, fontSize: 13, lineHeight: 19 }}>
          {(() => {
            const lim = getLimits(planId);
            const fmt = (n: number) => (n === Infinity ? t('plan.unlimited') : n);
            return t('set.planUsage', { a: activeCount, max1: fmt(lim.maxActiveItems), l: locCount, max2: fmt(lim.maxLocations), p: lim.maxItemPhotos });
          })()}
        </Text>
        <View style={{ gap: 5, marginTop: 2 }}>
          {(['plan.benefitQr', 'plan.benefitLimits', 'plan.benefitCloud'] as const).map((key) => (
            <View key={key} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="checkmark-circle" size={16} color={Colors.teal} />
              <Text style={{ flex: 1, color: '#fff', fontSize: 13, fontWeight: '600' }}>{t(key)}</Text>
            </View>
          ))}
        </View>
        {planId === 'FREE' && (
          <AppButton
            title={t('plan.upgradeBtn')}
            icon="rocket-outline"
            style={{ marginTop: 8, backgroundColor: Colors.coral, shadowColor: Colors.coral }}
            onPress={() => showInfo(t('plan.upgradeTitle'), t('plan.revenueCatSoon'))}
          />
        )}
        {/* Nhập mã khuyến mãi tự quản của chủ app (promoService) — điểm nối
            Premium dùng chung: thẻ gói này là bề mặt gói duy nhất của app.
            Công tắc cấu hình từ xa (remoteConfigService.selfPromoEnabled):
            TẮT → ẩn hẳn dòng nhập mã tự quản và thay bằng lối "Đổi mã
            Google Play" mở thẳng trang redeem của Google, để lối đổi mã
            Play (vốn chỉ nằm trong modal promo) vẫn tới được như cũ —
            đúng chốt chặn Mảng 3: bản chưa có máy chủ chỉ giữ lối Play */}
        {selfPromoEnabled ? (
          <TouchableOpacity
            onPress={openPromoModal}
            activeOpacity={0.8}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, paddingVertical: 2 }}
          >
            <Ionicons name="ticket-outline" size={17} color={Colors.teal} />
            <Text style={{ flex: 1, fontSize: 13.5, fontWeight: '700', color: '#fff' }}>{t('promo.haveCode')}</Text>
            <Ionicons name="chevron-forward" size={15} color={Colors.onDarkMuted} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            onPress={openGooglePlayRedeem}
            activeOpacity={0.8}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, paddingVertical: 2 }}
          >
            <Ionicons name="logo-google" size={17} color={Colors.teal} />
            <Text style={{ flex: 1, fontSize: 13.5, fontWeight: '700', color: '#fff' }}>{t('promo.playRow')}</Text>
            <Ionicons name="chevron-forward" size={15} color={Colors.onDarkMuted} />
          </TouchableOpacity>
        )}
        <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.16)', marginTop: 6 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff' }}>{t('plan.simToggle')}</Text>
            <Text style={{ fontSize: 12, color: Colors.onDarkMuted, marginTop: 1 }}>{t('plan.simNote')}</Text>
          </View>
          <Switch
            value={planId === 'PRO'}
            onValueChange={(v) => { handleSimToggle(v).catch(() => {}); }}
            trackColor={{ false: 'rgba(255,255,255,0.25)', true: Colors.coral }}
            thumbColor="#fff"
          />
        </View>
      </View>

      <View style={[styles.card, { gap: 7 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
          <IconTile icon="server" color={Colors.teal} size={46} iconSize={23} />
          <Text style={{ fontSize: 16, fontWeight: '800', color: Colors.text }}>{t('set.dataTitle')}</Text>
        </View>
        <Text style={{ color: Colors.subtext, fontSize: 13 }}>
          Schema v{SCHEMA_VERSION} · FTS5: {ftsAvailable ? t('set.ftsOn') : t('set.ftsOff')}
        </Text>
        <Text style={{ color: Colors.subtext, fontSize: 13 }}>
          {t('set.dataNote')}
        </Text>
      </View>


      {/* Ứng dụng: ngôn ngữ (segmented control) + đặt lại lịch nhắc, gộp 1 thẻ */}
      <View style={[styles.card, { gap: 12 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
          <IconTile icon="apps" color={Colors.sky} size={46} iconSize={23} />
          <Text style={{ fontSize: 16, fontWeight: '800', color: Colors.text }}>{t('set.app')}</Text>
        </View>
        <Text style={{ fontSize: 15, fontWeight: '700', color: Colors.text }}>{t('set.langTitle')}</Text>
        <View style={{ flexDirection: 'row', backgroundColor: Colors.chipBg, borderRadius: 12, padding: 4, gap: 4 }}>
          {(['auto', 'vi', 'en'] as const).map((mode) => {
            const selected = langMode === mode;
            return (
              <TouchableOpacity
                key={mode}
                onPress={async () => { await setLangMode(mode); rescheduleAllReminders().catch(() => {}); }}
                activeOpacity={0.8}
                style={{
                  flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, borderRadius: 9,
                  backgroundColor: selected ? Colors.primary : 'transparent',
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: '700', color: selected ? '#fff' : Colors.subtext }}>
                  {mode === 'auto' ? t('langMode.autoShort') : mode === 'vi' ? t('langMode.vi') : t('langMode.en')}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <View style={{ height: 1, backgroundColor: '#F0EDFA' }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <IconTile icon="notifications" color={Colors.orange} size={44} iconSize={22} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: Colors.text }}>{t('set.notifTitle')}</Text>
            <Text style={{ fontSize: 12, color: Colors.subtext, marginTop: 1 }}>{t('set.notifReschedule')}</Text>
          </View>
        </View>
        <AppButton
          title={t('set.notifReschedule')}
          variant="secondary"
          icon="notifications-outline"
          onPress={async () => { await rescheduleAllReminders(); showInfo(t('set.notifDoneTitle'), t('set.notifDoneMsg')); }}
        />
      </View>

      {/* Cảnh báo 4 mức: 2 ngưỡng ngày dạng segmented + công tắc thông báo theo loại */}
      <View style={[styles.card, { gap: 12 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
          <IconTile icon="notifications" color={Colors.red} size={46} iconSize={23} />
          <Text style={{ fontSize: 16, fontWeight: '800', color: Colors.text }}>{t('settings.alertsTitle')}</Text>
        </View>
        {alertCfgState && (
          <>
            <Text style={{ fontSize: 15, fontWeight: '700', color: Colors.text }}>{t('settings.alertSoonLabel')}</Text>
            <DaySegmented
              value={alertCfgState.soonDays}
              options={[3, 5, 7, 14]}
              labelFor={(n) => t('settings.alertDays', { n })}
              onPick={(n) => { changeAlert('soonDays', n).catch(() => {}); }}
            />
            <Text style={{ fontSize: 15, fontWeight: '700', color: Colors.text }}>{t('settings.alertWatchLabel')}</Text>
            <DaySegmented
              value={alertCfgState.watchDays}
              options={[14, 30, 60]}
              labelFor={(n) => t('settings.alertDays', { n })}
              onPick={(n) => { changeAlert('watchDays', n).catch(() => {}); }}
            />
            <View style={{ height: 1, backgroundColor: '#F0EDFA' }} />
            {([
              ['notifyExpiry', 'settings.alertNotifyExpiry'],
              ['notifyLoan', 'settings.alertNotifyLoan'],
              ['notifyWarranty', 'settings.alertNotifyWarranty'],
              ['loanRepeat', 'settings.alertLoanRepeat'],
              ['consignRemind', 'settings.alertConsignRemind'],
            ] as const).map(([key, labelKey], idx, arr) => (
              <View key={key}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Text style={{ flex: 1, fontSize: 14.5, fontWeight: '600', color: Colors.text }}>{t(labelKey)}</Text>
                  <Switch
                    value={alertCfgState[key]}
                    onValueChange={(v) => { changeAlert(key, v).catch(() => {}); }}
                    trackColor={{ false: Colors.chipBg, true: Colors.primary }}
                    thumbColor="#fff"
                  />
                </View>
                {idx < arr.length - 1 && <View style={{ height: 1, backgroundColor: '#F0EDFA', marginTop: 12 }} />}
              </View>
            ))}
          </>
        )}
      </View>

      {/* Bảo mật: khoá app bằng PIN + sinh trắc (Phase 6) */}
      <View style={[styles.card, { gap: 12 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
          <IconTile icon="lock-closed" color={Colors.primary} size={46} iconSize={23} />
          <Text style={{ fontSize: 16, fontWeight: '800', color: Colors.text }}>{t('settings.securityTitle')}</Text>
        </View>
        {lockCfg && (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14.5, fontWeight: '600', color: Colors.text }}>{t('settings.lockApp')}</Text>
                <Text style={{ fontSize: 12, color: Colors.subtext, marginTop: 1 }}>{t('settings.lockAppDesc')}</Text>
              </View>
              <Switch
                value={lockCfg.lockEnabled}
                onValueChange={(v) => { handleToggleLock(v).catch(() => {}); }}
                trackColor={{ false: Colors.chipBg, true: Colors.primary }}
                thumbColor="#fff"
              />
            </View>
            {lockCfg.lockEnabled && (
              <>
                <View style={{ height: 1, backgroundColor: '#F0EDFA' }} />
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
                  onPress={() => openPinModal('change')}
                  activeOpacity={0.7}
                >
                  <Text style={{ flex: 1, fontSize: 14.5, fontWeight: '600', color: Colors.text }}>{t('settings.changePin')}</Text>
                  <Ionicons name="chevron-forward" size={17} color={Colors.subtext} />
                </TouchableOpacity>
                {bioAvail && (
                  <>
                    <View style={{ height: 1, backgroundColor: '#F0EDFA' }} />
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <Text style={{ flex: 1, fontSize: 14.5, fontWeight: '600', color: Colors.text }}>{t('settings.biometric')}</Text>
                      <Switch
                        value={lockCfg.biometricEnabled}
                        onValueChange={async (v) => setLockCfg(await setLockConfig({ biometricEnabled: v }))}
                        trackColor={{ false: Colors.chipBg, true: Colors.primary }}
                        thumbColor="#fff"
                      />
                    </View>
                  </>
                )}
                <View style={{ height: 1, backgroundColor: '#F0EDFA' }} />
                <Text style={{ fontSize: 15, fontWeight: '700', color: Colors.text }}>{t('settings.lockTimeout')}</Text>
                <DaySegmented
                  value={lockCfg.lockTimeoutSec}
                  options={[...LOCK_TIMEOUT_CHOICES]}
                  labelFor={(n) => (n === 0 ? t('settings.timeoutNow') : n === 60 ? t('settings.timeout1m') : t('settings.timeout5m'))}
                  onPick={async (n) => setLockCfg(await setLockConfig({ lockTimeoutSec: n }))}
                />
                <Text style={{ fontSize: 12, color: Colors.subtext, lineHeight: 17 }}>{t('lock.forgotWarning')}</Text>
              </>
            )}
          </>
        )}
      </View>

      {/* Sao lưu & khôi phục bằng file mã hoá (Phase 5 lõi) */}
      <View style={[styles.card, { gap: 12 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
          <IconTile icon="cloud-upload-outline" color={Colors.sky} size={46} iconSize={23} />
          <Text style={{ fontSize: 16, fontWeight: '800', color: Colors.text }}>{t('backup.title')}</Text>
        </View>
        <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>
          {t('backup.desc')}
        </Text>
        <AppButton
          title={backupBusy ? t('backup.busyCreate') : t('backup.createBtn')}
          variant="secondary"
          icon="lock-closed-outline"
          disabled={backupBusy}
          onPress={() => openPwModal('export')}
        />
        <AppButton
          title={backupBusy ? t('backup.busyRestore') : t('backup.restoreBtn')}
          variant="secondary"
          icon="folder-open-outline"
          disabled={backupBusy}
          onPress={() => { handlePickImportFile().catch(() => {}); }}
        />
        <View style={{ height: 1, backgroundColor: '#F0EDFA' }} />
        {/* Điểm nối mây Pro (Phase 6): BYOC Google Drive là mặc định, mây SmartStash dành cho gói Pro — sắp có */}
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
          onPress={() => showInfo(t('plan.upgradeTitle'), t('plan.revenueCatSoon'))}
          activeOpacity={0.7}
        >
          <IconTile icon="cloud-outline" color={Colors.subtext} size={44} iconSize={22} />
          <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: Colors.text }}>{t('plan.cloudRow')}</Text>
          <View style={{ backgroundColor: Colors.chipBg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: Colors.primary }}>{t('plan.proSoonBadge')}</Text>
          </View>
        </TouchableOpacity>

        <View style={{ height: 1, backgroundColor: '#F0EDFA' }} />
        {/* Google Drive của khách (BYOC): khách kết nối Drive của CHÍNH họ —
            app chỉ kích hoạt mục này khi đã cấu hình Client ID (xem config.ts) */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <IconTile icon="logo-google" color={Colors.sky} size={44} iconSize={22} />
          <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: Colors.text }}>{t('drive.title')}</Text>
        </View>
        {!driveConfigured ? (
          <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>{t('drive.notConfigured')}</Text>
        ) : !driveConnectedState ? (
          <>
            <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>{t('drive.desc')}</Text>
            <DriveConnectButton
              onConnected={() => { load().catch(() => {}); }}
              onError={(e) => showInfo(t('drive.title'), driveErrorMessage(e))}
            />
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <Ionicons name="checkmark-circle" size={17} color={Colors.green} />
              <Text style={{ flex: 1, fontSize: 13.5, fontWeight: '600', color: Colors.text }}>
                {driveEmail ? t('drive.connectedAs', { email: driveEmail }) : t('drive.connected')}
              </Text>
            </View>
            {!driveHasKey ? (
              <>
                <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>{t('drive.needKeyDesc')}</Text>
                <AppButton
                  title={t('drive.setPasswordBtn')}
                  variant="secondary"
                  icon="key-outline"
                  disabled={driveBusy}
                  onPress={() => {
                    setDrivePw('');
                    setDrivePwConfirm('');
                    setDrivePwError(null);
                    setDrivePwShow(false);
                    setDrivePwModal({ mode: 'setup' });
                  }}
                />
              </>
            ) : (
              <>
                <AppButton
                  title={t('drive.backupNowBtn')}
                  variant="secondary"
                  icon="cloud-upload-outline"
                  loading={driveBusy}
                  onPress={() => { handleDriveBackupNow().catch(() => {}); }}
                />
                <AppButton
                  title={t('drive.restoreBtn')}
                  variant="secondary"
                  icon="cloud-download-outline"
                  disabled={driveBusy}
                  onPress={() => { handleDriveRestoreOpen().catch(() => {}); }}
                />
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14.5, fontWeight: '600', color: Colors.text }}>{t('drive.autoLabel')}</Text>
                    <Text style={{ fontSize: 12, color: Colors.subtext, marginTop: 1 }}>{t('drive.autoDesc')}</Text>
                  </View>
                  <Switch
                    value={driveAuto}
                    onValueChange={(v) => { handleDriveAutoToggle(v).catch(() => {}); }}
                    trackColor={{ false: Colors.chipBg, true: Colors.primary }}
                    thumbColor="#fff"
                  />
                </View>
                <Text style={{ fontSize: 12.5, color: Colors.subtext }}>
                  {driveLastAt
                    ? t('drive.lastBackup', { time: new Date(driveLastAt).toLocaleString() })
                    : t('drive.lastNone')}
                </Text>
                {driveLastStatus === 'error' && (
                  <Text style={{ fontSize: 12.5, color: Colors.danger }}>{t('drive.lastFailed')}</Text>
                )}
              </>
            )}
            <TouchableOpacity
              style={{ alignItems: 'center', paddingVertical: 6 }}
              onPress={() => { handleDriveDisconnect().catch(() => {}); }}
            >
              <Text style={{ fontSize: 13.5, fontWeight: '600', color: Colors.danger }}>{t('drive.disconnectBtn')}</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* Dữ liệu thử nghiệm: seed ~30 món mẫu để trải nghiệm app */}
      <View style={[styles.card, { gap: 12 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
          <IconTile icon="flask-outline" color={Colors.coral} size={46} iconSize={23} />
          <Text style={{ fontSize: 16, fontWeight: '800', color: Colors.text }}>{t('settings.demoTitle')}</Text>
        </View>
        <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>
          {t('settings.demoDesc')}
        </Text>
        {demoExists ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <Ionicons name="checkmark-circle" size={17} color={Colors.green} />
              <Text style={{ fontSize: 13, fontWeight: '600', color: Colors.text }}>{t('settings.demoExists')}</Text>
            </View>
            <AppButton
              title={t('settings.demoDelete')}
              variant="danger"
              icon="trash-outline"
              loading={demoBusy}
              onPress={() => setShowClearDemoPopup(true)}
            />
          </>
        ) : (
          <AppButton
            title={t('settings.demoCreate')}
            variant="secondary"
            icon="flask-outline"
            loading={demoBusy}
            onPress={handleSeedDemo}
          />
        )}
      </View>

      {/* Menu chức năng: hàng có icon tile + tiêu đề + chevron, ngăn hairline */}
      <View style={[styles.card, { padding: 0, overflow: 'hidden' }]}>
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}
          onPress={handleExportCsv}
          disabled={exporting}
          activeOpacity={0.7}
        >
          <IconTile icon="download" color={Colors.teal} size={44} iconSize={22} />
          <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: Colors.text }}>
            {exporting ? t('set.exporting') : t('set.exportCsv')}
          </Text>
          <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(15,181,168,0.11)', alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="chevron-forward" size={16} color={Colors.teal} />
          </View>
        </TouchableOpacity>
        <View style={{ height: 1, backgroundColor: '#F0EDFA', marginLeft: 70, marginRight: 14 }} />
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}
          onPress={() => router.push('/labels')}
          activeOpacity={0.7}
        >
          <IconTile icon="qr-code-outline" color={Colors.primary} size={44} iconSize={22} />
          <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: Colors.text }}>
            {t('settings.printLabels')}
          </Text>
          <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(109,40,217,0.11)', alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="chevron-forward" size={16} color={Colors.primary} />
          </View>
        </TouchableOpacity>
        <View style={{ height: 1, backgroundColor: '#F0EDFA', marginLeft: 70, marginRight: 14 }} />
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}
          onPress={() => router.push('/onboarding')}
          activeOpacity={0.7}
        >
          <IconTile icon="play-circle" color={Colors.coral} size={44} iconSize={22} />
          <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: Colors.text }}>{t('set.replayIntro')}</Text>
          <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(255,90,118,0.11)', alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="chevron-forward" size={16} color={Colors.coral} />
          </View>
        </TouchableOpacity>
      </View>

      <View style={{ gap: 10 }}>
        <SectionTitle title={t('set.trash')} subtitle={t('set.trashSubtitle')} color={Colors.red} />
        {trash.length === 0 ? (
          <Text style={{ color: Colors.subtext, fontSize: 13 }}>{t('set.trashEmpty')}</Text>
        ) : (
          trash.map((i) => (
            <View key={i.id} style={[styles.card, { flexDirection: 'row', alignItems: 'center', gap: 11, padding: 12 }]}>
              <IconTile icon="trash-outline" color={Colors.subtext} size={42} iconSize={21} />
              <Text style={{ flex: 1, fontSize: 14, fontWeight: '600', color: Colors.text }}>{i.name}</Text>
              <TouchableOpacity
                style={[styles.buttonSecondary, { paddingVertical: 8, paddingHorizontal: 12 }]}
                onPress={async () => { await restoreItem(i.id); bump(); }}
              >
                <Text style={[styles.buttonSecondaryText, { fontSize: 13.5 }]}>{t('set.restore')}</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
      </View>

      <Text style={{ color: Colors.subtext, fontSize: 12, textAlign: 'center', marginTop: 12 }}>
        {t('set.footer')}
      </Text>

      <AppPopup
        visible={showClearDemoPopup}
        title={t('settings.demoTitle')}
        message={t('settings.demoDeleteConfirm')}
        confirm={{ label: t('settings.demoDelete'), danger: true, onConfirm: () => { handleClearDemoConfirm().catch(() => {}); } }}
        onClose={() => setShowClearDemoPopup(false)}
      />

      <AppPopup
        visible={!!infoPopup}
        title={infoPopup?.title ?? ''}
        message={infoPopup?.message}
        okLabel={t('common.gotIt')}
        onClose={() => setInfoPopup(null)}
      />

      {/* Cảnh báo mất sao lưu Drive (Mảng 8): chỉ hiện khi
          checkDriveBackupMissing phát hiện danh sách sao lưu rỗng dù máy
          đã từng sao lưu thành công (mỗi lần mất hiện đúng 1 lần). Hai
          hành động: tạo lại sao lưu mới từ dữ liệu máy này (an toàn —
          dữ liệu cục bộ không bao giờ bị đụng), hoặc xem hướng dẫn khôi
          phục từ Thùng rác Google Drive */}
      <AppPopup
        visible={driveMissingWarn}
        title={t('drive.missingTitle')}
        message={t('drive.missingMsg')}
        options={[
          {
            label: t('drive.missingRecreate'),
            icon: 'cloud-upload-outline',
            description: t('drive.missingRecreateDesc'),
            onPress: () => { handleDriveBackupNow().catch(() => {}); },
          },
          {
            label: t('drive.missingTrashGuide'),
            icon: 'trash-outline',
            description: t('drive.missingTrashGuideDesc'),
            onPress: () => showInfo(t('drive.trashGuideTitle'), t('drive.trashGuideMsg')),
          },
        ]}
        onClose={() => setDriveMissingWarn(false)}
      />

      {/* Xác nhận GHI ĐÈ toàn bộ dữ liệu trước khi khôi phục (danger) */}
      <AppPopup
        visible={showOverwriteConfirm}
        title={t('backup.overwriteTitle')}
        message={t('backup.overwriteMsg')}
        confirm={{
          label: t('backup.overwriteConfirm'),
          danger: true,
          onConfirm: () => { handleImportConfirm().catch(() => {}); },
        }}
        onClose={() => {
          setShowOverwriteConfirm(false);
          setPendingImport(null);
          setPendingImportUri(null);
        }}
      />

      {/* Modal mật khẩu sao lưu — mật khẩu không được lưu ở bất cứ đâu.
          Các ô có nút mắt hiện/ẩn; chế độ tạo mới kèm khối cảnh báo lưu kỹ mật khẩu */}
      <Modal visible={pwModal !== null} transparent animationType="fade" onRequestClose={() => setPwModal(null)}>
        <Pressable style={styles.modalOverlay} onPress={() => setPwModal(null)}>
          <Pressable style={[styles.card, styles.modalCard, { gap: 6 }]} onPress={() => {}}>
            <Text style={{ fontSize: 17, fontWeight: '800', color: Colors.text }}>
              {pwModal?.mode === 'import' ? t('backup.restoreTitle') : t('backup.createTitle')}
            </Text>
            <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>
              {t('backup.pwWarn')}
            </Text>
            {pwModal?.mode === 'export' && <PasswordWarnBox text={t('backup.passwordWarn')} />}
            <SecretField
              label={t('backup.pwLabel')}
              value={pwValue}
              onChangeText={setPwValue}
              visible={pwShow}
              onToggleVisible={() => setPwShow((v) => !v)}
              toggleLabel={pwShow ? t('common.hide') : t('common.show')}
              autoFocus
            />
            {pwModal?.mode === 'export' && (
              <SecretField
                label={t('backup.pwConfirmLabel')}
                value={pwConfirm}
                onChangeText={setPwConfirm}
                visible={pwShow}
                onToggleVisible={() => setPwShow((v) => !v)}
                toggleLabel={pwShow ? t('common.hide') : t('common.show')}
              />
            )}
            <AppButton
              title={pwModal?.mode === 'import' ? t('backup.confirmRestore') : t('backup.confirmCreate')}
              icon={pwModal?.mode === 'import' ? 'lock-open-outline' : 'lock-closed-outline'}
              style={{ marginTop: 14 }}
              loading={pwBusy}
              onPress={pwModal?.mode === 'import' ? () => { handleImportPwSubmit().catch(() => {}); } : () => { handleExportSubmit().catch(() => {}); }}
            />
            <TouchableOpacity style={{ alignItems: 'center', paddingVertical: 10 }} onPress={() => setPwModal(null)}>
              <Text style={{ fontSize: 13.5, fontWeight: '600', color: Colors.subtext }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Modal nhập mã khuyến mãi tự quản của chủ app (promoService — seam
          TODO backend/RevenueCat). Lỗi phân loại hiện tại chỗ trong modal.
          Khu vực riêng cho mã Google Play: app không tự kiểm tra loại mã đó,
          chỉ mở trang đổi mã chính thức của Google */}
      <Modal visible={promoOpen} transparent animationType="fade" onRequestClose={() => setPromoOpen(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setPromoOpen(false)}>
          <Pressable style={[styles.card, styles.modalCard, { gap: 6 }]} onPress={() => {}}>
            <Text style={{ fontSize: 17, fontWeight: '800', color: Colors.text }}>
              {t('promo.title')}
            </Text>
            <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>
              {t('promo.desc')}
            </Text>
            <Text style={[styles.label, { marginTop: 10 }]}>{t('promo.codeLabel')}</Text>
            <TextInput
              style={[styles.input, promoError ? { borderColor: Colors.danger } : null]}
              value={promoCode}
              onChangeText={(v) => {
                setPromoCode(v);
                if (promoError) setPromoError(null);
              }}
              placeholder={t('promo.placeholder')}
              placeholderTextColor={Colors.faint}
              autoCapitalize="characters"
              autoCorrect={false}
              autoFocus
            />
            {promoError && (
              <Text style={{ color: Colors.danger, fontSize: 13, marginTop: 8 }}>{promoError}</Text>
            )}
            <AppButton
              title={t('promo.apply')}
              icon="ticket-outline"
              style={{ marginTop: 14 }}
              loading={promoBusy}
              onPress={() => { handlePromoApply().catch(() => {}); }}
            />
            <View style={{ height: 1, backgroundColor: Colors.border, marginTop: 16, marginBottom: 6 }} />
            <Text style={{ fontSize: 13.5, fontWeight: '700', color: Colors.text }}>{t('promo.playTitle')}</Text>
            <Text style={{ color: Colors.subtext, fontSize: 12.5, lineHeight: 18 }}>{t('promo.playNote')}</Text>
            <AppButton
              title={t('promo.playBtn')}
              icon="logo-google"
              variant="secondary"
              style={{ marginTop: 8 }}
              onPress={openGooglePlayRedeem}
            />
            <TouchableOpacity style={{ alignItems: 'center', paddingVertical: 10 }} onPress={() => setPromoOpen(false)}>
              <Text style={{ fontSize: 13.5, fontWeight: '600', color: Colors.subtext }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Modal PIN khoá app — form MỘT màn hình: mọi ô hiện cùng lúc, có nút
          mắt hiện mã và lỗi kiểm tra ngay trong modal. PIN chỉ sống trong
          state tạm, hash lưu SecureStore */}
      <Modal visible={pinModal !== null} transparent animationType="fade" onRequestClose={() => setPinModal(null)}>
        <Pressable style={styles.modalOverlay} onPress={() => setPinModal(null)}>
          <Pressable style={[styles.card, styles.modalCard, { gap: 6 }]} onPress={() => {}}>
            <Text style={{ fontSize: 17, fontWeight: '800', color: Colors.text }}>{pinModalTitle()}</Text>
            {(pinModal?.mode === 'change' || pinModal?.mode === 'disable') && (
              <SecretField
                label={t('lock.oldPin')}
                value={pinOld}
                onChangeText={setPinOld}
                visible={pinShow}
                onToggleVisible={() => setPinShow((v) => !v)}
                toggleLabel={pinShow ? t('common.hide') : t('common.show')}
                numeric
                autoFocus
              />
            )}
            {pinModal?.mode !== 'disable' && (
              <>
                <SecretField
                  label={t('lock.newPin')}
                  value={pinNew}
                  onChangeText={setPinNew}
                  visible={pinShow}
                  onToggleVisible={() => setPinShow((v) => !v)}
                  toggleLabel={pinShow ? t('common.hide') : t('common.show')}
                  numeric
                  autoFocus={pinModal?.mode === 'setup'}
                />
                <SecretField
                  label={t('lock.confirmPin')}
                  value={pinConfirm}
                  onChangeText={setPinConfirm}
                  visible={pinShow}
                  onToggleVisible={() => setPinShow((v) => !v)}
                  toggleLabel={pinShow ? t('common.hide') : t('common.show')}
                  numeric
                />
              </>
            )}
            {pinError && (
              <Text style={{ color: Colors.danger, fontSize: 13, marginTop: 10 }}>{pinError}</Text>
            )}
            <AppButton
              title={t('common.confirm')}
              icon="lock-closed-outline"
              style={{ marginTop: 14 }}
              onPress={() => { handlePinSubmit().catch(() => {}); }}
            />
            <TouchableOpacity style={{ alignItems: 'center', paddingVertical: 10 }} onPress={() => setPinModal(null)}>
              <Text style={{ fontSize: 13.5, fontWeight: '600', color: Colors.subtext }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Danh sách bản sao lưu trên Drive → chọn 1 bản để khôi phục */}
      <AppPopup
        visible={driveRestoreList !== null}
        title={t('drive.restoreListTitle')}
        message={t('drive.restoreListDesc')}
        options={(driveRestoreList ?? []).map<AppPopupOption>((f) => ({
          label: f.name,
          icon: 'cloud-download-outline',
          color: Colors.sky,
          description: f.createdTime ? new Date(f.createdTime).toLocaleString() : undefined,
          onPress: () => {
            setDriveRestoreList(null);
            setPendingDriveRestore(f);
          },
        }))}
        onClose={() => setDriveRestoreList(null)}
      />

      {/* Xác nhận GHI ĐÈ trước khi khôi phục từ Drive (danger, cùng khuôn bản file) */}
      <AppPopup
        visible={pendingDriveRestore !== null}
        title={t('backup.overwriteTitle')}
        message={t('backup.overwriteMsg')}
        confirm={{
          label: t('backup.overwriteConfirm'),
          danger: true,
          onConfirm: () => {
            const f = pendingDriveRestore;
            setPendingDriveRestore(null);
            if (f) attemptDriveRestore(f.id).catch(() => {});
          },
        }}
        onClose={() => setPendingDriveRestore(null)}
      />

      {/* Modal mật khẩu sao lưu Drive: đặt lần đầu (mới + nhập lại) hoặc mở
          khoá khôi phục trên máy mới (1 ô) — kèm cảnh báo lưu kỹ mật khẩu */}
      <Modal visible={drivePwModal !== null} transparent animationType="fade" onRequestClose={() => setDrivePwModal(null)}>
        <Pressable style={styles.modalOverlay} onPress={() => setDrivePwModal(null)}>
          <Pressable style={[styles.card, styles.modalCard, { gap: 6 }]} onPress={() => {}}>
            <Text style={{ fontSize: 17, fontWeight: '800', color: Colors.text }}>
              {drivePwModal?.mode === 'setup' ? t('drive.setPasswordTitle') : t('drive.unlockTitle')}
            </Text>
            <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>
              {drivePwModal?.mode === 'setup' ? t('drive.setPasswordDesc') : t('drive.unlockDesc')}
            </Text>
            <PasswordWarnBox text={t('backup.passwordWarn')} />
            <SecretField
              label={drivePwModal?.mode === 'setup' ? t('backup.pwLabel') : t('drive.passwordLabel')}
              value={drivePw}
              onChangeText={setDrivePw}
              visible={drivePwShow}
              onToggleVisible={() => setDrivePwShow((v) => !v)}
              toggleLabel={drivePwShow ? t('common.hide') : t('common.show')}
              autoFocus
            />
            {drivePwModal?.mode === 'setup' && (
              <SecretField
                label={t('backup.pwConfirmLabel')}
                value={drivePwConfirm}
                onChangeText={setDrivePwConfirm}
                visible={drivePwShow}
                onToggleVisible={() => setDrivePwShow((v) => !v)}
                toggleLabel={drivePwShow ? t('common.hide') : t('common.show')}
              />
            )}
            {drivePwError && (
              <Text style={{ color: Colors.danger, fontSize: 13, marginTop: 10 }}>{drivePwError}</Text>
            )}
            <AppButton
              title={t('common.confirm')}
              icon="lock-closed-outline"
              style={{ marginTop: 14 }}
              loading={drivePwBusy}
              onPress={() => { handleDrivePwSubmit().catch(() => {}); }}
            />
            <TouchableOpacity style={{ alignItems: 'center', paddingVertical: 10 }} onPress={() => setDrivePwModal(null)}>
              <Text style={{ fontSize: 13.5, fontWeight: '600', color: Colors.subtext }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}
