// PWA quản trị SmartStash — JS thuần, không thư viện ngoài.
//
// Cấu hình kết nối (Worker URL + ADMIN_TOKEN) lưu ở localStorage của trình
// duyệt quản trị. Đây là biện pháp tạm chấp nhận được vì PWA này chỉ dùng cho
// chủ app; lớp bảo vệ chính thức là Cloudflare Access đặt trước trang này
// khi triển khai (xem README). KHÔNG đưa token này vào code hay repo.

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function getSettings() {
    return {
      apiBase: (localStorage.getItem('ss_api_base') || '').replace(/\/$/, ''),
      token: localStorage.getItem('ss_admin_token') || '',
    };
  }

  function setStatus(el, text, ok) {
    el.textContent = text;
    el.className = 'status ' + (ok === true ? 'ok' : ok === false ? 'bad' : '');
  }

  async function api(path, options) {
    var s = getSettings();
    if (!s.apiBase) throw new Error('Chưa nhập địa chỉ Worker (API).');
    var headers = { 'Content-Type': 'application/json' };
    if (s.token) headers.Authorization = 'Bearer ' + s.token;
    var res = await fetch(s.apiBase + path, Object.assign({ headers: headers }, options || {}));
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok || !data || data.ok === false) {
      var msg = (data && (data.message || data.error)) || ('Lỗi HTTP ' + res.status);
      throw new Error(msg);
    }
    return data;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('vi-VN'); } catch (e) { return iso; }
  }

  // --- Kết nối ---
  $('apiBase').value = getSettings().apiBase;
  $('adminToken').value = getSettings().token;
  $('saveSettings').addEventListener('click', function () {
    localStorage.setItem('ss_api_base', $('apiBase').value.trim().replace(/\/$/, ''));
    localStorage.setItem('ss_admin_token', $('adminToken').value.trim());
    setStatus($('connStatus'), 'Đã lưu kết nối.', true);
  });

  // --- Tabs ---
  var tabButtons = document.querySelectorAll('#tabs button');
  tabButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      tabButtons.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      document.querySelectorAll('main .tab').forEach(function (t) { t.classList.add('hidden'); });
      $('tab-' + btn.dataset.tab).classList.remove('hidden');
    });
  });

  // --- Mã khuyến mãi ---
  async function loadPromos() {
    var box = $('promoList');
    box.innerHTML = '<p>Đang tải…</p>';
    try {
      var data = await api('/api/promo');
      if (!data.promos.length) { box.innerHTML = '<p>Chưa có mã nào.</p>'; return; }
      box.innerHTML = data.promos.map(function (p) {
        return '<div class="row" data-code="' + esc(p.code) + '">' +
          '<div class="title">' + esc(p.code) + '</div>' +
          '<div class="meta">Quyền lợi: ' + esc(p.entitlement) + ' · ' + p.days + ' ngày · ' +
          'Đã đổi: ' + p.used + '/' + p.max_uses +
          (p.campaign ? ' · Đợt: ' + esc(p.campaign) : '') +
          (p.expires_at ? ' · Hết hạn: ' + fmtDate(p.expires_at) : '') + '</div>' +
          '<div class="actions">' +
          '<button type="button" class="secondary toggle" data-enabled="' + (p.enabled ? 0 : 1) + '">' +
          (p.enabled ? 'Tắt mã' : 'Bật lại mã') + '</button>' +
          '<button type="button" class="secondary view-redemptions">Xem lượt đổi</button>' +
          '</div><div class="sub-list"></div></div>';
      }).join('');
      box.querySelectorAll('.toggle').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var row = btn.closest('.row');
          try {
            await api('/api/promo/' + encodeURIComponent(row.dataset.code), {
              method: 'PATCH',
              body: JSON.stringify({ enabled: btn.dataset.enabled === '1' }),
            });
            loadPromos();
          } catch (e) { alert('Lỗi: ' + e.message); }
        });
      });
      box.querySelectorAll('.view-redemptions').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var row = btn.closest('.row');
          var sub = row.querySelector('.sub-list');
          try {
            var d = await api('/api/promo/' + encodeURIComponent(row.dataset.code) + '/redemptions');
            sub.innerHTML = d.redemptions.length
              ? d.redemptions.map(function (r) {
                  return '<div class="meta">' + fmtDate(r.redeemed_at) + ' · ' + esc(r.account_id) +
                    ' · ' + esc(r.result) + (r.reason ? ' (' + esc(r.reason) + ')' : '') + '</div>';
                }).join('')
              : '<div class="meta">Chưa có lượt đổi nào.</div>';
          } catch (e) { sub.innerHTML = '<div class="meta">Lỗi: ' + esc(e.message) + '</div>'; }
        });
      });
    } catch (e) { box.innerHTML = '<p class="status bad">Lỗi: ' + esc(e.message) + '</p>'; }
  }
  $('reloadPromos').addEventListener('click', loadPromos);

  $('createPromoForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var f = ev.target;
    var toIso = function (v) { return v ? new Date(v).toISOString() : null; };
    try {
      var d = await api('/api/promo', {
        method: 'POST',
        body: JSON.stringify({
          code: f.code.value,
          entitlement: f.entitlement.value || 'pro',
          days: parseInt(f.days.value, 10),
          max_uses: parseInt(f.max_uses.value, 10),
          campaign: f.campaign.value || null,
          starts_at: toIso(f.starts_at.value),
          expires_at: toIso(f.expires_at.value),
        }),
      });
      setStatus($('createPromoMsg'), 'Đã tạo mã ' + d.code + '.', true);
      f.reset();
      f.entitlement.value = 'pro';
      f.days.value = 90;
      f.max_uses.value = 1;
      loadPromos();
    } catch (e) { setStatus($('createPromoMsg'), 'Lỗi: ' + e.message, false); }
  });

  // --- Nhật ký đổi mã ---
  async function loadLog() {
    var box = $('logList');
    box.innerHTML = '<p>Đang tải…</p>';
    try {
      var data = await api('/api/promo/redemptions?limit=100');
      box.innerHTML = data.redemptions.length
        ? data.redemptions.map(function (r) {
            return '<div class="row"><div class="title">' + esc(r.code) + ' — ' + esc(r.result) + '</div>' +
              '<div class="meta">' + fmtDate(r.redeemed_at) + ' · ' + esc(r.account_id) +
              (r.reason ? ' · Lý do: ' + esc(r.reason) : '') + '</div></div>';
          }).join('')
        : '<p>Chưa có lượt đổi nào.</p>';
    } catch (e) { box.innerHTML = '<p class="status bad">Lỗi: ' + esc(e.message) + '</p>'; }
  }
  $('reloadLog').addEventListener('click', loadLog);

  // --- Cấp / thu hồi thủ công ---
  $('grantForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var f = ev.target;
    try {
      var d = await api('/api/entitlements/grant', {
        method: 'POST',
        body: JSON.stringify({
          account_id: f.account_id.value,
          entitlement: f.entitlement.value || 'pro',
          days: parseInt(f.days.value, 10),
        }),
      });
      setStatus($('grantMsg'), 'Đã cấp ' + d.entitlement + ' tới ' + fmtDate(d.expires_at) + '.', true);
    } catch (e) { setStatus($('grantMsg'), 'Lỗi: ' + e.message, false); }
  });
  $('revokeForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var f = ev.target;
    try {
      await api('/api/entitlements/revoke', {
        method: 'POST',
        body: JSON.stringify({
          account_id: f.account_id.value,
          entitlement: f.entitlement.value || 'pro',
        }),
      });
      setStatus($('revokeMsg'), 'Đã thu hồi quyền lợi tặng.', true);
    } catch (e) { setStatus($('revokeMsg'), 'Lỗi: ' + e.message, false); }
  });

  // --- Cờ cấu hình ---
  async function loadConfig() {
    try {
      var data = await api('/api/config');
      var f = $('configForm');
      f.self_promo_enabled.checked = !!data.flags.self_promo_enabled;
      f.min_version.value = data.flags.min_version || '';
      f.maintenance_notice.value = data.flags.maintenance_notice || '';
      f.plan_limits_override.value = data.flags.plan_limits_override
        ? JSON.stringify(data.flags.plan_limits_override) : '';
    } catch (e) { setStatus($('configMsg'), 'Lỗi tải cấu hình: ' + e.message, false); }
  }
  $('configForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var f = ev.target;
    var override = null;
    if (f.plan_limits_override.value.trim()) {
      try { override = JSON.parse(f.plan_limits_override.value); }
      catch (e) { setStatus($('configMsg'), 'Lỗi: plan_limits_override không phải JSON hợp lệ.', false); return; }
    }
    try {
      await api('/api/config', {
        method: 'PUT',
        body: JSON.stringify({
          self_promo_enabled: f.self_promo_enabled.checked,
          min_version: f.min_version.value || null,
          maintenance_notice: f.maintenance_notice.value || null,
          plan_limits_override: override,
        }),
      });
      setStatus($('configMsg'), 'Đã lưu cấu hình.', true);
    } catch (e) { setStatus($('configMsg'), 'Lỗi: ' + e.message, false); }
  });

  // --- Sao lưu ---
  async function loadBackups() {
    var box = $('backupStats');
    box.innerHTML = '<p>Đang tải…</p>';
    try {
      var data = await api('/api/backups/usage');
      box.innerHTML = '<div class="row"><div class="title">Kho chứa: ' + esc(data.storage) + '</div>' +
        '<div class="meta">Số file: ' + data.files + ' · Tổng dung lượng: ' +
        (data.bytes / 1048576).toFixed(2) + ' MB</div></div>';
    } catch (e) { box.innerHTML = '<p class="status bad">Lỗi: ' + esc(e.message) + '</p>'; }
  }
  $('reloadBackups').addEventListener('click', loadBackups);

  // Tải dữ liệu lần đầu cho màn đang mở.
  loadPromos();
  loadConfig();

  // Đăng ký service worker (PWA) — im lặng nếu trình duyệt không hỗ trợ.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
