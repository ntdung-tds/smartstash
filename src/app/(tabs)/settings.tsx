import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert, Switch } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { styles, Colors, IconTile, ScreenHeader, SectionTitle, AppButton, TAB_BAR_CLEARANCE } from '@/components/ui';
import type { Item } from '@/types';
import {
  countActiveItems, countLocations, listItems, listDeletedItems, restoreItem, getBreadcrumb, breadcrumbText,
} from '@/db/queries';
import { ftsAvailable, kvGet } from '@/db/client';
import { useAppStore } from '@/store/useAppStore';
import { CURRENT_LIMITS } from '@/config';
import { useT } from '@/i18n';
import { rescheduleAllReminders } from '@/services/notificationService';
import { getAlertSettings, setAlertSetting, type AlertSettings } from '@/services/alertSettings';
import { seedDemoData, clearDemoData } from '@/services/demoData';
import { categoryLabel, statusLabel } from '@/theme';
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
  const [alertCfgState, setAlertCfgState] = useState<AlertSettings | null>(null);
  const refreshTick = useAppStore((s) => s.refreshTick);
  const bump = useAppStore((s) => s.bump);

  const load = useCallback(async () => {
    setActiveCount(await countActiveItems());
    setLocCount(await countLocations());
    setTrash(await listDeletedItems());
    setDemoExists(!!(await kvGet('demo_seed_ids')));
    setAlertCfgState(await getAlertSettings());
  }, []);

  /** Đổi một tuỳ chọn cảnh báo: lưu alert_cfg + đặt lại lịch nhắc + báo các màn khác tải lại */
  async function changeAlert<K extends keyof AlertSettings>(key: K, value: AlertSettings[K]) {
    const next = await setAlertSetting(key, value);
    setAlertCfgState(next);
    rescheduleAllReminders().catch(() => {});
    bump();
  }

  async function handleSeedDemo() {
    setDemoBusy(true);
    try {
      const res = await seedDemoData();
      if (res.skipped) {
        Alert.alert(t('settings.demoTitle'), t('settings.demoExists'));
      } else {
        Alert.alert(t('settings.demoTitle'), t('settings.demoCreated', { items: res.items, locations: res.locations }));
      }
      setDemoExists(!!(await kvGet('demo_seed_ids')));
      bump();
    } catch (e) {
      Alert.alert(t('settings.demoTitle'), e instanceof Error ? e.message : String(e));
    } finally {
      setDemoBusy(false);
    }
  }

  function handleClearDemo() {
    Alert.alert(t('settings.demoTitle'), t('settings.demoDeleteConfirm'), [
      { text: t('common.cancel') },
      {
        text: t('settings.demoDelete'), style: 'destructive',
        onPress: async () => {
          setDemoBusy(true);
          try {
            await clearDemoData();
            setDemoExists(false);
            bump();
            Alert.alert(t('settings.demoTitle'), t('settings.demoDeleted'));
          } catch (e) {
            Alert.alert(t('settings.demoTitle'), e instanceof Error ? e.message : String(e));
          } finally {
            setDemoBusy(false);
          }
        },
      },
    ]);
  }

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load, refreshTick]),
  );

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
        Alert.alert(t('set.fileCreated'), path);
      }
    } catch (e) {
      Alert.alert(t('set.exportFail'), e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <ScrollView style={[styles.screen, { paddingTop: 54 }]} contentContainerStyle={[styles.content, { paddingBottom: TAB_BAR_CLEARANCE }]}>
      <ScreenHeader title={t('set.title')} subtitle={t('set.subtitle')} icon="settings" color={Colors.primary} />

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
          <Text style={{ fontSize: 17, fontWeight: '800', color: '#fff' }}>{t('set.planName')}</Text>
        </View>
        <Text style={{ color: Colors.onDarkMuted, fontSize: 13, lineHeight: 19 }}>
          {t('set.planUsage', { a: activeCount, max1: CURRENT_LIMITS.maxActiveItems, l: locCount, max2: CURRENT_LIMITS.maxLocations, p: CURRENT_LIMITS.maxPhotosPerItem })}
        </Text>
        <Text style={{ color: Colors.onDarkMuted, fontSize: 13, lineHeight: 19 }}>
          {t('set.planPro')}
        </Text>
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
          onPress={async () => { await rescheduleAllReminders(); Alert.alert(t('set.notifDoneTitle'), t('set.notifDoneMsg')); }}
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
              onPress={handleClearDemo}
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
                <Text style={[styles.buttonSecondaryText, { fontSize: 13 }]}>{t('set.restore')}</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
      </View>

      <Text style={{ color: Colors.subtext, fontSize: 12, textAlign: 'center', marginTop: 12 }}>
        {t('set.footer')}
      </Text>
    </ScrollView>
  );
}
