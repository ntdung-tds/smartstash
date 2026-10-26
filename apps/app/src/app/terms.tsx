import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { styles, Colors, ScreenHeader } from '@/components/ui';
import { useT } from '@/i18n';

/**
 * Trang Điều khoản sử dụng — mở từ hàng "Điều khoản sử dụng" trong
 * Cài đặt → Hỗ trợ & thông tin. Màn hình trong app (v71) thay cho link
 * web vì app chưa có hosting; nội dung ngắn gọn, trung thực theo đúng
 * thực tế app (không SLA, không hứa hẹn pháp lý vượt thực tế).
 */
const SECTIONS = [
  { t: 'terms.s1Title', b: 'terms.s1Body' },
  { t: 'terms.s2Title', b: 'terms.s2Body' },
  { t: 'terms.s3Title', b: 'terms.s3Body' },
  { t: 'terms.s4Title', b: 'terms.s4Body' },
  { t: 'terms.s5Title', b: 'terms.s5Body' },
  { t: 'terms.s6Title', b: 'terms.s6Body' },
  { t: 'terms.s7Title', b: 'terms.s7Body' },
  { t: 'terms.s8Title', b: 'terms.s8Body' },
] as const;

export default function TermsScreen() {
  const { t } = useT();
  return (
    <ScrollView style={[styles.screen, { paddingTop: 54 }]} contentContainerStyle={styles.content}>
      <ScreenHeader
        title={t('terms.title')}
        subtitle={t('terms.subtitle')}
        icon="document-text-outline"
        color={Colors.primary}
        onBack={() => router.back()}
      />
      {SECTIONS.map((item) => (
        <View key={item.t} style={[styles.card, { gap: 8 }]}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: Colors.text }}>{t(item.t)}</Text>
          <Text style={{ fontSize: 13.5, color: Colors.subtext, lineHeight: 20 }}>{t(item.b)}</Text>
        </View>
      ))}
    </ScrollView>
  );
}
