import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { styles, Colors, ScreenHeader } from '@/components/ui';
import { useT } from '@/i18n';

/**
 * Trang Hướng dẫn sử dụng — mở từ hàng "Hướng dẫn sử dụng" trong Cài đặt.
 * Trang riêng (không phải modal) theo cùng khuôn các màn độc lập khác
 * (router.push('/guide')); đầu trang dùng ScreenHeader có nút quay lại
 * thay vì đăng ký Stack.Screen riêng, để không phải sửa _layout.tsx.
 * Nội dung lấy hoàn toàn từ i18n (guide.*), mỗi mục một thẻ.
 */
const SECTIONS = [
  { title: 'guide.s1Title', body: 'guide.s1Body' },
  { title: 'guide.s2Title', body: 'guide.s2Body' },
  { title: 'guide.s3Title', body: 'guide.s3Body' },
  { title: 'guide.s4Title', body: 'guide.s4Body' },
  { title: 'guide.s5Title', body: 'guide.s5Body' },
  { title: 'guide.s6Title', body: 'guide.s6Body' },
  { title: 'guide.s7Title', body: 'guide.s7Body' },
] as const;

export default function GuideScreen() {
  const { t } = useT();
  return (
    <ScrollView style={[styles.screen, { paddingTop: 54 }]} contentContainerStyle={styles.content}>
      <ScreenHeader
        title={t('guide.title')}
        subtitle={t('guide.subtitle')}
        icon="book-outline"
        color={Colors.primary}
        onBack={() => router.back()}
      />
      {SECTIONS.map((s) => (
        <View key={s.title} style={[styles.card, { gap: 8 }]}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: Colors.text }}>{t(s.title)}</Text>
          <Text style={{ fontSize: 13.5, color: Colors.subtext, lineHeight: 20 }}>{t(s.body)}</Text>
        </View>
      ))}
    </ScrollView>
  );
}
