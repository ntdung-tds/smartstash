import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, Modal, TextInput, Alert,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { styles, Colors, ScreenHeader, SectionTitle, AppButton, TAB_BAR_CLEARANCE } from '@/components/ui';
import type { Loan } from '@/types';
import { listActiveLoans, listReturnedLoans, returnLoan, setLoanAlertSnooze } from '@/db/queries';
import { useAppStore } from '@/store/useAppStore';
import { formatDate, getAlertTier, isAlertSnoozed, addDaysISO, localTodayISO, ALERT_TIER_RANK } from '@/utils';
import { alertTierColor, alertTierIcon, tint } from '@/theme';
import { getAlertSettings, ALERT_SETTINGS_DEFAULTS, type AlertSettings } from '@/services/alertSettings';
import { useT } from '@/i18n';
import { rescheduleAllReminders } from '@/services/notificationService';

type LoanRow = Loan & { item_name: string };

const AVATAR_COLORS = [Colors.primary, Colors.coral, Colors.orange, Colors.teal, Colors.sky];

/** Màu avatar ổn định theo tên người mượn (hash đơn giản) */
function borrowerColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export default function LendingScreen() {
  const { t } = useT();
  const [active, setActive] = useState<LoanRow[]>([]);
  const [returned, setReturned] = useState<LoanRow[]>([]);
  const [returnTarget, setReturnTarget] = useState<LoanRow | null>(null);
  const [returnQty, setReturnQty] = useState('1');
  const [alertCfg, setAlertCfg] = useState<AlertSettings>(ALERT_SETTINGS_DEFAULTS);
  const refreshTick = useAppStore((s) => s.refreshTick);
  const bump = useAppStore((s) => s.bump);

  const load = useCallback(async () => {
    const cfg = await getAlertSettings();
    setAlertCfg(cfg);
    const act = await listActiveLoans();
    // Sắp xếp theo mức cảnh báo hạn trả: OVERDUE → DUE → SOON → WATCH → chưa đặt hạn,
    // cùng mức thì hạn gần hơn lên trước (khoản đang hoãn nhắc xếp như không có mức)
    const rankOf = (l: LoanRow): number => {
      if (!l.expected_return_date || isAlertSnoozed(l.alert_snoozed_until)) return 5;
      const info = getAlertTier(l.expected_return_date, cfg.soonDays, cfg.watchDays);
      return info ? ALERT_TIER_RANK[info.tier] : 4;
    };
    act.sort((a, b) => {
      const r = rankOf(a) - rankOf(b);
      if (r !== 0) return r;
      const da = a.expected_return_date ?? '9999-12-31';
      const db = b.expected_return_date ?? '9999-12-31';
      return da < db ? -1 : da > db ? 1 : 0;
    });
    setActive(act);
    setReturned(await listReturnedLoans());
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load, refreshTick]),
  );

  async function handleReturn() {
    if (!returnTarget) return;
    const qty = parseInt(returnQty, 10);
    if (!qty || qty < 1) {
      Alert.alert(t('lend.qtyInvalidTitle'), t('lend.qtyInvalidMsg'));
      return;
    }
    await returnLoan(returnTarget.id, qty);
    setReturnTarget(null);
    bump();
    rescheduleAllReminders().catch(() => {});
  }

  function openReturn(loan: LoanRow) {
    setReturnQty(String(loan.quantity_lent - loan.quantity_returned));
    setReturnTarget(loan);
  }

  /** Hoãn nhắc hạn trả của khoản vay đang mở trong modal (1/3/7 ngày) */
  function handleSnoozeLoan() {
    if (!returnTarget) return;
    const target = returnTarget;
    setReturnTarget(null);
    const pick = (n: number) => async () => {
      await setLoanAlertSnooze(target.id, addDaysISO(localTodayISO(), n));
      bump();
      rescheduleAllReminders().catch(() => {});
      load();
    };
    Alert.alert(t('alerts.snoozeTitle'), '', [
      { text: t('alerts.snooze1'), onPress: () => { pick(1)().catch(() => {}); } },
      { text: t('alerts.snooze3'), onPress: () => { pick(3)().catch(() => {}); } },
      { text: t('alerts.snooze7'), onPress: () => { pick(7)().catch(() => {}); } },
      { text: t('common.cancel') },
    ]);
  }

  return (
    <View style={[styles.screen, { paddingTop: 54 }]}>
      <View style={{ paddingHorizontal: 18, marginBottom: 10 }}>
        <ScreenHeader title={t('lend.title')} subtitle={t('lend.subtitle', { n: active.length })} icon="swap-horizontal" color={Colors.orange} />
      </View>

      <FlatList
        data={active}
        keyExtractor={(l) => l.id}
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 6, paddingBottom: TAB_BAR_CLEARANCE }}
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        renderItem={({ item: loan }) => {
          const info = loan.expected_return_date && !isAlertSnoozed(loan.alert_snoozed_until)
            ? getAlertTier(loan.expected_return_date, alertCfg.soonDays, alertCfg.watchDays)
            : null;
          const tierColor = info ? alertTierColor(info.tier, info.days) : null;
          const overdue = info?.tier === 'OVERDUE';
          const remaining = loan.quantity_lent - loan.quantity_returned;
          return (
            <View style={[styles.card, { gap: 7, borderColor: overdue ? '#F6C6CE' : Colors.border, backgroundColor: overdue ? '#FFF5F6' : Colors.card }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                <View
                  style={{
                    width: 44, height: 44, borderRadius: 22,
                    backgroundColor: borrowerColor(loan.borrower_name),
                    alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <Text style={{ color: '#fff', fontSize: 17, fontWeight: '800' }}>
                    {(loan.borrower_name.trim().charAt(0) || '?').toUpperCase()}
                  </Text>
                </View>
                <Text style={{ flex: 1, fontSize: 16, fontWeight: '700', color: Colors.text }}>{loan.item_name}</Text>
                {info && tierColor && (
                  <View style={{ backgroundColor: tint(tierColor), borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Ionicons name={alertTierIcon(info.tier)} size={11} color={tierColor} />
                    <Text style={{ color: tierColor, fontSize: 12, fontWeight: '700' }}>
                      {info.tier === 'OVERDUE'
                        ? t('alerts.badgeOverdue', { d: -info.days })
                        : info.tier === 'DUE'
                          ? t('alerts.badgeDueToday')
                          : info.tier === 'SOON'
                            ? t('alerts.badgeDaysLeft', { d: info.days })
                            : t('alerts.badgeWatch', { d: info.days })}
                    </Text>
                  </View>
                )}
              </View>
              <Text style={{ color: Colors.subtext, fontSize: 13 }}>
                {t('lend.borrowerLine', { name: loan.borrower_name, a: remaining, b: loan.quantity_lent })}
              </Text>
              <Text style={{ color: Colors.subtext, fontSize: 13 }}>
                {t('lend.datesLine', { d1: formatDate(loan.lent_at), d2: loan.expected_return_date ? formatDate(loan.expected_return_date) : t('lend.notSet') })}
              </Text>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
                <AppButton title={t('lend.returnedBtn')} icon="checkmark" onPress={() => openReturn(loan)} style={{ flex: 1 }} />
                <AppButton title={t('lend.viewItem')} variant="secondary" onPress={() => router.push(`/item/${loan.item_id}`)} style={{ flex: 1 }} />
              </View>
            </View>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>{t('lend.empty')}</Text>}
        ListFooterComponent={
          returned.length > 0 ? (
            <View style={{ marginTop: 20, gap: 10 }}>
              <SectionTitle title={t('lend.historyTitle')} subtitle={t('lend.historySubtitle')} color={Colors.orange} />
              {returned.map((loan) => (
                <View key={loan.id} style={[styles.card, { gap: 3 }]}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: Colors.text }}>{loan.item_name} — {loan.borrower_name}</Text>
                  <Text style={{ fontSize: 12, color: Colors.subtext }}>
                    {t('lend.historyLine', { d1: formatDate(loan.lent_at), d2: formatDate(loan.returned_at), n: loan.quantity_lent })}
                  </Text>
                </View>
              ))}
            </View>
          ) : undefined
        }
      />

      <Modal visible={!!returnTarget} transparent animationType="fade" onRequestClose={() => setReturnTarget(null)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.card, styles.modalCard, { gap: 14 }]}>
            <Text style={{ fontSize: 18, fontWeight: '800', color: Colors.text }}>{t('lend.returnTitle')}</Text>
            <Text style={{ color: Colors.subtext }}>
              {t('lend.returnQuestion', { item: returnTarget?.item_name ?? '', borrower: returnTarget?.borrower_name ?? '', n: returnTarget ? returnTarget.quantity_lent - returnTarget.quantity_returned : 0 })}
            </Text>
            <TextInput style={styles.input} keyboardType="number-pad" value={returnQty} onChangeText={setReturnQty} autoFocus />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <AppButton title={t('common.cancel')} variant="secondary" onPress={() => setReturnTarget(null)} style={{ flex: 1 }} />
              <AppButton title={t('common.confirm')} onPress={handleReturn} style={{ flex: 1 }} />
            </View>
            <AppButton title={t('alerts.actSnooze')} variant="ghost" icon="notifications-off-outline" onPress={handleSnoozeLoan} />
          </View>
        </View>
      </Modal>
    </View>
  );
}
