import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { Stack, Redirect, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { initDb, kvGet } from '@/db/client';
import { seedIfEmpty } from '@/db/seed';
import { useAppStore } from '@/store/useAppStore';
import { ensureNotificationSetup, rescheduleAllReminders } from '@/services/notificationService';
import { useT } from '@/i18n';
import { Colors } from '@/components/ui';

export default function RootLayout() {
  const { t } = useT();
  const [ready, setReady] = useState(false);
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    (async () => {
      try {
        await initDb();
        await seedIfEmpty();
        await useAppStore.getState().loadTaxonomy();
        await useAppStore.getState().loadLanguage();
        const flag = await kvGet('onboarded');
        setOnboarded(flag === '1');
        ensureNotificationSetup().catch(() => {});
        rescheduleAllReminders().catch(() => {});
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setReady(true);
      }
    })();
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
      <StatusBar style={pathname === '/onboarding' ? 'light' : 'dark'} />
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
      </Stack>
    </>
  );
}
