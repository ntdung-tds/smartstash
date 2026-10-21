import React, { useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Dimensions } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors, AppButton } from '@/components/ui';
import { kvSet } from '@/db/client';
import { useT } from '@/i18n';

const { width } = Dimensions.get('window');

export default function OnboardingScreen() {
  const { t } = useT();
  const scrollRef = useRef<any>(null);
  const [page, setPage] = useState(0);

  const PAGES = [
    { icon: 'camera' as const, color: Colors.coral, title: t('ob.p1Title'), body: t('ob.p1Body') },
    { icon: 'location' as const, color: Colors.teal, title: t('ob.p2Title'), body: t('ob.p2Body') },
    { icon: 'shield-checkmark' as const, color: Colors.sky, title: t('ob.p3Title'), body: t('ob.p3Body') },
  ];

  async function finish() {
    await kvSet('onboarded', '1');
    router.replace('/(tabs)');
  }

  return (
    <View style={{ flex: 1, backgroundColor: Colors.deep, paddingTop: 56, overflow: 'hidden' }}>
      <View pointerEvents="none" style={{ position: 'absolute', width: 260, height: 260, borderRadius: 130, backgroundColor: Colors.coral, opacity: 0.3, top: -110, right: -80 }} />
      <View pointerEvents="none" style={{ position: 'absolute', width: 190, height: 190, borderRadius: 95, backgroundColor: Colors.teal, opacity: 0.26, bottom: 120, left: -95 }} />
      <View pointerEvents="none" style={{ position: 'absolute', width: 110, height: 110, borderRadius: 55, backgroundColor: Colors.pink, opacity: 0.25, top: 190, right: -45 }} />
      <View pointerEvents="none" style={{ position: 'absolute', width: 90, height: 90, borderRadius: 45, backgroundColor: Colors.yellow, opacity: 0.22, bottom: -30, right: 60 }} />

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
      >
        {PAGES.map((p) => (
          <View key={p.title} style={{ width, padding: 28, alignItems: 'center', gap: 16, paddingTop: 24 }}>
            <View
              style={{
                width: 120, height: 120, borderRadius: 60,
                backgroundColor: `${p.color}2E`, borderWidth: 1.5, borderColor: `${p.color}66`,
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              <View style={{ width: 84, height: 84, borderRadius: 42, backgroundColor: p.color, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name={p.icon} size={42} color="#fff" />
              </View>
            </View>
            <Text style={{ fontSize: 30, fontWeight: '800', color: '#fff', textAlign: 'center', lineHeight: 38 }}>{p.title}</Text>
            <Text style={{ fontSize: 15, color: Colors.onDarkMuted, textAlign: 'center', lineHeight: 24 }}>{p.body}</Text>
          </View>
        ))}
      </ScrollView>

      <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        {PAGES.map((_, i) => (
          <View
            key={i}
            style={{
              width: i === page ? 28 : 9, height: 9, borderRadius: 5,
              backgroundColor: i === page ? Colors.coral : 'rgba(255,255,255,0.32)',
            }}
          />
        ))}
      </View>

      <View style={{ paddingHorizontal: 18, paddingBottom: 30, gap: 10 }}>
        {page < PAGES.length - 1 ? (
          <>
            <AppButton
              title={t('ob.continue')}
              onPress={() => { const n = page + 1; setPage(n); scrollRef.current?.scrollTo({ x: n * width, animated: true }); }}
              style={{ backgroundColor: Colors.coral, shadowColor: Colors.coral, height: 56, borderRadius: 999 }}
            />
            <TouchableOpacity
              style={{ alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: 999, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.35)' }}
              onPress={finish}
            >
              <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>{t('ob.skip')}</Text>
            </TouchableOpacity>
          </>
        ) : (
          <AppButton
            title={t('ob.start')}
            onPress={finish}
            style={{ backgroundColor: Colors.coral, shadowColor: Colors.coral, height: 56, borderRadius: 999 }}
          />
        )}
      </View>
    </View>
  );
}
