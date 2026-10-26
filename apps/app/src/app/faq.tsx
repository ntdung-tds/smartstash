import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { styles, Colors, ScreenHeader } from '@/components/ui';
import { useT } from '@/i18n';

/**
 * Trang Câu hỏi thường gặp — mở từ hàng "Câu hỏi thường gặp" trong
 * Cài đặt → Hỗ trợ & thông tin. Trang riêng theo cùng khuôn guide.tsx
 * (router.push('/faq')); không sửa _layout.tsx. Nội dung lấy hoàn toàn
 * từ i18n (faq.*), mỗi câu hỏi một thẻ.
 */
const QA = [
  { q: 'faq.q1', a: 'faq.a1' },
  { q: 'faq.q2', a: 'faq.a2' },
  { q: 'faq.q3', a: 'faq.a3' },
  { q: 'faq.q4', a: 'faq.a4' },
  { q: 'faq.q5', a: 'faq.a5' },
  { q: 'faq.q6', a: 'faq.a6' },
] as const;

export default function FaqScreen() {
  const { t } = useT();
  return (
    <ScrollView style={[styles.screen, { paddingTop: 54 }]} contentContainerStyle={styles.content}>
      <ScreenHeader
        title={t('faq.title')}
        subtitle={t('faq.subtitle')}
        icon="help-circle-outline"
        color={Colors.primary}
        onBack={() => router.back()}
      />
      {QA.map((item) => (
        <View key={item.q} style={[styles.card, { gap: 8 }]}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: Colors.text }}>{t(item.q)}</Text>
          <Text style={{ fontSize: 13.5, color: Colors.subtext, lineHeight: 20 }}>{t(item.a)}</Text>
        </View>
      ))}
    </ScrollView>
  );
}
