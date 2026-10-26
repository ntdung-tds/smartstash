import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { styles, Colors, ScreenHeader } from '@/components/ui';
import { useT } from '@/i18n';

/**
 * Trang Có gì mới — mở từ hàng "Có gì mới" trong Cài đặt → Hỗ trợ &
 * thông tin. Trang riêng theo cùng khuôn guide.tsx (router.push('/changelog'));
 * không sửa _layout.tsx. Nội dung lấy hoàn toàn từ i18n (ch.*), mới nhất
 * trước, chỉ ghi những thay đổi có thật theo lịch sử bản build.
 */
const ENTRIES = [
  { title: 'ch.v70Title', body: 'ch.v70Body' },
  { title: 'ch.v69Title', body: 'ch.v69Body' },
  { title: 'ch.v67Title', body: 'ch.v67Body' },
  { title: 'ch.v66Title', body: 'ch.v66Body' },
  { title: 'ch.v62Title', body: 'ch.v62Body' },
] as const;

export default function ChangelogScreen() {
  const { t } = useT();
  return (
    <ScrollView style={[styles.screen, { paddingTop: 54 }]} contentContainerStyle={styles.content}>
      <ScreenHeader
        title={t('ch.title')}
        subtitle={t('ch.subtitle')}
        icon="newspaper-outline"
        color={Colors.primary}
        onBack={() => router.back()}
      />
      {ENTRIES.map((e) => (
        <View key={e.title} style={[styles.card, { gap: 8 }]}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: Colors.text }}>{t(e.title)}</Text>
          <Text style={{ fontSize: 13.5, color: Colors.subtext, lineHeight: 20 }}>{t(e.body)}</Text>
        </View>
      ))}
    </ScrollView>
  );
}
