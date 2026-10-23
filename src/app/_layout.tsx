import '@/lib/cryptoPolyfill';
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, AppState } from 'react-native';
import { Stack, Redirect, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { initDb, kvGet } from '@/db/client';
import { seedIfEmpty } from '@/db/seed';
import { useAppStore } from '@/store/useAppStore';
import { ensureNotificationSetup, rescheduleAllReminders } from '@/services/notificationService';
import { loadPlan } from '@/services/planService';
import { runAutoDriveBackupIfDue } from '@/services/driveService';
import { getLockConfig, hasPin } from '@/services/appLockService';
import { AppLockScreen } from '@/components/AppLockScreen';
import { useT } from '@/i18n';
import { Colors } from '@/components/ui';

export default function RootLayout() {
  const { t } = useT();
  const [ready, setReady] = useState(false);
  // Cờ onboarding sống trong store dùng chung — KHÔNG giữ snapshot state riêng
  // ở layout này: onboarding ghi KV rồi lật cờ trong store trước khi điều hướng,
  // layout thấy ngay giá trị mới nên Redirect không đá ngược về màn giới thiệu.
  const onboarded = useAppStore((s) => s.onboarded);
  const [error, setError] = useState<string | null>(null);
  // Khoá app (Phase 6): overlay phủ toàn app khi `locked`
  const [locked, setLocked] = useState(false);
  const backgroundAtRef = useRef<number | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    (async () => {
      try {
        await initDb();
        await seedIfEmpty();
        await useAppStore.getState().loadTaxonomy();
        await useAppStore.getState().loadLanguage();
        await loadPlan();
        const flag = await kvGet('onboarded');
        useAppStore.getState().setOnboarded(flag === '1');
        // Mở app lạnh: khoá ngay nếu đã bật khoá + đã đặt PIN + đã qua onboarding
        if (flag === '1') {
          const cfg = await getLockConfig();
          if (cfg.lockEnabled && (await hasPin())) setLocked(true);
        }
        ensureNotificationSetup().catch(() => {});
        rescheduleAllReminders().catch(() => {});
        // Tự động sao lưu Drive (BYOC) nếu đã bật + bản cuối quá 24 giờ —
        // chạy nền, nuốt mọi lỗi, không bao giờ chặn hay làm phiền lúc mở app
        runAutoDriveBackupIfDue().catch(() => {});
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setReady(true);
      }
    })();
  }, []);

  // Tự khoá khi rời app quá thời gian đã đặt (mặc định 0 = khoá ngay khi quay lại).
  // Chỉ theo mốc 'background' — KHÔNG dùng 'inactive' vì prompt sinh trắc trên iOS
  // cũng phát inactive→active, sẽ gây khoá lặp ngay sau khi mở khoá bằng vân tay.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        backgroundAtRef.current = Date.now();
        return;
      }
      if (state !== 'active') return;
      const at = backgroundAtRef.current;
      backgroundAtRef.current = null;
      if (at == null) return;
      (async () => {
        try {
          // Không khoá trước khi onboarding xong (đọc KV tươi, không dùng state cũ)
          if ((await kvGet('onboarded')) !== '1') return;
          const cfg = await getLockConfig();
          if (!cfg.lockEnabled || !(await hasPin())) return;
          const elapsedSec = (Date.now() - at) / 1000;
          if (elapsedSec >= cfg.lockTimeoutSec) setLocked(true);
        } catch {
          // Lỗi đọc cấu hình thì bỏ qua lượt này — không khoá oan
        }
      })();
    });
    return () => sub.remove();
  }, []);

  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg, gap: 12 }}>
        <ActivityIndicator size="large" color={Colors.primary} />
        <Text style={{ color: Colors.subtext }}>{t('root.loading')}</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 }}>
        <Text style={{ fontSize: 17, fontWeight: '700', color: Colors.danger }}>{t('root.errorTitle')}</Text>
        <Text style={{ color: Colors.subtext, textAlign: 'center' }}>{error}</Text>
      </View>
    );
  }

  const needsOnboarding = onboarded === false && pathname !== '/onboarding';

  return (
    <>
      <StatusBar style={locked || pathname === '/onboarding' ? 'light' : 'dark'} />
      {needsOnboarding && <Redirect href="/onboarding" />}
      <Stack
        screenOptions={{
          headerShown: false,
          headerStyle: { backgroundColor: Colors.bg },
          headerTintColor: Colors.primaryDark,
          headerTitleStyle: { fontWeight: '800', color: Colors.text },
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="item/[id]" options={{ headerShown: true, title: t('root.itemDetails') }} />
        <Stack.Screen name="item/edit" options={{ headerShown: true, title: t('root.editItem') }} />
        <Stack.Screen name="location/[id]" options={{ headerShown: true, title: t('root.locationDetails') }} />
        <Stack.Screen name="labels" options={{ headerShown: true, title: t('labels.title') }} />
      </Stack>
      {locked && <AppLockScreen onUnlock={() => setLocked(false)} />}
    </>
  );
}
