import React from 'react';
import { View } from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/components/ui';
import { floatingShadow, tint, type IconName } from '@/theme';
import { useT } from '@/i18n';

/**
 * Icon tab trong khung CỐ ĐỊNH 50×30 — kích thước không đổi theo trạng thái,
 * nền pill chỉ đổi màu khi active nên glyph không bao giờ bị cắt/lệch.
 */
function TabBarIcon({ name, focused, color }: { name: IconName; focused: boolean; color: string }) {
  return (
    <View
      style={{
        width: 50, height: 30, borderRadius: 15,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: focused ? tint(Colors.primary, '22') : 'transparent',
      }}
    >
      <Ionicons name={name} size={22} color={color} />
    </View>
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
          position: 'absolute', left: 14, right: 14, bottom: 12,
          height: 70, paddingTop: 8, paddingBottom: 8,
          borderRadius: 30, backgroundColor: '#fff', borderTopWidth: 0,
          ...floatingShadow,
        },
        tabBarItemStyle: { flex: 1, paddingVertical: 2 },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700', marginTop: 2 },
        tabBarIconStyle: { width: 50, height: 30 },
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
          tabBarLabelStyle: { fontSize: 11, fontWeight: '700', marginTop: 2, color: Colors.accent },
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
