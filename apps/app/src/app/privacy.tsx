import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, Linking } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { styles, Colors, ScreenHeader } from '@/components/ui';
import { useT } from '@/i18n';
import { PRIVACY_URL } from '@/config';

/**
 * Trang Chính sách riêng tư — mở từ hàng "Chính sách riêng tư" trong
 * Cài đặt → Hỗ trợ & thông tin. Nội dung trong app khớp với bản web;
 * cuối màn có link mở bản web đầy đủ (site Cloudflare Pages, chốt
 * 27/10/2026 — dùng cho Google verification và listing Play sau này).
 */
const SECTIONS = [
  { t: 'privacy.s1Title', b: 'privacy.s1Body' },
  { t: 'privacy.s2Title', b: 'privacy.s2Body' },
  { t: 'privacy.s3Title', b: 'privacy.s3Body' },
  { t: 'privacy.s4Title', b: 'privacy.s4Body' },
  { t: 'privacy.s5Title', b: 'privacy.s5Body' },
  { t: 'privacy.s6Title', b: 'privacy.s6Body' },
  { t: 'privacy.s7Title', b: 'privacy.s7Body' },
  { t: 'privacy.s8Title', b: 'privacy.s8Body' },
  { t: 'privacy.s9Title', b: 'privacy.s9Body' },
] as const;

export default function PrivacyScreen() {
  const { t } = useT();
  return (
    <ScrollView style={[styles.screen, { paddingTop: 54 }]} contentContainerStyle={styles.content}>
      <ScreenHeader
        title={t('privacy.title')}
        subtitle={t('privacy.subtitle')}
        icon="shield-checkmark-outline"
        color={Colors.primary}
        onBack={() => router.back()}
      />
      {SECTIONS.map((item) => (
        <View key={item.t} style={[styles.card, { gap: 8 }]}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: Colors.text }}>{t(item.t)}</Text>
          <Text style={{ fontSize: 13.5, color: Colors.subtext, lineHeight: 20 }}>{t(item.b)}</Text>
        </View>
      ))}
      <TouchableOpacity
        style={[styles.card, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}
        onPress={() => { Linking.openURL(PRIVACY_URL).catch(() => {}); }}
      >
        <Ionicons name="open-outline" size={20} color={Colors.primary} />
        <Text style={{ flex: 1, fontSize: 14.5, fontWeight: '700', color: Colors.primary }}>{t('privacy.webLink')}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}
