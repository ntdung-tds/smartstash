/**
 * Màn trò chuyện với trợ lý AI (Gemini miễn phí) — nhánh feature/ai-add.
 *
 * Trợ lý trả lời bằng tiếng Việt, biết cách dùng app SmartStash và biết đồ
 * của người dùng đang ở đâu (ngữ cảnh nạp từ DB máy: tên món + đường dẫn
 * vị trí, tối đa 150 món, cắt ngắn để prompt không quá dài). Lịch sử chat
 * chỉ giữ trong bộ nhớ của màn này, thoát màn là mất — cố ý, để không lưu
 * thêm nội dung chat vào DB. Không cần key hay cài đặt: màn gọi thẳng
 * Worker, lỗi (chưa bật AI, hết lượt) hiện bằng popup.
 */

import React, { useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { styles, Colors, AppPopup } from '@/components/ui';
import { cardShadow } from '@/theme';
import { listItems, getBreadcrumb, breadcrumbText } from '@/db/queries';
import { aiChat, AiError } from '@/services/aiService';
import { useT } from '@/i18n';

interface ChatMsg {
  role: 'user' | 'model';
  text: string;
}

export default function AssistantScreen() {
  const { t } = useT();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [popup, setPopup] = useState<{ title: string; message?: string } | null>(null);
  const listRef = useRef<FlatList<ChatMsg>>(null);

  async function buildContext(): Promise<string> {
    try {
      const items = await listItems();
      const lines: string[] = [];
      for (const it of items.slice(0, 150)) {
        const crumb = breadcrumbText(await getBreadcrumb(it.location_id));
        lines.push(`- ${it.name} (SL ${it.quantity} ${it.unit}) — ${crumb || 'chưa có vị trí'}`);
      }
      const joined = lines.join('\n');
      return joined.slice(0, 8000);
    } catch {
      return '';
    }
  }

  async function handleSend() {
    const msg = input.trim();
    if (!msg || busy) return;
    setInput('');
    const history = messages;
    setMessages((prev) => [...prev, { role: 'user', text: msg }]);
    setBusy(true);
    try {
      const context = await buildContext();
      const reply = await aiChat(history, msg, context);
      setMessages((prev) => [...prev, { role: 'model', text: reply }]);
    } catch (e) {
      const text = e instanceof AiError ? e.message : e instanceof Error ? e.message : String(e);
      setPopup({ title: t('ai.error'), message: text });
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.screen, { paddingTop: 54, flex: 1 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, marginBottom: 12 }}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={8}
          style={{
            width: 36, height: 36, borderRadius: 18, backgroundColor: '#fff',
            alignItems: 'center', justifyContent: 'center', ...cardShadow,
          }}
        >
          <Ionicons name="chevron-back" size={16} color={Colors.primaryDark} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: Colors.text }}>{t('ai.title')}</Text>
          <Text style={{ fontSize: 12.5, color: Colors.subtext }}>{t('ai.freeNote')}</Text>
        </View>
      </View>

      <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(_, i) => String(i)}
            contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 12, gap: 10 }}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            renderItem={({ item }) => (
              <View
                style={{
                  alignSelf: item.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '85%',
                  backgroundColor: item.role === 'user' ? Colors.primary : '#fff',
                  borderRadius: 16,
                  paddingHorizontal: 13,
                  paddingVertical: 10,
                  ...cardShadow,
                }}
              >
                <Text style={{ fontSize: 14.5, lineHeight: 21, color: item.role === 'user' ? '#fff' : Colors.text }}>
                  {item.text}
                </Text>
              </View>
            )}
            ListEmptyComponent={
              <Text style={{ color: Colors.subtext, fontSize: 13.5, lineHeight: 20, paddingHorizontal: 18 }}>
                {t('ai.chatPlaceholder')}
              </Text>
            }
          />
          {busy && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, paddingBottom: 6 }}>
              <ActivityIndicator size="small" color={Colors.primary} />
              <Text style={{ fontSize: 13, color: Colors.subtext }}>{t('ai.thinking')}</Text>
            </View>
          )}
          <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 18, paddingBottom: 24 }}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              value={input}
              onChangeText={setInput}
              placeholder={t('ai.chatPlaceholder')}
              placeholderTextColor={Colors.faint}
              multiline
              editable={!busy}
              onSubmitEditing={() => { handleSend().catch(() => {}); }}
            />
            <TouchableOpacity
              style={{
                width: 52, height: 52, borderRadius: 16, backgroundColor: Colors.primary,
                alignItems: 'center', justifyContent: 'center', opacity: busy || !input.trim() ? 0.5 : 1,
              }}
              disabled={busy || !input.trim()}
              onPress={() => { handleSend().catch(() => {}); }}
            >
              <Ionicons name="send" size={20} color="#fff" />
            </TouchableOpacity>
          </View>
      <AppPopup
        visible={!!popup}
        title={popup?.title ?? ''}
        message={popup?.message}
        okLabel={t('common.gotIt')}
        onClose={() => setPopup(null)}
      />
    </View>
  );
}
