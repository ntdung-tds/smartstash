import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { styles, Colors, IconTile, SectionTitle, AppButton, AppPopup, type IconName } from '@/components/ui';
import { LOCATION_TYPE_COLORS, locationIconName, categoryColor, categoryIcon } from '@/theme';
import { useT } from '@/i18n';
import type { Location } from '@/types';
import { listLocations, listItems } from '@/db/queries';
import { getCurrentPlan, getLimits } from '@/services/planService';
import { printLabels, shareLabelsPdf, type LabelData, type LabelSize } from '@/services/qrPrintService';

interface LocRow {
  key: string;
  name: string;
  subtitle: string;
  icon: IconName;
  color: string;
  label: LabelData;
}

interface ItemRow {
  key: string;
  name: string;
  subtitle: string;
  code: string;
  icon: IconName;
  color: string;
  label: LabelData;
}

const SIZES: LabelSize[] = ['S', 'M', 'L'];

/** Đường dẫn các vị trí CHA (không gồm chính vị trí) — phụ đề cho nhãn/hàng vị trí */
function parentChainText(loc: Location, byId: Map<string, Location>): string {
  const names: string[] = [];
  const guard = new Set<string>([loc.id]);
  let cur = loc.parent_id ? byId.get(loc.parent_id) : undefined;
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    names.unshift(cur.name);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return names.join(' > ');
}

/** Đường dẫn đầy đủ gồm chính vị trí — phụ đề "nơi chứa món" cho nhãn món */
function fullChainText(locId: string | null, byId: Map<string, Location>): string {
  if (!locId) return '';
  const start = byId.get(locId);
  if (!start) return '';
  const parent = parentChainText(start, byId);
  return parent ? `${parent} > ${start.name}` : start.name;
}

/** Ô tick tròn tự vẽ theo style app */
function RoundCheck({ checked }: { checked: boolean }) {
  return (
    <View
      style={{
        width: 26, height: 26, borderRadius: 13, borderWidth: 2,
        borderColor: checked ? Colors.primary : Colors.border,
        backgroundColor: checked ? Colors.primary : '#fff',
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      {checked && <Ionicons name="checkmark" size={16} color="#fff" />}
    </View>
  );
}

export default function LabelsScreen() {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ loc?: string; item?: string }>();
  const [size, setSize] = useState<LabelSize>('S');
  const [locRows, setLocRows] = useState<LocRow[]>([]);
  const [itemRows, setItemRows] = useState<ItemRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [noBarcodeCount, setNoBarcodeCount] = useState(0);
  const [noQrCount, setNoQrCount] = useState(0);
  const [busy, setBusy] = useState<'print' | 'pdf' | null>(null);
  // Popup lỗi dùng chung (1 nút "Đã hiểu") thay hộp thoại hệ thống
  const [infoPopup, setInfoPopup] = useState<{ title: string; message?: string } | null>(null);

  useEffect(() => {
    (async () => {
      const [locations, items] = await Promise.all([listLocations(), listItems()]);
      const byId = new Map(locations.map((l) => [l.id, l]));

      const locs: LocRow[] = [];
      let skippedLoc = 0;
      for (const loc of locations) {
        if (!loc.qr_code) {
          skippedLoc++;
          continue;
        }
        const subtitle = parentChainText(loc, byId);
        locs.push({
          key: `loc:${loc.id}`,
          name: loc.name,
          subtitle,
          icon: locationIconName(loc),
          color: LOCATION_TYPE_COLORS[loc.type],
          label: { code: loc.qr_code, title: loc.name, subtitle: subtitle || undefined },
        });
      }

      const its: ItemRow[] = [];
      let noBarcode = 0;
      for (const item of items) {
        const code = item.barcode?.trim();
        if (!code) {
          noBarcode++;
          continue;
        }
        const subtitle = fullChainText(item.location_id, byId);
        its.push({
          key: `item:${item.id}`,
          name: item.name,
          subtitle,
          code,
          icon: categoryIcon(item.category),
          color: categoryColor(item.category),
          label: { code, title: item.name, subtitle: subtitle || undefined },
        });
      }

      setLocRows(locs);
      setItemRows(its);
      setNoQrCount(skippedLoc);
      setNoBarcodeCount(noBarcode);

      // Chọn mặc định: tham số điều hướng thắng (chỉ món/vị trí được trỏ tới),
      // còn lại chọn toàn bộ vị trí và không chọn món nào.
      const initial = new Set<string>();
      if (params.loc) {
        const key = `loc:${params.loc}`;
        if (locs.some((r) => r.key === key)) initial.add(key);
      } else if (params.item) {
        const key = `item:${params.item}`;
        if (its.some((r) => r.key === key)) initial.add(key);
      } else {
        for (const r of locs) initial.add(r.key);
      }
      setSelected(initial);
    })();
    // Chỉ nạp một lần khi mở màn — params là ý định điều hướng ban đầu
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedLabels = useMemo<LabelData[]>(() => {
    const out: LabelData[] = [];
    for (const r of locRows) if (selected.has(r.key)) out.push(r.label);
    for (const r of itemRows) if (selected.has(r.key)) out.push(r.label);
    return out;
  }, [locRows, itemRows, selected]);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleGroup(rows: { key: string }[], allSelected: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of rows) {
        if (allSelected) next.delete(r.key);
        else next.add(r.key);
      }
      return next;
    });
  }

  const allLocsSelected = locRows.length > 0 && locRows.every((r) => selected.has(r.key));
  const allItemsSelected = itemRows.length > 0 && itemRows.every((r) => selected.has(r.key));
  const count = selectedLabels.length;
  const actionsDisabled = count === 0 || busy !== null;

  /** Cổng gói Pro (Phase 6): FREE không in được nhãn QR — hiện popup nâng cấp */
  async function ensureQrAllowed(): Promise<boolean> {
    const plan = await getCurrentPlan();
    if (getLimits(plan).allowQrPrintPdf) return true;
    setInfoPopup({ title: t('plan.upgradeTitle'), message: t('plan.upgradeQrMsg') });
    return false;
  }

  async function handlePrint() {
    if (!(await ensureQrAllowed())) return;
    setBusy('print');
    try {
      await printLabels(selectedLabels, size);
    } catch {
      setInfoPopup({ title: t('labels.title'), message: t('labels.error') });
    } finally {
      setBusy(null);
    }
  }

  async function handleMakePdf() {
    if (!(await ensureQrAllowed())) return;
    setBusy('pdf');
    try {
      await shareLabelsPdf(selectedLabels, size, t('labels.shareDialog'));
    } catch {
      setInfoPopup({ title: t('labels.title'), message: t('labels.error') });
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={styles.screen}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content}>
        <View>
          <Text style={styles.label}>{t('labels.sizeLabel')}</Text>
          <View style={{ flexDirection: 'row', backgroundColor: Colors.chipBg, borderRadius: 12, padding: 4, gap: 4 }}>
            {SIZES.map((sz) => {
              const active = size === sz;
              return (
                <TouchableOpacity
                  key={sz}
                  onPress={() => setSize(sz)}
                  activeOpacity={0.8}
                  style={{
                    flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 9, borderRadius: 9,
                    backgroundColor: active ? Colors.primary : 'transparent',
                  }}
                >
                  <Text
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.8}
                    style={{ fontSize: 12.5, fontWeight: '700', color: active ? '#fff' : Colors.subtext }}
                  >
                    {t(`labels.size${sz}`)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={{ gap: 10 }}>
          <SectionTitle
            title={t('labels.locationsGroup')}
            color={Colors.teal}
            right={
              locRows.length > 0 ? (
                <TouchableOpacity onPress={() => toggleGroup(locRows, allLocsSelected)} hitSlop={6}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: Colors.primary }}>
                    {allLocsSelected ? t('labels.deselectAll') : t('labels.selectAll')}
                  </Text>
                </TouchableOpacity>
              ) : undefined
            }
          />
          {locRows.length === 0 ? (
            <Text style={{ color: Colors.subtext, fontSize: 13 }}>{t('labels.emptyLocations')}</Text>
          ) : (
            locRows.map((row) => {
              const checked = selected.has(row.key);
              return (
                <TouchableOpacity
                  key={row.key}
                  style={[styles.card, { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 }]}
                  onPress={() => toggle(row.key)}
                  activeOpacity={0.7}
                >
                  <RoundCheck checked={checked} />
                  <IconTile icon={row.icon} color={row.color} size={42} iconSize={21} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: Colors.text }}>{row.name}</Text>
                    {!!row.subtitle && (
                      <Text style={{ fontSize: 12.5, color: Colors.subtext, marginTop: 1 }}>{row.subtitle}</Text>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })
          )}
          {noQrCount > 0 && (
            <Text style={{ color: Colors.subtext, fontSize: 12.5, lineHeight: 18 }}>
              {t('labels.noQrNote', { n: noQrCount })}
            </Text>
          )}
        </View>

        <View style={{ gap: 10 }}>
          <SectionTitle
            title={t('labels.itemsGroup')}
            color={Colors.orange}
            right={
              itemRows.length > 0 ? (
                <TouchableOpacity onPress={() => toggleGroup(itemRows, allItemsSelected)} hitSlop={6}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: Colors.primary }}>
                    {allItemsSelected ? t('labels.deselectAll') : t('labels.selectAll')}
                  </Text>
                </TouchableOpacity>
              ) : undefined
            }
          />
          {itemRows.length === 0 ? (
            <Text style={{ color: Colors.subtext, fontSize: 13 }}>{t('labels.emptyItems')}</Text>
          ) : (
            itemRows.map((row) => {
              const checked = selected.has(row.key);
              return (
                <TouchableOpacity
                  key={row.key}
                  style={[styles.card, { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 }]}
                  onPress={() => toggle(row.key)}
                  activeOpacity={0.7}
                >
                  <RoundCheck checked={checked} />
                  <IconTile icon={row.icon} color={row.color} size={42} iconSize={21} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: Colors.text }}>{row.name}</Text>
                    <Text style={{ fontSize: 12.5, color: Colors.subtext, marginTop: 1 }}>
                      {row.subtitle ? `${row.subtitle} · ` : ''}{row.code}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })
          )}
          {noBarcodeCount > 0 && (
            <Text style={{ color: Colors.subtext, fontSize: 12.5, lineHeight: 18 }}>
              {t('labels.noBarcodeNote', { n: noBarcodeCount })}
            </Text>
          )}
        </View>
      </ScrollView>

      <View
        style={{
          borderTopWidth: 1, borderTopColor: Colors.border,
          backgroundColor: 'rgba(255,255,255,0.97)',
          paddingHorizontal: 18, paddingTop: 12,
          paddingBottom: Math.max(insets.bottom, 12),
          gap: 10,
        }}
      >
        <Text style={{ fontSize: 13.5, fontWeight: '700', color: Colors.text }}>
          {t('labels.selected', { n: count })}
        </Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <AppButton
            title={t('labels.printNow')}
            icon="print-outline"
            variant="secondary"
            style={{ flex: 1 }}
            disabled={actionsDisabled}
            loading={busy === 'print'}
            onPress={handlePrint}
          />
          <AppButton
            title={t('labels.makePdf')}
            icon="share-outline"
            style={{ flex: 1 }}
            disabled={actionsDisabled}
            loading={busy === 'pdf'}
            onPress={handleMakePdf}
          />
        </View>
      </View>

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
