import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Modal, TextInput, FlatList, Linking,
} from 'react-native';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as ExpoLocation from 'expo-location';
import { styles, Colors, ItemCard, LocationPickerModal, IconTile, IconPickerGrid, SectionTitle, AppPopup, PhotoGallery, OsmMapPreview, type IconName } from '@/components/ui';
import { LOCATION_TYPE_COLORS, locationIconName, locationTypeLabel } from '@/theme';
import { useT } from '@/i18n';
import type { Item, Location, MediaFile } from '@/types';
import {
  getLocation, getBreadcrumb, breadcrumbText, listLocations, itemsInLocation,
  getDescendantLocationIds, moveLocation, renameLocation, setLocationIcon, softDeleteLocation, createLocation,
  setLocationCoords, clearLocationCoords,
  listMediaForOwner, softDeleteMedia, setPrimaryMedia,
} from '@/db/queries';
import { takePhoto, pickPhotos, processAndRegisterPhoto, type PickedPhoto } from '@/services/imageService';
import { getCurrentLimits } from '@/services/planService';
import { useAppStore } from '@/store/useAppStore';

export default function LocationDetailScreen() {
  const { t } = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [loc, setLoc] = useState<Location | null>(null);
  // Ảnh hiện trường của chính vị trí này: media owner_type 'LOCATION',
  // kind 'LOCATION_SCENE' (đúng mô hình media dùng chung; đọc bằng
  // listMediaForOwner như mọi nơi, thứ tự is_primary DESC, created_at ASC)
  const [sceneMedia, setSceneMedia] = useState<MediaFile[]>([]);
  // Key của ảnh hiện trường vừa thêm — truyền xuống PhotoGallery làm
  // focusKey để gallery tự nhảy tới hiển thị ngay ảnh mới ở khung lớn
  const [focusSceneKey, setFocusSceneKey] = useState<string | null>(null);
  const [crumb, setCrumb] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [children, setChildren] = useState<Location[]>([]);
  const [allLocations, setAllLocations] = useState<Location[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
  const [crumbsMap, setCrumbsMap] = useState<Record<string, string>>({});
  const [showMove, setShowMove] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [showAddChild, setShowAddChild] = useState(false);
  const [text, setText] = useState('');
  const [renameIcon, setRenameIcon] = useState<IconName | null>(null);
  const [childIcon, setChildIcon] = useState<IconName | null>(null);
  const [fetchingCoords, setFetchingCoords] = useState(false);
  const [latText, setLatText] = useState('');
  const [lngText, setLngText] = useState('');
  const [showDeletePopup, setShowDeletePopup] = useState(false);
  const [showClearCoordsPopup, setShowClearCoordsPopup] = useState(false);
  // Popup thông báo/lỗi dùng chung (1 nút "Đã hiểu") thay hộp thoại hệ thống
  const [infoPopup, setInfoPopup] = useState<{ title: string; message?: string } | null>(null);
  const showInfo = (title: string, message?: string) => setInfoPopup({ title, message });
  const bump = useAppStore((s) => s.bump);

  const load = useCallback(async () => {
    if (!id) return;
    const l = await getLocation(id);
    setLoc(l);
    if (!l) return;
    const locMedia = await listMediaForOwner('LOCATION', l.id);
    setSceneMedia(locMedia.filter((m) => m.kind === 'LOCATION_SCENE'));
    setCrumb(breadcrumbText(await getBreadcrumb(l.id)));
    const its = await itemsInLocation(l.id, true);
    setItems(its);
    const all = await listLocations();
    setAllLocations(all);
    setChildren(all.filter((c) => c.parent_id === l.id));
    const tMap: Record<string, string | null> = {};
    const cMap: Record<string, string> = {};
    for (const it of its) {
      const media = await listMediaForOwner('ITEM', it.id);
      tMap[it.id] = media[0]?.thumbnail_uri ?? null;
      cMap[it.id] = breadcrumbText(await getBreadcrumb(it.location_id));
    }
    setThumbs(tMap);
    setCrumbsMap(cMap);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (!loc) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={styles.empty}>{t('ld.notFound')}</Text>
      </View>
    );
  }

  const depth = crumb ? crumb.split('>').length - 1 : 0;
  const lat = loc.latitude;
  const lng = loc.longitude;

  function handleDelete() {
    const childCount = children.length;
    if (childCount > 0 || items.length > 0) {
      showInfo(t('ld.cantDeleteTitle'), t('ld.cantDeleteMsg'));
      return;
    }
    setShowDeletePopup(true);
  }

  /** Xác nhận ở AppPopup xoá vị trí */
  async function handleDeleteConfirm() {
    await softDeleteLocation(loc!.id);
    bump();
    router.back();
  }

  async function handleAddChild() {
    if (!text.trim()) return;
    const types: Location['type'][] = ['PROPERTY', 'ROOM', 'FURNITURE', 'CONTAINER'];
    const nextType = types[Math.min(3, depth + 1)];
    try {
      await createLocation({ name: text.trim(), type: nextType, parent_id: loc!.id, icon: childIcon });
      setText('');
      setChildIcon(null);
      setShowAddChild(false);
      bump();
      load();
    } catch (e) {
      showInfo(t('ld.createFailTitle'), e instanceof Error ? e.message : String(e));
    }
  }

  /** Ghim/cập nhật toạ độ từ vị trí hiện tại của thiết bị — chỉ xin quyền khi người dùng bấm nút này */
  async function handlePinCurrent() {
    if (fetchingCoords) return;
    const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      showInfo(t('loc.coordsPermDeniedTitle'), t('loc.coordsPermDenied'));
      return;
    }
    setFetchingCoords(true);
    try {
      const pos = await ExpoLocation.getCurrentPositionAsync({ accuracy: ExpoLocation.Accuracy.High });
      await setLocationCoords(loc!.id, pos.coords.latitude, pos.coords.longitude);
      bump();
      await load();
      showInfo(t('loc.coordsSaved'));
    } catch {
      showInfo(t('loc.coordsFailedTitle'), t('loc.coordsFailed'));
    } finally {
      setFetchingCoords(false);
    }
  }

  /** Lưu toạ độ nhập tay (dự phòng khi không lấy được GPS) */
  async function handleSaveManualCoords() {
    const lat = Number(latText.trim().replace(',', '.'));
    const lng = Number(lngText.trim().replace(',', '.'));
    if (
      latText.trim() === '' || lngText.trim() === '' ||
      !Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat < -90 || lat > 90 || lng < -180 || lng > 180
    ) {
      showInfo(t('loc.coordsInvalidTitle'), t('loc.coordsInvalid'));
      return;
    }
    await setLocationCoords(loc!.id, lat, lng);
    setLatText('');
    setLngText('');
    bump();
    load();
    showInfo(t('loc.coordsSaved'));
  }

  function handleClearCoords() {
    setShowClearCoordsPopup(true);
  }

  /** Xác nhận ở AppPopup xoá ghim toạ độ */
  async function handleClearCoordsConfirm() {
    await clearLocationCoords(loc!.id);
    bump();
    load();
  }

  function handleDirections() {
    if (loc!.latitude == null || loc!.longitude == null) return;
    Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${loc!.latitude},${loc!.longitude}`);
  }

  // ---- Thêm/xoá ảnh hiện trường ngay tại trang chi tiết vị trí: ĐÚNG
  // mẫu bucket hiện trường của trang chi tiết đồ (item/[id].tsx) — cùng
  // trần maxScenePhotos theo gói, cùng đăng ký media qua imageService,
  // cùng hệ quả xoá. Khác duy nhất: owner 'LOCATION' + kind
  // 'LOCATION_SCENE', và vị trí ĐÃ CÓ id nên đăng ký ngay bằng
  // processAndRegisterPhoto (không qua gallery chờ như modal tạo mới) ----

  /** Lấy ảnh mới theo nguồn: camera = 1 tấm; thư viện = chọn nhiều
   *  trong 1 lần, cắt ở số slot còn lại theo trần bucket */
  async function acquireScenePhotos(source: 'camera' | 'library'): Promise<PickedPhoto[]> {
    const limit = getCurrentLimits().maxScenePhotos;
    const remaining = limit - sceneMedia.length;
    if (remaining <= 0) {
      showInfo(t('loc.limitTitle'), t('photos.sceneLimitMsg', { n: limit }));
      return [];
    }
    if (source === 'camera') {
      const p = await takePhoto();
      return p ? [p] : [];
    }
    const all = await pickPhotos(remaining);
    // Một số máy bỏ qua selectionLimit: chỉ lấy đến trần và báo giới hạn
    if (all.length > remaining) {
      showInfo(t('loc.limitTitle'), t('photos.sceneLimitMsg', { n: limit }));
    }
    return all.slice(0, remaining);
  }

  /** Thêm ảnh hiện trường cho vị trí này; sau khi nạp lại danh sách,
   *  đặt focusKey = id ảnh mới đầu tiên → gallery tự nhảy tới hiển thị
   *  ngay ảnh đó. Chưa có ảnh chính thì tấm thêm đầu tiên nhận vai trò
   *  đó (cờ is_primary — nhất quán với phía tạo mới và phía hiển thị) */
  async function addScenePhotos(source: 'camera' | 'library') {
    const pickedList = await acquireScenePhotos(source);
    if (pickedList.length === 0) return;
    const newIds: string[] = [];
    let needPrimary = !sceneMedia.some((m) => m.is_primary === 1);
    for (const p of pickedList) {
      const reg = await processAndRegisterPhoto(p, 'LOCATION', loc!.id, 'LOCATION_SCENE', needPrimary);
      newIds.push(reg.id);
      needPrimary = false;
    }
    bump();
    await load();
    if (newIds.length > 0) setFocusSceneKey(newIds[0]);
  }

  /** Xoá ảnh hiện trường ngay tại chi tiết — ĐÚNG logic hệ quả của các
   *  bucket ở chi tiết đồ: softDeleteMedia cho hàng media, tấm còn lại
   *  đầu tiên lên ảnh chính nếu vừa mất ảnh chính */
  async function handleDeleteScenePhoto(m: MediaFile) {
    await softDeleteMedia(m.id);
    let list = (await listMediaForOwner('LOCATION', loc!.id)).filter((x) => x.kind === 'LOCATION_SCENE');
    setSceneMedia(list);
    if (list.length > 0 && !list.some((x) => x.is_primary === 1)) {
      await setPrimaryMedia('LOCATION', loc!.id, list[0].id);
      list = (await listMediaForOwner('LOCATION', loc!.id)).filter((x) => x.kind === 'LOCATION_SCENE');
      setSceneMedia(list);
    }
    bump();
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingBottom: 40 }]}>
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <IconTile icon={locationIconName(loc)} color={LOCATION_TYPE_COLORS[loc.type]} size={54} iconSize={27} />
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{loc.name}</Text>
            <Text style={styles.subtitle}>{locationTypeLabel(loc.type)} · {loc.qr_code}</Text>
          </View>
        </View>
        {!!crumb && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', backgroundColor: Colors.chipBg, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 }}>
            <Ionicons name="location" size={14} color={Colors.primary} />
            <Text style={{ fontSize: 13, color: Colors.primaryDark, fontWeight: '700' }}>{crumb}</Text>
          </View>
        )}
      </View>

      {/* Ảnh hiện trường của vị trí (PhotoGallery mode 'detail' — ĐÚNG
          mẫu block hiện trường ở chi tiết đồ): nằm ngay dưới phần đầu
          trang, trên thẻ Toạ độ. Block LUÔN render (kể cả chưa có ảnh:
          khung trống + nút "Thêm ảnh mới" để thêm được ảnh đầu tiên
          ngay tại đây); thêm qua popup Chụp / Thư viện rồi đăng ký ngay
          (vị trí đã có id), xoá qua nút thùng rác trên chính ảnh lớn
          (popup xác nhận → softDeleteMedia + hệ quả ảnh chính như các
          bucket khác), thêm xong gallery nhảy tới ảnh mới qua focusKey */}
      <PhotoGallery
        card
        mode="detail"
        title={t('photos.scene')}
        titleColor={Colors.teal}
        photos={sceneMedia.map((m) => ({
          key: m.id,
          uri: m.thumbnail_uri,
          fullUri: m.local_uri,
          isPrimary: m.is_primary === 1,
        }))}
        takeLabel={t('qa.takePhoto')}
        pickLabel={t('photos.addScene')}
        onTake={() => { addScenePhotos('camera').catch(() => {}); }}
        onPick={() => { addScenePhotos('library').catch(() => {}); }}
        onRemove={(e) => {
          const m = sceneMedia.find((x) => x.id === e.key);
          if (m) handleDeleteScenePhoto(m).catch(() => {});
        }}
        focusKey={focusSceneKey ?? undefined}
        maxReached={sceneMedia.length >= getCurrentLimits().maxScenePhotos}
        limitText={t('photos.sceneLimitMsg', { n: getCurrentLimits().maxScenePhotos })}
      />

      {/* Thẻ toạ độ: đặt ngay dưới khối thông tin đầu tiên của vị trí
          (dưới block ảnh hiện trường nếu vị trí có ảnh) */}
      <View style={{ gap: 10 }}>
        <SectionTitle title={t('loc.coordsTitle')} color={Colors.coral} />
        <View style={[styles.card, { gap: 12 }]}>
          {loc.latitude != null && loc.longitude != null ? (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="location" size={19} color={Colors.coral} />
                <Text style={{ fontSize: 15.5, fontWeight: '700', color: Colors.text }}>
                  {loc.latitude.toFixed(6)}, {loc.longitude.toFixed(6)}
                </Text>
              </View>
              {/* Bản đồ xem trước ngay trong block, phía trên hàng nút —
                  key theo toạ độ (6 số thập phân) để toạ độ đổi là bản đồ
                  dựng lại theo điểm mới; mất mạng thì khung tự ẩn */}
              {lat != null && lng != null && (
                <OsmMapPreview
                  key={`${lat.toFixed(6)},${lng.toFixed(6)}`}
                  lat={lat}
                  lng={lng}
                  onPress={handleDirections}
                />
              )}
              <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
                <TouchableOpacity style={[styles.button, { paddingVertical: 10, paddingHorizontal: 14 }]} onPress={handleDirections} disabled={fetchingCoords}>
                  <Ionicons name="navigate-outline" size={16} color="#fff" />
                  <Text style={[styles.buttonText, { fontSize: 13 }]}>{t('loc.coordsDirections')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.buttonSecondary, { paddingVertical: 10, paddingHorizontal: 14 }]} onPress={handlePinCurrent} disabled={fetchingCoords}>
                  <Ionicons name="locate-outline" size={16} color={Colors.primaryDark} />
                  <Text style={[styles.buttonSecondaryText, { fontSize: 13 }]}>{fetchingCoords ? t('loc.coordsGetting') : t('loc.coordsUpdate')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.buttonDanger, { paddingVertical: 10, paddingHorizontal: 14 }]} onPress={handleClearCoords} disabled={fetchingCoords}>
                  <Text style={[styles.buttonDangerText, { fontSize: 13 }]}>{t('loc.coordsClear')}</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <TouchableOpacity style={styles.button} onPress={handlePinCurrent} disabled={fetchingCoords}>
                <Ionicons name="locate-outline" size={18} color="#fff" />
                <Text style={styles.buttonText}>{fetchingCoords ? t('loc.coordsGetting') : t('loc.coordsPinCurrent')}</Text>
              </TouchableOpacity>
              <View>
                <Text style={styles.label}>{t('loc.coordsManual')}</Text>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    placeholder={t('loc.coordsLat')}
                    value={latText}
                    onChangeText={setLatText}
                    keyboardType="decimal-pad"
                  />
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    placeholder={t('loc.coordsLng')}
                    value={lngText}
                    onChangeText={setLngText}
                    keyboardType="decimal-pad"
                  />
                  <TouchableOpacity style={[styles.button, { paddingHorizontal: 16 }]} onPress={handleSaveManualCoords}>
                    <Text style={styles.buttonText}>{t('common.save')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </>
          )}
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        {depth < 3 && (
          <TouchableOpacity style={[styles.button, { paddingVertical: 10, paddingHorizontal: 14 }]} onPress={() => { setText(''); setChildIcon(null); setShowAddChild(true); }}>
            <Ionicons name="add" size={16} color="#fff" />
            <Text style={[styles.buttonText, { fontSize: 13 }]}>{t('ld.addChild')}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={[styles.buttonSecondary, { paddingVertical: 10, paddingHorizontal: 14 }]} onPress={() => { setText(loc.name); setRenameIcon(loc.icon as IconName | null); setShowRename(true); }}>
          <Text style={[styles.buttonSecondaryText, { fontSize: 13 }]}>{t('ld.rename')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.buttonSecondary, { paddingVertical: 10, paddingHorizontal: 14 }]} onPress={() => setShowMove(true)}>
          <Text style={[styles.buttonSecondaryText, { fontSize: 13 }]}>{t('ld.move')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.buttonSecondary, { paddingVertical: 10, paddingHorizontal: 14 }]}
          onPress={() => router.push({ pathname: '/labels', params: { loc: loc.id } })}
        >
          <Ionicons name="qr-code-outline" size={16} color={Colors.primaryDark} />
          <Text style={[styles.buttonSecondaryText, { fontSize: 13 }]}>{t('detail.printLabel')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.buttonDanger, { paddingVertical: 10, paddingHorizontal: 14 }]} onPress={handleDelete}>
          <Text style={[styles.buttonDangerText, { fontSize: 13 }]}>{t('ld.delete')}</Text>
        </TouchableOpacity>
      </View>

      {children.length > 0 && (
        <View style={{ gap: 10 }}>
          <SectionTitle title={t('ld.childrenTitle')} color={Colors.teal} />
          {children.map((c) => (
            <TouchableOpacity key={c.id} style={[styles.card, { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 }]} onPress={() => router.push(`/location/${c.id}`)}>
              <IconTile icon={locationIconName(c)} color={LOCATION_TYPE_COLORS[c.type]} size={44} iconSize={22} />
              <Text style={{ flex: 1, fontSize: 15, fontWeight: '700', color: Colors.text }}>{c.name}</Text>
              <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: Colors.chipBg, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="chevron-forward" size={17} color={Colors.primary} />
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={{ gap: 10 }}>
        <SectionTitle title={t('ld.itemsTitle')} subtitle={t('home.itemsCount', { n: items.length })} color={Colors.orange} />
        {items.length === 0 ? (
          <Text style={{ color: Colors.subtext, fontSize: 13 }}>{t('ld.emptyItems')}</Text>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(i) => i.id}
            scrollEnabled={false}
            ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
            renderItem={({ item }) => (
              <ItemCard item={item} breadcrumb={crumbsMap[item.id] ?? ''} thumbUri={thumbs[item.id]} onPress={() => router.push(`/item/${item.id}`)} />
            )}
          />
        )}
      </View>

      <LocationPickerModal
        visible={showMove}
        locations={allLocations}
        title={t('ld.moveTitle')}
        excludeId={loc.id}
        onClose={() => setShowMove(false)}
        onSelect={async (target) => {
          try {
            // picker chọn vị trí cha mới; chặn hậu duệ bằng validateParent trong moveLocation
            const descendants = await getDescendantLocationIds(loc.id);
            if (descendants.includes(target.id)) {
              showInfo(t('ld.moveFailTitle'), t('ld.moveIntoChildMsg'));
              return;
            }
            await moveLocation(loc.id, target.id);
            bump();
            load();
          } catch (e) {
            showInfo(t('ld.moveFailTitle'), e instanceof Error ? e.message : String(e));
          }
        }}
      />

      <Modal visible={showRename || showAddChild} transparent animationType="fade" onRequestClose={() => { setShowRename(false); setShowAddChild(false); }}>
        <View style={styles.modalOverlay}>
          <View style={[styles.card, styles.modalCard, { gap: 14 }]}>
            <Text style={{ fontSize: 18, fontWeight: '800', color: Colors.text }}>{showRename ? t('ld.renameTitle') : t('ld.addChild')}</Text>
            <TextInput style={styles.input} value={text} onChangeText={setText} autoFocus />
            <View>
              <Text style={styles.label}>{t('locations.iconLabel')}</Text>
              <IconPickerGrid
                value={showRename ? renameIcon : childIcon}
                onChange={showRename ? setRenameIcon : setChildIcon}
                showDefaultOption
              />
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity style={[styles.buttonSecondary, { flex: 1 }]} onPress={() => { setShowRename(false); setShowAddChild(false); }}>
                <Text style={styles.buttonSecondaryText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, { flex: 1 }]}
                onPress={async () => {
                  if (showRename) {
                    if (text.trim()) await renameLocation(loc.id, text.trim());
                    await setLocationIcon(loc.id, renameIcon);
                    setShowRename(false);
                  } else {
                    await handleAddChild();
                    return;
                  }
                  bump();
                  load();
                }}
              >
                <Text style={styles.buttonText}>{t('common.save')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <AppPopup
        visible={showDeletePopup}
        title={t('ld.deleteTitle')}
        message={t('ld.deleteMsg', { name: loc.name })}
        confirm={{ label: t('ld.delete'), danger: true, onConfirm: () => { handleDeleteConfirm().catch(() => {}); } }}
        onClose={() => setShowDeletePopup(false)}
      />

      <AppPopup
        visible={showClearCoordsPopup}
        title={t('loc.coordsClearTitle')}
        message={t('loc.coordsClearMsg')}
        confirm={{ label: t('loc.coordsClear'), danger: true, onConfirm: () => { handleClearCoordsConfirm().catch(() => {}); } }}
        onClose={() => setShowClearCoordsPopup(false)}
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
