import React from 'react';
import { View, Text } from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/components/ui';
import { floatingShadow, tint, type IconName } from '@/theme';
import { useT } from '@/i18n';

/**
 * Icon tab trong khung CỐ ĐỊNH 46×30 — kích thước không đổi theo trạng thái,
 * nền pill chỉ đổi màu khi active nên glyph không bao giờ bị cắt/lệch.
 */
function TabBarIcon({ name, focused, color }: { name: IconName; focused: boolean; color: string }) {
  return (
    <View
      style={{
        width: 46, height: 30, borderRadius: 15,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: focused ? tint(Colors.primary, '22') : 'transparent',
      }}
    >
      <Ionicons name={name} size={22} color={color} />
    </View>
  );
}

/**
 * Nhãn tab dựng thủ công: nhãn mặc định của bottom-tabs bị cắt '…' ở các
 * nhãn dài như "Cho mượn" (ô tab chỉ ~66dp mà chữ 12px/700 cần ~57dp, máy
 * để fontScale > 1 là tràn). Ở đây nhãn LUÔN hiện đủ: 1 dòng, căn giữa
 * trọn bề ngang ô và tự co tối thiểu 0.8 lần thay vì cắt chữ.
 */
function TabLabel({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <Text
      numberOfLines={1}
      adjustsFontSizeToFit
      minimumFontScale={0.8}
      style={{ fontSize: 12, fontWeight: '700', marginTop: 2, width: '100%', textAlign: 'center', color }}
    >
      {children}
    </Text>
  );
}

export default function TabsLayout() {
  const { t } = useT();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Colors.primaryDark,
        tabBarInactiveTintColor: Colors.faint,
        tabBarStyle: {
          position: 'absolute', left: 10, right: 10, bottom: 12,
          height: 70, paddingTop: 8, paddingBottom: 8,
          borderRadius: 30, backgroundColor: '#fff', borderTopWidth: 0,
          ...floatingShadow,
        },
        tabBarItemStyle: { flex: 1, paddingVertical: 2 },
        tabBarLabel: ({ color, children }) => <TabLabel color={String(color)}>{children}</TabLabel>,
        tabBarIconStyle: { width: 46, height: 30 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('tab.home'),
          tabBarIcon: ({ color, focused }) => (
            <TabBarIcon name={focused ? 'home' : 'home-outline'} focused={focused} color={String(color)} />
          ),
        }}
      />
      <Tabs.Screen
        name="locations"
        options={{
          title: t('tab.locations'),
          tabBarIcon: ({ color, focused }) => (
            <TabBarIcon name={focused ? 'location' : 'location-outline'} focused={focused} color={String(color)} />
          ),
        }}
      />
      <Tabs.Screen
        name="quick-add"
        options={{
          title: t('tab.quickAdd'),
          // Ô icon của tab giữa khoá bề ngang ĐÚNG 62 = bề ngang nút tròn:
          // thanh tab trái/phải đều 10 và 5 ô tab flex:1 bằng nhau nên tâm
          // ô giữa trùng tâm màn hình; ô icon 62 vừa khít nút tròn → nút
          // nằm đúng giữa tuyệt đối, không phụ thuộc cách thư viện căn
          // phần tử tràn (nút 62 trong ô 46 mặc định)
          tabBarIconStyle: { width: 62, height: 30 },
          tabBarIcon: ({ focused }) => (
            <View
              style={{
                width: 62, height: 62, borderRadius: 31, marginTop: -22,
                backgroundColor: tint(Colors.accent, '30'),
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              <View
                style={{
                  width: 54, height: 54, borderRadius: 27,
                  backgroundColor: Colors.accent, alignItems: 'center', justifyContent: 'center',
                  shadowColor: Colors.accent, shadowOpacity: 0.45, shadowRadius: 10, shadowOffset: { width: 0, height: 6 }, elevation: 8,
                  borderWidth: 3, borderColor: '#fff',
                }}
              >
                <Ionicons name={focused ? 'camera' : 'add'} size={28} color="#fff" />
              </View>
            </View>
          ),
          tabBarLabel: ({ children }) => <TabLabel color={Colors.accent}>{children}</TabLabel>,
        }}
      />
      <Tabs.Screen
        name="lending"
        options={{
          title: t('tab.lending'),
          tabBarIcon: ({ color, focused }) => (
            <TabBarIcon name="swap-horizontal" focused={focused} color={String(color)} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tab.settings'),
          tabBarIcon: ({ color, focused }) => (
            <TabBarIcon name={focused ? 'settings' : 'settings-outline'} focused={focused} color={String(color)} />
          ),
        }}
      />
    </Tabs>
  );
}
