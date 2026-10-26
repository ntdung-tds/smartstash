// Service worker tối giản cho PWA quản trị.
// - Cache vỏ giao diện (HTML/CSS/JS/manifest) để mở lại được khi ngoại tuyến.
// - Mọi request tới /api/* luôn đi mạng (không cache dữ liệu quản trị).
// Lưu ý: icon-192.png / icon-512.png khai trong manifest chưa có file thật —
// trình duyệt chỉ bỏ qua icon khi cài đặt nếu thiếu; tạo 2 ảnh PNG đơn giản
// trước khi phát hành PWA chính thức (xem README).

// BÀI HỌC CỨNG (25/10/2026): MỖI LẦN đổi index.html/app.js/styles.css thì
// PHẢI tăng số version này. Nếu không, trình duyệt thấy file sw.js không đổi
// nên không cài service worker mới, cache cũ (cache-first) phục vụ bản PWA cũ
// mãi — người dùng nhập ADMIN_TOKEN vào bản cũ thì không bao giờ đăng nhập
// được vì bản cũ không có màn đăng nhập.
const CACHE = 'smartstash-admin-v18';
const SHELL = ['index.html', 'styles.css', 'app.js', 'manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return; // API: luôn đi mạng.
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(
      (cached) =>
        cached ||
        fetch(event.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
          return res;
        })
    )
  );
});
