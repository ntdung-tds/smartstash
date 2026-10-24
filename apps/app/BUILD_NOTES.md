# SmartStash — Ghi chú bản build POC 0.1.0

Nguồn sự thật: Tài liệu hợp nhất PRD+SRS v2.1 (Phụ lục D đã áp dụng V21-01 → V21-20).

## Stack thực tế của bản này
- Expo SDK 58 (mới nhất tại thời điểm khởi tạo — V21-01), React Native 0.88, React 19, TypeScript strict
- Expo Router (file-based, thư mục src/app)
- expo-sqlite, schema v2: 7 bảng chính + items_fts (FTS5, tokenizer unicode61 remove_diacritics 2) + 3 trigger; plugin `expo-sqlite` với `enableFTS: true` (mặc định SDK 58)
- Migration SQL thủ công là nguồn sự thật duy nhất, PRAGMA user_version theo dõi phiên bản (V21-03). Drizzle chưa đưa vào bản POC — tầng queries dùng SQL trực tiếp qua expo-sqlite
- Ảnh: expo-image-picker + expo-image-manipulator (WebP/Android, JPEG/iOS — V21-10), đăng ký qua media_files, nén 1280px q0.75, thumbnail 300px
- State: Zustand (chỉ refresh tick), dữ liệu đọc trực tiếp từ SQLite (V21-11)
- Giao diện: React Native StyleSheet (chưa dùng NativeWind), icon @expo/vector-icons (Ionicons) thay lucide — chốt lại ở phase hoàn thiện

## Phạm vi đã làm (đối chiếu B.19)
- Phase 1: project + dev cấu hình native qua prebuild, schema v2 + migration + FTS5 + trigger, CRUD items/locations/loans/media/history, seed cây căn hộ mẫu
- Phase 2: 5 tab (Trang chủ, Vị trí, Thêm nhanh, Cho mượn, Cài đặt), tìm kiếm FTS5 debounce 150ms + fallback bỏ dấu trong JS nếu FTS5 không khả dụng, chips lọc, thẻ "Cần xử lý", cây vị trí đệ quy + breadcrumb, onboarding 3 trang, xin quyền theo ngữ cảnh
- Phase 3: thêm đồ nhanh (chụp/chọn ảnh, nén, thumbnail, SHA-256), ảnh hiện trường + ghim toạ độ chuẩn hoá (pin_x/pin_y 0..1, chấm đỏ nhấp nháy), màn hình chi tiết
- Phase 4 (một phần): cho mượn/trả một phần qua bảng loans, trạng thái LENT/PARTIALLY_LENT tự tính, bán một phần chưa làm (bán toàn bộ đã có), vứt bỏ/thất lạc (LOST — v2.1), thông báo cục bộ nhắc hết hạn 30/7 ngày + nhắc đòi đồ 09:00 ngày hẹn trả (best-effort), xuất CSV cơ bản ở Cài đặt
- Chưa làm: quét QR/barcode (expo-camera), in PDF nhãn QR, đồng bộ Drive + mã hoá (Phase 5, chờ spike V21-13), khoá app + paywall/RevenueCat (Phase 6), Family Sharing (Phase 7)

## Quy tắc đã áp dụng từ v2.1
- Cây vị trí tối đa 4 cấp + validate chống vòng lặp khi di chuyển (V21-04)
- Category có FOOD, KIDS; status có LOST; condition có NEED_REPAIR (V21-05, V21-06)
- PLAN_LIMITS ở src/config.ts, FAMILY kế thừa PRO bằng spread (V21-07)
- Trigger FTS UPDATE không có OF — mọi UPDATE đều đồng bộ FTS (V21-08)
- Cột deleted_at ở 4 bảng chính; purge khi mở app với bản ghi xoá mềm quá 30 ngày (V21-09)
- Giới hạn Free được áp thật: 50 món, 30 vị trí, nhắc hết hạn không bị paywall (R6)

## Build APK (local, không qua EAS)
Kiểm tra trước build: `npx tsc --noEmit` (0 lỗi), `npx eslint src` (0 lỗi).

Môi trường build trên VM này có nhiều bẫy riêng — xem mục "Môi trường build local trên VM" bên dưới trước khi build lại. Tóm tắt nhanh:
- JDK 17 tại ~/jdk17; Gradle 9.4.1 tại ~/gradle-9.4.1 (KHÔNG dùng gradlew — tải wrapper bị timeout qua proxy); GRADLE_USER_HOME=~/gradle-user-home.
- Android SDK tại ~/android-sdk: platforms android-36 + android-37.0 (bản 37.0 phải có package.xml viết tay theo mẫu của android-36 thì AGP mới nhận), build-tools 36.0.0 + 37.0.0, NDK 27.1.12297006 (bản :app yêu cầu — thông báo "preferred 28.2" của RN là đánh lạc hướng) và 28.2.13676358, CMake 3.22.1.
- Mạng của Java/Gradle qua egress proxy bị chặn ở tầng TLS ⇒ build chạy OFFLINE hoàn toàn bằng kho Maven local ~/local-maven-repo: init script ~/gradle-user-home/init.d/hermetic.init.gradle viết lại mọi repository http/https về kho local; artifact còn thiếu được tải bằng curl (script ~/seed_module.py, ~/seed_plugin.py) theo vòng lặp ~/build_loop.sh (chạy `BUILD_TASK=assembleRelease bash ~/build_loop.sh`, log tại ~/build-logs/).
- gradle.properties cấp user (~/gradle-user-home/gradle.properties) đặt `android.aapt2FromMavenOverride=/home/hatch/android-sdk/build-tools/37.0.0/aapt2` vì transform aapt2 từ Maven cho kết quả rỗng trên Gradle 9.4.1 ở môi trường này.
- KHÔNG dùng curl `-C -` (resume) khi tải artifact: file nối chồng làm hỏng cấu trúc zip mà kích thước vẫn đúng (đã gặp ở prefab cli). Seeder cũng từng lưu trang HTML 404 của Google thành file .module/.jar — đã quét xoá 360 file như vậy khỏi kho local ngày 21/10/2026.

Lệnh build chuẩn (sau khi kho local đã đủ artifact):

```bash
export JAVA_HOME=~/jdk17 ANDROID_HOME=~/android-sdk GRADLE_USER_HOME=~/gradle-user-home
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
~/gradle-9.4.1/bin/gradle --no-daemon --offline assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a --max-workers=2
# APK: android/app/build/outputs/apk/release/app-release.apk
```

Lưu ý: variant debug KHÔNG nhúng JS bundle (plugin RN chỉ tạo bundle cho variant không-debuggable) nên APK debug mở ra sẽ đòi Metro — bản bàn giao dùng **assembleRelease** (vẫn ký bằng debug keystore của template nên cài trực tiếp để test được). Kết quả build đầu tiên: assembleDebug BUILD SUCCESSFUL 21/10/2026 (40 phút), assembleRelease xem log ~/build-logs/.

## Bàn giao thực tế ngày 21/10/2026
- assembleDebug: BUILD SUCCESSFUL (app-debug.apk 131MB, com.smartstash.app, versionName 0.1.0, versionCode 1, minSdk 24, targetSdk 36).
- assembleRelease: người dùng yêu cầu DỪNG giữa chừng (đã biên dịch xong phần lớn thư viện release; toàn bộ cache + kho local còn nguyên, chạy lại `BUILD_TASK=assembleRelease bash ~/build_loop.sh` là tiếp tục từ chỗ dừng).
- File đã gửi người dùng: `SmartStash-POC-v0.1.0.apk` — lấy APK debug đã build xong, tiêm JS bundle Hermes bytecode (tạo bằng `npx expo export:embed --platform android --dev false --bytecode`) vào `assets/index.android.bundle`, zipalign + ký lại bằng debug keystore (apksigner verify đạt v2/v3). RN 0.88 tự fallback sang bundle nhúng khi không có Metro nên app chạy độc lập.
- Hạn chế của file bàn giao này: font icon (Ionicons...) và icon điều hướng của React Navigation KHÔNG được nhúng (chúng phải qua pipeline aapt2 resources của bản build đầy đủ) ⇒ icon hiển thị trống, nhãn chữ vẫn còn; chức năng lõi (SQLite/FTS, thêm đồ bằng camera, cho mượn, thông báo) không bị ảnh hưởng. Muốn bản hoàn chỉnh 100% thì chạy nốt assembleRelease.

## Release đầy đủ — hoàn thành 21/10/2026

- Người dùng yêu cầu chạy tiếp lúc 14:04 (sau khi dừng sáng cùng ngày); vòng lặp hermetic chạy lại với BUILD_TASK=assembleRelease, iteration 1 chạy 31m1s → **BUILD SUCCESSFUL** (621 tasks: 481 executed, 140 up-to-date). Đã qua đủ: bundle release (1503 modules, 48 assets), R8, lintVitalRelease, đóng gói.
- APK: `android/app/build/outputs/apk/release/app-release.apk`, 56.637.525 byte, com.smartstash.app v0.1.0 (versionCode 1), minSdk 24, targetSdk 36, 2 ABI. Đã kiểm chứng: `assets/index.android.bundle` có trong APK; font .ttf đã nhúng dạng resources (tên bị rút gọn do shrinkResources — bình thường ở release); apksigner verify đạt, chứng thư **debug** (CN=Android Debug) — bản này để test sideload, muốn lên Play Store cần keystore release riêng.
- Bản bàn giao: `~/workspace/your_files/SmartStash-v0.1.0-release.apk` — thay thế vai trò của bản POC tiêm bundle (icon ở bản này hiển thị đủ).
- Dự phòng icon (người dùng dặn chuẩn bị song song ở chat phụ): không cần triển khai nữa vì release đã xong.

## Dời thư mục dự án — xoá cache Gradle (bài học 24/10/2026)

Sau khi dời cây dự án sang vị trí mới (monorepo `apps/app`), build thất bại 3 lần
với lỗi `Configuring project ':react-native-nitro-modules' ... does not exist`
trỏ tới đường dẫn CŨ. Nguyên nhân thật: file phát sinh
`android/build/generated/autolinking/autolinking.json` chứa đường dẫn tuyệt đối
cũ, và vì `mv` giữ nguyên mtime nên Gradle tưởng nhiệm vụ tạo file đó vẫn
"up-to-date" và dùng lại bản cũ. Xoá cache trong dự án (`.gradle`, `.cxx`,
`app/build`) và configuration cache (`gradle-user-home/configuration-cache`)
KHÔNG đủ — phải xoá cả `android/build` để nhiệm vụ autolinking chạy lại.
Sau đó build sạch lần đầu biên dịch lại toàn bộ mã native nên lâu (~70 phút),
các lần sau trở lại bình thường.
