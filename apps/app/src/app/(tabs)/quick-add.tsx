import React, { useCallback, useRef, useState } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity, findNodeHandle,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { styles, Colors, LocationPickerModal, AddTermModal, AppButton, Field, QtyInput, DateField, AppPopup, PhotoGallery, TAB_BAR_CLEARANCE, type AppPopupOption } from '@/components/ui';
import { categoryColor, categoryIcon, categoryLabel, conditionColor, conditionHint, conditionIcon, conditionLabel, tint, cardShadow, locationIconName, LOCATION_TYPE_COLORS, type IconName } from '@/theme';
import type { ItemCategory, ItemCondition, Location } from '@/types';
import { CATEGORY_LABELS } from '@/types';
import { listLocations, createItem, updateItem, updateMediaPin, countRealActiveItems, findItemByBarcode, findLocationByQrCode } from '@/db/queries';
import BarcodeScannerModal from '@/components/BarcodeScannerModal';
import { kvGet, kvSet } from '@/db/client';
import { takePhoto, pickPhotos, processAndRegisterPhoto, type PickedPhoto } from '@/services/imageService';
import { scheduleExpiryReminders, rescheduleAllReminders } from '@/services/notificationService';
import { useT } from '@/i18n';
import { useAppStore } from '@/store/useAppStore';
import { getCurrentLimits } from '@/services/planService';
import { parseDisplayDate, uuid } from '@/utils';

const CATEGORIES = Object.keys(CATEGORY_LABELS) as ItemCategory[];
const CONDITIONS: ItemCondition[] = ['NEW', 'GOOD', 'WORN', 'NEED_REPAIR', 'BROKEN'];

/**
 * Thẻ một bước trong form thêm đồ: số bước trong vòng tròn màu + tiêu đề.
 * `collapsible` = hàng tiêu đề thành nút bấm mở/thu toàn bộ nội dung
 * (chevron ở mép phải); trạng thái mở/thu do nơi gọi giữ (controlled
 * qua collapsed/onToggle) để luồng Lưu có thể TỰ MỞ thẻ khi trường lỗi
 * nằm bên trong. Nội dung bị ẩn bằng cách không render — dữ liệu form
 * nằm ở state của màn hình cha nên thu/mở không mất gì đã nhập.
 */
function StepCard({
  step, color, title, children, collapsible, collapsed, onToggle,
}: {
  step: number;
  color: string;
  title: string;
  children: React.ReactNode;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const isCollapsed = !!collapsible && !!collapsed;
  const header = (
    <>
      <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: color, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>{step}</Text>
      </View>
      <Text style={{ flex: 1, fontSize: 15, fontWeight: '800', color: Colors.text }}>{title}</Text>
      {collapsible && (
        <Ionicons name={isCollapsed ? 'chevron-down' : 'chevron-up'} size={20} color={Colors.subtext} />
      )}
    </>
  );
  return (
    <View style={[styles.card, { gap: 14, padding: 16 }]}>
      {collapsible ? (
        <TouchableOpacity
          onPress={onToggle}
          activeOpacity={0.7}
          accessibilityRole="button"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
        >
          {header}
        </TouchableOpacity>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>{header}</View>
      )}
      {!isCollapsed && children}
    </View>
  );
}

/** Ảnh đang chờ lưu trong form: key ổn định để gallery xoá đúng tấm.
 *  Ảnh hiện trường mang theo ghim RIÊNG của chính nó (pin, tỉ lệ 0–1) —
 *  khi lưu sẽ ghi vào cột pin của hàng media tương ứng. */
interface PendingPhoto {
  key: string;
  picked: PickedPhoto;
  pin?: { x: number; y: number } | null;
}

export default function QuickAddScreen() {
  const { t, lang } = useT();
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [scenePhotos, setScenePhotos] = useState<PendingPhoto[]>([]);
  const [name, setName] = useState('');
  // Vị trí đang chọn: NGUỒN SỰ THẬT DUY NHẤT là `locationId`. Đối tượng
  // hiển thị `location` luôn SUY RA từ `locations` theo id này — hàng
  // chip chọn nhanh, ô chọn (dropdown) bên dưới và giá trị lưu khi tạo
  // đồ đều đọc từ cùng một suy ra nên không thể lệch nhau (trước đây giữ
  // đối tượng `location` riêng: đối tượng đó có thể cũ hơn danh sách đã
  // tải lại / đến từ picker / quét QR mà không nằm trong danh sách).
  const [locationId, setLocationId] = useState<string | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const location = locations.find((l) => l.id === locationId) ?? null;

  /** Chọn một vị trí (chạm chip / chọn trong picker / quét QR): chỉ ghi
   *  id + upsert đối tượng tươi nhất vào danh sách để `location` suy ra
   *  được ngay — ô chọn hiển thị đúng vị trí vừa chạm trong cùng nhịp. */
  const selectLocation = useCallback((loc: Location) => {
    setLocations((prev) => (prev.some((l) => l.id === loc.id)
      ? prev.map((l) => (l.id === loc.id ? loc : l))
      : [...prev, loc]));
    setLocationId(loc.id);
  }, []);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [showAddCat, setShowAddCat] = useState(false);
  const [showAddCond, setShowAddCond] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [barcode, setBarcode] = useState<string | null>(null);
  const [category, setCategory] = useState<string>('OTHER');
  const [condition, setCondition] = useState<string>('GOOD');
  const [conditionNote, setConditionNote] = useState('');
  // Số lượng BẮT BUỘC: khởi tạo TRỐNG, người dùng phải tự nhập/chọn
  const [quantity, setQuantity] = useState('');
  const [qtyError, setQtyError] = useState(false);
  const [unit, setUnit] = useState(() => t('qa.unitDefault'));
  const [positionNote, setPositionNote] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [warrantyDate, setWarrantyDate] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [purchasePlace, setPurchasePlace] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [price, setPrice] = useState('');
  const [saving, setSaving] = useState(false);
  // Bước 3 "Chi tiết thêm": mặc định THU GỌN — chỉ hiện hàng tiêu đề,
  // chạm mới mở; luồng Lưu cũng tự mở khi trường lỗi nằm trong bước này
  const [step3Open, setStep3Open] = useState(false);
  // Key của ảnh mới đầu tiên vừa thêm ở mỗi bucket → truyền xuống
  // PhotoGallery làm focusKey để khung lớn NHẢY TỚI ngay ảnh mới (cùng
  // cơ chế trang chi tiết đã có; ở form là key tạm của ảnh đang chờ)
  const [itemFocusKey, setItemFocusKey] = useState<string | undefined>(undefined);
  const [sceneFocusKey, setSceneFocusKey] = useState<string | undefined>(undefined);
  // Refs phục vụ "focus trường lỗi khi bấm Lưu": ScrollView của màn +
  // View bọc từng trường cần cuộn tới + input Tên/Số lượng để focus
  const scrollRef = useRef<React.ElementRef<typeof ScrollView>>(null);
  const nameFieldRef = useRef<React.ElementRef<typeof View>>(null);
  const nameInputRef = useRef<React.ElementRef<typeof TextInput>>(null);
  const locFieldRef = useRef<React.ElementRef<typeof View>>(null);
  const qtyFieldRef = useRef<React.ElementRef<typeof View>>(null);
  const qtyInputRef = useRef<React.ElementRef<typeof TextInput>>(null);
  const expiryFieldRef = useRef<React.ElementRef<typeof View>>(null);
  const purchaseFieldRef = useRef<React.ElementRef<typeof View>>(null);
  const warrantyFieldRef = useRef<React.ElementRef<typeof View>>(null);

  /** Cuộn màn hình tới một trường (View bọc trường) — đo vị trí tương
   *  đối với ScrollView rồi scrollTo, chừa 70px phía trên để trường
   *  không dính sát mép. Đo trong requestAnimationFrame để layout của
   *  lần render gây ra thao tác (vd vừa mở Bước 3) đã kịp áp. */
  const scrollToField = useCallback((ref: React.RefObject<React.ElementRef<typeof View> | null>, delay = 60) => {
    setTimeout(() => {
      const node = ref.current;
      const scroll = scrollRef.current;
      if (!node || !scroll) return;
      const scrollHandle = findNodeHandle(scroll);
      if (scrollHandle == null) return;
      node.measureLayout(
        scrollHandle,
        (_x, y) => { scroll.scrollTo({ y: Math.max(0, y - 70), animated: true }); },
        () => {},
      );
    }, delay);
  }, []);

  /** Cuộn tới trường lỗi rồi focus input của nó (sau khi cuộn gần xong) */
  const focusField = useCallback((fieldRef: React.RefObject<React.ElementRef<typeof View> | null>, inputRef: React.RefObject<React.ElementRef<typeof TextInput> | null>, delay = 60) => {
    scrollToField(fieldRef, delay);
    setTimeout(() => inputRef.current?.focus(), delay + 350);
  }, [scrollToField]);
  // Popup dùng chung thay hộp thoại hệ thống: không có options = thông
  // báo/lỗi 1 nút "Đã hiểu"; có options = danh sách lựa chọn AppPopup
  const [popup, setPopup] = useState<{ title: string; message?: string; options?: AppPopupOption[] } | null>(null);
  const showInfo = (title: string, message?: string) => setPopup({ title, message });
  const bump = useAppStore((s) => s.bump);
  const customCategories = useAppStore((s) => s.customCategories);
  const customConditions = useAppStore((s) => s.customConditions);
  const loadTaxonomy = useAppStore((s) => s.loadTaxonomy);

  const loadLocations = useCallback(async () => {
    const locs = await listLocations();
    setLocations(locs);
    const rec = await kvGet('recent_locations');
    const ids: string[] = rec ? JSON.parse(rec) : [];
    setRecentIds(ids);
    // Mặc định chọn = vị trí dùng gần nhất, chỉ khi chưa chọn gì và id
    // đó còn tồn tại trong danh sách vừa tải
    setLocationId((prev) => prev ?? (ids[0] && locs.some((l) => l.id === ids[0]) ? ids[0] : null));
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadTaxonomy();
      loadLocations();
    }, [loadLocations, loadTaxonomy]),
  );

  // Hàng chip chọn nhanh "Vị trí cất": các VỊ TRÍ CHÍNH (gốc cấp cao
  // nhất của cây, parent_id = null) — thay cho hàng "gần đây" trước
  // đây. Nếu vị trí đang chọn là vị trí CON (chọn qua bộ chọn đầy đủ),
  // chip của chính nó được đưa lên đầu hàng ở trạng thái đang chọn để
  // lựa chọn hiện tại luôn nhìn thấy được trong hàng; vị trí đó vẫn
  // được tôn trọng nguyên vẹn khi lưu
  const rootLocations = locations.filter((l) => l.parent_id === null);
  const selectedIsChild = location && location.parent_id !== null ? location : null;
  const locationChips = selectedIsChild ? [selectedIsChild, ...rootLocations] : rootLocations;

  // ---------- Ảnh (gallery dùng chung): 2 bucket riêng — ảnh đồ vật và
  // ảnh hiện trường — mỗi bucket có trần RIÊNG theo gói (maxItemPhotos /
  // maxScenePhotos trong PLAN_LIMITS) ----------

  const itemPhotoLimit = getCurrentLimits().maxItemPhotos;
  const scenePhotoLimit = getCurrentLimits().maxScenePhotos;
  const photoLimitFor = (kind: 'item' | 'scene') => (kind === 'item' ? itemPhotoLimit : scenePhotoLimit);

  async function addPhotosFromCamera(kind: 'item' | 'scene') {
    const current = kind === 'item' ? photos : scenePhotos;
    const photoLimit = photoLimitFor(kind);
    if (current.length >= photoLimit) {
      showInfo(t('loc.limitTitle'), t(kind === 'item' ? 'photos.limitMsg' : 'photos.sceneLimitMsg', { n: photoLimit }));
      return;
    }
    const picked = await takePhoto();
    if (!picked) return;
    const entry: PendingPhoto = { key: uuid(), picked, pin: null };
    if (kind === 'item') {
      setPhotos((prev) => [...prev, entry]);
      setItemFocusKey(entry.key);
    } else {
      setScenePhotos((prev) => [...prev, entry]);
      setSceneFocusKey(entry.key);
    }
  }

  async function addPhotosFromLibrary(kind: 'item' | 'scene') {
    const current = kind === 'item' ? photos : scenePhotos;
    const photoLimit = photoLimitFor(kind);
    const remaining = photoLimit - current.length;
    if (remaining <= 0) {
      showInfo(t('loc.limitTitle'), t(kind === 'item' ? 'photos.limitMsg' : 'photos.sceneLimitMsg', { n: photoLimit }));
      return;
    }
    const picked = await pickPhotos(remaining);
    if (picked.length === 0) return;
    // Một số máy bỏ qua selectionLimit: chỉ lấy đến trần và báo giới hạn
    const accepted = picked.slice(0, remaining).map((p) => ({ key: uuid(), picked: p, pin: null }));
    if (picked.length > remaining) {
      showInfo(t('loc.limitTitle'), t(kind === 'item' ? 'photos.limitMsg' : 'photos.sceneLimitMsg', { n: photoLimit }));
    }
    if (accepted.length > 0) {
      // Khung lớn nhảy tới ảnh mới đầu tiên vừa thêm của lần này
      if (kind === 'item') setItemFocusKey(accepted[0].key);
      else setSceneFocusKey(accepted[0].key);
    }
    if (kind === 'item') setPhotos((prev) => [...prev, ...accepted]);
    else setScenePhotos((prev) => [...prev, ...accepted]);
  }

  function removePendingPhoto(kind: 'item' | 'scene', key: string) {
    // Mỗi ảnh hiện trường mang ghim riêng — xoá tấm nào chỉ mất ghim của
    // chính tấm đó, các tấm còn lại giữ nguyên
    if (kind === 'item') {
      setPhotos((prev) => prev.filter((p) => p.key !== key));
    } else {
      setScenePhotos((prev) => prev.filter((p) => p.key !== key));
    }
  }

  /** Xử lý mã vừa quét: trùng món -> cảnh báo; mã vị trí -> chọn vị trí; còn lại gắn cho món mới */
  async function handleScannedCode(data: string) {
    const dup = await findItemByBarcode(data);
    if (dup) {
      setPopup({
        title: t('scan.dupTitle'),
        message: t('scan.dupBody', { name: dup.name }),
        options: [
          { label: t('scan.viewItem'), icon: 'eye-outline', color: Colors.primary, onPress: () => router.push(`/item/${dup.id}`) },
          { label: t('scan.later'), icon: 'time-outline', color: Colors.subtext, onPress: () => {} },
        ],
      });
      return;
    }
    const loc = await findLocationByQrCode(data);
    if (loc) {
      selectLocation(loc);
      showInfo(t('scan.locSet', { name: loc.name }));
      return;
    }
    setBarcode(data);
  }

  async function handleSave(stayHere: boolean) {
    // Validate theo thứ tự "trường lỗi ĐẦU TIÊN trên form thắng": mỗi
    // lỗi đều TỰ CUỘN tới đúng trường đó và focus (nếu là ô nhập) —
    // thông báo lỗi giữ nguyên hình thức như trước (popup cho tên/vị
    // trí/ngày, dòng đỏ tại chỗ cho số lượng)
    if (!name.trim()) {
      focusField(nameFieldRef, nameInputRef);
      showInfo(t('qa.noNameTitle'), t('qa.noNameMsg'));
      return;
    }
    if (!location) {
      scrollToField(locFieldRef);
      showInfo(t('qa.noLocTitle'), t('qa.noLocMsg'));
      return;
    }
    // Số lượng BẮT BUỘC ngang hàng tên đồ: trống / 0 / không phải số
    // nguyên ≥ 1 thì chặn lưu, báo lỗi ngay tại trường (không còn mặc
    // định im lặng về 1 như trước)
    const qtyNum = /^\d+$/.test(quantity.trim()) ? parseInt(quantity, 10) : NaN;
    if (isNaN(qtyNum) || qtyNum < 1) {
      setQtyError(true);
      focusField(qtyFieldRef, qtyInputRef);
      return;
    }
    const activeCount = await countRealActiveItems();
    if (activeCount >= getCurrentLimits().maxActiveItems) {
      showInfo(
        t('loc.limitTitle'),
        t('qa.limitItemMsg', { n: getCurrentLimits().maxActiveItems }),
      );
      return;
    }
    // Ngày nhập dạng DD/MM/YYYY (đã mask) → convert ISO khi lưu; sai định dạng thì báo lỗi
    const expiryISO = expiryDate.trim() ? parseDisplayDate(expiryDate) : null;
    const warrantyISO = warrantyDate.trim() ? parseDisplayDate(warrantyDate) : null;
    const purchaseISO = purchaseDate.trim() ? parseDisplayDate(purchaseDate) : null;
    if ((expiryDate.trim() && !expiryISO) || (warrantyDate.trim() && !warrantyISO) || (purchaseDate.trim() && !purchaseISO)) {
      // Ngày sai định dạng nằm ở Bước 3 (đang thu gọn mặc định): TỰ MỞ
      // bước đó rồi cuộn tới ô ngày lỗi đầu tiên theo thứ tự trên form
      const badDateRef = expiryDate.trim() && !expiryISO
        ? expiryFieldRef
        : purchaseDate.trim() && !purchaseISO
          ? purchaseFieldRef
          : warrantyFieldRef;
      setStep3Open(true);
      scrollToField(badDateRef, 300);
      showInfo(t('qa.badDateTitle'), t('qa.badDateMsg'));
      return;
    }
    const tagList = tagsText.split(',').map((s) => s.trim()).filter(Boolean);
    setSaving(true);
    try {
      const item = await createItem({
        name: name.trim(),
        category,
        condition,
        condition_note: conditionNote.trim() || null,
        location_id: location.id,
        position_note: positionNote.trim() || null,
        quantity: qtyNum,
        unit: unit.trim() || t('qa.unitDefault'),
        expiry_date: expiryISO,
        warranty_expiry_date: warrantyISO,
        purchase_date: purchaseISO,
        purchase_place: purchasePlace.trim() || null,
        tags: tagList.length > 0 ? JSON.stringify(tagList) : null,
        barcode: barcode || null,
        purchase_price: price ? parseInt(price.replace(/[^\d]/g, ''), 10) || null : null,
      });

      // Ảnh đồ vật: đăng ký lần lượt, tấm đầu tiên là ảnh chính
      for (let i = 0; i < photos.length; i++) {
        await processAndRegisterPhoto(photos[i].picked, 'ITEM', item.id, 'ITEM_CLOSEUP', i === 0);
      }
      // Ảnh hiện trường: nhiều tấm cùng kind ITEM_SCENE; scene_media_id vẫn
      // trỏ tấm đầu tiên (ảnh hiện trường chính). Ghim KHÔNG còn nằm ở item:
      // mỗi tấm ghi ghim riêng của nó vào chính hàng media vừa đăng ký.
      if (scenePhotos.length > 0) {
        let firstSceneId: string | null = null;
        for (const sp of scenePhotos) {
          const media = await processAndRegisterPhoto(sp.picked, 'ITEM', item.id, 'ITEM_SCENE', false);
          if (!firstSceneId) firstSceneId = media.id;
          if (sp.pin) await updateMediaPin(media.id, sp.pin.x, sp.pin.y);
        }
        await updateItem(item.id, { scene_media_id: firstSceneId });
      }
      if (expiryISO) {
        scheduleExpiryReminders(item.name, expiryISO).catch(() => {});
      }

      // nhớ vị trí gần nhất
      const newRecent = [location.id, ...recentIds.filter((id) => id !== location.id)].slice(0, 5);
      await kvSet('recent_locations', JSON.stringify(newRecent));
      setRecentIds(newRecent);
      bump();
      rescheduleAllReminders().catch(() => {});

      if (stayHere) {
        setPhotos([]);
        setScenePhotos([]);
        setName('');
        setPositionNote('');
        setConditionNote('');
        setBarcode(null);
        showInfo(t('qa.savedStayTitle'), t('qa.savedStayMsg'));
      } else {
        setPopup({
          title: t('qa.savedTitle'),
          message: t('qa.savedMsg', { name: item.name }),
          options: [
            { label: t('qa.viewItem'), icon: 'eye-outline', color: Colors.primary, onPress: () => router.push(`/item/${item.id}`) },
            { label: t('qa.goHome'), icon: 'home-outline', color: Colors.teal, onPress: () => router.push('/(tabs)') },
          ],
        });
        setPhotos([]);
        setScenePhotos([]);
        setName('');
        setPositionNote('');
        setConditionNote('');
        setBarcode(null);
      }
    } catch (e) {
      showInfo(t('qa.saveErrorTitle'), e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    // paddingBottom = TAB_BAR_CLEARANCE + 12 (chỉ riêng màn này): đo trên
    // máy thật, với 144 chung thì mép dưới hàng nút Lưu CHẠM đúng đỉnh nút
    // tròn Thêm đồ của tab bar (khoảng hở ≈ 0); +40 thì lại hơi xa (người
    // dùng phản hồi 23/10) — +12 giữ khoảng hở thật ~12dp: gần mà không chạm.
    <ScrollView ref={scrollRef} style={[styles.screen, { paddingTop: 54 }]} contentContainerStyle={[styles.content, { paddingBottom: TAB_BAR_CLEARANCE + 12, gap: 12 }]}>
      {/* Header riêng của màn Thêm đồ (không dùng ScreenHeader dùng chung):
          Hàng 1: nút quay lại 36×36 ở trái + cụm logo SmartStash ở phải (chỉ để
          cân bằng thị giác, KHÔNG gắn thao tác — mẫu B, khổ 36=36 theo mẫu 2,
          người dùng duyệt 23–24/10); hàng 2 là ô icon camera 58×58 + cột tiêu
          đề/phụ đề có đủ bề rộng còn lại để chữ chảy tự nhiên. marginBottom 4
          + gap 12 của ScrollView = khoảng cách 16 tới thẻ Bước 1. */}
      <View style={{ marginBottom: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <TouchableOpacity
            onPress={() => router.navigate('/(tabs)')}
            hitSlop={8}
            style={{
              width: 36, height: 36, borderRadius: 18, backgroundColor: '#fff',
              alignItems: 'center', justifyContent: 'center', ...cardShadow,
            }}
          >
            <Ionicons name="chevron-back" size={16} color={Colors.primaryDark} />
          </TouchableOpacity>
          {/* Logo thương hiệu: ô 36×36 nền primary + glyph 'cube' trắng — đúng
              biểu trưng app dùng ở onboarding (LogoTile) và trang chủ.
              marginRight 8: cụm logo lùi sang trái một chút khỏi mép lề nội
              dung cho cân với nút quay lại bên trái (người dùng chỉnh 24/10)
              — chỉ riêng cụm này, không đổi lề chung của trang. */}
          <View pointerEvents="none" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginRight: 8 }}>
            <View
              style={{
                width: 36, height: 36, borderRadius: 11, backgroundColor: Colors.primary,
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              <Ionicons name="cube" size={20} color="#fff" />
            </View>
            <Text style={{ fontSize: 16, fontWeight: '800', color: Colors.text }}>
              Smart<Text style={{ color: Colors.primary }}>Stash</Text>
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 14 }}>
          <View
            style={{
              width: 58, height: 58, borderRadius: 18, backgroundColor: tint(Colors.coral),
              alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Ionicons name="camera" size={28} color={Colors.coral} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 27, fontWeight: '800', lineHeight: 33, color: Colors.text }}>{t('qa.title')}</Text>
            <Text style={{ fontSize: 13.5, color: Colors.subtext, lineHeight: 19, marginTop: 2 }}>{t('qa.subtitle')}</Text>
          </View>
        </View>
      </View>

      {/* BƯỚC 1: Ảnh & tên đồ */}
      <StepCard step={1} color={Colors.coral} title={t('qa.step1')}>
        <PhotoGallery
          title={t('qa.photoLabel')}
          titleColor={Colors.coral}
          photos={photos.map((p, i) => ({ key: p.key, uri: p.picked.uri, isPrimary: i === 0 }))}
          takeLabel={t('qa.takePhoto')}
          pickLabel={t('qa.pickPhoto')}
          onTake={() => { addPhotosFromCamera('item').catch(() => {}); }}
          onPick={() => { addPhotosFromLibrary('item').catch(() => {}); }}
          onRemove={(e) => removePendingPhoto('item', e.key)}
          maxReached={photos.length >= itemPhotoLimit}
          limitText={t('photos.limitMsg', { n: itemPhotoLimit })}
          focusKey={itemFocusKey}
        />

        <View ref={nameFieldRef} collapsable={false}>
          <Field label={t('qa.nameLabel')}>
            <TextInput ref={nameInputRef} style={styles.input} placeholder={t('qa.namePlaceholder')} placeholderTextColor={Colors.faint} value={name} onChangeText={setName} />
          </Field>
        </View>

        <Field label={t('scan.fieldLabel')}>
          {barcode ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: tint(Colors.teal, '1C'), borderRadius: 14, paddingHorizontal: 12, height: 52 }}>
              <Ionicons name="barcode-outline" size={20} color={Colors.teal} />
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 14.5, fontWeight: '600', color: Colors.text }}>{barcode}</Text>
              <TouchableOpacity onPress={() => setBarcode(null)} hitSlop={8} accessibilityLabel={t('scan.remove')}>
                <Ionicons name="close-circle" size={20} color={Colors.subtext} />
              </TouchableOpacity>
            </View>
          ) : (
            <AppButton title={t('scan.action')} variant="secondary" icon="scan-outline" onPress={() => setShowScanner(true)} />
          )}
        </Field>
      </StepCard>

      {/* BƯỚC 2: Vị trí & phân loại */}
      <StepCard step={2} color={Colors.primary} title={t('qa.step2')}>
        <View ref={locFieldRef} collapsable={false}>
          <Field label={t('qa.locationLabel')}>
            {/* Hàng chip cuộn ngang = các VỊ TRÍ CHÍNH (gốc của cây):
                chạm 1 chạm là chọn (qua selectLocation — ghi đúng
                locationId dùng chung) nên ô chọn bên dưới nhận giá trị
                NGAY như khi chọn trong danh sách của picker; chip đang
                chọn nền đậm như trước. Chọn vị trí con sâu hơn / tạo vị
                trí mới vẫn qua ô chọn đầy đủ (LocationPickerModal) ngay
                bên dưới như cũ */}
            {locationChips.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
                {locationChips.map((l) => (
                  <TouchableOpacity
                    key={l.id}
                    style={[styles.chip, location?.id === l.id && styles.chipActive]}
                    onPress={() => selectLocation(l)}
                  >
                    <Ionicons
                      name={locationIconName(l)}
                      size={15}
                      color={location?.id === l.id ? '#fff' : LOCATION_TYPE_COLORS[l.type]}
                    />
                    <Text style={[styles.chipText, location?.id === l.id && styles.chipTextActive]}>{l.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
            <TouchableOpacity style={[styles.input, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]} onPress={() => setShowPicker(true)}>
              <Text style={{ fontSize: 15.5, color: location ? Colors.text : Colors.faint }}>
                {location ? location.name : t('qa.chooseLocation')}
              </Text>
              <Ionicons name="chevron-down" size={18} color={Colors.subtext} />
            </TouchableOpacity>
          </Field>
        </View>

        <PhotoGallery
          title={t('qa.sceneLabel')}
          titleColor={Colors.primary}
          photos={scenePhotos.map((p) => ({ key: p.key, uri: p.picked.uri, pin: p.pin ?? null }))}
          takeLabel={t('qa.takeScene')}
          pickLabel={t('photos.addScene')}
          onTake={() => { addPhotosFromCamera('scene').catch(() => {}); }}
          onPick={() => { addPhotosFromLibrary('scene').catch(() => {}); }}
          onRemove={(e) => removePendingPhoto('scene', e.key)}
          maxReached={scenePhotos.length >= scenePhotoLimit}
          limitText={t('photos.sceneLimitMsg', { n: scenePhotoLimit })}
          onPinChange={(e, newPin) => {
            // Ghim riêng của chính tấm vừa chạm — các tấm khác không đổi
            setScenePhotos((prev) => prev.map((p) => (p.key === e.key ? { ...p, pin: newPin } : p)));
          }}
          captionSuffix={t('photos.draftNote')}
          focusKey={sceneFocusKey}
        />

        {/* Chip chọn Danh mục & Tình trạng vật lý dùng CHUNG một khuôn:
            cao cố định 44, khung icon 26×26 (chipIconBox), glyph 15, chữ
            chipText — hai hàng nút chọn cao bằng nhau tuyệt đối, icon căn
            giữa theo chiều dọc giống hệt nhau (đồng bộ ở item/edit.tsx) */}
        <Field label={t('qa.categoryLabel')}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {CATEGORIES.map((c) => (
              <TouchableOpacity
                key={c}
                style={[styles.chip, { height: 44 }, category === c && { backgroundColor: categoryColor(c), borderColor: categoryColor(c) }]}
                onPress={() => setCategory(c)}
              >
                <View style={[styles.chipIconBox, { backgroundColor: category === c ? 'rgba(255,255,255,0.25)' : tint(categoryColor(c), '1F') }]}>
                  <Ionicons name={categoryIcon(c)} size={15} color={category === c ? '#fff' : categoryColor(c)} />
                </View>
                <Text style={[styles.chipText, category === c && styles.chipTextActive]}>{categoryLabel(c)}</Text>
              </TouchableOpacity>
            ))}
            {customCategories.map((t) => (
              <TouchableOpacity
                key={t.id}
                style={[styles.chip, { height: 44 }, category === t.id && { backgroundColor: t.color, borderColor: t.color }]}
                onPress={() => setCategory(t.id)}
              >
                <View style={[styles.chipIconBox, { backgroundColor: category === t.id ? 'rgba(255,255,255,0.25)' : tint(t.color, '1F') }]}>
                  <Ionicons
                    name={(t.icon in Ionicons.glyphMap ? t.icon : 'cube-outline') as IconName}
                    size={15}
                    color={category === t.id ? '#fff' : t.color}
                  />
                </View>
                <Text style={[styles.chipText, category === t.id && styles.chipTextActive]}>{t.name}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[styles.chip, { height: 44, borderStyle: 'dashed', borderColor: Colors.primary }]}
              onPress={() => setShowAddCat(true)}
            >
              <Ionicons name="add" size={15} color={Colors.primary} />
              <Text style={[styles.chipText, { color: Colors.primary }]}>{t('common.addCategory')}</Text>
            </TouchableOpacity>
          </ScrollView>
        </Field>

        <Field label={t('qa.conditionLabel')}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {CONDITIONS.map((c) => (
              <TouchableOpacity
                key={c}
                style={[styles.chip, { marginRight: 0, height: 44 }, condition === c && { backgroundColor: conditionColor(c), borderColor: conditionColor(c) }]}
                onPress={() => setCondition(c)}
              >
                <View style={[styles.chipIconBox, { backgroundColor: condition === c ? 'rgba(255,255,255,0.25)' : tint(conditionColor(c), '1F') }]}>
                  <Ionicons name={conditionIcon(c)} size={15} color={condition === c ? '#fff' : conditionColor(c)} />
                </View>
                <Text style={[styles.chipText, condition === c && styles.chipTextActive]}>{conditionLabel(c)}</Text>
              </TouchableOpacity>
            ))}
            {customConditions.map((ct) => (
              <TouchableOpacity
                key={ct.id}
                style={[styles.chip, { marginRight: 0, height: 44 }, condition === ct.id && { backgroundColor: ct.color, borderColor: ct.color }]}
                onPress={() => setCondition(ct.id)}
              >
                <View style={[styles.chipIconBox, { backgroundColor: condition === ct.id ? 'rgba(255,255,255,0.25)' : tint(ct.color, '1F') }]}>
                  <Ionicons
                    name={(ct.icon in Ionicons.glyphMap ? ct.icon : 'help-circle-outline') as IconName}
                    size={15}
                    color={condition === ct.id ? '#fff' : ct.color}
                  />
                </View>
                <Text style={[styles.chipText, condition === ct.id && styles.chipTextActive]}>{ct.name}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[styles.chip, { marginRight: 0, height: 44, borderStyle: 'dashed', borderColor: Colors.primary }]}
              onPress={() => setShowAddCond(true)}
            >
              <Ionicons name="add" size={15} color={Colors.primary} />
              <Text style={[styles.chipText, { color: Colors.primary }]}>{t('common.addCondition')}</Text>
            </TouchableOpacity>
          </View>
          <View style={[styles.hintBox, { backgroundColor: tint(conditionColor(condition), '14') }]}>
            <Ionicons name="information-circle" size={18} color={conditionColor(condition)} />
            {/* Tình trạng tự tạo không có mô tả sẵn — dùng câu chung từ i18n */}
            <Text style={styles.hintText}>{conditionHint(condition, lang) || t('condition.customHint')}</Text>
          </View>
        </Field>

        <Field label={t('condition.noteLabel')}>
          <TextInput
            style={styles.inputMultiline}
            multiline
            placeholder={t('condition.notePh')}
            placeholderTextColor={Colors.faint}
            value={conditionNote}
            onChangeText={setConditionNote}
          />
        </Field>

        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View ref={qtyFieldRef} collapsable={false} style={{ flex: 1 }}>
            <Field label={t('qa.qtyLabel')}>
              <QtyInput
                value={quantity}
                onChangeText={(v) => { setQuantity(v); setQtyError(false); }}
                placeholder={t('qa.qtyPlaceholder')}
                invalid={qtyError}
                inputRef={qtyInputRef}
              />
              {qtyError && (
                <Text style={{ fontSize: 12.5, color: Colors.danger, lineHeight: 17 }}>{t('qa.qtyRequired')}</Text>
              )}
            </Field>
          </View>
          <Field label={t('qa.unitLabel')} style={{ flex: 1 }}>
            <TextInput style={styles.input} value={unit} onChangeText={setUnit} />
          </Field>
        </View>
      </StepCard>

      {/* BƯỚC 3: Chi tiết thêm — COLLAPSIBLE, mặc định THU GỌN (chỉ hiện
          hàng tiêu đề + chevron), chạm tiêu đề mới mở đầy đủ các trường;
          dữ liệu các trường nằm ở state của màn nên thu/mở không mất */}
      <StepCard
        step={3}
        color={Colors.teal}
        title={t('qa.step3')}
        collapsible
        collapsed={!step3Open}
        onToggle={() => setStep3Open((v) => !v)}
      >
        <Field label={t('qa.noteLabel')}>
          <TextInput style={styles.input} placeholder={t('qa.notePlaceholder')} placeholderTextColor={Colors.faint} value={positionNote} onChangeText={setPositionNote} />
        </Field>
        <View ref={expiryFieldRef} collapsable={false}>
          <Field label={t('qa.expiryLabel')}>
            <DateField value={expiryDate} onChangeText={setExpiryDate} placeholder={t('date.example')} title={t('qa.expiryLabel')} />
          </Field>
        </View>
        <Field label={t('qa.priceLabel')}>
          <TextInput style={styles.input} placeholder="1250000" placeholderTextColor={Colors.faint} keyboardType="number-pad" value={price} onChangeText={setPrice} />
        </Field>
        <View ref={purchaseFieldRef} collapsable={false}>
          <Field label={t('qa.purchaseDateLabel')}>
            <DateField value={purchaseDate} onChangeText={setPurchaseDate} placeholder={t('date.example')} title={t('qa.purchaseDateLabel')} />
          </Field>
        </View>
        <Field label={t('qa.purchasePlaceLabel')}>
          <TextInput style={styles.input} placeholder={t('qa.purchasePlacePh')} placeholderTextColor={Colors.faint} value={purchasePlace} onChangeText={setPurchasePlace} />
        </Field>
        <View ref={warrantyFieldRef} collapsable={false}>
          <Field label={t('qa.warrantyLabel')}>
            <DateField value={warrantyDate} onChangeText={setWarrantyDate} placeholder={t('date.example')} title={t('qa.warrantyLabel')} />
          </Field>
        </View>
        <Field label={t('qa.tagsLabel')} hint={t('qa.tagsHint')}>
          <TextInput style={styles.input} placeholder={t('qa.tagsPh')} placeholderTextColor={Colors.faint} value={tagsText} onChangeText={setTagsText} />
        </Field>
      </StepCard>

      {/* Quay lại không cần lưu */}
      <AppButton
        title={t('qa.backHome')}
        variant="ghost"
        icon="arrow-back"
        onPress={() => router.navigate('/(tabs)')}
      />

      {/* Cặp nút Lưu: flex 1:1 TUYỆT ĐỐI (cùng bề ngang), AppButton tự
          khoá chiều cao 52 cho cả hai — đều nhau cả ngang lẫn dọc */}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
        <AppButton title={t('qa.saveStay')} variant="secondary" onPress={() => handleSave(true)} disabled={saving} style={{ flex: 1 }} />
        <AppButton
          title={t('qa.saveNow')}
          icon="checkmark-circle"
          onPress={() => handleSave(false)}
          loading={saving}
          style={{ flex: 1, backgroundColor: Colors.accent, shadowColor: Colors.accent }}
        />
      </View>

      <LocationPickerModal
        visible={showPicker}
        locations={locations}
        title={t('qa.pickLocTitle')}
        onClose={() => setShowPicker(false)}
        allowCreate
        onSelect={selectLocation}
      />
      <BarcodeScannerModal
        visible={showScanner}
        onClose={() => setShowScanner(false)}
        onScanned={(data) => { handleScannedCode(data).catch(() => {}); }}
      />
      <AddTermModal
        visible={showAddCat}
        kind="CATEGORY"
        onClose={() => setShowAddCat(false)}
        onAdded={(term) => setCategory(term.id)}
      />
      <AddTermModal
        visible={showAddCond}
        kind="CONDITION"
        onClose={() => setShowAddCond(false)}
        onAdded={(term) => setCondition(term.id)}
      />
      <AppPopup
        visible={!!popup}
        title={popup?.title ?? ''}
        message={popup?.message}
        options={popup?.options}
        okLabel={t('common.gotIt')}
        onClose={() => setPopup(null)}
      />
    </ScrollView>
  );
}
