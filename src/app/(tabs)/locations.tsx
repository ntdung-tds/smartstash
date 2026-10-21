import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Modal, TextInput, Alert,
  Vibration,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { styles, Colors, AppButton, IconTile, IconPickerGrid, TAB_BAR_CLEARANCE, type IconName } from '@/components/ui';
import { LOCATION_TYPE_COLORS, locationIconName, locationTypeLabel } from '@/theme';
import { useT } from '@/i18n';
import type { Location, LocationType } from '@/types';
import { listLocations, createLocation, itemsInLocation, countLocations, reorderLocations } from '@/db/queries';
import { useAppStore } from '@/store/useAppStore';
import { CURRENT_LIMITS } from '@/config';

const TYPE_BY_DEPTH: LocationType[] = ['PROPERTY', 'ROOM', 'FURNITURE', 'CONTAINER'];

// Chiều cao hàng cố định (IconTile 48 + padding dọc 13×2) + khoảng cách giữa các hàng.
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

  // Mọi thứ hiển thị/kéo thả thao tác trên renderedRows (phần đang hiển thị);
  // mảng đầy đủ `flat` chỉ còn dùng để ghép thứ tự khi lưu kéo thả + tìm độ sâu.
  const displayFlat = workFlat ?? renderedRows;

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

  async function handleCreate() {
    if (!newName.trim()) return;
    const total = await countLocations();
    if (total >= CURRENT_LIMITS.maxLocations) {
      Alert.alert(t('loc.limitTitle'), t('loc.limitLocMsg', { n: CURRENT_LIMITS.maxLocations }));
      return;
    }
    const parent = modalParent ?? null;
    const parentDepth = parent ? flat.find((f) => f.loc.id === parent.id)?.depth ?? 0 : -1;
    const type = TYPE_BY_DEPTH[Math.min(3, parentDepth + 1)];
    try {
      const created = await createLocation({
        name: newName.trim(),
        type,
        parent_id: parent?.id ?? null,
        icon: newIcon,
      });
      if (parent) setExpanded((s) => new Set(s).add(parent.id));
      setNewName('');
      setNewIcon(null);
      setModalParent(undefined);
      bump();
      void created;
    } catch (e) {
      Alert.alert(t('loc.createFail'), e instanceof Error ? e.message : String(e));
    }
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
            setModalParent(null);
          }}
        >
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={[styles.buttonText, { fontSize: 14 }]}>{t('loc.new')}</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={displayFlat}
        extraData={`${dragId ?? ''}|${dragDy}`}
        keyExtractor={({ loc }) => loc.id}
        scrollEnabled={dragId === null}
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 6, paddingBottom: TAB_BAR_CLEARANCE }}
        ItemSeparatorComponent={() => <View style={{ height: ROW_SEP }} />}
        renderItem={({ item: { loc, depth, hasChildren } }) => {
          const inDragBlock = dragBlockIds.has(loc.id);
          return (
            <View
              style={[
                styles.card,
                {
                  marginLeft: depth * 14, height: ROW_H, flexDirection: 'row', alignItems: 'center', gap: 8, padding: 13,
                },
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
              <TouchableOpacity
                onPress={() => {
                  if (!hasChildren) return;
                  setExpanded((s) => {
                    const next = new Set(s);
                    if (next.has(loc.id)) next.delete(loc.id);
                    else next.add(loc.id);
                    return next;
                  });
                }}
                disabled={dragId !== null}
                hitSlop={6}
                style={{ width: 22, alignItems: 'center' }}
              >
                {hasChildren && (
                  <Ionicons name={expanded.has(loc.id) ? 'chevron-down' : 'chevron-forward'} size={18} color={Colors.subtext} />
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 }}
                disabled={dragId !== null}
                onLongPress={() => startDrag({ loc, depth, hasChildren })}
                delayLongPress={350}
                onPress={() => {
                  // Vừa kết thúc kéo thì bỏ qua lần chạm nhả tay để không nhảy vào chi tiết
                  if (Date.now() - lastDragEndAt.current < 350) return;
                  router.push(`/location/${loc.id}`);
                }}
              >
                <IconTile icon={locationIconName(loc)} color={LOCATION_TYPE_COLORS[loc.type]} size={48} iconSize={24} />
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '700', color: Colors.text }}>{loc.name}</Text>
                  <Text numberOfLines={1} style={{ fontSize: 12, color: Colors.subtext, marginTop: 2 }}>
                    {locationTypeLabel(loc.type)}
                  </Text>
                </View>
              </TouchableOpacity>
              <View style={{ backgroundColor: Colors.chipBg, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 }}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: Colors.primaryDark }}>{t('loc.countItems', { n: counts[loc.id] ?? 0 })}</Text>
              </View>
              {depth < 3 && (
                <TouchableOpacity
                  hitSlop={8}
                  disabled={dragId !== null}
                  onPress={() => {
                    setNewIcon(null);
                    setModalParent(loc);
                  }}
                  style={{ backgroundColor: Colors.chipBg, borderRadius: 999, width: 34, height: 34, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Ionicons name="add" size={19} color={Colors.primary} />
                </TouchableOpacity>
              )}
              <Ionicons name="menu" size={18} color={Colors.faint} />
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

      <Modal visible={modalParent !== undefined} transparent animationType="fade" onRequestClose={() => setModalParent(undefined)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.card, styles.modalCard, { gap: 14 }]}>
            <Text style={{ fontSize: 18, fontWeight: '800', color: Colors.text }}>
              {modalParent ? t('loc.modalIn', { name: modalParent.name }) : t('loc.modalNew')}
            </Text>
            <TextInput style={styles.input} placeholder={t('loc.namePlaceholder')} value={newName} onChangeText={setNewName} autoFocus />
            <View>
              <Text style={styles.label}>{t('locations.iconLabel')}</Text>
              <IconPickerGrid value={newIcon} onChange={setNewIcon} showDefaultOption />
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity style={[styles.buttonSecondary, { flex: 1 }]} onPress={() => setModalParent(undefined)}>
                <Text style={styles.buttonSecondaryText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.button, { flex: 1 }]} onPress={handleCreate}>
                <Text style={styles.buttonText}>{t('common.create')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
