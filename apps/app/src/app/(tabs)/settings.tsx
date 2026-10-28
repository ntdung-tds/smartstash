import React, { useCallback, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Switch, Modal, Pressable, TextInput, Linking, Image, Share } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { styles, Colors, SectionTitle, AppButton, AppPopup, TAB_BAR_CLEARANCE, type AppPopupOption } from '@/components/ui';
import BarcodeScannerModal from '@/components/BarcodeScannerModal';
import type { Item, Location } from '@/types';
import {
  countRealActiveItems, countRealLocations, listItems, listDeletedItems, restoreItem, permanentDeleteItems, getBreadcrumb, breadcrumbText,
  findItemByBarcode, findLocationByQrCode,
  getDeletedLocations, countDeletedInSubtree, restoreLocation, permanentDeleteLocation, getLocation,
} from '@/db/queries';
import { ftsAvailable, kvGet, kvSet } from '@/db/client';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import { rescheduleAllReminders } from '@/services/notificationService';
import { getLimits, getPlanSync, loadPlan, type PlanId } from '@/services/planService';
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
  getDriveConnectionInfo, getPromoConnectionInfo, hasDriveMasterKey, listDriveBackups, restoreFromDrive,
  setupDriveMasterKey, signInForPromo, switchGoogleAccount, switchPromoGoogleAccount, type DriveBackupFile,
} from '@/services/driveService';
import {
  formatBytes,
  getCloudApiUrl,
  getStorageTier,
} from '@/services/storagePlanService';
import {
  CloudBackupError,
  downloadCloudBackup,
  getCloudUsage,
  uploadCloudBackup,
  type CloudUsage,
} from '@/services/cloudBackupService';
import { getAppVersion, getMaintenanceNotice, getMinVersion, getRemoteFlagsSync, getStoragePlans, isCloudBackupEnabled, isDriveBackupEnabled, isUpdateRequired, loadRemoteConfig, type StoragePlan } from '@/services/remoteConfigService';

import { getPromoIdToken, redeemPromoCodeViaServer, syncPlanFromServer } from '@/services/promoService';
import { categoryLabel, statusLabel, tint, cardShadow, type IconName } from '@/theme';
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
 * Nút "Kết nối Google Drive" — v84 theo cờ quản trị drive_backup_enabled:
 * cờ tắt thì mục Drive khoá hẳn và nút này không hiện; cờ bật thì nút này
 * gọi connectDrive() scope Drive như trước v82. Đổi mã khuyến mãi không
 * đi qua nút này mà qua modal đổi mã với luồng đăng nhập scope cơ bản
 * riêng.
 */
/**
 * Nhường 1 nhịp render (~50ms) để trạng thái bận của nút xác nhận kịp vẽ
 * lên màn hình TRƯỚC khi chạy tác vụ mã hoá — người dùng thấy phản hồi
 * ngay khi bấm, không có cảm giác app "đứng hình" lúc xử lý mật khẩu.
 */
function yieldUiTick(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 50); });
}

function DriveConnectButton({ onConnect, loading }: { onConnect: () => void; loading?: boolean }) {
  const { t } = useT();

  return (
    <AppButton
      title={t('drive.connectBtn')}
      variant="secondary"
      icon="logo-google"
      loading={loading}
      onPress={onConnect}
    />
  );
}

/**
 * Huy hiệu gói (v84): Free/Pro phải nhìn là phân biệt ngay, không chỉ đọc
 * chữ trong dòng mô tả — Pro: nền vàng cam + icon kim cương; Free: nền
 * tím nhạt (thẻ sáng) hoặc trắng mờ (thẻ tối) + icon khối. Dùng chung ở
 * thẻ tài khoản và thẻ gói, chữ PRO/FREE là ký hiệu quốc tế, không cần
 * thêm key i18n.
 */
function PlanBadge({ planId, dark }: { planId: string; dark?: boolean }) {
  const isPro = planId === 'PRO';
  const fg = isPro || dark ? '#fff' : Colors.primary;
  return (
    <View
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 4,
        paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
        backgroundColor: isPro ? '#FF9F43' : dark ? 'rgba(255,255,255,0.18)' : '#E5E0F5',
      }}
    >
      <Ionicons name={isPro ? 'diamond' : 'cube-outline'} size={11} color={fg} />
      <Text style={{ fontSize: 11, fontWeight: '800', letterSpacing: 1, color: fg }}>
        {isPro ? 'PRO' : 'FREE'}
      </Text>
    </View>
  );
}

/**
 * Tile icon phong cách iOS (chốt iOS cho Cài đặt v70): hình vuông bo góc
 * kiểu squircle (~30% cạnh), nền MÀU ĐẶC hệ thống iOS, glyph Ionicons
 * trắng bên trong (Ionicons vốn đã kiểu iOS). RIÊNG màn Cài đặt này dùng
 * — không sửa IconTile dùng chung của app. Màu cũ của app được map sang
 * màu hệ thống iOS gần nhất để toàn màn đồng nhất phong cách iOS.
 */
const IOS_COLORS: Record<string, string> = {
  '#0FB5A8': '#5AC8FA',
  '#38A8E8': '#007AFF',
  '#FF9F43': '#FF9500',
  '#FF5A76': '#FF3B30',
  '#6D28D9': '#AF52DE',
  '#E5484D': '#FF3B30',
  '#22A06B': '#34C759',
  '#6E6890': '#8E8E93',
};

function IOSTile({
  icon, color, size = 48, iconSize = 24,
}: {
  icon: IconName;
  color: string;
  size?: number;
  iconSize?: number;
}) {
  return (
    <View
      style={{
        width: size, height: size, borderRadius: Math.round(size * 0.3),
        backgroundColor: IOS_COLORS[color] ?? color,
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      <Ionicons name={icon} size={iconSize} color="#fff" />
    </View>
  );
}

/** Chuẩn hoá bỏ dấu tiếng Việt để tìm kiếm menu không dấu (đ/Đ xử lý riêng vì NFD không tách được) */
function stripMarks(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase();
}

/** 8 bảng Cài đặt — mỗi menu to mở đúng 1 bảng ngay trong cùng màn hình */
type PanelId = 'data' | 'app' | 'alerts' | 'security' | 'backup' | 'tools' | 'support' | 'trash';

export default function SettingsScreen() {
  const { t } = useT();
  // Phiên bản hiển thị ở nhóm Thông tin: lấy từ app.json qua expoConfig
  // (getAppVersion), không hardcode — null thì hàng chỉ hiện tên app.
  const appVersion = getAppVersion();
  const langMode = useAppStore((s) => s.langMode);
  const lang = useAppStore((s) => s.lang);
  const setLangMode = useAppStore((s) => s.setLangMode);
  const [activeCount, setActiveCount] = useState(0);
  const [locCount, setLocCount] = useState(0);
  const [trash, setTrash] = useState<Item[]>([]);
  // Thùng rác: id các món đang chọn + hộp xác nhận xoá vĩnh viễn đang chờ
  const [trashSelected, setTrashSelected] = useState<string[]>([]);
  const [trashDeletePending, setTrashDeletePending] = useState<{ ids: string[]; title: string; message: string } | null>(null);
  // Thùng rác vị trí (v93): một hàng = một vị trí đã xoá mềm
  type TrashLocationRow = {
    id: string; name: string; deletedAt: string | null;
    mode: 'move' | 'deleteAll'; destName: string | null;
    movedCount: number; subLocCount: number; subItemCount: number;
  };
  const [trashLocations, setTrashLocations] = useState<TrashLocationRow[]>([]);
  const [locDeletePending, setLocDeletePending] = useState<{ id: string; name: string } | null>(null);
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
  // Gói hiện tại (Phase 6 — khung Pro): đọc qua planService; mã khuyến mại
  // tự quản (promoService) cấp Pro qua cờ plan_sim_pro mà planService đọc.
  const [planId, setPlanId] = useState<PlanId>('FREE');
  // Mã khuyến mại tự quản: modal nhập mã + công tắc cấu hình từ xa
  // (selfPromoEnabled TẮT → ẩn hẳn điểm nhập mã, thay bằng lối Play).
  const [promoOpen, setPromoOpen] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const [promoBusy, setPromoBusy] = useState(false);
  const [promoLoginBusy, setPromoLoginBusy] = useState(false);
  const [googleSwitchBusy, setGoogleSwitchBusy] = useState(false);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [selfPromoEnabled, setSelfPromoEnabled] = useState(true);
  // Thông báo từ máy chủ (cấu hình từ xa): bảo trì + nhắc cập nhật. Chỉ
  // hiện banner, không chặn app — quyết định chặn là quyết định sản phẩm.
  const [maintenanceNotice, setMaintenanceNotice] = useState<string | null>(null);
  const [updateRequired, setUpdateRequired] = useState<string | null>(null);
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
  // v82: trạng thái đăng nhập cho ĐỔI MÃ (scope cơ bản) tách riêng khỏi
  // Drive — Drive luôn ở trạng thái "chưa kết nối" vì nút Drive chỉ báo
  // đang phát triển, còn modal đổi mã đọc đúng 2 state promo này.
  const [promoEmail, setPromoEmail] = useState<string | null>(null);
  const [promoConnectedState, setPromoConnectedState] = useState(false);
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
  // Lưu trữ trên Cloud của Smartstash (Phase 6): gói lưu trữ + sao lưu mã hoá lên Worker —
  // state chỉ là bản chụp để render; mật khẩu chỉ sống trong state tạm
  const [cloudTier, setCloudTierState] = useState(100);
  const [storagePlans, setStoragePlansState] = useState<StoragePlan[]>(() => getStoragePlans());
  const [cloudUsage, setCloudUsage] = useState<CloudUsage | null>(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudPwModal, setCloudPwModal] = useState<{ mode: 'upload' | 'restore'; fileName?: string } | null>(null);
  const [cloudPw, setCloudPw] = useState('');
  const [cloudPwConfirm, setCloudPwConfirm] = useState('');
  const [cloudPwShow, setCloudPwShow] = useState(false);
  const [cloudPwError, setCloudPwError] = useState<string | null>(null);
  const [cloudPwBusy, setCloudPwBusy] = useState(false);
  const [pendingCloudRestore, setPendingCloudRestore] = useState<{ fileName: string; password: string } | null>(null);
  const [showCloudOverwrite, setShowCloudOverwrite] = useState(false);
  // Công tắc khoá/mở sao lưu từ quản trị (v84): mặc định khoá (false)
  // cho tới khi loadRemoteConfig() nạp được cờ thật từ máy chủ.
  const [cloudBackupEnabled, setCloudBackupEnabled] = useState(false);
  const [driveBackupEnabled, setDriveBackupEnabled] = useState(false);
  const [pendingDriveRestore, setPendingDriveRestore] = useState<DriveBackupFile | null>(null);
  const refreshTick = useAppStore((s) => s.refreshTick);
  const bump = useAppStore((s) => s.bump);
  // Cài đặt kiểu mới v70: màn chính là danh sách menu to, nhấn vào mở
  // bảng của nhóm ngay trong cùng màn hình (không tạo route mới cho 8 bảng)
  const [activePanel, setActivePanel] = useState<PanelId | null>(null);
  const [menuQuery, setMenuQuery] = useState('');
  const [showScanner, setShowScanner] = useState(false);
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const scrollRef = useRef<React.ElementRef<typeof ScrollView>>(null);

  /**
   * Đồng bộ avatar Google vào avatar chung của app (v84): thẻ tài khoản ở
   * đây và avatar hero ở Trang chủ CÙNG đọc app_kv 'avatar_uri', nên chỉ
   * cần ghi URL ảnh Google vào đó là cả hai nơi cùng hiện ảnh đó.
   * - Chỉ lấp vào khi chưa có avatar riêng, hoặc avatar hiện tại đã là
   *   ảnh Google cũ (đổi tài khoản → ảnh mới thay ảnh cũ).
   * - Avatar riêng người dùng tự chọn (file trong thư mục ảnh của app)
   *   KHÔNG bị ghi đè; muốn dùng lại ảnh Google thì xoá avatar ở Trang
   *   chủ rồi mở lại Cài đặt là ảnh Google tự lấp vào.
   * - Xoá avatar ở Trang chủ an toàn với URL này: removeAvatarImage chỉ
   *   xoá file bắt đầu bằng thư mục ảnh của app, URL ngoài không bị đụng.
   */
  async function syncGoogleAvatar(photo: string | null): Promise<void> {
    if (!photo) return;
    try {
      const current = await kvGet('avatar_uri');
      if (!current || current.includes('googleusercontent.com')) {
        await kvSet('avatar_uri', photo);
        setAvatarUri(photo);
      }
    } catch {
      // đồng bộ avatar lỗi thì thôi — email + huy hiệu Google vẫn hiện
    }
  }

  const load = useCallback(async () => {
    setActiveCount(await countRealActiveItems());
    setLocCount(await countRealLocations());
    setTrash(await listDeletedItems());
    setDemoExists(!!(await kvGet('demo_seed_ids')));
    // Thẻ tài khoản ở đầu màn chính: avatar bền trong app_kv (cùng cách màn
    // Home đang dùng) — chỉ hiển thị, không tạo hệ thống tài khoản mới
    const av = await kvGet('avatar_uri');
    setAvatarUri(av || null);
    setAlertCfgState(await getAlertSettings());
    await loadPlan();
    setPlanId(getPlanSync());
    setLockCfg(await getLockConfig());
    setPinExists(await lockHasPin());
    setBioAvail(await isBiometricAvailable());
    // Trạng thái đăng nhập thật ở đây là của luồng đổi mã (scope cơ bản);
    // trạng thái Drive thật được nạp sau, khi đã biết cờ khoá/mở Drive.
    const conn = await getPromoConnectionInfo().catch(() => ({ connected: false, email: null, photo: null }));
    setPromoConnectedState(conn.connected);
    setPromoEmail(conn.email);
    // v84: người dùng đã đăng nhập từ bản cũ cũng được đồng bộ ảnh ngay
    // khi mở Cài đặt lần đầu ở bản này (không cần đăng nhập lại).
    if (conn.connected) await syncGoogleAvatar(conn.photo);
    setDriveConnectedState(false);
    setDriveEmail(null);
    // Đồng bộ gói từ máy chủ (v78): chỉ khi đã đăng nhập Google; lỗi mạng
    // hay token hết hạn thì sync tự giữ gói cũ, không chặn màn hình.
    if (conn.connected) {
      await syncPlanFromServer().catch(() => {});
      setPlanId(getPlanSync());
    }
    setDriveHasKey(await hasDriveMasterKey());
    setDriveLastAt(await kvGet('drive_last_at'));
    setDriveLastStatus(await kvGet('drive_last_status'));
    setDriveAuto((await kvGet('drive_auto')) === '1');
    await loadRemoteConfig().catch(() => {});
    setSelfPromoEnabled(getRemoteFlagsSync().selfPromoEnabled);
    setStoragePlansState(getStoragePlans());
    setMaintenanceNotice(getMaintenanceNotice());
    const minV = getMinVersion();
    setUpdateRequired(isUpdateRequired(minV) ? minV : null);
    // v84: công tắc khoá/mở sao lưu từ quản trị — Drive chỉ có trạng thái
    // thật + cảnh báo mất sao lưu khi cờ đang BẬT; cờ TẮT thì mục Drive
    // khoá hẳn (không kết nối, không cảnh báo).
    setCloudBackupEnabled(isCloudBackupEnabled());
    setDriveBackupEnabled(isDriveBackupEnabled());
    if (isDriveBackupEnabled()) {
      const dconn = await getDriveConnectionInfo().catch(() => ({ connected: false, email: null, photo: null }));
      setDriveConnectedState(dconn.connected);
      setDriveEmail(dconn.email);
      setDriveMissingWarn(dconn.connected ? await checkDriveBackupMissing() : false);
    } else {
      setDriveConnectedState(false);
      setDriveEmail(null);
      setDriveMissingWarn(false);
    }
    // Lưu trữ trên Cloud của Smartstash: nạp gói + usage (lỗi thì im lặng —
    // nút Làm mới trong mục sẽ báo lỗi rõ). Mây đang khoá thì không gọi
    // máy chủ làm gì — usage để null, mục mây chỉ hiện thông báo khoá.
    setCloudTierState(await getStorageTier());
    if (isCloudBackupEnabled()) await refreshCloudUsage(true).catch(() => {});
    else setCloudUsage(null);
  }, []);

  /**
   * Mã khuyến mại: mở modal (reset ô nhập + lỗi, làm mới trạng thái đăng
   * nhập Google để modal biết hiện khối đăng nhập hay ô nhập mã).
   */
  async function openPromoModal() {
    setPromoCode('');
    setPromoError(null);
    setPromoBusy(false);
    const conn = await getPromoConnectionInfo().catch(() => ({ connected: false, email: null, photo: null }));
    setPromoConnectedState(conn.connected);
    setPromoEmail(conn.email);
    setPromoOpen(true);
  }

  /**
   * Đăng nhập Google ngay trong modal đổi mã (v78, v82 tách scope cơ
   * bản): dùng signInForPromo(), KHÔNG xin drive.appdata nên không vướng
   * xác minh. Huỷ picker thì im lặng ở lại khối đăng nhập.
   */
  async function handlePromoLogin() {
    setPromoLoginBusy(true);
    setPromoError(null);
    try {
      const res = await signInForPromo();
      if (res.status === 'connected') {
        const conn = await getPromoConnectionInfo();
        setPromoConnectedState(conn.connected);
        setPromoEmail(conn.email);
        await syncGoogleAvatar(conn.photo);
      }
    } catch {
      setPromoError(t('promo.loginError'));
    } finally {
      setPromoLoginBusy(false);
    }
  }

  /**
   * Kết nối Drive (v84, chỉ khi cờ drive_backup_enabled đang BẬT):
   * connectDrive() scope drive.appdata như v80; kết nối xong lấy lại
   * trạng thái Drive thật + đồng bộ avatar Google nếu có ảnh.
   */
  async function handleDriveConnect() {
    setDriveBusy(true);
    try {
      const res = await connectDrive();
      if (res.status === 'connected') {
        const dconn = await getDriveConnectionInfo();
        setDriveConnectedState(dconn.connected);
        setDriveEmail(dconn.email);
        await syncGoogleAvatar(dconn.photo);
      }
    } catch (e) {
      showInfo(t('drive.title'), driveErrorMessage(e));
    } finally {
      setDriveBusy(false);
    }
  }

  /**
   * Đổi tài khoản Google (v80, v82 tách luồng):
   * - source 'modal' (đổi mã): switchPromoGoogleAccount() scope cơ bản;
   *   đổi xong lấy lại trạng thái tài khoản + đồng bộ gói từ máy chủ, vì
   *   gói gắn với tài khoản nên tài khoản mới có thể có gói khác. Huỷ
   *   bảng chọn mà phiên cũ cứu được thì giữ nguyên mọi thứ; huỷ mà
   *   phiên cũ mất thì UI báo rõ là đã đăng xuất (không đăng xuất lén).
   * - source 'drive': v84 theo cờ — cờ TẮT thì chỉ báo đang khoá, TUYỆT
   *   ĐỐI không signOut/signIn (tránh đăng xuất luôn phiên đổi mã);
   *   cờ BẬT thì switchGoogleAccount() scope Drive như v80.
   */
  async function handleSwitchGoogleAccount(source: 'modal' | 'drive') {
    if (source === 'drive') {
      if (!isDriveBackupEnabled()) {
        showInfo(t('drive.developingTitle'), t('drive.lockedMsg'));
        return;
      }
      setGoogleSwitchBusy(true);
      try {
        const res = await switchGoogleAccount();
        if (res.status === 'switched') {
          const dconn = await getDriveConnectionInfo();
          setDriveConnectedState(dconn.connected);
          setDriveEmail(dconn.email);
          await syncGoogleAvatar(dconn.photo);
        } else if (res.status === 'signed_out') {
          setDriveConnectedState(false);
          setDriveEmail(null);
          showInfo(t('drive.title'), t('promo.switchSignedOut'));
        }
      } catch (e) {
        showInfo(t('drive.title'), driveErrorMessage(e));
      } finally {
        setGoogleSwitchBusy(false);
      }
      return;
    }
    setGoogleSwitchBusy(true);
    setPromoError(null);
    try {
      const res = await switchPromoGoogleAccount();
      if (res.status === 'switched') {
        const conn = await getPromoConnectionInfo();
        setPromoConnectedState(conn.connected);
        setPromoEmail(conn.email);
        await syncGoogleAvatar(conn.photo);
        await syncPlanFromServer().catch(() => {});
        setPlanId(getPlanSync());
      } else if (res.status === 'signed_out') {
        setPromoConnectedState(false);
        setPromoEmail(null);
        setPromoError(t('promo.switchSignedOut'));
      }
      // 'cancelled' = phiên cũ đã cứu được: giữ nguyên mọi thứ, không báo gì
    } catch {
      setPromoError(t('promo.switchError'));
    } finally {
      setGoogleSwitchBusy(false);
    }
  }

  /**
   * Áp dụng mã khuyến mại qua máy chủ: lỗi phân loại của promoService hiện
   * TẠI CHỖ trong modal (không đóng modal); thành công thì đóng modal, làm
   * mới hiển thị gói ngay và báo quyền lợi đã nhận. Token hết hạn giữa
   * chừng thì quay về khối đăng nhập để người dùng đăng nhập lại.
   */
  async function handlePromoApply() {
    if (!promoCode.trim()) {
      setPromoError(t('promo.empty'));
      return;
    }
    setPromoBusy(true);
    setPromoError(null);
    try {
      const idToken = await getPromoIdToken();
      if (!idToken) {
        setPromoConnectedState(false);
        setPromoError(t('promo.loginRequired'));
        return;
      }
      const res = await redeemPromoCodeViaServer(promoCode, idToken);
      if (res.status === 'success') {
        setPromoOpen(false);
        setPlanId(getPlanSync());
        bump();
        showInfo(t('promo.successTitle'), t('promo.successMsg'));
      } else if (res.status === 'disabled') {
        setPromoError(t('promo.disabled'));
      } else if (res.status === 'not_found') {
        setPromoError(t('promo.notFound'));
      } else if (res.status === 'uses_exhausted') {
        setPromoError(t('promo.usesExhausted'));
      } else if (res.status === 'campaign_used') {
        setPromoError(t('promo.campaignUsed'));
      } else if (res.status === 'not_started') {
        setPromoError(t('promo.notStarted'));
      } else if (res.status === 'expired') {
        setPromoError(t('promo.expired'));
      } else if (res.status === 'paid_active') {
        setPromoError(t('promo.paidActive'));
      } else if (res.status === 'rate_limited') {
        setPromoError(t('promo.rateLimited'));
      } else if (res.status === 'account_required') {
        setPromoConnectedState(false);
        setPromoError(t('promo.loginRequired'));
      } else if (res.status === 'invalid_token') {
        setPromoConnectedState(false);
        setPromoError(t('promo.invalidToken'));
      } else {
        setPromoError(t('promo.networkError'));
      }
    } finally {
      setPromoBusy(false);
    }
  }

  /** Mã Google Play do Google xử lý — app chỉ mở trang đổi mã chính thức */
  function openGooglePlayRedeem() {
    Linking.openURL('https://play.google.com/redeem').catch(() => {});
  }

  /** Thùng rác: tải lại danh sách + tỉa selection về các id còn trong danh sách */
  async function refreshTrash() {
    const list = await listDeletedItems();
    setTrash(list);
    const kept = new Set(list.map((i) => i.id));
    setTrashSelected((prev) => prev.filter((id) => kept.has(id)));
    await refreshTrashLocations();
  }

  /** Thùng rác vị trí (v93): kèm thông tin đợt xoá để hiện đúng dòng mô tả */
  async function refreshTrashLocations() {
    const deleted: Location[] = await getDeletedLocations();
    const rows: TrashLocationRow[] = [];
    for (const loc of deleted) {
      let mode: 'move' | 'deleteAll' = 'deleteAll';
      let destName: string | null = null;
      let movedCount = 0;
      let subLocCount = 0;
      let subItemCount = 0;
      try {
        const meta = loc.trash_meta ? JSON.parse(loc.trash_meta) as { mode?: string; dest_id?: string; moved_item_ids?: unknown } : null;
        if (meta && meta.mode === 'move' && typeof meta.dest_id === 'string') {
          mode = 'move';
          movedCount = Array.isArray(meta.moved_item_ids) ? meta.moved_item_ids.length : 0;
          destName = (await getLocation(meta.dest_id))?.name ?? null;
        }
      } catch {
        // meta hỏng: coi như đợt xoá tất cả
      }
      if (mode === 'deleteAll') {
        const c = await countDeletedInSubtree(loc.id, loc.deleted_at);
        subLocCount = c.locations;
        subItemCount = c.items;
      }
      rows.push({ id: loc.id, name: loc.name, deletedAt: loc.deleted_at, mode, destName, movedCount, subLocCount, subItemCount });
    }
    setTrashLocations(rows);
  }

  async function handleTrashLocRestore(id: string, withItems: boolean) {
    try {
      await restoreLocation(id, withItems);
      bump();
      await refreshTrash();
    } catch (e) {
      if (e instanceof Error && e.message === 'PARENT_TRASHED') {
        showInfo(t('set.trashLocParentTitle'), t('set.trashLocParentMsg'));
      } else {
        showInfo(t('set.trashLocRestoreFailTitle'), e instanceof Error ? e.message : String(e));
      }
    }
  }

  async function handleTrashLocDeleteConfirm() {
    if (!locDeletePending) return;
    const pending = locDeletePending;
    setLocDeletePending(null);
    await permanentDeleteLocation(pending.id);
    bump();
    await refreshTrash();
    showInfo(t('set.trashLocDeleteTitle'), t('set.trashLocDeleted', { name: pending.name }));
  }

  function toggleTrashSelect(id: string) {
    setTrashSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleTrashRestore(id: string) {
    await restoreItem(id);
    bump();
    await refreshTrash();
  }

  /** Mở hộp xác nhận xoá vĩnh viễn (1 món ghi tên, nhiều món ghi số lượng) */
  function requestTrashDelete(ids: string[]) {
    if (ids.length === 0) return;
    if (ids.length === 1) {
      const item = trash.find((i) => i.id === ids[0]);
      setTrashDeletePending({
        ids,
        title: t('set.trashDeleteTitle'),
        message: t('set.trashDeleteConfirmOne', { name: item?.name ?? '' }),
      });
    } else {
      setTrashDeletePending({
        ids,
        title: t('set.trashDeleteTitle'),
        message: t('set.trashDeleteConfirm', { n: ids.length }),
      });
    }
  }

  async function handleTrashDeleteConfirm() {
    const ids = trashDeletePending?.ids ?? [];
    setTrashDeletePending(null);
    if (ids.length === 0) return;
    await permanentDeleteItems(ids);
    bump();
    await refreshTrash();
    showInfo(t('set.trashDeleteTitle'), t('set.trashDeleted', { n: ids.length }));
  }

  /** Lưu trữ trên Cloud của Smartstash: dịch mã lỗi service thành câu báo cho người dùng */
  function cloudErrorMessage(e: unknown): string {
    if (e instanceof CloudBackupError) {
      switch (e.code) {
        case 'NOT_CONFIGURED': return t('cloud.notConfigured');
        case 'QUOTA_EXCEEDED': return t('cloud.quotaErr');
        case 'UNAUTHORIZED': return t('cloud.authErr');
        case 'STORAGE_NOT_CONFIGURED': return t('cloud.storageErr');
        case 'NETWORK': return t('cloud.networkErr');
        default: return t('cloud.serverErr');
      }
    }
    return t('cloud.serverErr');
  }

  /** Lưu trữ trên Cloud của Smartstash: nạp usage từ máy chủ (silent = lỗi thì im lặng, dùng khi mở màn) */
  async function refreshCloudUsage(silent = false): Promise<void> {
    const url = await getCloudApiUrl();
    if (!url) {
      setCloudUsage(null);
      return;
    }
    try {
      const usage = await getCloudUsage();
      setCloudUsage(usage);
      setCloudTierState(usage.tier_mb);
    } catch (e) {
      if (!silent) showInfo(t('cloud.title'), cloudErrorMessage(e));
    }
  }

  /** Lưu trữ trên Cloud của Smartstash: đổi gói (v101) — gói lưu trữ chỉ
      đổi được qua quản trị viên kể từ khi máy chủ ngừng tin tier do app
      khai báo (27/10/2026, route POST /api/backups/tier đã gỡ). Bấm gói
      khác chỉ hiện popup hướng dẫn liên hệ hỗ trợ; lựa chọn hiển thị
      vẫn là gói thật từ máy chủ (usage.tier_mb) nên không lệch. */
  async function handleCloudTierChange(mb: number): Promise<void> {
    if (mb === cloudTier) return;
    showInfo(t('cloud.title'), t('cloud.tierByAdmin', { email: 'dungnt.apps@gmail.com' }));
  }

  /** Lưu trữ trên Cloud của Smartstash: mở modal mật khẩu (xoá trắng ô + lỗi mỗi lần mở) */
  function openCloudPwModal(mode: 'upload' | 'restore', fileName?: string): void {
    setCloudPw('');
    setCloudPwConfirm('');
    setCloudPwError(null);
    setCloudPwShow(false);
    setCloudPwBusy(false);
    setCloudPwModal({ mode, fileName });
  }

  /** Lưu trữ trên Cloud của Smartstash: xác nhận modal mật khẩu — upload thì sao lưu ngay,
      restore thì chuyển sang bước xác nhận ghi đè */
  async function handleCloudPwSubmit(): Promise<void> {
    if (!cloudPwModal) return;
    if (cloudPwModal.mode === 'upload') {
      if (cloudPw.length < 6) {
        setCloudPwError(t('backup.pwTooShort'));
        return;
      }
      if (cloudPw !== cloudPwConfirm) {
        setCloudPwError(t('backup.pwMismatch'));
        return;
      }
    } else if (cloudPw.length === 0) {
      setCloudPwError(t('backup.pwEmpty'));
      return;
    }
    setCloudPwBusy(true);
    try {
      if (cloudPwModal.mode === 'upload') {
        const res = await uploadCloudBackup(cloudPw);
        setCloudPwModal(null);
        setCloudPw('');
        setCloudPwConfirm('');
        showInfo(t('cloud.title'), t('cloud.backupDone', { name: res.name }));
        await refreshCloudUsage(true).catch(() => {});
      } else {
        setPendingCloudRestore({ fileName: cloudPwModal.fileName ?? '', password: cloudPw });
        setCloudPwModal(null);
        setCloudPw('');
        setCloudPwConfirm('');
        setShowCloudOverwrite(true);
      }
    } catch (e) {
      setCloudPwError(cloudErrorMessage(e));
    } finally {
      setCloudPwBusy(false);
    }
  }

  /** Lưu trữ trên Cloud của Smartstash: xác nhận ghi đè → tải bản trên mây về và khôi phục */
  async function handleCloudRestoreConfirm(): Promise<void> {
    if (!pendingCloudRestore) return;
    setShowCloudOverwrite(false);
    setCloudBusy(true);
    try {
      await downloadCloudBackup(pendingCloudRestore.fileName, pendingCloudRestore.password);
      setPendingCloudRestore(null);
      bump();
      showInfo(t('cloud.title'), t('cloud.restoreDone'));
      await refreshCloudUsage(true).catch(() => {});
    } catch (e) {
      if (e instanceof BackupError) {
        showInfo(t('cloud.title'), e.code === 'WRONG_PASSWORD' ? t('backup.wrongPw') : t('backup.invalidFile'));
      } else {
        showInfo(t('cloud.title'), cloudErrorMessage(e));
      }
    } finally {
      setCloudBusy(false);
    }
  }

  /** Đổi một tuỳ chọn cảnh báo: lưu alert_cfg + đặt lại lịch nhắc + báo các màn khác tải lại */
  async function changeAlert<K extends keyof AlertSettings>(key: K, value: AlertSettings[K]) {
    const next = await setAlertSetting(key, value);
    setAlertCfgState(next);
    rescheduleAllReminders().catch(() => {});
    bump();
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
      if (e.code === 'QUOTA') return t('drive.quotaErr');
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

  /** Kiểm tra cập nhật: làm mới cấu hình từ xa rồi báo kết quả bằng popup */
  async function handleCheckUpdate() {
    await loadRemoteConfig().catch(() => {});
    setMaintenanceNotice(getMaintenanceNotice());
    const minV = getMinVersion();
    setUpdateRequired(isUpdateRequired(minV) ? minV : null);
    if (isUpdateRequired(minV)) {
      showInfo(t('set.supCheckTitle'), t('set.supCheckNew', { v: minV ?? '' }));
    } else {
      showInfo(t('set.supCheckTitle'), t('set.supCheckLatest'));
    }
  }

  /** Danh sách 8 menu to ở màn chính (tiêu đề + mô tả + tile iOS) —
      thứ tự v83: Backup lên đầu (thay chỗ Data cũ), Data xuống ngay
      trên Support; các menu còn lại giữ nguyên thứ tự tương đối. */
  const MENUS: { id: PanelId; title: string; desc: string; icon: IconName; color: string }[] = [
    { id: 'backup', title: t('set.menuBackup'), desc: t('set.menuBackupDesc'), icon: 'cloud-upload-outline', color: '#5AC8FA' },
    { id: 'app', title: t('set.app'), desc: t('set.menuAppDesc'), icon: 'apps', color: '#AF52DE' },
    { id: 'alerts', title: t('settings.alertsTitle'), desc: t('set.menuAlertsDesc'), icon: 'notifications', color: '#FF9500' },
    { id: 'security', title: t('settings.securityTitle'), desc: t('set.menuSecurityDesc'), icon: 'lock-closed', color: '#34C759' },
    { id: 'tools', title: t('set.menuTools'), desc: t('set.menuToolsDesc'), icon: 'construct-outline', color: '#007AFF' },
    { id: 'data', title: t('set.menuData'), desc: t('set.menuDataDesc'), icon: 'server', color: '#007AFF' },
    { id: 'support', title: t('set.menuSupport'), desc: t('set.menuSupportDesc'), icon: 'information-circle-outline', color: '#AF52DE' },
    { id: 'trash', title: t('set.trash'), desc: t('set.trashSubtitle'), icon: 'trash-outline', color: '#FF3B30' },
  ];

  /** Menu sau khi lọc theo ô tìm kiếm (không dấu) */
  const visibleMenus = MENUS.filter((m) => {
    const q = stripMarks(menuQuery.trim());
    if (!q) return true;
    return stripMarks(`${m.title} ${m.desc}`).includes(q);
  });

  /** Mở bảng của nhóm + cuộn về đầu màn (panel render thay vị trí danh sách) */
  function openPanel(id: PanelId) {
    setActivePanel(id);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }

  /** Quay lại danh sách menu từ bảng của nhóm */
  function goBackToMenus() {
    setActivePanel(null);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }

  /** Quét mã QR từ bảng Công cụ: dùng đúng BarcodeScannerModal + lookup
      của Trang chủ — đồ → chi tiết đồ, vị trí → chi tiết vị trí, mã lạ → popup. */
  async function handleToolsScanned(data: string) {
    const foundItem = await findItemByBarcode(data);
    if (foundItem) { router.push(`/item/${foundItem.id}`); return; }
    const foundLoc = await findLocationByQrCode(data);
    if (foundLoc) { router.push(`/location/${foundLoc.id}`); return; }
    showInfo(t('set.toolScan'), t('set.scanNotFound'));
  }

  /** Tiêu đề bảng đang mở (tra từ MENUS để khỏi hardcode thêm key) */
  const panelTitle = MENUS.find((m) => m.id === activePanel)?.title ?? '';

  return (
    <ScrollView ref={scrollRef} style={[styles.screen, { paddingTop: 54 }]} contentContainerStyle={[styles.content, { paddingBottom: TAB_BAR_CLEARANCE }]}>
      {/* Màn chính: tiêu đề lớn + ô tìm kiếm + thẻ tài khoản. Bảng của nhóm:
          header riêng có nút quay lại về danh sách menu. */}
      {activePanel === null ? (
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 34, fontWeight: '800', color: Colors.text }}>{t('set.title')}</Text>
          <View style={[styles.searchBar, { marginTop: 8 }]}>
            <Ionicons name="search" size={20} color={Colors.subtext} />
            <TextInput
              style={{ flex: 1, fontSize: 15, color: Colors.text }}
              value={menuQuery}
              onChangeText={setMenuQuery}
              placeholder={t('set.searchPlaceholder')}
              placeholderTextColor={Colors.subtext}
              autoCorrect={false}
            />
            {menuQuery.length > 0 && (
              <TouchableOpacity onPress={() => setMenuQuery('')} hitSlop={6}>
                <Ionicons name="close-circle" size={20} color={Colors.subtext} />
              </TouchableOpacity>
            )}
          </View>
          {/* Thẻ tài khoản: avatar bền từ app_kv (cùng cách màn Home dùng);
              chưa có avatar thì vòng tím + icon người. Chỉ hiển thị.
              v83: đã đăng nhập Google (đổi mã) thì thẻ phải cho thấy rõ
              tài khoản đó — huy hiệu logo Google góc avatar + dòng email
              riêng dưới dòng gói; chưa đăng nhập thì giữ nguyên như cũ. */}
          <View style={[styles.card, { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 }]}>
            <View style={{ position: 'relative' }}>
              <View style={{ width: 56, height: 56, borderRadius: 28, overflow: 'hidden', backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' }}>
                {avatarUri ? (
                  <Image source={{ uri: avatarUri }} style={{ width: 56, height: 56 }} />
                ) : (
                  <Ionicons name="person" size={28} color="#fff" />
                )}
              </View>
              {promoConnectedState && (
                <View style={{ position: 'absolute', right: -2, bottom: -2, width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff', borderWidth: 1, borderColor: '#E5E0F5', alignItems: 'center', justifyContent: 'center' }}>
                  <Image source={require('../../../assets/images/google-g.png')} style={{ width: 15, height: 15 }} />
                </View>
              )}
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ flex: 1, fontSize: 16, fontWeight: '800', color: Colors.text }}>{t('set.accountTitle')}</Text>
                <PlanBadge planId={planId} />
              </View>
              <Text style={{ fontSize: 12.5, color: Colors.subtext, marginTop: 2 }}>
                {planId === 'PRO' ? t('plan.namePro') : t('set.planName')} · {t('set.accountLocal')}
              </Text>
              {promoConnectedState && promoEmail ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <Image source={require('../../../assets/images/google-g.png')} style={{ width: 16, height: 16 }} />
                  <Text style={{ flex: 1, fontSize: 12.5, color: Colors.subtext }} numberOfLines={1} ellipsizeMode="middle">
                    {promoEmail}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <TouchableOpacity
            onPress={goBackToMenus}
            hitSlop={8}
            style={{
              width: 40, height: 40, borderRadius: 20, backgroundColor: '#fff',
              alignItems: 'center', justifyContent: 'center', ...cardShadow,
            }}
          >
            <Ionicons name="chevron-back" size={22} color={Colors.primaryDark} />
          </TouchableOpacity>
          <Text style={{ flex: 1, fontSize: 26, fontWeight: '800', color: Colors.text }}>{panelTitle}</Text>
        </View>
      )}

      {/* Banner từ máy chủ (cấu hình từ xa): bảo trì + nhắc cập nhật. Chỉ màn chính. */}
      {activePanel === null && maintenanceNotice ? (
        <View style={{ backgroundColor: '#FEF3C7', borderRadius: 16, padding: 14, marginBottom: 6 }}>
          <Text style={{ fontSize: 13.5, fontWeight: '700', color: '#7C2D12' }}>{maintenanceNotice}</Text>
        </View>
      ) : null}
      {activePanel === null && updateRequired ? (
        <View style={{ backgroundColor: '#FEF3C7', borderRadius: 16, padding: 14, marginBottom: 6 }}>
          <Text style={{ fontSize: 13.5, fontWeight: '700', color: '#7C2D12' }}>
            {t('set.updateAvailable', { v: updateRequired })}
          </Text>
        </View>
      ) : null}

      {/* Thẻ gói SmartStash: gói hiện tại + quyền lợi. Chỉ màn chính. */}
      {activePanel === null && (
      <View
        style={{
          backgroundColor: Colors.deep, borderRadius: 24, padding: 18, gap: 8, overflow: 'hidden',
          shadowColor: Colors.deep, shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.3, shadowRadius: 20, elevation: 8,
        }}
      >
        <View pointerEvents="none" style={{ position: 'absolute', width: 150, height: 150, borderRadius: 75, backgroundColor: Colors.coral, opacity: 0.3, top: -75, right: -40 }} />
        <View pointerEvents="none" style={{ position: 'absolute', width: 100, height: 100, borderRadius: 50, backgroundColor: Colors.teal, opacity: 0.28, bottom: -55, left: -25 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
          {/* v84: icon gói khác hẳn nhau — Pro kim cương nền vàng cam,
              Free khối nền xám tím (trước đây cả hai cùng icon quà tặng) */}
          <View style={{ width: 46, height: 46, borderRadius: 16, backgroundColor: planId === 'PRO' ? '#FF9F43' : '#6E6890', alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name={planId === 'PRO' ? 'diamond' : 'cube-outline'} size={23} color="#fff" />
          </View>
          <Text style={{ flex: 1, flexShrink: 1, fontSize: 17, fontWeight: '800', color: '#fff' }}>
            {planId === 'PRO' ? t('plan.namePro') : t('set.planName')}
          </Text>
          <PlanBadge planId={planId} dark />
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
            Play (vốn chỉ nằm trong modal promo) vẫn tới được như cũ. */}
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
      </View>
      )}

      {/* Danh sách 8 menu to ở màn chính (lọc theo ô tìm kiếm) */}
      {activePanel === null && (
        <View style={{ gap: 12 }}>
          {visibleMenus.map((m) => (
            <TouchableOpacity
              key={m.id}
              onPress={() => openPanel(m.id)}
              activeOpacity={0.8}
              style={[styles.card, { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 }]}
            >
              <IOSTile icon={m.icon} color={m.color} size={52} iconSize={26} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 17, fontWeight: '700', color: Colors.text }}>{m.title}</Text>
                <Text style={{ fontSize: 13, color: Colors.subtext, marginTop: 2 }}>{m.desc}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={Colors.subtext} />
            </TouchableOpacity>
          ))}
          {visibleMenus.length === 0 && (
            <Text style={{ color: Colors.subtext, fontSize: 14, textAlign: 'center', marginTop: 8 }}>{t('set.searchEmpty')}</Text>
          )}
        </View>
      )}

      {activePanel === 'data' && (
      <View style={[styles.card, { gap: 7 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
          <IOSTile icon="server" color={Colors.teal} size={46} iconSize={23} />
          <Text style={{ flex: 1, flexShrink: 1, fontSize: 16, fontWeight: '800', color: Colors.text }}>{t('set.dataTitle')}</Text>
        </View>
        <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>
          {t('set.dataLocal')}
        </Text>
        <Text style={{ color: Colors.subtext, fontSize: 13 }}>
          {t('set.dataStats', { a: activeCount, l: locCount })}
        </Text>
        <Text style={{ color: Colors.subtext, fontSize: 13 }}>
          {t('set.dataTech', { v: SCHEMA_VERSION, s: ftsAvailable ? t('set.ftsOn') : t('set.ftsOff') })}
        </Text>
        <TouchableOpacity
          onPress={() => openPanel('backup')}
          activeOpacity={0.7}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}
        >
          <Ionicons name="shield-checkmark-outline" size={16} color={Colors.primary} />
          <Text style={{ flex: 1, fontSize: 13.5, fontWeight: '700', color: Colors.primary }}>{t('set.dataBackupLink')}</Text>
          <Ionicons name="chevron-forward" size={15} color={Colors.subtext} />
        </TouchableOpacity>
      </View>
      )}

      {/* Ứng dụng: ngôn ngữ (segmented control) + đặt lại lịch nhắc, gộp 1 thẻ */}
      {activePanel === 'app' && (
      <View style={[styles.card, { gap: 12 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
          <IOSTile icon="apps" color={Colors.sky} size={46} iconSize={23} />
          <Text style={{ flex: 1, flexShrink: 1, fontSize: 16, fontWeight: '800', color: Colors.text }}>{t('set.app')}</Text>
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
          <IOSTile icon="notifications" color={Colors.orange} size={44} iconSize={22} />
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
        <View style={{ height: 1, backgroundColor: '#F0EDFA' }} />
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
          onPress={() => { Linking.openSettings().catch(() => {}); }}
          activeOpacity={0.7}
        >
          <IOSTile icon="shield-outline" color="#007AFF" size={44} iconSize={22} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: Colors.text }}>{t('set.appPerms')}</Text>
            <Text style={{ fontSize: 12, color: Colors.subtext, marginTop: 1 }}>{t('set.appPermsDesc')}</Text>
          </View>
          <Ionicons name="chevron-forward" size={17} color={Colors.subtext} />
        </TouchableOpacity>
      </View>
      )}

      {/* Cảnh báo 4 mức: 2 ngưỡng ngày dạng segmented + công tắc thông báo theo loại */}
      {activePanel === 'alerts' && (
      <View style={[styles.card, { gap: 12 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
          <IOSTile icon="notifications" color={Colors.red} size={46} iconSize={23} />
          <Text style={{ flex: 1, flexShrink: 1, fontSize: 16, fontWeight: '800', color: Colors.text }}>{t('settings.alertsTitle')}</Text>
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
      )}

      {/* Bảo mật: khoá app bằng PIN + sinh trắc (Phase 6) */}
      {activePanel === 'security' && (
      <>
      {/* Thẻ tổng quan bảo mật: chip trạng thái cập nhật theo công tắc thật */}
      <View style={[styles.card, { gap: 10 }]}>
        <Text style={{ fontSize: 16, fontWeight: '800', color: Colors.text }}>{t('set.secOverview')}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <View style={{ backgroundColor: Colors.chipBg, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }}>
            <Text style={{ fontSize: 12.5, fontWeight: '700', color: lockCfg?.lockEnabled ? Colors.green : Colors.subtext }}>
              {lockCfg?.lockEnabled ? t('set.secLockOn') : t('set.secLockOff')}
            </Text>
          </View>
          {bioAvail && (
            <View style={{ backgroundColor: Colors.chipBg, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }}>
              <Text style={{ fontSize: 12.5, fontWeight: '700', color: lockCfg?.biometricEnabled ? Colors.green : Colors.subtext }}>
                {lockCfg?.biometricEnabled ? t('set.secBioOn') : t('set.secBioOff')}
              </Text>
            </View>
          )}
          <View style={{ backgroundColor: Colors.chipBg, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }}>
            <Text style={{ fontSize: 12.5, fontWeight: '700', color: Colors.green }}>{t('set.secEncrypted')}</Text>
          </View>
        </View>
      </View>
      <View style={[styles.card, { gap: 12 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
          <IOSTile icon="lock-closed" color={Colors.primary} size={46} iconSize={23} />
          <Text style={{ flex: 1, flexShrink: 1, fontSize: 16, fontWeight: '800', color: Colors.text }}>{t('settings.securityTitle')}</Text>
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
                {/* Thẻ PIN sinh động: dãy chấm che mã + chip trạng thái + nút đổi
                    + "Quên PIN?" (mở cảnh báo quên PIN = xoá dữ liệu đã có).
                    Dãy chấm chỉ là mặt nạ hiển thị — độ dài PIN thật (4–6 số)
                    không lưu ở đâu nên không khẳng định số chữ số cụ thể. */}
                <View style={{ backgroundColor: Colors.chipBg, borderRadius: 16, padding: 14, gap: 8 }}>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: Colors.text }}>{t('set.pinTitle')}</Text>
                  <Text style={{ fontSize: 22, letterSpacing: 6, color: Colors.text }}>••••••</Text>
                  <View style={{ flexDirection: 'row' }}>
                    <View style={{ backgroundColor: '#fff', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: Colors.green }}>{t('set.pinSet')}</Text>
                    </View>
                  </View>
                  <AppButton
                    title={t('settings.changePin')}
                    variant="secondary"
                    icon="key-outline"
                    onPress={() => openPinModal('change')}
                  />
                  <Text style={{ fontSize: 12, color: Colors.subtext, lineHeight: 17 }}>{t('set.pinHint')}</Text>
                  <TouchableOpacity
                    onPress={() => showInfo(t('settings.securityTitle'), t('lock.forgotWarning'))}
                    activeOpacity={0.7}
                  >
                    <Text style={{ fontSize: 13.5, fontWeight: '600', color: Colors.danger }}>{t('set.pinForgot')}</Text>
                  </TouchableOpacity>
                </View>
                {bioAvail && (
                  <>
                    <View style={{ height: 1, backgroundColor: '#F0EDFA' }} />
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14.5, fontWeight: '600', color: Colors.text }}>{t('settings.biometric')}</Text>
                        <Text style={{ fontSize: 12, color: Colors.subtext, marginTop: 1 }}>{t('set.secBioDesc')}</Text>
                      </View>
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
                <Text style={{ fontSize: 12, color: Colors.subtext }}>{t('set.secTimeoutDesc')}</Text>
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
      {/* Khối thông tin: dữ liệu được bảo vệ như thế nào (đúng kiến trúc app thật) */}
      <View style={[styles.card, { gap: 8 }]}>
        <Text style={{ fontSize: 16, fontWeight: '800', color: Colors.text }}>{t('set.secHowTitle')}</Text>
        <Text style={{ fontSize: 13, color: Colors.subtext, lineHeight: 19 }}>• {t('set.secHowPin')}</Text>
        <Text style={{ fontSize: 13, color: Colors.subtext, lineHeight: 19 }}>• {t('set.secHowBackup')}</Text>
        <Text style={{ fontSize: 13, color: Colors.subtext, lineHeight: 19 }}>• {t('set.secHowDrive')}</Text>
        <Text style={{ fontSize: 13, color: Colors.subtext, lineHeight: 19 }}>• {t('set.secHowLocal')}</Text>
      </View>
      <View style={[styles.card, { gap: 8 }]}>
        <Text style={{ fontSize: 16, fontWeight: '800', color: Colors.text }}>{t('set.secTipsTitle')}</Text>
        <Text style={{ fontSize: 13, color: Colors.subtext, lineHeight: 19 }}>• {t('set.secTip1')}</Text>
        <Text style={{ fontSize: 13, color: Colors.subtext, lineHeight: 19 }}>• {t('set.secTip2')}</Text>
        <Text style={{ fontSize: 13, color: Colors.subtext, lineHeight: 19 }}>• {t('set.secTip3')}</Text>
      </View>
      </>)}
      {/* Sao lưu & khôi phục bằng file mã hoá (Phase 5 lõi) */}
      {activePanel === 'backup' && (
      <View style={[styles.card, { gap: 12 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
          <IOSTile icon="cloud-upload-outline" color={Colors.sky} size={46} iconSize={23} />
          <Text style={{ flex: 1, flexShrink: 1, fontSize: 16, fontWeight: '800', color: Colors.text }}>{t('backup.title')}</Text>
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
        {/* Google Drive của khách (BYOC): khách kết nối Drive của CHÍNH họ —
            app chỉ kích hoạt mục này khi đã cấu hình Client ID (xem config.ts) */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <IOSTile icon="logo-google" color={Colors.sky} size={44} iconSize={22} />
          <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: Colors.text }}>{t('drive.title')}</Text>
        </View>
        {/* v102: cảnh báo dung lượng Drive — chỉ hiện khi Drive đã mở
            (lúc khoá chỉ hiện thông báo khoá, không thêm dòng này). */}
        {driveBackupEnabled && (
          <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>{t('drive.storageNote')}</Text>
        )}
        {!driveBackupEnabled ? (
          /* v84: Drive đang khoá bởi quản trị — chỉ hiện thông báo khoá,
             không hiện nút kết nối (bấm vào cũng không đăng nhập được). */
          <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>{t('drive.lockedMsg')}</Text>
        ) : !driveConfigured ? (
          <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>{t('drive.notConfigured')}</Text>
        ) : !driveConnectedState ? (
          <>
            <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>{t('drive.desc')}</Text>
            <DriveConnectButton
              loading={driveBusy}
              onConnect={() => { handleDriveConnect().catch(() => {}); }}
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
            <AppButton
              title={t('promo.switchAccount')}
              variant="secondary"
              icon="swap-horizontal-outline"
              loading={googleSwitchBusy}
              onPress={() => { handleSwitchGoogleAccount('drive').catch(() => {}); }}
            />
            <Text style={{ color: Colors.subtext, fontSize: 12.5, lineHeight: 18 }}>
              {t('promo.sharedAccountNote')}
            </Text>
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
      )}

      {/* Lưu trữ trên Cloud của Smartstash: sao lưu mã hoá lên Worker — chỉ dành cho gói Pro (mở bằng mã khuyến mại cho tới khi paywall lên sóng) */}
      {activePanel === 'backup' && (
      <View style={[styles.card, { gap: 12 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
          <IOSTile icon="cloud-outline" color={Colors.sky} size={46} iconSize={23} />
          <Text style={{ flex: 1, flexShrink: 1, fontSize: 16, fontWeight: '800', color: Colors.coral }}>{t('cloud.title')}</Text>
        </View>
        <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>{t('cloud.desc')}</Text>
        {!cloudBackupEnabled ? (
          /* v84: mây đang khoá bởi quản trị — chỉ hiện thông báo khoá,
             không hiện chọn gói / sao lưu / khôi phục cho bất kỳ gói nào. */
          <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>{t('cloud.lockedMsg')}</Text>
        ) : planId !== 'PRO' ? (
          <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>{t('cloud.proOnly')}</Text>
        ) : (
          <>
            <Text style={{ fontSize: 14.5, fontWeight: '600', color: Colors.text }}>{t('cloud.tierLabel')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {storagePlans.map((p) => (
                <TouchableOpacity
                  key={p.sizeMb}
                  onPress={() => { handleCloudTierChange(p.sizeMb).catch(() => {}); }}
                  disabled={cloudBusy}
                  style={{
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    borderRadius: 999,
                    backgroundColor: cloudTier === p.sizeMb ? Colors.primary : Colors.chipBg,
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: '700', color: cloudTier === p.sizeMb ? '#fff' : Colors.text }}>
                    {p.sizeMb >= 1000 ? `${p.sizeMb / 1000} GB` : `${p.sizeMb} MB`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={{ gap: 4 }}>
              {storagePlans.map((p) => {
                const sizeLabel = p.sizeMb >= 1000 ? `${p.sizeMb / 1000} GB` : `${p.sizeMb} MB`;
                const current = cloudTier === p.sizeMb;
                return (
                  <Text
                    key={p.sizeMb}
                    style={{ fontSize: 13, color: current ? Colors.text : Colors.subtext, fontWeight: current ? '700' : '400' }}
                  >
                    {sizeLabel} — {t('cloud.priceYear', { price: p.priceVnd.toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US') })}{current ? ` · ${t('cloud.currentPlan')}` : ''}
                  </Text>
                );
              })}
            </View>
            <Text style={{ fontSize: 12.5, color: Colors.subtext }}>
              {cloudUsage
                ? t('cloud.usage', { used: formatBytes(cloudUsage.used_bytes), quota: formatBytes(cloudUsage.quota_bytes) })
                : t('cloud.usageUnknown')}
            </Text>
            <Text style={{ fontSize: 12, color: Colors.subtext }}>{t('cloud.filesNote')}</Text>
            <AppButton
              title={t('cloud.backupNowBtn')}
              variant="secondary"
              icon="cloud-upload-outline"
              loading={cloudBusy}
              onPress={() => openCloudPwModal('upload')}
            />
            <AppButton
              title={t('cloud.refreshBtn')}
              variant="secondary"
              icon="refresh-outline"
              disabled={cloudBusy}
              onPress={() => { refreshCloudUsage().catch(() => {}); }}
            />
            {cloudUsage && cloudUsage.files.length > 0 && (
              <>
                <Text style={{ fontSize: 14.5, fontWeight: '600', color: Colors.text }}>
                  {t('cloud.restoreList', { n: cloudUsage.files.length })}
                </Text>
                {cloudUsage.files.map((f) => (
                  <TouchableOpacity
                    key={f.name}
                    onPress={() => openCloudPwModal('restore', f.name)}
                    disabled={cloudBusy}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
                  >
                    <Ionicons name="document-outline" size={17} color={Colors.subtext} />
                    <Text style={{ flex: 1, fontSize: 13.5, color: Colors.text }}>{f.name}</Text>
                    <Text style={{ fontSize: 12, color: Colors.subtext }}>{formatBytes(f.size)}</Text>
                  </TouchableOpacity>
                ))}
              </>
            )}
            {cloudUsage && cloudUsage.files.length === 0 && (
              <Text style={{ fontSize: 12.5, color: Colors.subtext }}>{t('cloud.noBackups')}</Text>
            )}
          </>
        )}
      </View>
      )}

      {/* Dữ liệu thử nghiệm: seed ~30 món mẫu để trải nghiệm app */}
      {activePanel === 'data' && (
      <View style={[styles.card, { gap: 12 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
          <IOSTile icon="flask-outline" color={Colors.coral} size={46} iconSize={23} />
          <Text style={{ flex: 1, flexShrink: 1, fontSize: 16, fontWeight: '800', color: Colors.text }}>{t('settings.demoTitle')}</Text>
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
      )}

      {/* Công cụ: mô tả đầu bảng + các hàng + thẻ mẹo cuối bảng.
          Hàng Quét mã QR dùng đúng BarcodeScannerModal + lookup của Trang chủ. */}
      {activePanel === 'tools' && (
      <>
      <View style={[styles.card, { gap: 6 }]}>
        <Text style={{ fontSize: 16, fontWeight: '800', color: Colors.text }}>{t('set.toolsIntro')}</Text>
        <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>{t('set.toolsIntroDesc')}</Text>
      </View>
      <View style={[styles.card, { padding: 0, overflow: 'hidden' }]}>
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 }}
          onPress={handleExportCsv}
          disabled={exporting}
          activeOpacity={0.7}
        >
          <IOSTile icon="download" color={Colors.teal} size={44} iconSize={22} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: Colors.text }}>
              {exporting ? t('set.exporting') : t('set.exportCsv')}
            </Text>
            <Text style={{ fontSize: 12, color: Colors.subtext, marginTop: 1 }}>{t('set.toolCsvDesc')}</Text>
          </View>
          <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(15,181,168,0.11)', alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="chevron-forward" size={16} color={Colors.teal} />
          </View>
        </TouchableOpacity>
        <View style={{ height: 1, backgroundColor: '#F0EDFA', marginLeft: 70, marginRight: 14 }} />
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 }}
          onPress={() => setShowScanner(true)}
          activeOpacity={0.7}
        >
          <IOSTile icon="scan-outline" color="#007AFF" size={44} iconSize={22} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: Colors.text }}>{t('set.toolScan')}</Text>
            <Text style={{ fontSize: 12, color: Colors.subtext, marginTop: 1 }}>{t('set.toolScanDesc')}</Text>
          </View>
          <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(0,122,255,0.11)', alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="chevron-forward" size={16} color="#007AFF" />
          </View>
        </TouchableOpacity>
        <View style={{ height: 1, backgroundColor: '#F0EDFA', marginLeft: 70, marginRight: 14 }} />
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 }}
          onPress={() => router.push('/labels')}
          activeOpacity={0.7}
        >
          <IOSTile icon="qr-code-outline" color={Colors.primary} size={44} iconSize={22} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: Colors.text }}>
              {t('settings.printLabels')}
            </Text>
            <Text style={{ fontSize: 12, color: Colors.subtext, marginTop: 1 }}>{t('set.toolQrDesc')}</Text>
          </View>
          <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(109,40,217,0.11)', alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="chevron-forward" size={16} color={Colors.primary} />
          </View>
        </TouchableOpacity>
        <View style={{ height: 1, backgroundColor: '#F0EDFA', marginLeft: 70, marginRight: 14 }} />
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 }}
          onPress={() => router.push('/onboarding')}
          activeOpacity={0.7}
        >
          <IOSTile icon="play-circle" color={Colors.coral} size={44} iconSize={22} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: Colors.text }}>{t('set.replayIntro')}</Text>
            <Text style={{ fontSize: 12, color: Colors.subtext, marginTop: 1 }}>{t('set.toolReplayDesc')}</Text>
          </View>
          <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(255,90,118,0.11)', alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="chevron-forward" size={16} color={Colors.coral} />
          </View>
        </TouchableOpacity>
      </View>
      <View style={[styles.card, { gap: 6 }]}>
        <Text style={{ fontSize: 15, fontWeight: '800', color: Colors.text }}>{t('set.toolsTipTitle')}</Text>
        <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>{t('set.toolsTipBody')}</Text>
      </View>
      </>
      )}

      {/* Hỗ trợ & thông tin: 2 nhóm con — Hỗ trợ và Thông tin.
          Hàng Đánh giá Play vẫn chưa có (chưa có trang Play). Privacy/Terms
          mở màn hình trong app (v71) thay vì link web vì chưa hosting. */}
      {activePanel === 'support' && (
      <>
      <Text style={{ fontSize: 15, fontWeight: '800', color: Colors.text }}>{t('ai.title')}</Text>
      <View style={[styles.card, { gap: 12 }]}>
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
          onPress={() => router.push('/assistant')}
          activeOpacity={0.7}
        >
          <IOSTile icon="chatbubble-ellipses-outline" color={Colors.primary} size={44} iconSize={22} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: Colors.text }}>{t('ai.chatBtn')}</Text>
            <Text style={{ fontSize: 12, color: Colors.subtext, marginTop: 1 }}>{t('ai.noSetup')}</Text>
          </View>
          <Ionicons name="chevron-forward" size={17} color={Colors.subtext} />
        </TouchableOpacity>
        <View style={{ height: 1, backgroundColor: '#F0EDFA' }} />
        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: 12.5, color: Colors.subtext, lineHeight: 18 }}>{t('ai.limitNote')}</Text>
          <Text style={{ fontSize: 12.5, color: Colors.subtext, lineHeight: 18 }}>{t('ai.freeNote')}</Text>
        </View>
      </View>
      <Text style={{ fontSize: 15, fontWeight: '800', color: Colors.text }}>{t('set.supGroupSupport')}</Text>
      <View style={[styles.card, { padding: 0, overflow: 'hidden' }]}>
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}
          onPress={() => router.push('/guide')}
          activeOpacity={0.7}
        >
          <IOSTile icon="book-outline" color={Colors.sky} size={44} iconSize={22} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: Colors.text }}>{t('guide.title')}</Text>
            <Text style={{ fontSize: 12, color: Colors.subtext, marginTop: 1 }}>{t('set.toolGuideDesc')}</Text>
          </View>
          <Ionicons name="chevron-forward" size={17} color={Colors.subtext} />
        </TouchableOpacity>
        <View style={{ height: 1, backgroundColor: '#F0EDFA', marginLeft: 70, marginRight: 14 }} />
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}
          onPress={() => router.push('/faq')}
          activeOpacity={0.7}
        >
          <IOSTile icon="help-circle-outline" color="#007AFF" size={44} iconSize={22} />
          <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: Colors.text }}>{t('set.supFaq')}</Text>
          <Ionicons name="chevron-forward" size={17} color={Colors.subtext} />
        </TouchableOpacity>
        <View style={{ height: 1, backgroundColor: '#F0EDFA', marginLeft: 70, marginRight: 14 }} />
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}
          onPress={() => { Linking.openURL(`mailto:dungnt.apps@gmail.com?subject=${encodeURIComponent(t('set.supFeedbackSubject'))}`).catch(() => {}); }}
          activeOpacity={0.7}
        >
          <IOSTile icon="chatbubble-outline" color="#34C759" size={44} iconSize={22} />
          <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: Colors.text }}>{t('set.supFeedback')}</Text>
          <Ionicons name="chevron-forward" size={17} color={Colors.subtext} />
        </TouchableOpacity>
        <View style={{ height: 1, backgroundColor: '#F0EDFA', marginLeft: 70, marginRight: 14 }} />
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}
          onPress={() => { handleCheckUpdate().catch(() => {}); }}
          activeOpacity={0.7}
        >
          <IOSTile icon="refresh-outline" color="#FF9500" size={44} iconSize={22} />
          <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: Colors.text }}>{t('set.supCheckTitle')}</Text>
          <Ionicons name="chevron-forward" size={17} color={Colors.subtext} />
        </TouchableOpacity>
        <View style={{ height: 1, backgroundColor: '#F0EDFA', marginLeft: 70, marginRight: 14 }} />
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}
          onPress={() => router.push('/changelog')}
          activeOpacity={0.7}
        >
          <IOSTile icon="sparkles-outline" color="#AF52DE" size={44} iconSize={22} />
          <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: Colors.text }}>{t('set.supChangelog')}</Text>
          <Ionicons name="chevron-forward" size={17} color={Colors.subtext} />
        </TouchableOpacity>
        <View style={{ height: 1, backgroundColor: '#F0EDFA', marginLeft: 70, marginRight: 14 }} />
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}
          onPress={() => { Share.share({ message: t('set.supShareMsg') }).catch(() => {}); }}
          activeOpacity={0.7}
        >
          <IOSTile icon="share-social-outline" color="#5AC8FA" size={44} iconSize={22} />
          <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: Colors.text }}>{t('set.supShare')}</Text>
          <Ionicons name="chevron-forward" size={17} color={Colors.subtext} />
        </TouchableOpacity>
        <View style={{ height: 1, backgroundColor: '#F0EDFA', marginLeft: 70, marginRight: 14 }} />
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}
          onPress={() => router.push('/privacy')}
          activeOpacity={0.7}
        >
          <IOSTile icon="shield-checkmark-outline" color="#34C759" size={44} iconSize={22} />
          <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: Colors.text }}>{t('set.supPrivacy')}</Text>
          <Ionicons name="chevron-forward" size={17} color={Colors.subtext} />
        </TouchableOpacity>
        <View style={{ height: 1, backgroundColor: '#F0EDFA', marginLeft: 70, marginRight: 14 }} />
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}
          onPress={() => router.push('/terms')}
          activeOpacity={0.7}
        >
          <IOSTile icon="document-text-outline" color="#FF9500" size={44} iconSize={22} />
          <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: Colors.text }}>{t('set.supTerms')}</Text>
          <Ionicons name="chevron-forward" size={17} color={Colors.subtext} />
        </TouchableOpacity>
      </View>
      <Text style={{ fontSize: 15, fontWeight: '800', color: Colors.text, marginTop: 4 }}>{t('set.supGroupInfo')}</Text>
      <View style={[styles.card, { padding: 0, overflow: 'hidden' }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}>
          <IOSTile icon="cube-outline" color="#AF52DE" size={44} iconSize={22} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: Colors.text }}>SmartStash</Text>
            {appVersion ? (
              <Text style={{ fontSize: 12, color: Colors.subtext, marginTop: 1 }}>{t('about.version', { v: appVersion })}</Text>
            ) : null}
          </View>
        </View>
        <View style={{ height: 1, backgroundColor: '#F0EDFA', marginLeft: 70, marginRight: 14 }} />
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}
          onPress={() => { Linking.openURL('mailto:dungnt.apps@gmail.com').catch(() => {}); }}
          activeOpacity={0.7}
        >
          <IOSTile icon="mail-outline" color="#007AFF" size={44} iconSize={22} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: Colors.text }}>{t('about.supportEmail')}</Text>
            <Text style={{ fontSize: 12, color: Colors.subtext, marginTop: 1 }}>dungnt.apps@gmail.com</Text>
          </View>
          <Ionicons name="chevron-forward" size={17} color={Colors.subtext} />
        </TouchableOpacity>
        <View style={{ height: 1, backgroundColor: '#F0EDFA', marginLeft: 70, marginRight: 14 }} />
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}
          onPress={() => { Linking.openURL('tel:+85588550000').catch(() => {}); }}
          activeOpacity={0.7}
        >
          <IOSTile icon="call-outline" color="#34C759" size={44} iconSize={22} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: Colors.text }}>{t('set.supPhone')}</Text>
            <Text style={{ fontSize: 12, color: Colors.subtext, marginTop: 1 }}>+85588550000</Text>
          </View>
          <Ionicons name="chevron-forward" size={17} color={Colors.subtext} />
        </TouchableOpacity>
      </View>
      </>
      )}

      {activePanel === 'trash' && (
      <View style={{ gap: 10 }}>
        <SectionTitle title={t('set.trash')} subtitle={t('set.trashSubtitle')} color={Colors.red} />
        {trash.length === 0 ? (
          <Text style={{ color: Colors.subtext, fontSize: 13 }}>{t('set.trashEmpty')}</Text>
        ) : (
          <>
            <View style={[styles.card, { gap: 10 }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <TouchableOpacity
                  onPress={() => {
                    if (trashSelected.length === trash.length) setTrashSelected([]);
                    else setTrashSelected(trash.map((i) => i.id));
                  }}
                  activeOpacity={0.8}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
                >
                  <Ionicons
                    name={trashSelected.length === trash.length ? 'checkbox' : 'square-outline'}
                    size={20}
                    color={Colors.primary}
                  />
                  <Text style={{ fontSize: 13.5, fontWeight: '700', color: Colors.text }}>
                    {trashSelected.length === trash.length ? t('set.trashDeselectAll') : t('set.trashSelectAll')}
                  </Text>
                </TouchableOpacity>
                <Text style={{ flex: 1, textAlign: 'right', fontSize: 13, color: Colors.subtext }}>
                  {t('set.trashSelected', { n: trashSelected.length })}
                </Text>
              </View>
              <AppButton
                title={t('set.trashDeleteSelected', { n: trashSelected.length })}
                variant="danger"
                icon="trash-outline"
                disabled={trashSelected.length === 0}
                onPress={() => requestTrashDelete(trashSelected)}
              />
            </View>
            {trash.map((i) => {
              const selected = trashSelected.includes(i.id);
              return (
                <TouchableOpacity
                  key={i.id}
                  activeOpacity={0.85}
                  onPress={() => toggleTrashSelect(i.id)}
                  style={[styles.card, {
                    flexDirection: 'row', alignItems: 'center', gap: 11, padding: 12,
                    backgroundColor: selected ? Colors.chipBg : undefined,
                  }]}
                >
                  <Ionicons
                    name={selected ? 'checkbox' : 'square-outline'}
                    size={21}
                    color={selected ? Colors.primary : Colors.subtext}
                  />
                  <IOSTile icon="trash-outline" color={Colors.subtext} size={42} iconSize={21} />
                  <Text style={{ flex: 1, fontSize: 14, fontWeight: '600', color: Colors.text }}>{i.name}</Text>
                  <TouchableOpacity
                    style={[styles.buttonSecondary, { paddingVertical: 8, paddingHorizontal: 12 }]}
                    onPress={async () => { await handleTrashRestore(i.id); }}
                  >
                    <Text style={[styles.buttonSecondaryText, { fontSize: 13.5 }]}>{t('set.restore')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={{ padding: 6 }}
                    hitSlop={6}
                    onPress={() => requestTrashDelete([i.id])}
                  >
                    <Ionicons name="trash-outline" size={19} color={Colors.danger} />
                  </TouchableOpacity>
                </TouchableOpacity>
              );
            })}
          </>
        )}

        {/* Vị trí đã xoá (v93): khôi phục "vị trí + đồ" hoặc "chỉ vị trí", hoặc xoá vĩnh viễn */}
        <SectionTitle title={t('set.trashLocTitle')} subtitle={t('set.trashLocSubtitle')} color={Colors.red} />
        {trashLocations.length === 0 ? (
          <Text style={{ color: Colors.subtext, fontSize: 13 }}>{t('set.trashLocEmpty')}</Text>
        ) : (
          trashLocations.map((row) => (
            <View key={row.id} style={[styles.card, { gap: 8, padding: 12 }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                <IOSTile icon="location-outline" color={Colors.subtext} size={42} iconSize={21} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: Colors.text }}>{row.name}</Text>
                  <Text style={{ fontSize: 12, color: Colors.subtext, marginTop: 1 }}>
                    {row.deletedAt ? row.deletedAt.slice(0, 16).replace('T', ' ') : ''}
                    {row.mode === 'move'
                      ? ' · ' + t('set.trashLocMoved', { n: row.movedCount, dest: row.destName ?? t('set.trashLocDestGone') })
                      : (row.subLocCount > 0 || row.subItemCount > 0
                        ? ' · ' + t('set.trashLocGroup', { locs: row.subLocCount, items: row.subItemCount })
                        : '')}
                  </Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TouchableOpacity
                  style={[styles.buttonSecondary, { flex: 1, paddingVertical: 8, alignItems: 'center' }]}
                  onPress={async () => { await handleTrashLocRestore(row.id, true); }}
                >
                  <Text style={[styles.buttonSecondaryText, { fontSize: 13.5 }]}>{t('set.trashLocRestoreAll')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.buttonSecondary, { flex: 1, paddingVertical: 8, alignItems: 'center' }]}
                  onPress={async () => { await handleTrashLocRestore(row.id, false); }}
                >
                  <Text style={[styles.buttonSecondaryText, { fontSize: 13.5 }]}>{t('set.trashLocRestoreOnly')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{ padding: 6, justifyContent: 'center' }}
                  hitSlop={6}
                  onPress={() => setLocDeletePending({ id: row.id, name: row.name })}
                >
                  <Ionicons name="trash-outline" size={19} color={Colors.danger} />
                </TouchableOpacity>
              </View>
            </View>
          ))
        )}
      </View>
      )}

      {/* v100: footer marginBottom 24 -> 14 theo yêu cầu người dùng
          (marginTop vẫn 12 như cũ; marginBottom 14 đủ để dòng footer
          không chạm nút tròn '+' Thêm đồ ở giữa thanh tab dưới). */}
      {activePanel === null && (
      <Text style={{ color: Colors.subtext, fontSize: 12, textAlign: 'center', marginTop: 12, marginBottom: 14 }}>
        {t('set.footer', { v: appVersion ?? '0.1.0' })}
      </Text>
      )}

      {/* Quét mã QR từ bảng Công cụ: dùng đúng BarcodeScannerModal của
          Trang chủ — đồ → chi tiết đồ, vị trí → chi tiết vị trí. */}
      <BarcodeScannerModal
        visible={showScanner}
        onClose={() => setShowScanner(false)}
        onScanned={(data) => { handleToolsScanned(data).catch(() => {}); }}
      />

      <AppPopup
        visible={showClearDemoPopup}
        title={t('settings.demoTitle')}
        message={t('settings.demoDeleteConfirm')}
        confirm={{ label: t('settings.demoDelete'), danger: true, onConfirm: () => { handleClearDemoConfirm().catch(() => {}); } }}
        onClose={() => setShowClearDemoPopup(false)}
      />

      {/* Xác nhận xoá vĩnh viễn khỏi thùng rác (1 món hoặc nhiều món đã chọn):
          không thể khôi phục, kể cả ảnh và lịch sử cho mượn của món. */}
      <AppPopup
        visible={trashDeletePending !== null}
        title={trashDeletePending?.title ?? ''}
        message={trashDeletePending?.message}
        confirm={{ label: t('set.trashDeleteBtn'), danger: true, onConfirm: () => { handleTrashDeleteConfirm().catch(() => {}); } }}
        onClose={() => setTrashDeletePending(null)}
      />

      {/* Xác nhận xoá vĩnh viễn một vị trí trong thùng rác (v93): đợt xoá
          tất cả thì xoá hẳn cả đồ/vị trí con cùng đợt; đợt chuyển đồ thì
          chỉ xoá hàng vị trí vì đồ đang sống ở chỗ khác. */}
      <AppPopup
        visible={locDeletePending !== null}
        title={t('set.trashLocDeleteTitle')}
        message={t('set.trashLocDeleteConfirm', { name: locDeletePending?.name ?? '' })}
        confirm={{ label: t('set.trashDeleteBtn'), danger: true, onConfirm: () => { handleTrashLocDeleteConfirm().catch(() => {}); } }}
        onClose={() => setLocDeletePending(null)}
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
      {/* Modal nhập mã khuyến mãi qua máy chủ (v78): chưa đăng nhập Google
          thì hiện khối đăng nhập trước, đăng nhập xong mới hiện ô nhập mã;
          mục Google Play bên dưới mở trang redeem chính thức. */}
      <Modal visible={promoOpen} transparent animationType="fade" onRequestClose={() => setPromoOpen(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setPromoOpen(false)}>
          <Pressable style={[styles.card, styles.modalCard, { gap: 6 }]} onPress={() => {}}>
            <Text style={{ fontSize: 17, fontWeight: '800', color: Colors.text }}>
              {t('promo.title')}
            </Text>
            <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>
              {t('promo.desc')}
            </Text>
            {promoConnectedState ? (
              <>
                {promoEmail ? (
                  <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>
                    {t('promo.currentAccount', { email: promoEmail })}
                  </Text>
                ) : null}
                {/* v82: bỏ ghi chú "1 tài khoản chung cho đổi mã + Drive" —
                    từ đây đổi mã dùng tài khoản riêng scope cơ bản, Drive
                    đang tạm dừng nên không còn "đổi chung cả hai". */}
                <AppButton
                  title={t('promo.switchAccount')}
                  icon="swap-horizontal-outline"
                  variant="secondary"
                  style={{ marginTop: 8 }}
                  loading={googleSwitchBusy}
                  onPress={() => { handleSwitchGoogleAccount('modal').catch(() => {}); }}
                />
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
              </>
            ) : (
              <>
                <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19, marginTop: 10 }}>
                  {t('promo.loginRequired')}
                </Text>
                <Text style={{ color: Colors.subtext, fontSize: 12.5, lineHeight: 18 }}>
                  {t('promo.loginNote')}
                </Text>
                {promoError && (
                  <Text style={{ color: Colors.danger, fontSize: 13, marginTop: 8 }}>{promoError}</Text>
                )}
                <AppButton
                  title={t('promo.loginBtn')}
                  icon="logo-google"
                  style={{ marginTop: 14 }}
                  loading={promoLoginBusy}
                  onPress={() => { handlePromoLogin().catch(() => {}); }}
                />
              </>
            )}
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

      {/* Xác nhận GHI ĐÈ toàn bộ dữ liệu trước khi khôi phục từ mây (danger) */}
      <AppPopup
        visible={showCloudOverwrite}
        title={t('backup.overwriteTitle')}
        message={t('backup.overwriteMsg')}
        confirm={{
          label: t('backup.overwriteConfirm'),
          danger: true,
          onConfirm: () => { handleCloudRestoreConfirm().catch(() => {}); },
        }}
        onClose={() => {
          setShowCloudOverwrite(false);
          setPendingCloudRestore(null);
        }}
      />

      {/* Modal mật khẩu sao lưu mây — mật khẩu không được lưu ở bất cứ đâu */}
      <Modal visible={cloudPwModal !== null} transparent animationType="fade" onRequestClose={() => setCloudPwModal(null)}>
        <Pressable style={styles.modalOverlay} onPress={() => setCloudPwModal(null)}>
          <Pressable style={[styles.card, styles.modalCard, { gap: 6 }]} onPress={() => {}}>
            <Text style={{ fontSize: 17, fontWeight: '800', color: Colors.text }}>
              {t('cloud.pwTitle')}
            </Text>
            <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>
              {cloudPwModal?.mode === 'upload' ? t('backup.pwWarn') : (cloudPwModal?.fileName ?? '')}
            </Text>
            {cloudPwModal?.mode === 'upload' && <PasswordWarnBox text={t('backup.passwordWarn')} />}
            <SecretField
              label={t('backup.pwLabel')}
              value={cloudPw}
              onChangeText={setCloudPw}
              visible={cloudPwShow}
              onToggleVisible={() => setCloudPwShow((v) => !v)}
              toggleLabel={cloudPwShow ? t('common.hide') : t('common.show')}
              autoFocus
            />
            {cloudPwModal?.mode === 'upload' && (
              <SecretField
                label={t('backup.pwConfirmLabel')}
                value={cloudPwConfirm}
                onChangeText={setCloudPwConfirm}
                visible={cloudPwShow}
                onToggleVisible={() => setCloudPwShow((v) => !v)}
                toggleLabel={cloudPwShow ? t('common.hide') : t('common.show')}
              />
            )}
            {cloudPwError && (
              <Text style={{ color: Colors.danger, fontSize: 13, marginTop: 10 }}>{cloudPwError}</Text>
            )}
            <AppButton
              title={t('common.confirm')}
              icon="lock-closed-outline"
              style={{ marginTop: 14 }}
              loading={cloudPwBusy}
              onPress={() => { handleCloudPwSubmit().catch(() => {}); }}
            />
            <TouchableOpacity style={{ alignItems: 'center', paddingVertical: 10 }} onPress={() => setCloudPwModal(null)}>
              <Text style={{ fontSize: 13.5, fontWeight: '600', color: Colors.subtext }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}
