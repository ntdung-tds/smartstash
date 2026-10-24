import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, Dimensions, Animated, FlatList, Modal, Pressable, TextInput,
  ActivityIndicator, Image, type ViewStyle,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors, styles, AppButton, AppPopup, type IconName } from '@/components/ui';
import { tint } from '@/theme';
import { kvSet } from '@/db/client';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import {
  connectDrive, hasDriveMasterKey, setupDriveMasterKey, DriveError, BackupError,
} from '@/services/driveService';

/**
 * Trang giới thiệu (mẫu v2 đã duyệt): nền tím sâu + orb màu TĨNH, 4 màn
 * vuốt ngang, mỗi màn có KHUNG NỘI DUNG LỚN (kính mờ, bo 20) flex:1 chiếm
 * trọn chiều cao còn lại — không còn đáy trống như v43:
 *  1) Logo + khẩu hiệu; trong khung: ô tìm kiếm giả + 4 hàng đồ vật ví
 *     dụ (hàng đầu nổi bật viền coral + thẻ "3 giây").
 *  2) Minh hoạ hiện trường VẼ BẰNG VIEW (phòng tím, 2 kệ, hộp máy ảnh
 *     viền coral phát sáng) + ghim coral nảy/vòng pulse + chip đường
 *     dẫn + thẻ thumbnail "Bản đồ" tĩnh. KHÔNG còn bản đồ trực tiếp
 *     (OsmMapPreview chỉ còn dùng ở chi tiết vị trí).
 *  3) Cho mượn / ký gửi: 3 thẻ tiến độ (có 1 thẻ quá hạn) + chip nhắc
 *     mốc + hàng 2 ô thống kê — các khối dàn đều khắp khung.
 *  4) Sao lưu & đồng bộ: 3 dòng tin cậy + thẻ "Sao lưu tự động hoạt
 *     động thế nào" + [Đăng nhập với Google] chạy
 *     đúng luồng Drive của Cài đặt (connectDrive native → chưa có khoá
 *     chính thì bước đặt mật khẩu sao lưu, bỏ qua được bằng "Để sau")
 *     hoặc [Tiếp tục không cần tài khoản] vào thẳng app.
 * "Bỏ qua" ở 3 màn đầu nhảy thẳng tới màn 4 (không kết thúc luôn).
 *
 * KHỬ LAG VUỐT (so với v43):
 *  - Bỏ MỌI vòng lặp Animated chạy thường trực: orb nền tĩnh, logo
 *    không còn "lơ lửng"; vòng pulse/nảy của ghim chỉ chạy khi màn 2
 *    đang active, rời màn là dừng hẳn.
 *  - Pager: windowSize=3, initialNumToRender=2 và LAZY-MOUNT — nội dung
 *    nặng của mỗi màn chỉ dựng khi màn nằm trong ±1 so với màn active
 *    (ngoài khoảng đó là khung trống cùng kích thước, layout không giật).
 *  - Chỉ báo trang = THANH ĐOẠN (kiểu A đã duyệt): 4 đoạn ngang chạy
 *    THUẦN theo state `page`, không nội suy theo vị trí cuộn (cơ chế
 *    dots + scrollX cũ đã bỏ hẳn). `page` chỉ cập nhật khi cuộn kết
 *    thúc (momentum end) hoặc qua goTo — không setState giữa cú vuốt.
 *  - Chiều cao pager do style flex:1 quyết định — KHÔNG đo onLayout
 *    vào state nữa (vòng đo nội dung ↔ khung chứa là nghi phạm crash
 *    còn lại của v44 ở dữ liệu trống).
 *  - Toàn bộ pager + hàng điều hướng được bọc OnboardingErrorBoundary:
 *    lỗi render nào cũng rơi về màn dự phòng tối giản (logo + chữ +
 *    nút "Bắt đầu" vào thẳng app) thay vì crash app.
 *  - Shadow trong cây pager được tiết chế (radius nhỏ).
 * Animation còn lại là RN Animated one-shot (ObRise hiện dần khi màn
 * thành active) — reanimated chưa cấu hình worklets nên không dùng.
 */

const { width: W } = Dimensions.get('window');
const PAGES = [0, 1, 2, 3];
const LAST_PAGE = PAGES.length - 1;

/** Nhường 1 nhịp render (~50ms) trước tác vụ mã hoá khoá — cùng mẹo với Cài đặt */
function yieldUiTick(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 50); });
}

/** Nội dung con của màn: hiện dần + trượt lên, so le theo `delay`, chạy khi màn thành active */
function ObRise({
  active, delay = 0, children, style,
}: {
  active: boolean;
  delay?: number;
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!active) return;
    const anim = Animated.timing(v, { toValue: 1, duration: 520, delay, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [active, delay, v]);
  return (
    <Animated.View
      style={[style, {
        opacity: v,
        transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }],
      }]}
    >
      {children}
    </Animated.View>
  );
}

/** Ô logo vuông bo ở đầu mỗi màn (màu đặc theo màn, viền sáng mảnh, bóng nhẹ) */
function LogoTile({ bg, children }: { bg: string; children: React.ReactNode }) {
  return (
    <View
      style={{
        width: 68, height: 68, borderRadius: 20, backgroundColor: bg,
        borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
        alignItems: 'center', justifyContent: 'center',
        shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 10, elevation: 5,
      }}
    >
      {children}
    </View>
  );
}

/**
 * Lưới an toàn cho trang giới thiệu: bắt mọi lỗi render của cây pager
 * (FlatList / dots / animation) rồi rơi về MÀN DỰ PHÒNG tối giản trên
 * nền tím — logo + dòng chữ + nút "Bắt đầu" gọi ĐÚNG finish() của màn
 * chính. Màn dự phòng chỉ dùng View/Text/TouchableOpacity tĩnh, KHÔNG
 * chứa bất kỳ thành phần nào của pager nên không thể lặp lại lỗi đó —
 * người dùng mới không bao giờ bị kẹt ngoài app vì lỗi hiển thị.
 */
class OnboardingErrorBoundary extends React.Component<
  { title: string; body: string; startLabel: string; onStart: () => void; children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    // Chỉ ghi log phục vụ debug; UI đã có màn dự phòng lo phần còn lại
    console.warn('[onboarding] render error:', error);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
        <LogoTile bg={Colors.primary}>
          <Ionicons name="cube" size={34} color="#fff" />
        </LogoTile>
        <Text style={{ marginTop: 22, fontSize: 20, lineHeight: 26, fontWeight: '800', color: '#fff', textAlign: 'center' }}>
          {this.props.title}
        </Text>
        <Text style={{ marginTop: 10, fontSize: 13.5, lineHeight: 20, color: 'rgba(255,255,255,0.78)', textAlign: 'center' }}>
          {this.props.body}
        </Text>
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={this.props.onStart}
          style={{ marginTop: 26, backgroundColor: Colors.coral, borderRadius: 999, paddingVertical: 13, paddingHorizontal: 30 }}
        >
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '800' }}>{this.props.startLabel}</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

/** Khung nội dung lớn kính mờ dùng chung cho các màn (flex:1, bo 20) */
const frameStyle: ViewStyle = {
  flex: 1, width: '100%', marginTop: 20, borderRadius: 20,
  backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
  padding: 14, gap: 10,
};

/**
 * Ghim coral nảy + vòng pulse phủ trên hộp máy ảnh (màn 2). Vòng lặp
 * CHỈ chạy khi `active` (màn 2 đang xem) — rời màn là stop ngay, không
 * còn animation nào chạy ngầm như bản v43.
 */
function ScenePinOverlay({ active }: { active: boolean }) {
  const [bounce] = useState(() => new Animated.Value(0));
  const [ring] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!active) return;
    const b = Animated.loop(
      Animated.sequence([
        Animated.timing(bounce, { toValue: 1, duration: 1100, useNativeDriver: true }),
        Animated.timing(bounce, { toValue: 0, duration: 1100, useNativeDriver: true }),
      ]),
    );
    const r = Animated.loop(
      Animated.timing(ring, { toValue: 1, duration: 2200, useNativeDriver: true }),
    );
    b.start();
    r.start();
    return () => { b.stop(); r.stop(); };
  }, [active, bounce, ring]);
  // Mỏ neo tại mép trên của hộp máy ảnh (left 49% / top 17% của khung cảnh)
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: '49%', top: '17%', width: 0, height: 0 }}>
      <Animated.View
        style={{
          position: 'absolute', left: -7, top: -7, width: 14, height: 14, borderRadius: 7,
          borderWidth: 2, borderColor: 'rgba(255,90,118,0.75)',
          opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
          transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.4, 3.4] }) }],
        }}
      />
      <Animated.View
        style={{
          position: 'absolute', left: -17, top: -34,
          transform: [{ translateY: bounce.interpolate({ inputRange: [0, 1], outputRange: [0, -5] }) }],
        }}
      >
        <Ionicons name="location" size={34} color={Colors.coral} />
      </Animated.View>
    </View>
  );
}

/**
 * Minh hoạ hiện trường vẽ hoàn toàn bằng View phẳng (màn 2): phòng tím
 * 2 kệ, các hộp/sách màu, hộp MÁY ẢNH viền coral phát sáng ở kệ trên,
 * chậu cây góc phải; phủ chip đường dẫn + thẻ "Bản đồ" tĩnh.
 * Toạ độ tính theo % khung cảnh nên co giãn theo máy.
 */
function SceneIllustration({ active, crumb, mapLabel }: { active: boolean; crumb: string; mapLabel: string }) {
  const boxBase: ViewStyle = { position: 'absolute', borderRadius: 3 };
  return (
    <View style={{ flex: 1, borderRadius: 14, overflow: 'hidden', backgroundColor: '#4A3A5E', position: 'relative' }}>
      {/* Tường + sàn */}
      <View style={{ position: 'absolute', left: 0, right: 0, top: 0, height: '72%', backgroundColor: '#5D4A75' }} />
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '28%', backgroundColor: '#3A2C4C' }} />

      {/* Quầng sáng sau hộp máy ảnh */}
      <View style={{ position: 'absolute', left: '40%', top: '15.5%', width: '18%', height: '19%', borderRadius: 10, backgroundColor: 'rgba(255,90,118,0.28)' }} />

      {/* Kệ trên (thanh ngang ở 32%) + đồ trên kệ */}
      <View style={{ position: 'absolute', top: '32%', left: '6%', width: '55%', height: 7, borderRadius: 3.5, backgroundColor: '#2E2142' }} />
      <View style={[boxBase, { left: '9%', top: '20%', width: '11%', height: '12%', backgroundColor: Colors.orange }]} />
      <View style={[boxBase, { left: '23%', top: '23%', width: '8%', height: '9%', backgroundColor: Colors.sky }]} />
      {/* Hộp máy ảnh — món được ghim: nền tím sâu, viền coral, ống kính ở giữa */}
      <View
        style={{
          position: 'absolute', left: '42%', top: '18%', width: '14%', height: '14%',
          borderRadius: 4, backgroundColor: Colors.primaryDark,
          borderWidth: 2.5, borderColor: Colors.coral,
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        <View style={{ width: 13, height: 13, borderRadius: 7, borderWidth: 2.5, borderColor: Colors.coral, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: Colors.coral }} />
        </View>
      </View>

      {/* Kệ dưới (thanh ngang ở 55%) + đồ trên kệ */}
      <View style={{ position: 'absolute', top: '55%', left: '6%', width: '55%', height: 7, borderRadius: 3.5, backgroundColor: '#2E2142' }} />
      <View style={[boxBase, { left: '9%', top: '44%', width: '12%', height: '11%', backgroundColor: Colors.teal }]} />
      <View style={[boxBase, { left: '25%', top: '46.5%', width: '9%', height: '8.5%', backgroundColor: Colors.violetSoft }]} />
      <View style={[boxBase, { left: '39%', top: '43%', width: '16%', height: '12%', backgroundColor: Colors.pink }]} />

      {/* Chậu cây góc phải: 3 lá + chậu nâu */}
      <View style={{ position: 'absolute', right: '13%', bottom: '33%', width: '7%', height: '13%', borderRadius: 99, backgroundColor: '#34D399', transform: [{ rotate: '-24deg' }] }} />
      <View style={{ position: 'absolute', right: '8%', bottom: '34%', width: '6%', height: '11%', borderRadius: 99, backgroundColor: '#34D399', transform: [{ rotate: '22deg' }] }} />
      <View style={{ position: 'absolute', right: '10.5%', bottom: '36%', width: '6%', height: '12%', borderRadius: 99, backgroundColor: '#34D399' }} />
      <View style={{ position: 'absolute', right: '9%', bottom: '24%', width: '13%', height: '9%', borderRadius: 3, backgroundColor: '#8B5E34' }} />

      <ScenePinOverlay active={active} />

      {/* Chip đường dẫn vị trí ở đáy-trái */}
      <View
        style={{
          position: 'absolute', left: 10, bottom: 10, maxWidth: '66%',
          backgroundColor: 'rgba(24,17,52,0.6)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
          borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6,
        }}
      >
        <Text numberOfLines={1} style={{ color: '#fff', fontSize: 11, fontWeight: '600' }}>{crumb}</Text>
      </View>

      {/* Thẻ thumbnail "Bản đồ" tĩnh ở đáy-phải: nền be, lưới đường
          trắng, chấm coral giữa, nhãn dưới — gợi ý tính năng xem bản đồ */}
      <View
        style={{
          position: 'absolute', right: 10, bottom: 10, width: 64, height: 46,
          borderRadius: 9, borderWidth: 2, borderColor: '#fff', overflow: 'hidden',
          backgroundColor: '#EDEAE2',
        }}
      >
        <View style={{ position: 'absolute', left: '31%', top: 0, bottom: 0, width: 5, backgroundColor: '#FFFFFF' }} />
        <View style={{ position: 'absolute', left: '64%', top: 0, bottom: 0, width: 5, backgroundColor: '#FFFFFF' }} />
        <View style={{ position: 'absolute', top: '30%', left: 0, right: 0, height: 5, backgroundColor: '#FFFFFF' }} />
        <View style={{ position: 'absolute', top: '63%', left: 0, right: 0, height: 5, backgroundColor: '#FFFFFF' }} />
        <View style={{ position: 'absolute', left: '50%', top: '38%', marginLeft: -4, width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.coral }} />
        <Text style={{ position: 'absolute', left: 0, right: 0, bottom: 1, fontSize: 7, fontWeight: '700', color: '#5B5648', textAlign: 'center' }}>
          {mapLabel}
        </Text>
      </View>
    </View>
  );
}

/** Hàng đồ vật ví dụ (màn 1): ô icon màu + tên + vị trí; `highlight` = viền coral + thẻ phụ bên phải */
function ExampleChip({
  icon, color, name, loc, highlight, tag,
}: {
  icon: IconName; color: string; name: string; loc: string; highlight?: boolean; tag?: string;
}) {
  return (
    <View
      style={{
        flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10,
        paddingVertical: 10, paddingHorizontal: 13, borderRadius: 16,
        backgroundColor: highlight ? 'rgba(255,90,118,0.13)' : 'rgba(255,255,255,0.09)',
        borderWidth: 1, borderColor: highlight ? Colors.coral : 'rgba(255,255,255,0.13)',
      }}
    >
      <View style={{ width: 34, height: 34, borderRadius: 11, backgroundColor: color, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={icon} size={17} color="#fff" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>{name}</Text>
        <Text style={{ color: 'rgba(255,255,255,0.68)', fontSize: 11.5, marginTop: 1 }}>{loc}</Text>
      </View>
      {!!tag && (
        <View style={{ backgroundColor: Colors.coral, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>{tag}</Text>
        </View>
      )}
    </View>
  );
}

/** Thẻ tiến độ ví dụ (màn 3): tên + dòng phụ + thanh tiến độ */
function ProgressCard({ name, sub, pct, color }: { name: string; sub: string; pct: number; color: string }) {
  return (
    <View
      style={{
        padding: 13, borderRadius: 16,
        backgroundColor: 'rgba(255,255,255,0.09)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.13)',
      }}
    >
      <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>{name}</Text>
      <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11.5, marginTop: 2 }}>{sub}</Text>
      <View style={{ height: 7, borderRadius: 99, backgroundColor: 'rgba(255,255,255,0.18)', overflow: 'hidden', marginTop: 8 }}>
        <View style={{ height: '100%', width: `${pct}%`, borderRadius: 99, backgroundColor: color }} />
      </View>
    </View>
  );
}

/** Ô thống kê nhỏ ở đáy khung màn 3 */
function StatBox({ title, sub }: { title: string; sub: string }) {
  return (
    <View
      style={{
        flex: 1, padding: 10, borderRadius: 14,
        backgroundColor: 'rgba(255,255,255,0.09)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.13)',
      }}
    >
      <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>{title}</Text>
      <Text style={{ color: 'rgba(255,255,255,0.68)', fontSize: 11.5, marginTop: 2, lineHeight: 16 }}>{sub}</Text>
    </View>
  );
}

/**
 * Một đoạn của chỉ báo trang KIỂU A (thanh đoạn): đang xem = coral dài
 * 34px, đã qua = trắng 55%, chưa tới = trắng 22%. Chỉ chạy theo state
 * `page` — bề rộng chuyển mượt bằng Animated.timing cục bộ, KHÔNG nội
 * suy theo vị trí cuộn như cơ chế dots cũ.
 */
function PageSegment({ state }: { state: 'on' | 'done' | 'todo' }) {
  const [w] = useState(() => new Animated.Value(state === 'on' ? 34 : 26));
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    const anim = Animated.timing(w, { toValue: state === 'on' ? 34 : 26, duration: 220, useNativeDriver: false });
    anim.start();
    return () => anim.stop();
  }, [state, w]);
  return (
    <Animated.View
      style={{
        width: w, height: 5, borderRadius: 99,
        backgroundColor: state === 'on' ? Colors.coral : state === 'done' ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.22)',
      }}
    />
  );
}

/** Chip nhắc hẹn nhỏ ở màn 3: chuông vàng + các mốc nhắc THẬT của app (trước hạn / quá hạn / ký gửi 30-60-90) */
function ReminderChip({ text }: { text: string }) {
  return (
    <View
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 7, alignSelf: 'center',
        paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999,
        backgroundColor: 'rgba(251,191,36,0.13)', borderWidth: 1, borderColor: 'rgba(251,191,36,0.35)',
      }}
    >
      <Ionicons name="notifications-outline" size={14} color={Colors.yellow} />
      <Text style={{ flexShrink: 1, color: 'rgba(255,255,255,0.88)', fontSize: 11.5, fontWeight: '600' }}>{text}</Text>
    </View>
  );
}

/** Một dòng trong thẻ "Sao lưu tự động hoạt động thế nào" (màn 4): icon teal nhỏ + câu mô tả hành vi BYOC thật */
function HowRow({ icon, text }: { icon: IconName; text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Ionicons name={icon} size={15} color={Colors.teal} />
      <Text style={{ flex: 1, color: 'rgba(255,255,255,0.85)', fontSize: 12, lineHeight: 16 }}>{text}</Text>
    </View>
  );
}

/** Dòng tin cậy ở màn 4: icon teal + câu ngắn, nền kính mờ */
function TrustRow({ icon, text }: { icon: IconName; text: string }) {
  return (
    <View
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 9,
        paddingVertical: 9, paddingHorizontal: 12, borderRadius: 13,
        backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.13)',
      }}
    >
      <Ionicons name={icon} size={17} color={Colors.teal} />
      <Text style={{ flex: 1, color: 'rgba(255,255,255,0.88)', fontSize: 12.5, lineHeight: 17 }}>{text}</Text>
    </View>
  );
}

/**
 * Ô nhập mật khẩu kèm nút MẮT hiện–ẩn — bản sao đúng chuẩn giao diện của
 * Cài đặt (SecretField ở settings.tsx là component cục bộ của màn đó,
 * không import chéo được nên dựng lại tại đây, cùng styles dùng chung).
 */
function SecretField({
  label, value, onChangeText, visible, onToggleVisible, toggleLabel, autoFocus,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  visible: boolean;
  onToggleVisible: () => void;
  toggleLabel: string;
  autoFocus?: boolean;
}) {
  return (
    <>
      <Text style={[styles.label, { marginTop: 10 }]}>{label}</Text>
      <View>
        <TextInput
          style={[styles.input, { paddingRight: 54 }]}
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={!visible}
          autoFocus={autoFocus}
          placeholder="••••••"
          placeholderTextColor={Colors.subtext}
        />
        <TouchableOpacity
          style={{ position: 'absolute', right: 4, top: 0, height: 52, width: 46, alignItems: 'center', justifyContent: 'center' }}
          onPress={onToggleVisible}
          hitSlop={6}
          accessibilityLabel={toggleLabel}
        >
          <Ionicons name={visible ? 'eye-off-outline' : 'eye-outline'} size={21} color={Colors.subtext} />
        </TouchableOpacity>
      </View>
    </>
  );
}

/** Khối cảnh báo hổ phách: nhắc lưu kỹ mật khẩu (quên = mất bản sao lưu) — cùng chuẩn Cài đặt */
function PasswordWarnBox({ text }: { text: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8, backgroundColor: tint(Colors.orange, '26'), borderRadius: 12, padding: 10, marginTop: 10 }}>
      <Ionicons name="alert-circle-outline" size={19} color={Colors.orange} />
      <Text style={{ flex: 1, fontSize: 12.5, lineHeight: 18, color: Colors.text }}>{text}</Text>
    </View>
  );
}

const titleStyle = { fontSize: 24, lineHeight: 31, fontWeight: '800' as const, color: '#fff', textAlign: 'center' as const, marginTop: 14 };
const bodyStyle = { fontSize: 13, lineHeight: 20, color: 'rgba(255,255,255,0.78)', textAlign: 'center' as const, marginTop: 8 };

export default function OnboardingScreen() {
  const { t } = useT();
  const listRef = useRef<FlatList<number>>(null);
  const targetRef = useRef(0);
  const [page, setPage] = useState(0);
  // Luồng Google Drive ở màn cuối: bận khi mở trình chọn tài khoản +
  // popup lỗi dùng chung + bước đặt mật khẩu sao lưu (như Cài đặt)
  const [googleBusy, setGoogleBusy] = useState(false);
  const [infoPopup, setInfoPopup] = useState<{ title: string; message?: string } | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwShow, setPwShow] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);

  async function finish() {
    await kvSet('onboarded', '1');
    // Lật cờ trong store TRƯỚC khi điều hướng: root layout quyết định cổng
    // onboarding từ store này. Chỉ ghi KV thì layout vẫn giữ giá trị cũ
    // (false) và Redirect sẽ đẩy ngược về màn giới thiệu — kẹt vòng lặp,
    // lộ rõ nhất sau khi xoá dữ liệu app (cờ khởi tạo là false).
    useAppStore.getState().setOnboarded(true);
    router.replace('/(tabs)');
  }

  function goTo(index: number) {
    targetRef.current = index;
    // Lật page ngay để màn đích lazy-mount kịp trước khi cuộn tới
    setPage(index);
    listRef.current?.scrollToIndex({ index, animated: true });
  }

  /** Map lỗi Drive/mã hoá sang thông điệp i18n — ĐÚNG bản ở Cài đặt */
  function driveErrorMessage(e: unknown): string {
    if (e instanceof BackupError && e.code === 'WRONG_PASSWORD') return t('backup.wrongPw');
    if (e instanceof BackupError) return t('backup.invalidFile');
    if (e instanceof DriveError) {
      if (e.code === 'NOT_CONNECTED') return t('drive.notConnectedErr');
      if (e.code === 'NO_MASTER_KEY') return t('drive.noKeyErr');
      if (e.code === 'AUTH') return t('drive.authErr');
      if (e.code === 'PLAY_SERVICES') return t('drive.playServicesErr');
      if (e.code === 'NOT_CONFIGURED') return t('drive.notConfigured');
    }
    return e instanceof Error ? e.message : String(e);
  }

  /**
   * Nút "Đăng nhập với Google" (màn cuối): ĐÚNG luồng Cài đặt —
   * connectDrive() native; người dùng huỷ chọn tài khoản thì im lặng ở
   * lại màn cuối; lỗi thật thì popup như Cài đặt. Kết nối xong mà máy
   * chưa có khoá chính Drive thì mở bước ĐẶT MẬT KHẨU sao lưu trước khi
   * hoàn tất giới thiệu (bỏ qua được bằng "Để sau").
   */
  async function handleGoogle() {
    setGoogleBusy(true);
    try {
      const res = await connectDrive();
      if (res.status === 'cancelled') return;
      if (!(await hasDriveMasterKey())) {
        setPw('');
        setPwConfirm('');
        setPwError(null);
        setPwShow(false);
        setPwOpen(true);
        return;
      }
      await finish();
    } catch (e) {
      setInfoPopup({ title: t('drive.title'), message: driveErrorMessage(e) });
    } finally {
      setGoogleBusy(false);
    }
  }

  /** Xác nhận trong bước đặt mật khẩu sao lưu Drive — kiểm tra như Cài đặt */
  async function handlePwSubmit() {
    if (pw.length < 6) {
      setPwError(t('backup.pwTooShort'));
      return;
    }
    if (pw !== pwConfirm) {
      setPwError(t('backup.pwMismatch'));
      return;
    }
    const password = pw;
    setPwBusy(true);
    await yieldUiTick();
    setPwBusy(false);
    setPwOpen(false);
    setPw('');
    setPwConfirm('');
    try {
      await setupDriveMasterKey(password);
      await finish();
    } catch (e) {
      setInfoPopup({ title: t('drive.title'), message: driveErrorMessage(e) });
    }
  }

  /** Khung gốc của mỗi màn: đầu trang (huy hiệu + tiêu đề + mô tả) rồi tới phần nội dung flex:1 */
  function slideShell(index: number, icon: IconName, iconBg: string, iconSize: number, title: string, body: string, children: React.ReactNode) {
    const active = page === index;
    return (
      <View style={{ width: W, height: '100%', paddingHorizontal: 24, paddingTop: 36, paddingBottom: 14, alignItems: 'center' }}>
        <ObRise active={active} delay={0}>
          <LogoTile bg={iconBg}>
            <Ionicons name={icon} size={iconSize} color="#fff" />
          </LogoTile>
        </ObRise>
        <ObRise active={active} delay={80}>
          <Text style={titleStyle}>{title}</Text>
        </ObRise>
        <ObRise active={active} delay={160}>
          <Text style={bodyStyle}>{body}</Text>
        </ObRise>
        {children}
      </View>
    );
  }

  function renderSlide(index: number) {
    const active = page === index;
    // LAZY-MOUNT: ngoài ±1 so với màn active chỉ trả khung trống đúng
    // kích thước — không dựng nội dung nặng, không giật layout
    if (Math.abs(index - page) > 1) {
      return <View style={{ width: W, height: '100%' }} />;
    }
    if (index === 0) {
      return slideShell(0, 'cube', Colors.primary, 34, t('ob.p1Title'), t('ob.p1Body'), (
        <ObRise active={active} delay={240} style={{ width: '100%', flex: 1 }}>
          <View style={frameStyle}>
            {/* Ô tìm kiếm giả */}
            <View
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 8,
                paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12,
                backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)',
              }}
            >
              <Ionicons name="search" size={15} color="rgba(255,255,255,0.85)" />
              <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12.5 }}>{t('ob.searchCamera')}</Text>
            </View>
            <ExampleChip icon="camera" color={Colors.coral} name={t('ob.ex1Name')} loc={t('ob.ex1Loc')} highlight tag={t('ob.fastTag')} />
            <ExampleChip icon="key" color={Colors.teal} name={t('ob.ex2Name')} loc={t('ob.ex2Loc')} />
            <ExampleChip icon="book" color={Colors.orange} name={t('ob.ex3Name')} loc={t('ob.ex3Loc')} />
            <ExampleChip icon="construct" color={Colors.violetSoft} name={t('ob.ex4Name')} loc={t('ob.ex4Loc')} />
          </View>
        </ObRise>
      ));
    }
    if (index === 1) {
      return slideShell(1, 'location', Colors.teal, 32, t('ob.p2Title'), t('ob.p2Body'), (
        <ObRise active={active} delay={240} style={{ width: '100%', flex: 1 }}>
          <View style={[frameStyle, { padding: 10 }]}>
            <SceneIllustration active={active} crumb={t('ob.crumbPath')} mapLabel={t('ob.mapLabel')} />
          </View>
        </ObRise>
      ));
    }
    if (index === 2) {
      return slideShell(2, 'list', Colors.orange, 30, t('ob.p3Title'), t('ob.p3Body'), (
        <ObRise active={active} delay={240} style={{ width: '100%', flex: 1 }}>
          <View style={[frameStyle, { justifyContent: 'space-between' }]}>
            <ProgressCard name={t('ob.loanName')} sub={t('ob.loanSub')} pct={50} color={Colors.teal} />
            <ProgressCard name={t('ob.consignName')} sub={t('ob.consignSub')} pct={80} color={Colors.yellow} />
            <ProgressCard name={t('ob.overdueName')} sub={t('ob.overdueSub')} pct={100} color={Colors.danger} />
            <ReminderChip text={t('ob.remindChip')} />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <StatBox title={t('ob.stat1Title')} sub={t('ob.stat1Sub')} />
              <StatBox title={t('ob.stat2Title')} sub={t('ob.stat2Sub')} />
            </View>
          </View>
        </ObRise>
      ));
    }
    // Màn cuối: 3 dòng tin cậy + thẻ "Sao lưu tự động hoạt động thế
    // nào" (3 hành vi BYOC thật: tự sao lưu >24 giờ, giữ 5 bản, đổi máy
    // khôi phục bằng đăng nhập + mật khẩu) + 2 lựa chọn — Đăng nhập
    // Google (đồng bộ) / Tiếp tục không cần tài khoản. Cụm trên lấp gần
    // hết chiều cao, nút bấm neo xuống đáy, khoảng trống còn lại nhỏ.
    return slideShell(3, 'shield-checkmark', Colors.sky, 32, t('ob.p4Title'), t('ob.p4Body'), (
      <View style={{ width: '100%', flex: 1, marginTop: 18 }}>
        <ObRise active={active} delay={240} style={{ width: '100%' }}>
          <View style={{ gap: 9 }}>
            <TrustRow icon="lock-closed" text={t('ob.trust1')} />
            <TrustRow icon="cloud-outline" text={t('ob.trust2')} />
            <TrustRow icon="flash" text={t('ob.trust3')} />
          </View>
        </ObRise>
        <ObRise active={active} delay={290} style={{ width: '100%' }}>
          <View
            style={{
              marginTop: 12, padding: 13, borderRadius: 16,
              backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.13)',
            }}
          >
            <Text style={{ color: '#fff', fontSize: 12.5, fontWeight: '800' }}>{t('ob.howTitle')}</Text>
            <View style={{ marginTop: 9, gap: 7 }}>
              <HowRow icon="cloud-upload-outline" text={t('ob.how1')} />
              <HowRow icon="layers-outline" text={t('ob.how2')} />
              <HowRow icon="key-outline" text={t('ob.how3')} />
            </View>
          </View>
        </ObRise>
        <View style={{ flex: 1 }} />
        <ObRise active={active} delay={340} style={{ width: '100%' }}>
          <TouchableOpacity
            activeOpacity={0.85}
            disabled={googleBusy}
            onPress={() => { handleGoogle().catch(() => {}); }}
            style={{
              height: 56, borderRadius: 999, backgroundColor: '#fff',
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
              shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 12, elevation: 5,
              opacity: googleBusy ? 0.7 : 1,
            }}
          >
            {googleBusy ? (
              <ActivityIndicator color={Colors.primaryDark} />
            ) : (
              <>
                <Image source={require('../../assets/images/google-g.png')} style={{ width: 20, height: 20 }} />
                <Text style={{ color: Colors.primaryDark, fontSize: 15, fontWeight: '700' }}>{t('ob.googleBtn')}</Text>
              </>
            )}
          </TouchableOpacity>
          <Text style={{ marginTop: 7, fontSize: 11.5, color: 'rgba(255,255,255,0.65)', textAlign: 'center' }}>
            {t('ob.googleSub')}
          </Text>
        </ObRise>
        <ObRise active={active} delay={420} style={{ width: '100%' }}>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => { finish().catch(() => {}); }}
            style={{
              marginTop: 12, height: 54, borderRadius: 999,
              borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.4)',
              alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>{t('ob.guestBtn')}</Text>
          </TouchableOpacity>
          <Text style={{ marginTop: 12, fontSize: 11, lineHeight: 16, color: 'rgba(255,255,255,0.55)', textAlign: 'center' }}>
            {t('ob.guestNote')}
          </Text>
        </ObRise>
      </View>
    ));
  }

  return (
    <View style={{ flex: 1, backgroundColor: Colors.deep, overflow: 'hidden' }}>
      {/* Nền: quầng tím sáng phía đáy (gợi gradient #241254 → #4B1E9E
          của mẫu) + 3 orb màu mờ TĨNH — không vòng lặp animation nào
          chạy thường trực trên nền nữa (nguồn lag chính của v43) */}
      <View pointerEvents="none" style={{ position: 'absolute', width: 460, height: 460, borderRadius: 230, backgroundColor: '#4B1E9E', opacity: 0.5, bottom: -200, left: W / 2 - 230 }} />
      <View pointerEvents="none" style={{ position: 'absolute', width: 190, height: 190, borderRadius: 95, backgroundColor: Colors.coral, opacity: 0.35, top: -70, right: -60 }} />
      <View pointerEvents="none" style={{ position: 'absolute', width: 130, height: 130, borderRadius: 65, backgroundColor: Colors.teal, opacity: 0.3, bottom: 90, left: -60 }} />
      <View pointerEvents="none" style={{ position: 'absolute', width: 80, height: 80, borderRadius: 40, backgroundColor: Colors.yellow, opacity: 0.25, bottom: -30, right: 50 }} />

      {page < LAST_PAGE && (
        <TouchableOpacity
          onPress={() => goTo(LAST_PAGE)}
          hitSlop={8}
          style={{
            position: 'absolute', top: 50, right: 16, zIndex: 5,
            paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
            backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
          }}
        >
          <Text style={{ fontSize: 12.5, fontWeight: '600', color: 'rgba(255,255,255,0.75)' }}>{t('ob.skip')}</Text>
        </TouchableOpacity>
      )}

      <OnboardingErrorBoundary
        title={t('ob.fallbackTitle')}
        body={t('ob.fallbackBody')}
        startLabel={t('ob.fallbackStart')}
        onStart={() => { finish().catch(() => {}); }}
      >
      <FlatList
        ref={listRef}
        style={{ flex: 1 }}
        data={PAGES}
        extraData={page}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(i) => String(i)}
        getItemLayout={(_, index) => ({ length: W, offset: W * index, index })}
        windowSize={3}
        initialNumToRender={2}
        maxToRenderPerBatch={2}
        removeClippedSubviews
        onScrollToIndexFailed={() => {
          listRef.current?.scrollToOffset({ offset: targetRef.current * W, animated: true });
        }}
        onMomentumScrollEnd={(e) => {
          const p = Math.round(e.nativeEvent.contentOffset.x / W);
          setPage(Math.max(0, Math.min(LAST_PAGE, p)));
        }}
        renderItem={({ item }) => renderSlide(item)}
      />

      {/* Hàng điều hướng đáy: THANH ĐOẠN kiểu A (trái) + nút Tiếp tục
          (phải, ẩn ở màn cuối). Thanh đoạn chạy THUẦN theo state page:
          đoạn đang xem coral dài 34px, đã qua trắng 55%, chưa tới
          trắng 22%, kèm nhãn "n/4" — không còn nội suy theo cuộn. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, paddingTop: 10, paddingBottom: 26 }}>
        <View style={{ flexDirection: 'row', gap: 5, alignItems: 'center' }}>
          {PAGES.map((i) => (
            <PageSegment key={i} state={i === page ? 'on' : i < page ? 'done' : 'todo'} />
          ))}
          <Text style={{ marginLeft: 9, fontSize: 11, fontWeight: '700', color: 'rgba(255,255,255,0.6)' }}>
            {page + 1}/{PAGES.length}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => goTo(page + 1)}
          disabled={page === LAST_PAGE}
          activeOpacity={0.85}
          style={{
            backgroundColor: Colors.coral, borderRadius: 999, paddingVertical: 12, paddingHorizontal: 22,
            shadowColor: Colors.coral, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.45, shadowRadius: 20, elevation: 6,
            opacity: page === LAST_PAGE ? 0 : 1,
          }}
        >
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '800' }}>{t('ob.continue')}</Text>
        </TouchableOpacity>
      </View>
      </OnboardingErrorBoundary>

      {/* Bước đặt mật khẩu sao lưu Drive sau khi đăng nhập Google (chưa
          có khoá chính) — ĐÚNG mẫu modal của Cài đặt, thêm lựa chọn
          "Để sau" để bỏ qua rồi vào app luôn */}
      <Modal visible={pwOpen} transparent animationType="fade" onRequestClose={() => setPwOpen(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setPwOpen(false)}>
          <Pressable style={[styles.card, styles.modalCard, { gap: 6 }]} onPress={() => {}}>
            <Text style={{ fontSize: 17, fontWeight: '800', color: Colors.text }}>{t('drive.setPasswordTitle')}</Text>
            <Text style={{ color: Colors.subtext, fontSize: 13, lineHeight: 19 }}>{t('drive.setPasswordDesc')}</Text>
            <PasswordWarnBox text={t('backup.passwordWarn')} />
            <SecretField
              label={t('backup.pwLabel')}
              value={pw}
              onChangeText={setPw}
              visible={pwShow}
              onToggleVisible={() => setPwShow((v) => !v)}
              toggleLabel={pwShow ? t('common.hide') : t('common.show')}
              autoFocus
            />
            <SecretField
              label={t('backup.pwConfirmLabel')}
              value={pwConfirm}
              onChangeText={setPwConfirm}
              visible={pwShow}
              onToggleVisible={() => setPwShow((v) => !v)}
              toggleLabel={pwShow ? t('common.hide') : t('common.show')}
            />
            {pwError && (
              <Text style={{ color: Colors.danger, fontSize: 13, marginTop: 10 }}>{pwError}</Text>
            )}
            <AppButton
              title={t('common.confirm')}
              icon="lock-closed-outline"
              style={{ marginTop: 14 }}
              loading={pwBusy}
              onPress={() => { handlePwSubmit().catch(() => {}); }}
            />
            <TouchableOpacity
              style={{ alignItems: 'center', paddingVertical: 10 }}
              onPress={() => { setPwOpen(false); finish().catch(() => {}); }}
            >
              <Text style={{ fontSize: 13.5, fontWeight: '600', color: Colors.subtext }}>{t('ob.later')}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Popup thông báo/lỗi dùng chung (như Cài đặt) */}
      <AppPopup
        visible={!!infoPopup}
        title={infoPopup?.title ?? ''}
        message={infoPopup?.message}
        okLabel={t('common.gotIt')}
        onClose={() => setInfoPopup(null)}
      />
    </View>
  );
}
