import React, { useCallback, useState } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { styles, Colors, LocationPickerModal, AddTermModal, AppButton, Field, QtyInput, DateField, AppPopup, PhotoGallery, TAB_BAR_CLEARANCE, type AppPopupOption } from '@/components/ui';
import { categoryColor, categoryIcon, categoryLabel, conditionColor, conditionHint, conditionIcon, conditionLabel, tint, cardShadow, type IconName } from '@/theme';
import type { ItemCategory, ItemCondition, Location } from '@/types';
import { CATEGORY_LABELS } from '@/types';
import { listLocations, createItem, updateItem, updateMediaPin, countActiveItems, findItemByBarcode, findLocationByQrCode } from '@/db/queries';
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

/** Thẻ một bước trong form thêm đồ: số bước trong vòng tròn màu + tiêu đề */
function StepCard({
  step, color, title, children,
}: {
  step: number;
  color: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.card, { gap: 14, padding: 16 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: color, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>{step}</Text>
        </View>
        <Text style={{ fontSize: 15, fontWeight: '800', color: Colors.text }}>{title}</Text>
      </View>
      {children}
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
  const [location, setLocation] = useState<Location | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
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
    setLocation((prev) => prev ?? locs.find((l) => l.id === ids[0]) ?? null);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadTaxonomy();
      loadLocations();
    }, [loadLocations, loadTaxonomy]),
  );

  const recentLocations = recentIds
    .map((id) => locations.find((l) => l.id === id))
    .filter((l): l is Location => !!l)
    .slice(0, 5);

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
    if (kind === 'item') setPhotos((prev) => [...prev, entry]);
    else setScenePhotos((prev) => [...prev, entry]);
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
      setLocation(loc);
      showInfo(t('scan.locSet', { name: loc.name }));
      return;
    }
    setBarcode(data);
  }

  async function handleSave(stayHere: boolean) {
    if (!name.trim()) {
      showInfo(t('qa.noNameTitle'), t('qa.noNameMsg'));
      return;
    }
    if (!location) {
      showInfo(t('qa.noLocTitle'), t('qa.noLocMsg'));
      return;
    }
    // Số lượng BẮT BUỘC ngang hàng tên đồ: trống / 0 / không phải số
    // nguyên ≥ 1 thì chặn lưu, báo lỗi ngay tại trường (không còn mặc
    // định im lặng về 1 như trước)
    const qtyNum = /^\d+$/.test(quantity.trim()) ? parseInt(quantity, 10) : NaN;
    if (isNaN(qtyNum) || qtyNum < 1) {
      setQtyError(true);
      return;
    }
    const activeCount = await countActiveItems();
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
    <ScrollView style={[styles.screen, { paddingTop: 54 }]} contentContainerStyle={[styles.content, { paddingBottom: TAB_BAR_CLEARANCE, gap: 12 }]}>
      {/* Header riêng của màn Thêm đồ (không dùng ScreenHeader dùng chung):
          Hàng 1 chỉ có nút quay lại 42×42; hàng 2 là ô icon camera 58×58 + cột tiêu đề/phụ đề
          có đủ bề rộng còn lại để chữ chảy tự nhiên. marginBottom 4 + gap 12 của ScrollView
          = khoảng cách 16 tới thẻ Bước 1. */}
      <View style={{ marginBottom: 4 }}>
        <TouchableOpacity
          onPress={() => router.navigate('/(tabs)')}
          hitSlop={8}
          style={{
            width: 42, height: 42, borderRadius: 21, backgroundColor: '#fff',
            alignItems: 'center', justifyContent: 'center', ...cardShadow,
          }}
        >
          <Ionicons name="chevron-back" size={22} color={Colors.primaryDark} />
        </TouchableOpacity>
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
        />

        <Field label={t('qa.nameLabel')}>
          <TextInput style={styles.input} placeholder={t('qa.namePlaceholder')} placeholderTextColor={Colors.faint} value={name} onChangeText={setName} />
        </Field>

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
        <Field label={t('qa.locationLabel')}>
          {recentLocations.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
              {recentLocations.map((l) => (
                <TouchableOpacity
                  key={l.id}
                  style={[styles.chip, location?.id === l.id && styles.chipActive]}
                  onPress={() => setLocation(l)}
                >
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
        />

        <Field label={t('qa.categoryLabel')}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {CATEGORIES.map((c) => (
              <TouchableOpacity
                key={c}
                style={[styles.chip, category === c && { backgroundColor: categoryColor(c), borderColor: categoryColor(c) }]}
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
                style={[styles.chip, category === t.id && { backgroundColor: t.color, borderColor: t.color }]}
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
              style={[styles.chip, { borderStyle: 'dashed', borderColor: Colors.primary }]}
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
                style={[styles.chip, { marginRight: 0, height: 42, paddingVertical: 9 }, condition === c && { backgroundColor: conditionColor(c), borderColor: conditionColor(c) }]}
                onPress={() => setCondition(c)}
              >
                <Ionicons name={conditionIcon(c)} size={16} color={condition === c ? '#fff' : conditionColor(c)} />
                <Text style={[styles.chipText, condition === c && styles.chipTextActive]}>{conditionLabel(c)}</Text>
              </TouchableOpacity>
            ))}
            {customConditions.map((ct) => (
              <TouchableOpacity
                key={ct.id}
                style={[styles.chip, { marginRight: 0, height: 42, paddingVertical: 9 }, condition === ct.id && { backgroundColor: ct.color, borderColor: ct.color }]}
                onPress={() => setCondition(ct.id)}
              >
                <Ionicons
                  name={(ct.icon in Ionicons.glyphMap ? ct.icon : 'help-circle-outline') as IconName}
                  size={16}
                  color={condition === ct.id ? '#fff' : ct.color}
                />
                <Text style={[styles.chipText, condition === ct.id && styles.chipTextActive]}>{ct.name}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[styles.chip, { marginRight: 0, height: 42, paddingVertical: 9, borderStyle: 'dashed', borderColor: Colors.primary }]}
              onPress={() => setShowAddCond(true)}
            >
              <Ionicons name="add" size={16} color={Colors.primary} />
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
          <Field label={t('qa.qtyLabel')} style={{ flex: 1 }}>
            <QtyInput
              value={quantity}
              onChangeText={(v) => { setQuantity(v); setQtyError(false); }}
              placeholder={t('qa.qtyPlaceholder')}
              invalid={qtyError}
            />
            {qtyError && (
              <Text style={{ fontSize: 12.5, color: Colors.danger, lineHeight: 17 }}>{t('qa.qtyRequired')}</Text>
            )}
          </Field>
          <Field label={t('qa.unitLabel')} style={{ flex: 1 }}>
            <TextInput style={styles.input} value={unit} onChangeText={setUnit} />
          </Field>
        </View>
      </StepCard>

      {/* BƯỚC 3: Chi tiết thêm */}
      <StepCard step={3} color={Colors.teal} title={t('qa.step3')}>
        <Field label={t('qa.noteLabel')}>
          <TextInput style={styles.input} placeholder={t('qa.notePlaceholder')} placeholderTextColor={Colors.faint} value={positionNote} onChangeText={setPositionNote} />
        </Field>
        <Field label={t('qa.expiryLabel')}>
          <DateField value={expiryDate} onChangeText={setExpiryDate} placeholder={t('date.example')} title={t('qa.expiryLabel')} />
        </Field>
        <Field label={t('qa.priceLabel')}>
          <TextInput style={styles.input} placeholder="1250000" placeholderTextColor={Colors.faint} keyboardType="number-pad" value={price} onChangeText={setPrice} />
        </Field>
        <Field label={t('qa.purchaseDateLabel')}>
          <DateField value={purchaseDate} onChangeText={setPurchaseDate} placeholder={t('date.example')} title={t('qa.purchaseDateLabel')} />
        </Field>
        <Field label={t('qa.purchasePlaceLabel')}>
          <TextInput style={styles.input} placeholder={t('qa.purchasePlacePh')} placeholderTextColor={Colors.faint} value={purchasePlace} onChangeText={setPurchasePlace} />
        </Field>
        <Field label={t('qa.warrantyLabel')}>
          <DateField value={warrantyDate} onChangeText={setWarrantyDate} placeholder={t('date.example')} title={t('qa.warrantyLabel')} />
        </Field>
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

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
        <AppButton title={t('qa.saveStay')} variant="secondary" onPress={() => handleSave(true)} disabled={saving} style={{ flex: 1 }} />
        <AppButton
          title={t('qa.saveNow')}
          icon="checkmark-circle"
          onPress={() => handleSave(false)}
          loading={saving}
          style={{ flex: 1.4, backgroundColor: Colors.accent, shadowColor: Colors.accent }}
        />
      </View>

      <LocationPickerModal
        visible={showPicker}
        locations={locations}
        title={t('qa.pickLocTitle')}
        onClose={() => setShowPicker(false)}
        onSelect={setLocation}
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
