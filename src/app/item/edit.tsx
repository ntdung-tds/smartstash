import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity, Alert, Image, type AlertButton } from 'react-native';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { styles, Colors, AddTermModal, AppButton, Field, SceneImage, SectionTitle } from '@/components/ui';
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
} from '@/db/queries';
import { takePhoto, pickPhoto, processAndRegisterPhoto } from '@/services/imageService';
import BarcodeScannerModal from '@/components/BarcodeScannerModal';
import { useAppStore } from '@/store/useAppStore';
import { CURRENT_LIMITS } from '@/config';
import { maskDateInput, parseDisplayDate, formatDisplayDate } from '@/utils';

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
  const [unit, setUnit] = useState('Cái');
  const [positionNote, setPositionNote] = useState('');
  const [expiryDisplay, setExpiryDisplay] = useState('');
  const [warrantyDisplay, setWarrantyDisplay] = useState('');
  const [purchaseDateDisplay, setPurchaseDateDisplay] = useState('');
  const [purchasePlace, setPurchasePlace] = useState('');
  const [price, setPrice] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [media, setMedia] = useState<MediaFile[]>([]);
  const [pinX, setPinX] = useState<number | null>(null);
  const [pinY, setPinY] = useState<number | null>(null);
  const [showAddCat, setShowAddCat] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [barcode, setBarcode] = useState<string | null>(null);
  const [showAddStatus, setShowAddStatus] = useState(false);
  const [showAddCond, setShowAddCond] = useState(false);
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
      setPinX(it.pin_x);
      setPinY(it.pin_y);
      await refreshMedia(it.id);
    })();
  }, [id, refreshMedia]);

  const closeups = media.filter((m) => m.kind === 'ITEM_CLOSEUP');
  const sceneMedia = item
    ? media.find((m) => m.id === item.scene_media_id) ?? media.find((m) => m.kind === 'ITEM_SCENE') ?? null
    : null;
  const primaryId = closeups.find((m) => m.is_primary === 1)?.id ?? closeups[0]?.id;
  const pin = pinX != null && pinY != null ? { x: pinX, y: pinY } : null;

  // ---------- Ảnh cận cảnh ----------

  async function addCloseup(source: 'camera' | 'library') {
    if (!item) return;
    const picked = source === 'camera' ? await takePhoto() : await pickPhoto();
    if (!picked) return;
    await processAndRegisterPhoto(picked, 'ITEM', item.id, 'ITEM_CLOSEUP', closeups.length === 0);
    await refreshMedia(item.id);
    bump();
  }

  function handleAddPhoto() {
    if (closeups.length >= CURRENT_LIMITS.maxPhotosPerItem) {
      Alert.alert(t('loc.limitTitle'), t('photos.limitMsg', { n: CURRENT_LIMITS.maxPhotosPerItem }));
      return;
    }
    Alert.alert(t('photos.title'), undefined, [
      { text: t('qa.takePhoto'), onPress: () => { addCloseup('camera').catch(() => {}); } },
      { text: t('qa.pickPhoto'), onPress: () => { addCloseup('library').catch(() => {}); } },
      { text: t('common.cancel'), style: 'cancel' },
    ]);
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

  function handlePhotoPress(m: MediaFile) {
    if (!item) return;
    const buttons: AlertButton[] = [];
    if (m.id !== primaryId) {
      buttons.push({
        text: t('photos.setPrimary'),
        onPress: () => {
          (async () => {
            await setPrimaryMedia('ITEM', item.id, m.id);
            await refreshMedia(item.id);
            bump();
          })().catch(() => {});
        },
      });
    }
    buttons.push({ text: t('photos.delete'), style: 'destructive', onPress: () => { handleDeletePhoto(m).catch(() => {}); } });
    buttons.push({ text: t('common.cancel'), style: 'cancel' });
    Alert.alert(t('photos.title'), undefined, buttons);
  }

  // ---------- Ảnh hiện trường ----------

  async function replaceScene(source: 'camera' | 'library') {
    if (!item) return;
    const picked = source === 'camera' ? await takePhoto() : await pickPhoto();
    if (!picked) return;
    const registered = await processAndRegisterPhoto(picked, 'ITEM', item.id, 'ITEM_SCENE', false);
    await updateItem(item.id, { scene_media_id: registered.id });
    setItem({ ...item, scene_media_id: registered.id });
    await refreshMedia(item.id);
    bump();
  }

  function handleSceneSource() {
    Alert.alert(t('photos.scene'), undefined, [
      { text: t('qa.takePhoto'), onPress: () => { replaceScene('camera').catch(() => {}); } },
      { text: t('qa.pickPhoto'), onPress: () => { replaceScene('library').catch(() => {}); } },
      { text: t('common.cancel'), style: 'cancel' },
    ]);
  }

  async function handlePinChange(p: { x: number; y: number }) {
    setPinX(p.x);
    setPinY(p.y);
    if (item) {
      await updateItem(item.id, { pin_x: p.x, pin_y: p.y });
      bump();
    }
  }

  // ---------- Lưu ----------

  async function handleSave() {
    if (!item) return;
    if (!name.trim()) {
      Alert.alert(t('qa.noNameTitle'), t('edit.noNameMsg'));
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
          Alert.alert(t('edit.badDateTitle', { label: t(f.labelKey) }), t('qa.badDateMsg'));
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
      quantity: Math.max(1, parseInt(quantity, 10) || 1),
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
      {/* ===== ẢNH ===== */}
      <View style={[styles.card, { gap: 14 }]}>
        <SectionTitle title={t('photos.title')} color={Colors.coral} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            {closeups.map((m) => (
              <TouchableOpacity key={m.id} onPress={() => handlePhotoPress(m)} activeOpacity={0.85}>
                <Image source={{ uri: m.thumbnail_uri }} style={{ width: 84, height: 84, borderRadius: 18 }} />
                {m.id === primaryId && (
                  <View style={{ position: 'absolute', left: 6, bottom: 6, backgroundColor: Colors.primary, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 }}>
                    <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800', lineHeight: 14 }}>{t('photos.primary')}</Text>
                  </View>
                )}
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              onPress={handleAddPhoto}
              activeOpacity={0.85}
              style={{
                width: 84, height: 84, borderRadius: 18, borderWidth: 1.5, borderStyle: 'dashed',
                borderColor: Colors.primary, backgroundColor: tint(Colors.primary, '10'),
                alignItems: 'center', justifyContent: 'center', gap: 4,
              }}
            >
              <Ionicons name="camera" size={24} color={Colors.primary} />
              <Text style={{ fontSize: 11, fontWeight: '700', color: Colors.primary }}>{t('photos.add')}</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>

        <Field label={t('photos.scene')}>
          {sceneMedia ? (
            <View style={{ gap: 10 }}>
              <SceneImage uri={sceneMedia.local_uri} pin={pin} editable onPinChange={handlePinChange} height={220} />
              <AppButton title={t('photos.replaceScene')} variant="secondary" icon="camera-outline" onPress={handleSceneSource} />
            </View>
          ) : (
            <AppButton title={t('photos.addScene')} variant="secondary" icon="image-outline" onPress={handleSceneSource} />
          )}
        </Field>
      </View>

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
            <TextInput style={styles.input} keyboardType="number-pad" value={quantity} onChangeText={setQuantity} />
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
          <TextInput
            style={styles.input}
            keyboardType="number-pad"
            value={purchaseDateDisplay}
            onChangeText={(v) => setPurchaseDateDisplay(maskDateInput(v))}
            placeholder={t('date.example')}
            placeholderTextColor={Colors.faint}
          />
        </Field>
        <Field label={t('qa.purchasePlaceLabel')}>
          <TextInput style={styles.input} value={purchasePlace} onChangeText={setPurchasePlace} placeholder={t('qa.purchasePlacePh')} placeholderTextColor={Colors.faint} />
        </Field>
        <Field label={t('qa.expiryLabel')}>
          <TextInput
            style={styles.input}
            keyboardType="number-pad"
            value={expiryDisplay}
            onChangeText={(v) => setExpiryDisplay(maskDateInput(v))}
            placeholder={t('date.example')}
            placeholderTextColor={Colors.faint}
          />
        </Field>
        <Field label={t('edit.warrantyLabel')}>
          <TextInput
            style={styles.input}
            keyboardType="number-pad"
            value={warrantyDisplay}
            onChangeText={(v) => setWarrantyDisplay(maskDateInput(v))}
            placeholder={t('date.example')}
            placeholderTextColor={Colors.faint}
          />
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
    </ScrollView>
  );
}
