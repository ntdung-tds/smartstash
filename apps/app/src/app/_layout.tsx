import '@/lib/cryptoPolyfill';
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, AppState } from 'react-native';
import { Stack, Redirect, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { initDb, kvGet } from '@/db/client';
import { seedIfEmpty } from '@/db/seed';
import { useAppStore } from '@/store/useAppStore';
import { ensureNotificationSetup, rescheduleAllReminders } from '@/services/notificationService';
import * as Font from 'expo-font';
import { BeVietnamPro_700Bold } from '@expo-google-fonts/be-vietnam-pro';
import { loadPlan } from '@/services/planService';
import { loadCachedRemoteConfig, loadRemoteConfig } from '@/services/remoteConfigService';
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
        // FIX DELAY MỞ APP (v87): trước đây các bước chạy NỐI TIẾP và
        // _layout await cả fetch cấu hình từ xa (timeout tới 8 giây) nên
        // màn hình "Đang tải…" đứng rất lâu khi mạng chậm. Giờ chỉ những
        // gì BẮT BUỘC mới chặn hiện giao diện, và chúng chạy song song:
        // font (local) song song với initDb; sau DB thì taxonomy / ngôn
        // ngữ / gói / cờ đã cache / cờ onboarding chạy cùng lúc. Mọi
        // việc còn lại (fetch cờ mới, thông báo, sao lưu tự động) dời
        // sang effect sau khi ready — xem useEffect bên dưới.
        await Promise.all([
          // Font tiếng Việt cho thanh "Thu gọn" (v86): Be Vietnam Pro 700 —
          // dấu tiếng Việt (ọ, ộ…) hiển thị đúng, không bị font hệ thống
          // làm xấu khi xếp dọc. Lỗi nạp thì thôi, thanh vẫn hiện bằng
          // font hệ thống, không bao giờ chặn khởi động app.
          Font.loadAsync({ BeVietnamPro_700Bold }).catch(() => {}),
          initDb(),
        ]);
        await seedIfEmpty();
        const store = useAppStore.getState();
        const [flag] = await Promise.all([
          kvGet('onboarded'),
          store.loadTaxonomy(),
          store.loadLanguage(),
          loadPlan(),
          // Chỉ đọc cờ ĐÃ CACHE trong máy (vài ms), không chạm mạng.
          loadCachedRemoteConfig().catch(() => {}),
        ]);
        store.setOnboarded(flag === '1');
        // Mở app lạnh: khoá ngay nếu đã bật khoá + đã đặt PIN + đã qua onboarding
        if (flag === '1') {
          const cfg = await getLockConfig();
          if (cfg.lockEnabled && (await hasPin())) setLocked(true);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setReady(true);
      }
    })();
  }, []);

  // Việc nền sau khi giao diện đã hiện — không chặn lần mở app đầu tiên:
  // fetch cờ mới từ máy chủ (Cài đặt vào lại cũng tự fetch lại nên cờ
  // mới không bị lỡ), dựng thông báo, đồng bộ lịch nhắc, sao lưu Drive
  // tự động nếu tới hạn. Tất cả nuốt lỗi, không làm phiền lúc mở app.
  useEffect(() => {
    if (!ready) return;
    loadRemoteConfig().catch(() => {});
    ensureNotificationSetup().catch(() => {});
    rescheduleAllReminders().catch(() => {});
    runAutoDriveBackupIfDue().catch(() => {});
  }, [ready]);

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
