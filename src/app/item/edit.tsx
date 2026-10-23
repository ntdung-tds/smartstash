import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity } from 'react-native';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { styles, Colors, AddTermModal, AppButton, Field, QtyInput, DateField, SectionTitle, AppPopup, PhotoGallery, type AppPopupOption } from '@/components/ui';
import {
  categoryColor, categoryIcon, categoryLabel, statusColorFor, statusIcon, statusLabel,
  conditionColor, conditionHint, conditionIcon, conditionLabel, tint, type IconName,
} from '@/theme';
import { useT } from '@/i18n';
import { rescheduleAllReminders } from '@/services/notificationService';
import type { Item, ItemCategory, ItemCondition, ItemStatus, MediaFile } from '@/types';
import { CATEGORY_LABELS, STATUS_LABELS } from '@/types';
import {
  getItem, updateItem, setItemStatus, listMediaForOwner, softDeleteMedia, setPrimaryMedia,
  updateMediaPin, countActiveLoansForItem,
} from '@/db/queries';
import { takePhoto, pickPhotos, processAndRegisterPhoto, type PickedPhoto } from '@/services/imageService';
import BarcodeScannerModal from '@/components/BarcodeScannerModal';
import { useAppStore } from '@/store/useAppStore';
import { getCurrentLimits } from '@/services/planService';
import { parseDisplayDate, formatDisplayDate } from '@/utils';

const CATEGORIES = Object.keys(CATEGORY_LABELS) as ItemCategory[];
const STATUSES = Object.keys(STATUS_LABELS) as ItemStatus[];
const CONDITIONS: ItemCondition[] = ['NEW', 'GOOD', 'WORN', 'NEED_REPAIR', 'BROKEN'];

/** tags lưu dạng JSON array string; nạp ra ô nhập thì nối bằng ', ' */
function tagsToText(tags: string | null): string {
  if (!tags) return '';
  try {
    const arr = JSON.parse(tags) as unknown;
    if (Array.isArray(arr)) return arr.map(String).join(', ');
  } catch {
    // không phải JSON — giữ nguyên chuỗi gốc
  }
  return tags;
}

export default function EditItemScreen() {
  const { t, lang } = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [item, setItem] = useState<Item | null>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<string>('OTHER');
  const [status, setStatus] = useState<string>('STORED');
  const [condition, setCondition] = useState<string>('GOOD');
  const [conditionNote, setConditionNote] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [qtyError, setQtyError] = useState(false);
  const [unit, setUnit] = useState('Cái');
  const [positionNote, setPositionNote] = useState('');
  const [expiryDisplay, setExpiryDisplay] = useState('');
  const [warrantyDisplay, setWarrantyDisplay] = useState('');
  const [purchaseDateDisplay, setPurchaseDateDisplay] = useState('');
  const [purchasePlace, setPurchasePlace] = useState('');
  const [price, setPrice] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [media, setMedia] = useState<MediaFile[]>([]);
  const [showAddCat, setShowAddCat] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [barcode, setBarcode] = useState<string | null>(null);
  const [showAddStatus, setShowAddStatus] = useState(false);
  const [showAddCond, setShowAddCond] = useState(false);
  // Số lượt mượn đang mở của món — để cảnh báo khi đổi sang trạng thái kết thúc
  const [activeLoanCount, setActiveLoanCount] = useState(0);
  // Popup dùng chung thay hộp thoại hệ thống: không có options = thông
  // báo/lỗi 1 nút "Đã hiểu"; có options = danh sách lựa chọn AppPopup
  const [popup, setPopup] = useState<{ title: string; message?: string; options?: AppPopupOption[] } | null>(null);
  const showInfo = (title: string, message?: string) => setPopup({ title, message });
  const bump = useAppStore((s) => s.bump);
  const customCategories = useAppStore((s) => s.customCategories);
  const customStatuses = useAppStore((s) => s.customStatuses);
  const customConditions = useAppStore((s) => s.customConditions);
  const loadTaxonomy = useAppStore((s) => s.loadTaxonomy);

  useFocusEffect(
    useCallback(() => {
      loadTaxonomy();
    }, [loadTaxonomy]),
  );

  const refreshMedia = useCallback(async (itemId: string): Promise<MediaFile[]> => {
    const list = await listMediaForOwner('ITEM', itemId);
    setMedia(list);
    return list;
  }, []);

  useEffect(() => {
    (async () => {
      if (!id) return;
      const it = await getItem(id);
      if (!it) return;
      setItem(it);
      setName(it.name);
      setCategory(it.category);
      setStatus(it.status);
      setCondition(it.condition);
      setConditionNote(it.condition_note ?? '');
      setQuantity(String(it.quantity));
      setUnit(it.unit);
      setPositionNote(it.position_note ?? '');
      setExpiryDisplay(formatDisplayDate(it.expiry_date));
      setWarrantyDisplay(formatDisplayDate(it.warranty_expiry_date));
      setPurchaseDateDisplay(formatDisplayDate(it.purchase_date));
      setPurchasePlace(it.purchase_place ?? '');
      setPrice(it.purchase_price != null ? String(it.purchase_price) : '');
      setTagsText(tagsToText(it.tags));
      setBarcode(it.barcode ?? null);
      setActiveLoanCount(await countActiveLoansForItem(it.id));
      await refreshMedia(it.id);
    })();
  }, [id, refreshMedia]);

  const closeups = media.filter((m) => m.kind === 'ITEM_CLOSEUP');
  const scenePhotos = media.filter((m) => m.kind === 'ITEM_SCENE');
  const primaryId = closeups.find((m) => m.is_primary === 1)?.id ?? closeups[0]?.id;

  // ---------- Ảnh (gallery dùng chung): 2 bucket riêng — ảnh đồ vật và
  // ảnh hiện trường — mỗi bucket có trần riêng theo gói (maxItemPhotos /
  // maxScenePhotos trong PLAN_LIMITS) ----------

  /** Lấy ảnh mới theo nguồn: camera = 1 tấm; thư viện = chọn nhiều trong 1 lần.
   *  Trần tách theo bucket: đồ vật dùng maxItemPhotos, hiện trường maxScenePhotos */
  async function acquirePhotos(
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

  async function addPhotos(kind: 'ITEM_CLOSEUP' | 'ITEM_SCENE', source: 'camera' | 'library') {
    if (!item) return;
    const isCloseup = kind === 'ITEM_CLOSEUP';
    const pickedList = await acquirePhotos(
      source,
      isCloseup ? closeups.length : scenePhotos.length,
      isCloseup ? getCurrentLimits().maxItemPhotos : getCurrentLimits().maxScenePhotos,
      isCloseup ? 'photos.limitMsg' : 'photos.sceneLimitMsg',
    );
    if (pickedList.length === 0) return;
    if (isCloseup) {
      // Chưa có ảnh chính thì tấm thêm đầu tiên nhận vai trò đó
      let needPrimary = !closeups.some((m) => m.is_primary === 1);
      for (const p of pickedList) {
        await processAndRegisterPhoto(p, 'ITEM', item.id, 'ITEM_CLOSEUP', needPrimary);
        needPrimary = false;
      }
    } else {
      // scene_media_id luôn trỏ 1 tấm hiện trường (ảnh hiện trường chính);
      // chưa có thì tấm thêm đầu tiên nhận vai trò đó, các tấm sau chỉ nằm
      // trong gallery. Ghim là của riêng từng tấm, không liên quan việc này.
      let mainSceneId = item.scene_media_id;
      for (const p of pickedList) {
        const reg = await processAndRegisterPhoto(p, 'ITEM', item.id, 'ITEM_SCENE', false);
        if (!mainSceneId) mainSceneId = reg.id;
      }
      if (mainSceneId !== item.scene_media_id) {
        await updateItem(item.id, { scene_media_id: mainSceneId });
        setItem({ ...item, scene_media_id: mainSceneId });
      }
    }
    await refreshMedia(item.id);
    bump();
  }

  async function handleDeletePhoto(m: MediaFile) {
    if (!item) return;
    await softDeleteMedia(m.id);
    const list = await refreshMedia(item.id);
    const rest = list.filter((x) => x.kind === 'ITEM_CLOSEUP');
    if (rest.length > 0 && !rest.some((x) => x.is_primary === 1)) {
      await setPrimaryMedia('ITEM', item.id, rest[0].id);
      await refreshMedia(item.id);
    }
    bump();
  }

  async function handleDeleteScenePhoto(m: MediaFile) {
    if (!item) return;
    await softDeleteMedia(m.id);
    const list = await refreshMedia(item.id);
    if (item.scene_media_id === m.id) {
      // Ảnh hiện trường chính bị xoá: trỏ scene_media_id sang tấm hiện
      // trường còn lại đầu tiên (hoặc null khi hết). Ghim của tấm bị xoá
      // mất theo chính hàng media của nó — mỗi ảnh có ghim riêng, KHÔNG
      // còn cơ chế chuyển ghim sang ảnh khác như mô hình cũ.
      const nextId = list.find((x) => x.kind === 'ITEM_SCENE')?.id ?? null;
      await updateItem(item.id, { scene_media_id: nextId });
      setItem({ ...item, scene_media_id: nextId });
    }
    bump();
  }

  async function handlePinChange(mediaId: string, p: { x: number; y: number }) {
    // Ghim riêng của từng ảnh hiện trường: cập nhật state ngay + lưu ngay
    // vào chính hàng media đó (giữ nhịp lưu ngay như trước)
    setMedia((prev) => prev.map((m) => (m.id === mediaId ? { ...m, pin_x: p.x, pin_y: p.y } : m)));
    await updateMediaPin(mediaId, p.x, p.y);
    bump();
  }

  // ---------- Lưu ----------

  async function handleSave() {
    if (!item) return;
    if (!name.trim()) {
      showInfo(t('qa.noNameTitle'), t('edit.noNameMsg'));
      return;
    }
    // Số lượng BẮT BUỘC như ở form thêm mới: bị xoá trống / 0 / không
    // phải số nguyên ≥ 1 thì chặn lưu, báo lỗi ngay tại trường (không
    // còn mặc định im lặng về 1 như trước)
    const qtyNum = /^\d+$/.test(quantity.trim()) ? parseInt(quantity, 10) : NaN;
    if (isNaN(qtyNum) || qtyNum < 1) {
      setQtyError(true);
      return;
    }
    const dateFields = [
      { labelKey: 'edit.expiryName', display: expiryDisplay },
      { labelKey: 'edit.warrantyName', display: warrantyDisplay },
      { labelKey: 'edit.purchaseDateName', display: purchaseDateDisplay },
    ] as const;
    const parsed: Record<string, string | null> = {};
    for (const f of dateFields) {
      if (f.display.trim()) {
        const iso = parseDisplayDate(f.display);
        if (!iso) {
          showInfo(t('edit.badDateTitle', { label: t(f.labelKey) }), t('qa.badDateMsg'));
          return;
        }
        parsed[f.labelKey] = iso;
      } else {
        parsed[f.labelKey] = null;
      }
    }
    const tagList = tagsText.split(',').map((s) => s.trim()).filter(Boolean);
    await updateItem(item.id, {
      name: name.trim(),
      category,
      condition,
      condition_note: conditionNote.trim() || null,
      quantity: qtyNum,
      unit: unit.trim() || t('qa.unitDefault'),
      position_note: positionNote.trim() || null,
      expiry_date: parsed['edit.expiryName'],
      warranty_expiry_date: parsed['edit.warrantyName'],
      purchase_date: parsed['edit.purchaseDateName'],
      purchase_place: purchasePlace.trim() || null,
      purchase_price: price ? parseInt(price.replace(/[^\d]/g, ''), 10) || null : null,
      tags: tagList.length > 0 ? JSON.stringify(tagList) : null,
      barcode: barcode || null,
    });
    if (status !== item.status) {
      if ((STATUSES as string[]).includes(status)) {
        // Trạng thái built-in: đi qua setItemStatus để giữ hệ quả (bán / vứt bỏ / thất lạc…)
        await setItemStatus(item.id, status as ItemStatus);
      } else {
        // Trạng thái tự tạo là nhãn trung tính: chỉ gán nhãn, không gắn logic nào
        await updateItem(item.id, { status });
      }
    }
    bump();
    rescheduleAllReminders().catch(() => {});
    router.back();
  }

  if (!item) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={styles.empty}>{t('edit.loading')}</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingBottom: 40, gap: 16 }]}>
      {/* ===== ẢNH: 2 block độc lập, mỗi block một thẻ riêng ===== */}
      <PhotoGallery
        card
        title={t('photos.item')}
        titleColor={Colors.coral}
        photos={closeups.map((m) => ({ key: m.id, uri: m.thumbnail_uri, fullUri: m.local_uri, isPrimary: m.id === primaryId }))}
        takeLabel={t('qa.takePhoto')}
        pickLabel={t('qa.pickPhoto')}
        onTake={() => { addPhotos('ITEM_CLOSEUP', 'camera').catch(() => {}); }}
        onPick={() => { addPhotos('ITEM_CLOSEUP', 'library').catch(() => {}); }}
        onRemove={(e) => {
          const m = closeups.find((x) => x.id === e.key);
          if (m) handleDeletePhoto(m).catch(() => {});
        }}
        onSetPrimary={(e) => {
          (async () => {
            await setPrimaryMedia('ITEM', item.id, e.key);
            await refreshMedia(item.id);
            bump();
          })().catch(() => {});
        }}
        maxReached={closeups.length >= getCurrentLimits().maxItemPhotos}
        limitText={t('photos.limitMsg', { n: getCurrentLimits().maxItemPhotos })}
      />

      <PhotoGallery
        card
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
        onTake={() => { addPhotos('ITEM_SCENE', 'camera').catch(() => {}); }}
        onPick={() => { addPhotos('ITEM_SCENE', 'library').catch(() => {}); }}
        onRemove={(e) => {
          const m = scenePhotos.find((x) => x.id === e.key);
          if (m) handleDeleteScenePhoto(m).catch(() => {});
        }}
        maxReached={scenePhotos.length >= getCurrentLimits().maxScenePhotos}
        limitText={t('photos.sceneLimitMsg', { n: getCurrentLimits().maxScenePhotos })}
        onPinChange={(e, p) => { handlePinChange(e.key, p).catch(() => {}); }}
      />

      {/* ===== THÔNG TIN ===== */}
      <View style={[styles.card, { gap: 14 }]}>
        <SectionTitle title={t('edit.infoSection')} color={Colors.primary} />
        <Field label={t('qa.nameLabel')}>
          <TextInput style={styles.input} value={name} onChangeText={setName} />
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
            {customCategories.map((ct) => (
              <TouchableOpacity
                key={ct.id}
                style={[styles.chip, category === ct.id && { backgroundColor: ct.color, borderColor: ct.color }]}
                onPress={() => setCategory(ct.id)}
              >
                <View style={[styles.chipIconBox, { backgroundColor: category === ct.id ? 'rgba(255,255,255,0.25)' : tint(ct.color, '1F') }]}>
                  <Ionicons
                    name={(ct.icon in Ionicons.glyphMap ? ct.icon : 'cube-outline') as IconName}
                    size={15}
                    color={category === ct.id ? '#fff' : ct.color}
                  />
                </View>
                <Text style={[styles.chipText, category === ct.id && styles.chipTextActive]}>{ct.name}</Text>
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
        <Field label={t('edit.statusLabel')}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {STATUSES.map((s) => (
              <TouchableOpacity
                key={s}
                style={[styles.chip, status === s && { backgroundColor: statusColorFor(s), borderColor: statusColorFor(s) }]}
                onPress={() => setStatus(s)}
              >
                <Ionicons name={statusIcon(s)} size={15} color={status === s ? '#fff' : statusColorFor(s)} />
                <Text style={[styles.chipText, status === s && styles.chipTextActive]}>{statusLabel(s)}</Text>
              </TouchableOpacity>
            ))}
            {customStatuses.map((ct) => (
              <TouchableOpacity
                key={ct.id}
                style={[styles.chip, status === ct.id && { backgroundColor: ct.color, borderColor: ct.color }]}
                onPress={() => setStatus(ct.id)}
              >
                <Ionicons
                  name={(ct.icon in Ionicons.glyphMap ? ct.icon : 'bookmark-outline') as IconName}
                  size={15}
                  color={status === ct.id ? '#fff' : ct.color}
                />
                <Text style={[styles.chipText, status === ct.id && styles.chipTextActive]}>{ct.name}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[styles.chip, { borderStyle: 'dashed', borderColor: Colors.primary }]}
              onPress={() => setShowAddStatus(true)}
            >
              <Ionicons name="add" size={15} color={Colors.primary} />
              <Text style={[styles.chipText, { color: Colors.primary }]}>{t('common.addStatus')}</Text>
            </TouchableOpacity>
          </ScrollView>
        </Field>
        {/* Đổi sang trạng thái KẾT THÚC trong lúc món còn lượt mượn mở:
            tầng dữ liệu sẽ tự đóng các lượt đó khi lưu — cảnh báo ngay tại
            form để không đóng ngầm (DAMAGED không đóng nên không cảnh báo) */}
        {status !== item.status
          && (['SOLD', 'GIFTED', 'DONATED', 'DISPOSED', 'LOST', 'USED_UP'] as string[]).includes(status)
          && activeLoanCount > 0 && (
            <View
              style={{
                flexDirection: 'row', gap: 7, alignItems: 'flex-start',
                backgroundColor: tint(Colors.orange, '16'), borderRadius: 12,
                paddingHorizontal: 10, paddingVertical: 8,
              }}
            >
              <Ionicons name="warning-outline" size={16} color={Colors.orange} style={{ marginTop: 1 }} />
              <Text style={{ flex: 1, fontSize: 12.5, lineHeight: 18, color: Colors.text }}>
                {t('loan.autoCloseWarn', { n: activeLoanCount })}
              </Text>
            </View>
          )}
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
            value={conditionNote}
            onChangeText={setConditionNote}
            placeholder={t('condition.notePh')}
            placeholderTextColor={Colors.faint}
          />
        </Field>
      </View>

      {/* ===== SỐ LƯỢNG & GHI CHÚ ===== */}
      <View style={[styles.card, { gap: 14 }]}>
        <SectionTitle title={t('edit.qtySection')} color={Colors.teal} />
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
        <Field label={t('qa.noteLabel')}>
          <TextInput style={styles.input} value={positionNote} onChangeText={setPositionNote} placeholder={t('qa.notePlaceholder')} placeholderTextColor={Colors.faint} />
        </Field>
      </View>

      {/* ===== MUA SẮM & HẠN ===== */}
      <View style={[styles.card, { gap: 14 }]}>
        <SectionTitle title={t('edit.purchaseSection')} color={Colors.orange} />
        <Field label={t('qa.priceLabel')}>
          <TextInput style={styles.input} keyboardType="number-pad" value={price} onChangeText={setPrice} placeholder="1250000" placeholderTextColor={Colors.faint} />
        </Field>
        <Field label={t('qa.purchaseDateLabel')}>
          <DateField value={purchaseDateDisplay} onChangeText={setPurchaseDateDisplay} placeholder={t('date.example')} title={t('qa.purchaseDateLabel')} />
        </Field>
        <Field label={t('qa.purchasePlaceLabel')}>
          <TextInput style={styles.input} value={purchasePlace} onChangeText={setPurchasePlace} placeholder={t('qa.purchasePlacePh')} placeholderTextColor={Colors.faint} />
        </Field>
        <Field label={t('qa.expiryLabel')}>
          <DateField value={expiryDisplay} onChangeText={setExpiryDisplay} placeholder={t('date.example')} title={t('qa.expiryLabel')} />
        </Field>
        <Field label={t('edit.warrantyLabel')}>
          <DateField value={warrantyDisplay} onChangeText={setWarrantyDisplay} placeholder={t('date.example')} title={t('edit.warrantyLabel')} />
        </Field>
        <Field label={t('qa.tagsLabel')} hint={t('qa.tagsHint')}>
          <TextInput style={styles.input} value={tagsText} onChangeText={setTagsText} placeholder={t('qa.tagsPh')} placeholderTextColor={Colors.faint} />
        </Field>
      </View>

      <AppButton title={t('edit.save')} icon="save-outline" onPress={handleSave} />

      <BarcodeScannerModal
        visible={showScanner}
        onClose={() => setShowScanner(false)}
        onScanned={(data) => setBarcode(data)}
      />
      <AddTermModal
        visible={showAddCat}
        kind="CATEGORY"
        onClose={() => setShowAddCat(false)}
        onAdded={(term) => setCategory(term.id)}
      />
      <AddTermModal
        visible={showAddStatus}
        kind="STATUS"
        onClose={() => setShowAddStatus(false)}
        onAdded={(term) => setStatus(term.id)}
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
