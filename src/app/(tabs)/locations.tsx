import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Modal, TextInput, ScrollView,
  Vibration,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { styles, Colors, AppButton, IconTile, IconPickerGrid, AppPopup, PhotoGallery, TAB_BAR_CLEARANCE, type IconName } from '@/components/ui';
import { LOCATION_TYPE_COLORS, locationIconName, locationTypeLabel, tint } from '@/theme';
import { useT } from '@/i18n';
import type { Location } from '@/types';
import { LOCATION_TYPE_BY_DEPTH as TYPE_BY_DEPTH } from '@/types';
import { listLocations, createLocation, itemsInLocation, countLocations, reorderLocations } from '@/db/queries';
import { takePhoto, pickPhotos, processAndRegisterPhoto, type PickedPhoto } from '@/services/imageService';
import { uuid } from '@/utils';
import { useAppStore } from '@/store/useAppStore';
import { getCurrentLimits } from '@/services/planService';

// Chiều cao hàng cố định (IconTile 44 + padding dọc 15×2) + khoảng cách giữa các hàng.
// Kéo thả tính toán theo các hằng số này nên hàng KHÔNG được cao hơn/kém — tên dài bị cắt 1 dòng.
const ROW_H = 74;
const ROW_SEP = 10;
const STRIDE = ROW_H + ROW_SEP;

type FlatRow = { loc: Location; depth: number; hasChildren: boolean };

/** Chỉ số kết thúc (exclusive) của khối bắt đầu tại start: node + mọi hậu duệ ĐANG hiển thị */
function blockEnd(rows: FlatRow[], start: number): number {
  const d = rows[start].depth;
  let i = start + 1;
  while (i < rows.length && rows[i].depth > d) i++;
  return i;
}

export default function LocationsScreen() {
  const { t } = useT();
  const [locations, setLocations] = useState<Location[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [visibleRootCount, setVisibleRootCount] = useState(10);
  const [modalParent, setModalParent] = useState<Location | null | undefined>(undefined); // undefined = đóng
  const [newName, setNewName] = useState('');
  const [newIcon, setNewIcon] = useState<IconName | null>(null);
  // Ảnh hiện trường ĐANG CHỜ của vị trí sắp tạo (kiến trúc pending của
  // quick-add): form này là nhập-xong-mới-lưu — vị trí chưa có id khi đang
  // nhập nên ảnh chỉ giữ ở state; ngay sau khi createLocation thành công
  // mới đăng ký media (owner 'LOCATION', kind 'LOCATION_SCENE') theo id
  // vừa tạo. Key ổn định để gallery xoá đúng tấm.
  const [pendingScenePhotos, setPendingScenePhotos] = useState<{ key: string; picked: PickedPhoto }[]>([]);
  // Key ảnh hiện trường vừa thêm trong modal → focusKey cho gallery để
  // khung lớn nhảy tới ngay ảnh mới (như quick-add)
  const [pendingFocusKey, setPendingFocusKey] = useState<string | undefined>(undefined);
  // Ô Tên của modal tạo vị trí: TỰ FOCUS mỗi khi modal mở (effect theo
  // trạng thái mở — autoFocus một mình chỉ chạy ở lần mount đầu vì form
  // nằm cố định trong cây của màn, không remount theo lần mở)
  const newNameInputRef = useRef<React.ElementRef<typeof TextInput>>(null);
  useEffect(() => {
    if (modalParent === undefined) return;
    const timer = setTimeout(() => newNameInputRef.current?.focus(), 150);
    return () => clearTimeout(timer);
  }, [modalParent]);
  const refreshTick = useAppStore((s) => s.refreshTick);
  const bump = useAppStore((s) => s.bump);

  // ----- Kéo thả sắp xếp (responder system của RN, không thêm thư viện) -----
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragDy, setDragDy] = useState(0);
  const [workFlat, setWorkFlat] = useState<FlatRow[] | null>(null);
  const dragRef = useRef<{ id: string; parentId: string | null; dyBase: number; startY: number | null } | null>(null);
  const workRef = useRef<FlatRow[] | null>(null);
  const flatRef = useRef<FlatRow[]>([]);
  const lastDragEndAt = useRef(0);

  // ----- Đánh dấu + cuộn tới vị trí vừa tạo -----
  const listRef = useRef<FlatList<FlatRow>>(null);
  const pendingFocusRef = useRef<string | null>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [newLocId, setNewLocId] = useState<string | null>(null);
  // Popup thông báo dùng chung (1 nút "Đã hiểu") thay hộp thoại hệ thống
  const [infoPopup, setInfoPopup] = useState<{ title: string; message?: string } | null>(null);
  const showInfo = (title: string, message?: string) => setInfoPopup({ title, message });

  const load = useCallback(async () => {
    const locs = await listLocations();
    setLocations(locs);
    const map: Record<string, number> = {};
    for (const l of locs) {
      map[l.id] = (await itemsInLocation(l.id, true)).length;
    }
    setCounts(map);
    // mặc định mở cấp 1
    setExpanded((prev) => (prev.size > 0 ? prev : new Set(locs.filter((l) => !l.parent_id).map((l) => l.id))));
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load, refreshTick]),
  );

  const flat = useMemo<FlatRow[]>(() => {
    const byParent = new Map<string | null, Location[]>();
    for (const l of locations) {
      const arr = byParent.get(l.parent_id) ?? [];
      arr.push(l);
      byParent.set(l.parent_id, arr);
    }
    const out: FlatRow[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const l of byParent.get(parentId) ?? []) {
        const children = byParent.get(l.id) ?? [];
        out.push({ loc: l, depth, hasChildren: children.length > 0 });
        if (expanded.has(l.id)) walk(l.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [locations, expanded]);

  // ----- Phân trang theo KHỐI VỊ TRÍ GỐC -----
  // Một khối = 1 vị trí gốc (depth 0) + toàn bộ hậu duệ đang hiển thị của nó
  // (cùng định nghĩa khối mà kéo thả dùng). Chỉ hiển thị vài khối đầu để danh
  // sách không trải dài khi có hàng trăm vị trí; "Xem thêm" mở thêm từng đợt.
  // KHÔNG reset visibleRootCount khi dữ liệu đổi (đang kéo thả ở sâu mà bị co
  // lại rất khó chịu) — chỉ clamp bằng min() ngay khi render.
  const rootBlocks = useMemo<FlatRow[][]>(() => {
    const blocks: FlatRow[][] = [];
    for (const row of flat) {
      if (row.depth === 0) blocks.push([row]);
      else if (blocks.length > 0) blocks[blocks.length - 1].push(row);
    }
    return blocks;
  }, [flat]);
  const totalRoots = rootBlocks.length;
  const shownRoots = Math.min(visibleRootCount, totalRoots);
  const renderedRows = useMemo<FlatRow[]>(
    () => rootBlocks.slice(0, shownRoots).flatMap((b) => b),
    [rootBlocks, shownRoots],
  );
  // Số vị trí nằm trong các khối chưa hiển thị: đếm TOÀN BỘ hậu duệ của các
  // gốc đó trong dữ liệu đầy đủ (kể cả con cháu đang thu gọn, chưa thành hàng).
  const hiddenCount = useMemo(() => {
    if (shownRoots >= totalRoots) return 0;
    const childrenOf = new Map<string, string[]>();
    for (const l of locations) {
      if (!l.parent_id) continue;
      const arr = childrenOf.get(l.parent_id) ?? [];
      arr.push(l.id);
      childrenOf.set(l.parent_id, arr);
    }
    let count = 0;
    const stack = rootBlocks.slice(shownRoots).map((b) => b[0].loc.id);
    while (stack.length > 0) {
      const id = stack.pop() as string;
      count++;
      for (const c of childrenOf.get(id) ?? []) stack.push(c);
    }
    return count;
  }, [locations, rootBlocks, shownRoots, totalRoots]);

  useEffect(() => {
    flatRef.current = flat;
  });

  useEffect(() => () => {
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
  }, []);

  // Mọi thứ hiển thị/kéo thả thao tác trên renderedRows (phần đang hiển thị);
  // mảng đầy đủ `flat` chỉ còn dùng để ghép thứ tự khi lưu kéo thả + tìm độ sâu.
  const displayFlat = workFlat ?? renderedRows;

  // Cuộn tới vị trí vừa tạo: chờ hàng của nó xuất hiện trong renderedRows
  // (dữ liệu đã reload + tổ tiên đã mở rộng). Nếu khối gốc chứa nó đang nằm
  // ngoài phần hiển thị (phân trang theo khối gốc) thì mở thêm khối trước.
  // Hàng cao cố định (STRIDE) nên offset tính chính xác theo chỉ số hàng.
  useEffect(() => {
    const target = pendingFocusRef.current;
    if (!target) return;
    const fi = flat.findIndex((r) => r.loc.id === target);
    if (fi < 0) return;
    let rootIdx = -1;
    for (let i = 0; i <= fi; i++) if (flat[i].depth === 0) rootIdx++;
    if (rootIdx >= shownRoots) {
      setVisibleRootCount(rootIdx + 1);
      return;
    }
    const ri = renderedRows.findIndex((r) => r.loc.id === target);
    if (ri < 0) return;
    pendingFocusRef.current = null;
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    // Timer để trong ref (không dọn ở cleanup của effect) vì load() setState
    // nhiều đợt — cleanup sẽ huỷ mất lần cuộn đã hẹn
    scrollTimer.current = setTimeout(() => {
      listRef.current?.scrollToOffset({ offset: Math.max(0, 6 + ri * STRIDE - 76), animated: true });
    }, 90);
  }, [flat, renderedRows, shownRoots]);

  /** Tập id thuộc khối đang kéo (node + hậu duệ đang hiển thị) — để nhấc cả khối */
  const dragBlockIds = useMemo(() => {
    if (!dragId) return new Set<string>();
    const i = displayFlat.findIndex((r) => r.loc.id === dragId);
    if (i < 0) return new Set<string>();
    const end = blockEnd(displayFlat, i);
    return new Set(displayFlat.slice(i, end).map((r) => r.loc.id));
  }, [dragId, displayFlat]);

  function startDrag(row: FlatRow) {
    if (dragRef.current) return;
    dragRef.current = { id: row.loc.id, parentId: row.loc.parent_id, dyBase: 0, startY: null };
    workRef.current = renderedRows;
    setWorkFlat(renderedRows);
    setDragId(row.loc.id);
    setDragDy(0);
    Vibration.vibrate(10);
  }

  /**
   * Theo dõi ngón tay: khi TÂM của khối kéo vượt qua TÂM khối anh em kề
   * (ngưỡng = nửa tổng "sải" hai khối) thì hoán đổi hai khối trong mảng phẳng.
   * dyBase ghi lại độ dịch gốc tích luỹ sau mỗi lần hoán đổi để vị trí thị giác
   * của khối kéo không bị nhảy khi mảng thay đổi.
   */
  const handleDragMove = useCallback((totalDy: number) => {
    const drag = dragRef.current;
    if (!drag || !workRef.current) return;
    let rows = workRef.current;
    let relDy = totalDy - drag.dyBase;
    let changed = false;
    for (let guard = 0; guard < 64; guard++) {
      const di = rows.findIndex((r) => r.loc.id === drag.id);
      if (di < 0) break;
      const dEnd = blockEnd(rows, di);
      const dRows = dEnd - di;
      const depth = rows[di].depth;
      let swapped = false;
      if (relDy > 0) {
        const nStart = dEnd;
        if (
          nStart < rows.length
          && rows[nStart].loc.parent_id === drag.parentId
          && rows[nStart].depth === depth
        ) {
          const nRows = blockEnd(rows, nStart) - nStart;
          if (relDy > ((dRows + nRows) * STRIDE) / 2) {
            rows = [
              ...rows.slice(0, di),
              ...rows.slice(nStart, nStart + nRows),
              ...rows.slice(di, dEnd),
              ...rows.slice(nStart + nRows),
            ];
            drag.dyBase += nRows * STRIDE;
            swapped = true;
          }
        }
      } else if (relDy < 0 && di > 0) {
        // Đầu khối anh em ngay phía trên: hàng gần nhất phía trên có cùng cha + cùng depth
        let prevStart = -1;
        for (let j = di - 1; j >= 0; j--) {
          if (rows[j].loc.parent_id === drag.parentId && rows[j].depth === depth) {
            prevStart = j;
            break;
          }
        }
        if (prevStart >= 0) {
          const pRows = di - prevStart;
          if (relDy < -((dRows + pRows) * STRIDE) / 2) {
            rows = [
              ...rows.slice(0, prevStart),
              ...rows.slice(di, dEnd),
              ...rows.slice(prevStart, di),
              ...rows.slice(dEnd),
            ];
            drag.dyBase -= pRows * STRIDE;
            swapped = true;
          }
        }
      }
      if (!swapped) break;
      changed = true;
      relDy = totalDy - drag.dyBase;
    }
    if (changed) {
      workRef.current = rows;
      setWorkFlat(rows);
    }
    setDragDy(relDy);
  }, []);

  const finalizeDrag = useCallback(async () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    lastDragEndAt.current = Date.now();
    const rows = workRef.current;
    workRef.current = null;
    setDragId(null);
    setDragDy(0);
    setWorkFlat(null);
    if (!rows) return;
    const depth = rows.find((r) => r.loc.id === drag.id)?.depth;
    if (depth == null) return;
    const isSibling = (r: FlatRow) => r.loc.parent_id === drag.parentId && r.depth === depth;
    // Thứ tự mới sau kéo chỉ gồm các anh em ĐANG HIỂN THỊ (renderedRows). Ghép
    // vào thứ tự đầy đủ theo vị trí: các anh em bị phân trang ẩn giữ nguyên
    // chỗ, các chỗ của anh em đang hiển thị được điền theo thứ tự mới.
    // (Nhóm anh em ở depth > 0 luôn hiển thị trọn vì cha đã mở rộng, nên phép
    // ghép này chỉ thực sự phát huy ở nhóm gốc.)
    const visibleOrder = rows.filter(isSibling).map((r) => r.loc.id);
    const fullOrder = flatRef.current.filter(isSibling).map((r) => r.loc.id);
    const visibleSet = new Set(visibleOrder);
    const mergedOrder: string[] = [];
    let vi = 0;
    for (const id of fullOrder) {
      const nextVisible = visibleOrder[vi];
      if (visibleSet.has(id) && nextVisible !== undefined) {
        mergedOrder.push(nextVisible);
        vi++;
      } else {
        mergedOrder.push(id);
      }
    }
    if (mergedOrder.join('|') !== fullOrder.join('|')) {
      try {
        await reorderLocations(drag.parentId, mergedOrder);
        bump();
      } catch {
        load();
      }
    }
  }, [bump, load]);

  // Bắt cử chỉ ở pha capture trên khung màn hình qua responder props của root View:
  // chỉ giành quyền responder khi đang có kéo (dragRef đã được onLongPress của hàng
  // đặt trước). Nhấn giữ nằm trên THÂN hàng, nút chevron là TouchableOpacity riêng
  // nên không xung đột. dy được tính từ pageY tại thời điểm giành responder —
  // ngón tay gần như đứng yên trong 350ms nhấn giữ nên sai lệch không đáng kể.

  // ----- Ảnh hiện trường cho vị trí mới: trần theo gói (maxScenePhotos)
  // dùng CHUNG thông báo chạm trần với bucket hiện trường của đồ vật -----
  const scenePhotoLimit = getCurrentLimits().maxScenePhotos;

  async function addLocSceneFromCamera() {
    if (pendingScenePhotos.length >= scenePhotoLimit) {
      showInfo(t('loc.limitTitle'), t('photos.sceneLimitMsg', { n: scenePhotoLimit }));
      return;
    }
    const picked = await takePhoto();
    if (!picked) return;
    const entry = { key: uuid(), picked };
    setPendingScenePhotos((prev) => [...prev, entry]);
    setPendingFocusKey(entry.key);
  }

  async function addLocSceneFromLibrary() {
    const remaining = scenePhotoLimit - pendingScenePhotos.length;
    if (remaining <= 0) {
      showInfo(t('loc.limitTitle'), t('photos.sceneLimitMsg', { n: scenePhotoLimit }));
      return;
    }
    const picked = await pickPhotos(remaining);
    if (picked.length === 0) return;
    // Một số máy bỏ qua selectionLimit: chỉ lấy đến trần và báo giới hạn
    if (picked.length > remaining) {
      showInfo(t('loc.limitTitle'), t('photos.sceneLimitMsg', { n: scenePhotoLimit }));
    }
    const accepted = picked.slice(0, remaining).map((p) => ({ key: uuid(), picked: p }));
    setPendingScenePhotos((prev) => [...prev, ...accepted]);
    if (accepted.length > 0) setPendingFocusKey(accepted[0].key);
  }

  function removePendingScenePhoto(key: string) {
    // Ảnh đang chờ chưa hề ghi xuống DB/file của app nên xoá = bỏ khỏi
    // danh sách chờ (đúng cơ chế ảnh pending của quick-add)
    setPendingScenePhotos((prev) => prev.filter((p) => p.key !== key));
  }

  /** Đóng modal tạo vị trí: ảnh chờ thuộc về đúng phiên nhập đó nên dọn luôn */
  function closeCreateModal() {
    setModalParent(undefined);
    setPendingScenePhotos([]);
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    const total = await countLocations();
    if (total >= getCurrentLimits().maxLocations) {
      showInfo(t('loc.limitTitle'), t('loc.limitLocMsg', { n: getCurrentLimits().maxLocations }));
      return;
    }
    const parent = modalParent ?? null;
    const parentDepth = parent ? flat.find((f) => f.loc.id === parent.id)?.depth ?? 0 : -1;
    const type = TYPE_BY_DEPTH[Math.min(3, parentDepth + 1)];
    let created: Location;
    try {
      created = await createLocation({
        name: newName.trim(),
        type,
        parent_id: parent?.id ?? null,
        icon: newIcon,
      });
    } catch (e) {
      // Tạo vị trí THẤT BẠI: modal giữ nguyên — tên và ảnh đang chờ không
      // mất, người dùng sửa rồi thử lại được
      showInfo(t('loc.createFail'), e instanceof Error ? e.message : String(e));
      return;
    }
    // Vị trí đã có id: đăng ký các ảnh hiện trường đang chờ NGAY BÂY GIỜ,
    // tấm đầu tiên là ảnh chính (cờ is_primary của media — đúng cơ chế
    // trang chi tiết vị trí đang đọc để hiện huy hiệu "Chính" và xếp thứ
    // tự; locations.scene_media_id chưa có hàm ghi sẵn nên không dùng).
    // Lỗi đăng ký ảnh không huỷ vị trí vừa tạo.
    let photoError: string | null = null;
    try {
      for (let i = 0; i < pendingScenePhotos.length; i++) {
        await processAndRegisterPhoto(pendingScenePhotos[i].picked, 'LOCATION', created.id, 'LOCATION_SCENE', i === 0);
      }
    } catch (e) {
      photoError = e instanceof Error ? e.message : String(e);
    }
    try {
      // Mở rộng TOÀN BỘ chuỗi tổ tiên để hàng vị trí mới hiện ra, kể cả khi
      // các tổ tiên đang thu gọn (trước đây chỉ mở đúng cha trực tiếp)
      const parentById = new Map(locations.map((l) => [l.id, l.parent_id]));
      const ancestors: string[] = [];
      let cur: string | null = parent?.id ?? null;
      while (cur) {
        ancestors.push(cur);
        cur = parentById.get(cur) ?? null;
      }
      if (ancestors.length > 0) {
        setExpanded((s) => {
          const next = new Set(s);
          for (const a of ancestors) next.add(a);
          return next;
        });
      }
      // Đánh dấu vị trí mới: hàng được highlight + pill "Mới", tự tắt sau
      // 4 giây; effect theo dõi renderedRows sẽ cuộn tới khi hàng xuất hiện.
      // newLocId là state của màn nên các lần reload dữ liệu không làm mất
      // highlight trước khi hết giờ.
      pendingFocusRef.current = created.id;
      setNewLocId(created.id);
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => {
        setNewLocId(null);
        pendingFocusRef.current = null;
      }, 4000);
      setNewName('');
      setNewIcon(null);
      setPendingScenePhotos([]);
      setModalParent(undefined);
      bump();
    } catch (e) {
      showInfo(t('loc.createFail'), e instanceof Error ? e.message : String(e));
    }
    // Vị trí đã tạo xong xuôi mới báo lỗi ảnh (nếu có) để không che mất
    // luồng thành công phía trên
    if (photoError) showInfo(t('loc.createFail'), photoError);
  }

  return (
    <View
      style={[styles.screen, { paddingTop: 54 }]}
      onMoveShouldSetResponderCapture={() => dragRef.current != null}
      onResponderGrant={(e) => {
        if (dragRef.current) dragRef.current.startY = e.nativeEvent.pageY;
      }}
      onResponderMove={(e) => {
        const drag = dragRef.current;
        if (!drag || drag.startY == null) return;
        handleDragMove(e.nativeEvent.pageY - drag.startY);
      }}
      onResponderRelease={() => {
        void finalizeDrag();
      }}
      onResponderTerminate={() => {
        void finalizeDrag();
      }}
      onResponderTerminationRequest={() => dragRef.current == null}
    >
      <View style={{ paddingHorizontal: 18, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 6, height: 52, borderRadius: 3, backgroundColor: Colors.teal }} />
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{t('loc.title')}</Text>
          <Text style={styles.subtitle}>{t('loc.subtitle', { n: locations.length })}</Text>
        </View>
        <TouchableOpacity
          style={[styles.button, { paddingVertical: 10, paddingHorizontal: 14 }]}
          onPress={() => {
            setNewIcon(null);
            setPendingScenePhotos([]);
            setModalParent(null);
          }}
        >
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={[styles.buttonText, { fontSize: 13.5 }]}>{t('loc.new')}</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        ref={listRef}
        data={displayFlat}
        extraData={`${dragId ?? ''}|${dragDy}`}
        keyExtractor={({ loc }) => loc.id}
        scrollEnabled={dragId === null}
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 6, paddingBottom: TAB_BAR_CLEARANCE }}
        ItemSeparatorComponent={() => <View style={{ height: ROW_SEP }} />}
        renderItem={({ item: { loc, depth, hasChildren } }) => {
          const inDragBlock = dragBlockIds.has(loc.id);
          const isNew = loc.id === newLocId;
          const hasCoords = loc.latitude != null && loc.longitude != null;
          return (
            <View
              style={[
                styles.card,
                {
                  // Thụt lề bằng paddingLeft (không marginLeft) để thẻ trải hết
                  // bề ngang: các vạch dẫn cây vẽ trong vùng thụt lề mới liền
                  // mạch được. Chiều cao hàng không đổi → toán kéo thả (STRIDE)
                  // không bị ảnh hưởng. Thụt 12px/cấp + icon 44 + bỏ bong bóng
                  // đếm bên phải (số món chuyển xuống dòng phụ) để TÊN là thành
                  // phần chính: màn 360dp, cấp sâu nhất (3) còn ~194px cho tên,
                  // cấp 2 có con là chật nhất cũng còn ~154px (trước đây ~38px).
                  height: ROW_H, flexDirection: 'row', alignItems: 'center', gap: 8,
                  paddingVertical: 15, paddingRight: 12, paddingLeft: 12 + depth * 12,
                },
                loc.id === newLocId && { backgroundColor: tint(Colors.primary, '16'), borderColor: Colors.primary },
                inDragBlock && {
                  transform: [{ translateY: dragDy }],
                  zIndex: 20,
                  elevation: 10,
                  shadowColor: Colors.primaryDark,
                  shadowOpacity: 0.3,
                  shadowRadius: 16,
                  shadowOffset: { width: 0, height: 8 },
                  borderColor: Colors.primary,
                },
              ]}
            >
              {/* Vạch dẫn dọc theo từng cấp tổ tiên: x = tâm chevron của tổ
                  tiên cấp a (paddingLeft 12 + a*12, ô chevron rộng 20 → tâm
                  +10 → 22 + a*12). Mỗi hàng tự vẽ đoạn của mình nên khi cuộn
                  dài vẫn đọc được cấu trúc lồng nhau. PHÂN BIỆT MÀU có chủ
                  đích: vạch dẫn giữ Colors.border (xám-tím rất nhạt, trung
                  tính) còn chevron mở/đóng dùng Colors.coral tương phản rõ
                  — trước đây chevron Colors.primary cùng tông tím với vạch
                  dẫn nên nhìn như một khối, khó biết đâu là nút bấm. */}
              {depth > 0 && Array.from({ length: depth }, (_, a) => (
                <View
                  key={`guide-${a}`}
                  pointerEvents="none"
                  style={{ position: 'absolute', left: 22 + a * 12, top: 0, bottom: 0, width: 1.5, backgroundColor: Colors.border }}
                />
              ))}
              {/* Chevron CHỈ chiếm chỗ khi nút có con; nút lá chỉ đệm 8px
                  để nhường bề ngang cho tên */}
              {hasChildren ? (
                <TouchableOpacity
                  onPress={() => {
                    setExpanded((s) => {
                      const next = new Set(s);
                      if (next.has(loc.id)) next.delete(loc.id);
                      else next.add(loc.id);
                      return next;
                    });
                  }}
                  disabled={dragId !== null}
                  hitSlop={6}
                  style={{ width: 20, alignItems: 'center' }}
                >
                  <Ionicons name={expanded.has(loc.id) ? 'chevron-down' : 'chevron-forward'} size={20} color={Colors.coral} />
                </TouchableOpacity>
              ) : (
                <View style={{ width: 8 }} />
              )}
              <TouchableOpacity
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }}
                disabled={dragId !== null}
                onLongPress={() => startDrag({ loc, depth, hasChildren })}
                delayLongPress={350}
                onPress={() => {
                  // Vừa kết thúc kéo thì bỏ qua lần chạm nhả tay để không nhảy vào chi tiết
                  if (Date.now() - lastDragEndAt.current < 350) return;
                  router.push(`/location/${loc.id}`);
                }}
              >
                <IconTile icon={locationIconName(loc)} color={LOCATION_TYPE_COLORS[loc.type]} size={44} iconSize={22} />
                <View style={{ flex: 1 }}>
                  {/* Hàng tên CHỈ còn tên: bỏ ký hiệu '↪', ghim toạ độ và
                      huy hiệu 'Mới' đều chuyển xuống dòng phụ */}
                  <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '700', color: Colors.text }}>{loc.name}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                    {hasCoords && <Ionicons name="location" size={12} color={Colors.coral} />}
                    <Text numberOfLines={1} style={{ flex: 1, fontSize: 12.5, color: Colors.subtext }}>
                      {locationTypeLabel(loc.type)} · {t('loc.countItems', { n: counts[loc.id] ?? 0 })}
                      {isNew && (
                        <Text style={{ color: Colors.primary, fontWeight: '800' }}> · {t('loc.newBadge')}</Text>
                      )}
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
              {depth < 3 && (
                <TouchableOpacity
                  hitSlop={8}
                  disabled={dragId !== null}
                  onPress={() => {
                    setNewIcon(null);
                    setPendingScenePhotos([]);
                    setModalParent(loc);
                  }}
                  style={{ backgroundColor: Colors.chipBg, borderRadius: 999, width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Ionicons name="add" size={18} color={Colors.primary} />
                </TouchableOpacity>
              )}
            </View>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>{t('loc.empty')}</Text>}
        ListFooterComponent={
          shownRoots < totalRoots ? (
            <AppButton
              title={t('locations.showMore', { n: hiddenCount })}
              variant="secondary"
              icon="chevron-down"
              onPress={() => setVisibleRootCount((c) => c + 10)}
              style={{ marginTop: ROW_SEP }}
            />
          ) : undefined
        }
      />

      <Modal visible={modalParent !== undefined} transparent animationType="fade" onRequestClose={closeCreateModal}>
        <View style={styles.modalOverlay}>
          {/* Nội dung cuộn dọc + trần chiều cao: block ảnh hiện trường làm
              modal cao hơn hẳn, máy nhỏ vẫn xem/bấm được mọi phần */}
          <View style={[styles.card, styles.modalCard, { maxHeight: '92%' }]}>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 14 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: Colors.text }}>
                {modalParent ? t('loc.modalIn', { name: modalParent.name }) : t('loc.modalNew')}
              </Text>
              <TextInput ref={newNameInputRef} style={styles.input} placeholder={t('loc.namePlaceholder')} value={newName} onChangeText={setNewName} autoFocus />
              <View>
                <Text style={styles.label}>{t('locations.iconLabel')}</Text>
                <IconPickerGrid value={newIcon} onChange={setNewIcon} showDefaultOption />
              </View>
              {/* Ảnh hiện trường của vị trí mới: gallery mode 'edit' với
                  ảnh ĐANG CHỜ (chưa có id vị trí) — tấm đầu tiên hiển thị
                  huy hiệu "Chính" vì khi tạo xong nó được đăng ký với
                  is_primary = 1; trần maxScenePhotos theo gói như bucket
                  hiện trường của đồ vật */}
              <PhotoGallery
                title={t('photos.scene')}
                titleColor={Colors.teal}
                photos={pendingScenePhotos.map((p, i) => ({ key: p.key, uri: p.picked.uri, isPrimary: i === 0 }))}
                focusKey={pendingFocusKey}
                takeLabel={t('qa.takePhoto')}
                pickLabel={t('photos.addScene')}
                onTake={() => { addLocSceneFromCamera().catch(() => {}); }}
                onPick={() => { addLocSceneFromLibrary().catch(() => {}); }}
                onRemove={(e) => removePendingScenePhoto(e.key)}
                maxReached={pendingScenePhotos.length >= scenePhotoLimit}
                limitText={t('photos.sceneLimitMsg', { n: scenePhotoLimit })}
              />
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <TouchableOpacity style={[styles.buttonSecondary, { flex: 1 }]} onPress={closeCreateModal}>
                  <Text style={styles.buttonSecondaryText}>{t('common.cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.button, { flex: 1 }]} onPress={handleCreate}>
                  <Text style={styles.buttonText}>{t('common.create')}</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <AppPopup
        visible={!!infoPopup}
        title={infoPopup?.title ?? ''}
        message={infoPopup?.message}
        okLabel={t('common.gotIt')}
        onClose={() => setInfoPopup(null)}
      />
    </View>
  );
}
