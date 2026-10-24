import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from './ui';
import { useT } from '@/i18n';
import {
  authenticateBiometric, getLockConfig, isBiometricAvailable, verifyPin,
} from '@/services/appLockService';

/**
 * Màn hình khoá phủ toàn app (Phase 6).
 * - Nền tím đậm hero giống onboarding, tên app + vòng tròn khoá.
 * - Chấm PIN theo đúng độ dài đã đặt (4–6); nhập đủ là tự kiểm tra.
 * - Tự mở prompt sinh trắc khi hiện (nếu đã bật + thiết bị hỗ trợ), có nút
 *   gọi lại prompt; sai PIN thì báo lỗi tại chỗ và xoá chấm.
 */
export function AppLockScreen({ onUnlock }: { onUnlock: () => void }) {
  const { t } = useT();
  const [pin, setPin] = useState('');
  const [pinLength, setPinLength] = useState(6);
  const [error, setError] = useState(false);
  const [bioReady, setBioReady] = useState(false);
  const bioPromptRef = useRef(false);
  const checkingRef = useRef(false);

  const tryBiometric = useCallback(async () => {
    const ok = await authenticateBiometric(t('lock.biometricPrompt'));
    if (ok) onUnlock();
  }, [t, onUnlock]);

  // Nạp cấu hình: số chấm PIN + sinh trắc; tự mở prompt sinh trắc 1 lần
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfg = await getLockConfig();
      if (cancelled) return;
      setPinLength(cfg.pinLength);
      const available = await isBiometricAvailable();
      if (cancelled) return;
      const usable = cfg.biometricEnabled && available;
      setBioReady(usable);
      if (usable && !bioPromptRef.current) {
        bioPromptRef.current = true;
        const ok = await authenticateBiometric(t('lock.biometricPrompt'));
        if (ok && !cancelled) onUnlock();
      }
    })();
    return () => { cancelled = true; };
    // Chỉ chạy khi màn hình khoá hiện — tránh mở lại prompt khi t/onUnlock đổi identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Nhập đủ số chấm → tự kiểm tra PIN
  useEffect(() => {
    if (pin.length !== pinLength || checkingRef.current) return;
    checkingRef.current = true;
    (async () => {
      const ok = await verifyPin(pin);
      if (ok) {
        onUnlock();
        return;
      }
      setError(true);
      setPin('');
      checkingRef.current = false;
    })();
  }, [pin, pinLength, onUnlock]);

  function pressDigit(d: string) {
    setError(false);
    setPin((p) => (p.length >= pinLength ? p : p + d));
  }

  function pressDelete() {
    setError(false);
    setPin((p) => p.slice(0, -1));
  }

  const rows: (string | 'bio' | 'del' | 'empty')[][] = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    [bioReady ? 'bio' : 'empty', '0', 'del'],
  ];

  return (
    <View
      style={{
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999,
        backgroundColor: Colors.deep, overflow: 'hidden',
        alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, gap: 14,
      }}
    >
      <View pointerEvents="none" style={{ position: 'absolute', width: 260, height: 260, borderRadius: 130, backgroundColor: Colors.coral, opacity: 0.3, top: -110, right: -80 }} />
      <View pointerEvents="none" style={{ position: 'absolute', width: 190, height: 190, borderRadius: 95, backgroundColor: Colors.teal, opacity: 0.26, bottom: 120, left: -95 }} />
      <View pointerEvents="none" style={{ position: 'absolute', width: 110, height: 110, borderRadius: 55, backgroundColor: Colors.pink, opacity: 0.25, top: 190, right: -45 }} />

      <View
        style={{
          width: 92, height: 92, borderRadius: 46,
          backgroundColor: `${Colors.coral}2E`, borderWidth: 1.5, borderColor: `${Colors.coral}66`,
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: Colors.coral, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="lock-closed" size={30} color="#fff" />
        </View>
      </View>

      <Text style={{ fontSize: 26, fontWeight: '800', color: '#fff' }}>SmartStash</Text>
      <Text style={{ fontSize: 15, color: Colors.onDarkMuted, textAlign: 'center' }}>{t('lock.title')}</Text>
      <Text style={{ fontSize: 13.5, color: Colors.onDarkMuted, textAlign: 'center', marginTop: -8 }}>
        {t('lock.enterPin')}
      </Text>

      {/* Chấm PIN: đầy = đã nhập */}
      <View style={{ flexDirection: 'row', gap: 14, marginVertical: 10, height: 18, alignItems: 'center' }}>
        {Array.from({ length: pinLength }).map((_, i) => (
          <View
            key={i}
            style={{
              width: 15, height: 15, borderRadius: 8,
              borderWidth: 1.5, borderColor: error ? Colors.danger : '#fff',
              backgroundColor: i < pin.length ? (error ? Colors.danger : '#fff') : 'transparent',
            }}
          />
        ))}
      </View>
      <View style={{ height: 20, marginTop: -8 }}>
        {error && (
          <Text style={{ fontSize: 13.5, fontWeight: '600', color: Colors.danger }}>{t('lock.wrongPin')}</Text>
        )}
      </View>

      {/* Bàn phím số tự dựng */}
      <View style={{ gap: 10 }}>
        {rows.map((row, ri) => (
          <View key={ri} style={{ flexDirection: 'row', gap: 16 }}>
            {row.map((cell, ci) => {
              if (cell === 'empty') return <View key={ci} style={{ width: 72, height: 60 }} />;
              if (cell === 'bio') {
                return (
                  <TouchableOpacity
                    key={ci}
                    onPress={() => { tryBiometric().catch(() => {}); }}
                    activeOpacity={0.7}
                    style={{ width: 72, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Ionicons name="finger-print" size={30} color="#fff" />
                  </TouchableOpacity>
                );
              }
              if (cell === 'del') {
                return (
                  <TouchableOpacity
                    key={ci}
                    onPress={pressDelete}
                    activeOpacity={0.7}
                    style={{ width: 72, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Ionicons name="backspace-outline" size={27} color="#fff" />
                  </TouchableOpacity>
                );
              }
              return (
                <TouchableOpacity
                  key={ci}
                  onPress={() => pressDigit(cell)}
                  activeOpacity={0.7}
                  style={{
                    width: 72, height: 60, borderRadius: 30,
                    backgroundColor: 'rgba(255,255,255,0.10)',
                    alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontSize: 25, fontWeight: '600', color: '#fff' }}>{cell}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </View>

      {bioReady && (
        <TouchableOpacity
          onPress={() => { tryBiometric().catch(() => {}); }}
          activeOpacity={0.7}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 10, marginTop: 4 }}
        >
          <Ionicons name="finger-print" size={19} color={Colors.onDarkMuted} />
          <Text style={{ fontSize: 13.5, fontWeight: '700', color: Colors.onDarkMuted }}>{t('lock.useBiometric')}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
