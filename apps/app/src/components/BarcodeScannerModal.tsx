import React, { useRef, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, ActivityIndicator, Vibration, StyleSheet,
} from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from './ui';
import { useT } from '../i18n';

/** Các loại mã hỗ trợ theo docs expo-camera SDK 58 (BarcodeType) */
const BARCODE_TYPES: BarcodeType[] = [
  'qr', 'ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'code93',
  'codabar', 'itf14', 'pdf417', 'aztec', 'datamatrix',
];

function FrameCorner({ style }: { style: object }) {
  return <View pointerEvents="none" style={[local.corner, style]} />;
}

/**
 * Màn quét QR / barcode toàn màn hình (expo-camera).
 * Quét trúng mã đầu tiên -> rung nhẹ, gọi onScanned(data, type) rồi onClose();
 * mọi sự kiện quét sau đó bị bỏ qua cho tới khi modal mở lại.
 */
export default function BarcodeScannerModal({
  visible, onClose, onScanned,
}: {
  visible: boolean;
  onClose: () => void;
  onScanned: (data: string, type: string) => void;
}) {
  const { t } = useT();
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const scannedRef = useRef(false);

  /** Mọi đường đóng đều qua đây: reset chống-trùng + tắt đèn để lần mở sau sạch trạng thái */
  const handleClose = () => {
    scannedRef.current = false;
    setTorch(false);
    onClose();
  };

  const handleScanned = ({ data, type }: { data: string; type: string }) => {
    if (scannedRef.current || !data) return;
    scannedRef.current = true;
    Vibration.vibrate(80);
    onScanned(data, type);
    handleClose();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {visible && !permission && (
          <View style={local.center}>
            <ActivityIndicator size="large" color="#fff" />
          </View>
        )}

        {visible && permission && !permission.granted && (
          <View style={local.center}>
            <View style={local.permIconCircle}>
              <Ionicons name="camera-outline" size={40} color="#fff" />
            </View>
            <Text style={local.permTitle}>{t('scan.permTitle')}</Text>
            <Text style={local.permBody}>
              {permission.canAskAgain ? t('scan.permBody') : t('scan.permDenied')}
            </Text>
            {permission.canAskAgain && (
              <TouchableOpacity
                style={[local.primaryBtn, { backgroundColor: Colors.primary }]}
                onPress={() => { requestPermission(); }}
              >
                <Text style={local.primaryBtnText}>{t('scan.permAllow')}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={local.ghostBtn} onPress={handleClose}>
              <Text style={local.ghostBtnText}>{t('scan.close')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {visible && permission?.granted && (
          <>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              enableTorch={torch}
              barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
              onBarcodeScanned={handleScanned}
            />
            <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
              {/* Thanh trên: đóng + tiêu đề */}
              <View pointerEvents="box-none" style={local.topBar}>
                <TouchableOpacity style={local.roundBtn} onPress={handleClose} hitSlop={8}>
                  <Ionicons name="close" size={24} color="#fff" />
                </TouchableOpacity>
                <Text pointerEvents="none" style={local.topTitle}>{t('scan.title')}</Text>
                <View style={{ width: 44 }} />
              </View>

              {/* Khung ngắm + gợi ý */}
              <View pointerEvents="none" style={local.frameWrap}>
                <View style={local.frame}>
                  <FrameCorner style={{ top: -2, left: -2, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 16 }} />
                  <FrameCorner style={{ top: -2, right: -2, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 16 }} />
                  <FrameCorner style={{ bottom: -2, left: -2, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 16 }} />
                  <FrameCorner style={{ bottom: -2, right: -2, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 16 }} />
                </View>
                <Text style={local.hint}>{t('scan.hint')}</Text>
              </View>

              {/* Nút đèn pin */}
              <View pointerEvents="box-none" style={local.bottomBar}>
                <TouchableOpacity
                  style={[local.torchBtn, torch && { backgroundColor: Colors.coral }]}
                  onPress={() => setTorch((v) => !v)}
                >
                  <Ionicons name={torch ? 'flashlight' : 'flashlight-outline'} size={20} color="#fff" />
                  <Text style={local.torchText}>{t('scan.torch')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const local = StyleSheet.create({
  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 14,
  },
  permIconCircle: {
    width: 84, height: 84, borderRadius: 42, backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center', justifyContent: 'center',
  },
  permTitle: { color: '#fff', fontSize: 20, fontWeight: '800', textAlign: 'center' },
  permBody: { color: 'rgba(255,255,255,0.75)', fontSize: 14.5, lineHeight: 21, textAlign: 'center' },
  primaryBtn: {
    borderRadius: 999, paddingVertical: 13, paddingHorizontal: 22,
    alignItems: 'center', justifyContent: 'center', marginTop: 6, alignSelf: 'stretch',
  },
  primaryBtnText: { color: '#fff', fontSize: 15.5, fontWeight: '700' },
  ghostBtn: { paddingVertical: 10, paddingHorizontal: 18 },
  ghostBtnText: { color: 'rgba(255,255,255,0.85)', fontSize: 15, fontWeight: '600' },
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    paddingTop: 52, paddingHorizontal: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  topTitle: { color: '#fff', fontSize: 16.5, fontWeight: '800' },
  roundBtn: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center',
  },
  frameWrap: {
    position: 'absolute', top: 0, bottom: 0, left: 0, right: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  frame: {
    width: 250, height: 250, borderRadius: 18,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)',
  },
  corner: {
    position: 'absolute', width: 30, height: 30, borderColor: Colors.coral,
  },
  hint: {
    marginTop: 22, color: '#fff', fontSize: 14.5, fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.45)', paddingHorizontal: 14, paddingVertical: 7,
    borderRadius: 999, overflow: 'hidden',
  },
  bottomBar: {
    position: 'absolute', bottom: 56, left: 0, right: 0, alignItems: 'center',
  },
  torchBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999,
    paddingHorizontal: 18, paddingVertical: 11,
  },
  torchText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
