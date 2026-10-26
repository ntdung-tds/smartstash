// PWA quản trị SmartStash — JS thuần, không thư viện ngoài.
//
// Khung: sidebar (desktop) / drawer (mobile) + topbar + một màn tại một thời
// điểm. Dashboard: KPI + biểu đồ SVG tự vẽ + bảng dữ liệu. Đăng nhập bằng
// tài khoản riêng từng người; phân quyền kiểm tra ở phía server, PWA chỉ
// ẩn/hiện mục cho gọn. Mọi thao tác ghi theo SRS đều kèm lý do bắt buộc
// (trừ tạo mã và quản lý người dùng) và ghi vào kiểm toán.

(function () {
  'use strict';

  var DEFAULT_API_BASE = 'https://smartstash-admin.iaict-platform.workers.dev';
  var ROLE_LABELS = { admin: 'Quản trị', staff: 'Nhân viên', viewer: 'Chỉ xem' };
  var PLAN_LABELS = { free: 'Miễn phí', pro_paid: 'Pro trả phí', pro_promo: 'Pro tặng', pro: 'Pro' };
  var ACTION_LABELS = {
    admin_setup: 'Tạo tài khoản đầu tiên',
    admin_login: 'Đăng nhập',
    admin_change_password: 'Đổi mật khẩu',
    admin_user_create: 'Thêm người dùng',
    admin_user_update: 'Sửa người dùng',
    admin_user_delete: 'Xoá người dùng',
    admin_user_reset_password: 'Đặt lại mật khẩu',
    promo_create: 'Tạo mã',
    promo_toggle: 'Bật/tắt mã',
    promo_update: 'Sửa mã',
    promo_delete: 'Xoá mã',
    app_account_block: 'Khoá tài khoản app',
    app_account_unblock: 'Mở khoá tài khoản app',
    app_account_delete: 'Xoá tài khoản app',
    entitlement_grant: 'Cấp quyền lợi',
    entitlement_revoke: 'Thu hồi quyền lợi',
    redemption_revoke: 'Thu hồi lượt đổi',
    config_update: 'Sửa cấu hình',
    config_restore: 'Khôi phục cấu hình',
    backup_tier_change: 'Đổi gói sao lưu',
    revenuecat_event: 'Sự kiện RevenueCat',
  };
  var PAGE_TITLES = {
    overview: 'Tổng quan',
    revenue: 'Doanh thu',
    appaccounts: 'Tài khoản app',
    users: 'Người dùng quản trị',
    promos: 'Mã khuyến mãi',
    log: 'Nhật ký đổi mã',
    grant: 'Cấp / thu hồi',
    config: 'Cấu hình app',
    backups: 'Sao lưu',
    audit: 'Nhật ký kiểm toán',
    settings: 'Cài đặt',
  };
  var $ = function (id) { return document.getElementById(id); };
  var currentUser = null;

  function getSettings() {
    return {
      apiBase: (localStorage.getItem('ss_api_base') || '').replace(/\/$/, ''),
      session: localStorage.getItem('ss_session') || '',
    };
  }

  function setSession(token) {
    if (token) localStorage.setItem('ss_session', token);
    else localStorage.removeItem('ss_session');
  }

  function setStatus(el, text, ok) {
    el.textContent = text;
    el.className = 'status ' + (ok === true ? 'ok' : ok === false ? 'bad' : '');
  }

  // --- Popup thông báo (dùng cho "Lưu cấu hình thành công") ---
  function showPopup(title, message) {
    $('popupTitle').textContent = title;
    $('popupMsg').textContent = message;
    $('popupOverlay').classList.remove('hidden');
  }
  function closePopup() {
    $('popupOverlay').classList.add('hidden');
  }
  $('popupClose').addEventListener('click', closePopup);
  $('popupOverlay').addEventListener('click', function (ev) {
    if (ev.target === $('popupOverlay')) closePopup();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closePopup();
  });

  // --- Danh sách: thu gọn bằng icon + tiêu chí tìm kiếm riêng (26/10/2026) ---
  // "Lọc chính là tìm kiếm": mỗi bảng có đúng tiêu chí của nó, không
  // còn một ô lọc chung chung. Nút thu gọn DẠNG ICON (▲ = đang mở,
  // ▼ = đang thu). Cuộn dọc trong khung do CSS (tối đa 520px).
  // Mặc định tất cả đều mở — lọc chỉ ẩn hiển thị, hàng vẫn nằm trong
  // DOM nên không mất dữ liệu khi lưu form. Tìm kiếm không phân biệt
  // dấu tiếng Việt (gõ "tang" vẫn tìm được "TẶNG").
  function normFilter(s) {
    return String(s || '').toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  }
  // get: hàm lấy giá trị tiêu chí từ một hàng (trả '' nếu không áp dụng).
  // col(n): cột thứ n của bảng (tbody tr). data(k): data-k của thẻ .row.
  function colVal(n) {
    return function (el) {
      var cells = el.querySelectorAll('td');
      return cells[n] ? cells[n].textContent.trim() : '';
    };
  }
  function dataVal(k) {
    return function (el) { return el.dataset[k] || ''; };
  }
  // FILTERS: tiêu chí từng bảng. text = gợi ý ô tìm kiếm; selects =
  // các select lọc, options động (dynamic: true) thì lấy giá trị duy
  // nhất từ chính các hàng đang hiện, còn không thì dùng options tĩnh.
  var FILTERS = {
    promoList: {
      text: 'Tìm mã, đợt phát hành…',
      selects: [
        { label: 'Trạng thái', get: dataVal('enabled'),
          options: [['', 'Tất cả'], ['1', 'Đang bật'], ['0', 'Đã tắt']] },
        { label: 'Lượt đổi', get: function (el) {
            var used = parseInt(el.dataset.used || '0', 10);
            var max = parseInt(el.dataset.max || '0', 10);
            return used < max ? 'left' : 'out';
          },
          options: [['', 'Tất cả'], ['left', 'Còn lượt'], ['out', 'Hết lượt']] },
      ],
    },
    appAccountList: { text: 'Tìm ID tài khoản, email…' },
    // Nhật ký đổi mã đã có tra cứu theo mã/tài khoản/kết quả ở phía
    // máy chủ (phía trên bảng) nên ở đây chỉ thêm tìm theo lý do.
    logList: { text: 'Tìm trong lý do…' },
    auditList: {
      text: 'Tìm người làm, đối tượng, lý do…',
      selects: [{ label: 'Việc', get: colVal(1), dynamic: true }],
    },
    auditFullList: {
      text: 'Tìm người làm, đối tượng, lý do…',
      selects: [{ label: 'Việc', get: colVal(1), dynamic: true }],
    },
    recentRedeemList: {
      text: 'Tìm mã, tài khoản…',
      selects: [{ label: 'Kết quả', get: colVal(2), dynamic: true }],
    },
    revenueMonthly: {
      text: 'Tìm tháng (VD: 2026-10)…',
      selects: [{ label: 'Tiền', get: colVal(1), dynamic: true }],
    },
    revenueByProduct: {
      text: 'Tìm sản phẩm…',
      selects: [{ label: 'Tiền', get: colVal(1), dynamic: true }],
    },
    revenueByStore: {
      text: 'Tìm kênh…',
      selects: [
        { label: 'Tiền', get: colVal(1), dynamic: true },
        { label: 'Loại kênh', get: function (el) {
            var c0 = colVal(0)(el);
            return c0.indexOf('Cửa hàng') === 0 ? 'store' :
              c0.indexOf('Quốc gia') === 0 ? 'country' : '';
          },
          options: [['', 'Tất cả'], ['store', 'Cửa hàng'], ['country', 'Quốc gia']] },
      ],
    },
    backupAccountList: {
      text: 'Tìm tài khoản…',
      selects: [
        { label: 'Gói', get: function (el) {
            return el.dataset.tier ? el.dataset.tier + ' MB' : '';
          }, dynamic: true },
        { label: 'Dung lượng', get: function (el) {
            var p = parseFloat(el.dataset.usedPct || '0');
            return p >= 95 ? 'full' : p >= 80 ? 'warn' : '';
          },
          options: [['', 'Tất cả'], ['warn', 'Sắp đầy (80–95%)'], ['full', 'Gần hết (≥95%)']] },
      ],
    },
    userList: {
      text: 'Tìm email…',
      selects: [
        { label: 'Vai trò', get: dataVal('role'),
          options: [['', 'Tất cả'], ['admin', 'Quản trị'], ['staff', 'Nhân viên'], ['viewer', 'Chỉ xem']] },
        { label: 'Trạng thái', get: dataVal('active'),
          options: [['', 'Tất cả'], ['1', 'Đang hoạt động'], ['0', 'Đã khoá']] },
      ],
    },
  };
  (function setupListTools() {
    var targets = document.querySelectorAll(
      '.list, #auditList, #recentRedeemList, #revenueMonthly, ' +
      '#revenueByProduct, #revenueByStore, #appAccountList, #logList, ' +
      '#auditFullList, #accountDetail, #storagePlanRows'
    );
    targets.forEach(function (target) {
      if (target.dataset.collapseSetup) return;
      // Khung thống kê kho chứa chỉ có 1 hàng — không cần công cụ lọc.
      if (target.id === 'backupStats') return;
      target.dataset.collapseSetup = '1';
      target.classList.add('scroll-list');
      var toolbar = document.createElement('div');
      toolbar.className = 'list-toolbar';
      var cfg = FILTERS[target.id] || null;
      var input = null;
      var selects = [];
      if (cfg) {
        input = document.createElement('input');
        input.type = 'text';
        input.className = 'list-filter';
        input.placeholder = cfg.text;
        input.setAttribute('aria-label', cfg.text);
        toolbar.appendChild(input);
        (cfg.selects || []).forEach(function (s) {
          var sel = document.createElement('select');
          sel.className = 'list-select';
          sel.setAttribute('aria-label', s.label);
          sel.dataset.dynamic = s.dynamic ? '1' : '';
          var first = document.createElement('option');
          first.value = '';
          first.textContent = s.label + ': Tất cả';
          sel.appendChild(first);
          (s.options || []).forEach(function (o) {
            var opt = document.createElement('option');
            opt.value = o[0];
            opt.textContent = o[1];
            sel.appendChild(opt);
          });
          selects.push({ el: sel, get: s.get, dynamic: !!s.dynamic });
          toolbar.appendChild(sel);
        });
      }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'list-toggle secondary small';
      btn.textContent = '▲';
      btn.setAttribute('aria-label', 'Thu gọn');
      btn.title = 'Thu gọn';
      btn.addEventListener('click', function () {
        var collapsed = target.classList.toggle('collapsed');
        btn.textContent = collapsed ? '▼' : '▲';
        btn.setAttribute('aria-label', collapsed ? 'Mở rộng' : 'Thu gọn');
        btn.title = collapsed ? 'Mở rộng' : 'Thu gọn';
      });
      toolbar.appendChild(btn);
      target.parentNode.insertBefore(toolbar, target);
      if (!cfg) return;
      var applyFilter = function () {
        // Select động: gom giá trị duy nhất từ các hàng đang hiện.
        selects.forEach(function (s) {
          if (!s.dynamic) return;
          var seen = {};
          var vals = [];
          var items0 = target.querySelectorAll(':scope > .row, tbody tr');
          items0.forEach(function (el) {
            var v = s.get(el);
            if (v && !seen[v]) { seen[v] = true; vals.push(v); }
          });
          var cur = s.el.value;
          while (s.el.options.length > 1) s.el.remove(1);
          vals.sort().forEach(function (v) {
            var opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            s.el.appendChild(opt);
          });
          s.el.value = vals.indexOf(cur) !== -1 ? cur : '';
        });
        var q = normFilter(input.value.trim());
        // Tìm kiếm chỉ trên nội dung dữ liệu, KHÔNG tìm trên chữ của
        // nút bấm (không thì gõ "khoá" sẽ ra mọi hàng vì hàng nào cũng
        // có nút Khoá/Sửa/Xem file). Bảng: bỏ ô chứa nút; thẻ .row:
        // chỉ lấy tiêu đề + mô tả, bỏ khối nút và danh sách con.
        var searchText = function (el) {
          if (el.tagName === 'TR') {
            var t = '';
            el.querySelectorAll('td').forEach(function (c) {
              if (!c.querySelector('button')) t += ' ' + c.textContent;
            });
            return t;
          }
          var parts = [];
          el.querySelectorAll(':scope > .title, :scope > .meta').forEach(function (c) {
            parts.push(c.textContent);
          });
          return parts.length ? parts.join(' ') : el.textContent;
        };
        var items = target.querySelectorAll(':scope > .row, tbody tr');
        items.forEach(function (el) {
          var ok = !q || normFilter(searchText(el)).indexOf(q) !== -1;
          if (ok) {
            for (var i = 0; i < selects.length; i++) {
              var v = selects[i].el.value;
              if (v && selects[i].get(el) !== v) { ok = false; break; }
            }
          }
          el.style.display = ok ? '' : 'none';
        });
      };
      input.addEventListener('input', applyFilter);
      selects.forEach(function (s) { s.el.addEventListener('change', applyFilter); });
      // Bảng tải lại (innerHTML thay mới) thì lọc lại + nạp lại
      // options động theo dữ liệu mới.
      if (window.MutationObserver) {
        new MutationObserver(applyFilter).observe(target, { childList: true, subtree: true });
      }
    });
  })();

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('vi-VN'); } catch (e) { return iso; }
  }

  function fmtDay(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
    } catch (e) { return iso; }
  }

  function fmtNum(n) {
    return (n == null ? 0 : n).toLocaleString('vi-VN');
  }

  function fmtMB(bytes) {
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function fmtMoney(amount, currency) {
    if (amount == null) return '—';
    try {
      return Number(amount).toLocaleString('vi-VN', { maximumFractionDigits: 2 }) +
        (currency ? ' ' + currency : '');
    } catch (e) { return String(amount); }
  }

  function isAdmin() { return currentUser && currentUser.role === 'admin'; }
  function canWritePromo() {
    return currentUser && (currentUser.role === 'admin' || currentUser.role === 'staff');
  }

  async function api(path, options) {
    var s = getSettings();
    if (!s.apiBase) throw new Error('Chưa nhập địa chỉ Worker (API).');
    options = options || {};
    var headers = { 'Content-Type': 'application/json' };
    var authed = !!s.session && !options.noAuth;
    if (authed) headers.Authorization = 'Bearer ' + s.session;
    var res = await fetch(s.apiBase + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body,
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok || !data || data.ok === false) {
      var msg = (data && (data.message || data.error)) || ('Lỗi HTTP ' + res.status);
      if (res.status === 401 && authed) {
        setSession(null);
        currentUser = null;
        showLogin('Phiên đã hết hạn, đăng nhập lại.');
      }
      var err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // --- Bảng dữ liệu ---
  // Phân trang: vẽ "Trước / Trang n trên tổng m / Sau" vào một div pager.
  // onPage(offsetMoi) là hàm tải lại trang đó; total/limit/offset lấy
  // từ chính phản hồi máy chủ (kèm total) nên không đoán số trang.
  function renderPager(pagerId, total, offset, limit, onPage) {
    var pager = $(pagerId);
    if (!pager) return;
    if (!total || total <= limit) { pager.innerHTML = ''; return; }
    var page = Math.floor(offset / limit) + 1;
    var pages = Math.ceil(total / limit);
    var shownFrom = offset + 1;
    var shownTo = Math.min(offset + limit, total);
    pager.innerHTML = '<button type="button" class="secondary small pager-prev"' +
      (offset <= 0 ? ' disabled' : '') + '>← Trước</button>' +
      '<span class="meta">Trang ' + page + '/' + pages +
      ' · Đang hiện ' + shownFrom + '–' + shownTo + ' / ' + total + '</span>' +
      '<button type="button" class="secondary small pager-next"' +
      (offset + limit >= total ? ' disabled' : '') + '>Sau →</button>';
    var prev = pager.querySelector('.pager-prev');
    var next = pager.querySelector('.pager-next');
    if (prev) prev.addEventListener('click', function () { onPage(Math.max(0, offset - limit)); });
    if (next) next.addEventListener('click', function () { onPage(offset + limit); });
  }

  function tableHTML(headers, rows, emptyText) {
    if (!rows.length) return '<p>' + esc(emptyText || 'Chưa có dữ liệu.') + '</p>';
    return '<div class="table-wrap"><table><thead><tr>' +
      headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  // --- Biểu đồ SVG (tự vẽ, không thư viện) ---
  function donutHTML(segments, total) {
    // segments: [{label, value, color}] — vòng tròn r=54, chu vi ~339.3.
    var C = 2 * Math.PI * 54;
    var offset = 0;
    var circles = '';
    segments.forEach(function (s) {
      var frac = total ? s.value / total : 0;
      var len = frac * C;
      if (len > 0) {
        circles += '<circle cx="70" cy="70" r="54" fill="none" stroke="' + s.color +
          '" stroke-width="22" stroke-dasharray="' + Math.max(len - 2, 0) + ' ' + (C - len + 2) +
          '" stroke-dashoffset="' + (-offset) + '" transform="rotate(-90 70 70)"></circle>';
      }
      offset += len;
    });
    var legend = segments.map(function (s) {
      return '<span><i style="background:' + s.color + '"></i>' + esc(s.label) +
        ': ' + fmtNum(s.value) + '</span>';
    }).join('');
    return '<svg viewBox="0 0 140 140" style="max-width:180px;margin:0 auto">' +
      '<circle cx="70" cy="70" r="54" fill="none" stroke="#e3def5" stroke-width="22"></circle>' +
      circles +
      '<text x="70" y="66" text-anchor="middle" font-size="24" font-weight="800" fill="#241254">' +
      fmtNum(total) + '</text>' +
      '<text x="70" y="86" text-anchor="middle" font-size="11" fill="#5b5570">tài khoản</text>' +
      '</svg><div class="legend">' + legend + '</div>';
  }

  function barsHTML(points, valueLabel) {
    // points: [{label, value}] — cột đứng, lưới ngang 0/50%/100%.
    if (!points.length) return '<p>Chưa có dữ liệu.</p>';
    var max = 0;
    points.forEach(function (p) { max = Math.max(max, p.value); });
    if (!max) max = 1;
    var W = 560, H = 190, PAD_L = 34, PAD_B = 26, PAD_T = 18;
    var plotW = W - PAD_L - 8, plotH = H - PAD_T - PAD_B;
    var slot = plotW / points.length;
    var bw = Math.max(Math.min(slot * 0.6, 26), 4);
    var grid = [0, 0.5, 1].map(function (f) {
      var y = PAD_T + plotH * (1 - f);
      return '<line x1="' + PAD_L + '" y1="' + y + '" x2="' + (W - 8) + '" y2="' + y +
        '" stroke="#e3def5" stroke-width="1"></line>' +
        '<text x="' + (PAD_L - 4) + '" y="' + (y + 4) + '" text-anchor="end" font-size="10" fill="#5b5570">' +
        fmtNum(Math.round(max * f)) + '</text>';
    }).join('');
    var bars = points.map(function (p, i) {
      var h = (p.value / max) * plotH;
      var x = PAD_L + i * slot + (slot - bw) / 2;
      var y = PAD_T + plotH - h;
      return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + h.toFixed(1) + '" rx="3" fill="#6d28d9"></rect>' +
        '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (y - 4).toFixed(1) +
        '" text-anchor="middle" font-size="10" font-weight="700" fill="#241254">' +
        (p.value ? fmtNum(p.value) : '') + '</text>' +
        '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 8) +
        '" text-anchor="middle" font-size="10" fill="#5b5570">' + esc(p.label) + '</text>';
    }).join('');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '">' + grid + bars + '</svg>' +
      (valueLabel ? '<p class="meta">' + esc(valueLabel) + '</p>' : '');
  }

  // --- Menu drawer + chuyển màn ---
  function openDrawer() {
    $('drawer').classList.add('open');
    $('drawerOverlay').classList.remove('hidden');
  }
  function closeDrawer() {
    $('drawer').classList.remove('open');
    $('drawerOverlay').classList.add('hidden');
  }
  $('menuBtn').addEventListener('click', openDrawer);
  $('drawerOverlay').addEventListener('click', closeDrawer);

  // --- Menu con của Cấu hình app ---
  // 'all' = hiện toàn bộ trang cấu hình tổng; còn lại chỉ hiện đúng nhóm
  // đó (các nhóm khác vẫn nằm trong form nên nút Lưu vẫn lưu toàn bộ).
  var CONFIG_GROUP_TITLES = {
    general: 'Cấu hình app · Chung',
    backup: 'Cấu hình app · Sao lưu & ảnh',
    plans: 'Cấu hình app · Gói lưu trữ',
  };
  function showConfigGroup(group) {
    document.querySelectorAll('.config-group').forEach(function (g) {
      g.classList.toggle('hidden', group !== 'all' && g.dataset.configGroup !== group);
    });
    document.querySelectorAll('#drawer button.sub').forEach(function (b) {
      b.classList.toggle('active', b.dataset.configGroup === group);
    });
    if (group !== 'all') {
      $('pageTitle').textContent = CONFIG_GROUP_TITLES[group] || 'Cấu hình app';
    }
  }

  function showTab(tab) {
    document.querySelectorAll('#drawer button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    document.querySelectorAll('main .view').forEach(function (t) { t.classList.add('hidden'); });
    $('tab-' + tab).classList.remove('hidden');
    $('pageTitle').textContent = PAGE_TITLES[tab] || 'Tổng quan';
    // Về lại trang Cấu hình app từ menu cha thì hiện toàn bộ trang.
    if (tab === 'config') showConfigGroup('all');
    closeDrawer();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  document.querySelectorAll('#drawer button').forEach(function (btn) {
    // Nút con dùng data-config-group, không dùng data-tab nên bỏ qua ở
    // đây — chúng có listener riêng bên dưới, tránh showTab(undefined).
    if (!btn.dataset.tab) return;
    btn.addEventListener('click', function () { showTab(btn.dataset.tab); });
  });
  document.querySelectorAll('#drawer button.sub').forEach(function (btn) {
    btn.addEventListener('click', function () {
      showTab('config');
      showConfigGroup(btn.dataset.configGroup);
    });
  });

  // --- Hiển thị theo trạng thái đăng nhập ---
  function hideAllAuth() {
    $('setupBox').classList.add('hidden');
    $('loginBox').classList.add('hidden');
  }

  function showSetup() {
    hideAllAuth();
    $('setupBox').classList.remove('hidden');
    $('shell').classList.add('hidden');
    $('authViews').classList.remove('hidden');
  }

  function showLogin(msg) {
    hideAllAuth();
    $('loginBox').classList.remove('hidden');
    $('shell').classList.add('hidden');
    $('authViews').classList.remove('hidden');
    if (msg) setStatus($('loginMsg'), msg, false);
  }

  function showApp(user) {
    currentUser = user;
    hideAllAuth();
    $('authViews').classList.add('hidden');
    $('shell').classList.remove('hidden');
    $('userBar').classList.remove('hidden');
    $('userInfo').textContent = user.email + ' · ' + (ROLE_LABELS[user.role] || user.role);
    $('drawerUserInfo').textContent = user.email + ' · ' + (ROLE_LABELS[user.role] || user.role);
    $('accountInfo').textContent = 'Đang đăng nhập: ' + user.email + ' · Vai trò: ' +
      (ROLE_LABELS[user.role] || user.role);
    // Phân quyền giao diện (server vẫn kiểm tra lại mọi thao tác).
    $('tabBtn-grant').style.display = isAdmin() ? '' : 'none';
    $('tabBtn-users').style.display = isAdmin() ? '' : 'none';
    $('createPromoWrap').style.display = canWritePromo() ? '' : 'none';
    $('configSave').style.display = isAdmin() ? '' : 'none';
    $('configReadOnly').classList.toggle('hidden', isAdmin());
    var activeBtn = document.querySelector('#drawer button.active');
    if (activeBtn && activeBtn.style.display === 'none') showTab('overview');
    loadStats();
    loadHealth();
    loadAudit('auditList', 30);
    loadRecentRedeems();
    loadRevenue();
    loadPromos();
    loadLog();
    loadConfig();
    loadConfigHistory();
    loadAppAccounts();
    loadBackups();
    loadBackupAccounts();
    loadAuditFull();
    if (isAdmin()) { loadUsers(); loadLoginLogs(); }
  }

  // --- Kết nối ---
  var savedBase = localStorage.getItem('ss_api_base');
  if (!savedBase) localStorage.setItem('ss_api_base', DEFAULT_API_BASE);
  $('apiBase').value = getSettings().apiBase;
  $('saveSettings').addEventListener('click', function () {
    localStorage.setItem('ss_api_base', $('apiBase').value.trim().replace(/\/$/, ''));
    setStatus($('connStatus'), 'Đã lưu kết nối.', true);
    boot();
  });

  // --- Tài khoản: setup / login / logout / đổi mật khẩu ---
  $('setupForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var f = ev.target;
    if (f.password.value !== f.password2.value) {
      setStatus($('setupMsg'), 'Lỗi: hai mật khẩu không khớp.', false); return;
    }
    try {
      var d = await api('/api/auth/setup', {
        method: 'POST', noAuth: true,
        body: JSON.stringify({
          setup_token: f.setup_token.value,
          email: f.email.value,
          password: f.password.value,
        }),
      });
      setSession(d.token);
      setStatus($('setupMsg'), 'Đã tạo tài khoản quản trị.', true);
      showApp(d.user);
    } catch (e) { setStatus($('setupMsg'), 'Lỗi: ' + e.message, false); }
  });

  $('loginForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var f = ev.target;
    try {
      var d = await api('/api/auth/login', {
        method: 'POST', noAuth: true,
        body: JSON.stringify({ email: f.email.value, password: f.password.value }),
      });
      setSession(d.token);
      setStatus($('loginMsg'), '', null);
      showApp(d.user);
    } catch (e) { setStatus($('loginMsg'), 'Lỗi: ' + e.message, false); }
  });

  $('logoutBtn').addEventListener('click', async function () {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* kệ */ }
    setSession(null);
    currentUser = null;
    showLogin();
  });

  $('changePwForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var f = ev.target;
    if (f.new_password.value !== f.new_password2.value) {
      setStatus($('changePwMsg'), 'Lỗi: hai mật khẩu mới không khớp.', false); return;
    }
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          current_password: f.current_password.value,
          new_password: f.new_password.value,
        }),
      });
      setStatus($('changePwMsg'), 'Đã đổi mật khẩu.', true);
      f.reset();
    } catch (e) { setStatus($('changePwMsg'), 'Lỗi: ' + e.message, false); }
  });

  // --- Tổng quan ---
  function kpiCard(accent, num, lbl) {
    return '<div class="kpi ' + accent + '"><div class="num">' + num + '</div>' +
      '<div class="lbl">' + esc(lbl) + '</div></div>';
  }

  async function loadStats() {
    var box = $('statGrid');
    box.innerHTML = '<p>Đang tải…</p>';
    try {
      var d = await api('/api/admin/stats');
      var cards = [
        kpiCard('a0', fmtNum(d.accounts.total), 'Tài khoản app'),
        kpiCard('a1', fmtNum(d.accounts.new_30d), 'Tài khoản mới (30 ngày)'),
        kpiCard('a2', fmtNum(d.accounts.by_plan.pro_paid), 'Pro trả phí'),
        kpiCard('a3', fmtNum(d.accounts.by_plan.pro_promo), 'Pro tặng'),
        kpiCard('a0', fmtNum(d.accounts.by_plan.free), 'Miễn phí'),
        kpiCard('a1', fmtNum(d.promos.enabled) + ' / ' + fmtNum(d.promos.total), 'Mã đang bật'),
        kpiCard('a2', fmtNum(d.redemptions.granted), 'Lượt đổi thành công (30 ngày: ' + fmtNum(d.redemptions.granted_30d) + ')'),
        kpiCard('a3', fmtNum(d.redemptions.rejected), 'Lượt đổi bị từ chối'),
        kpiCard('a0', fmtNum(d.backups.accounts), 'Tài khoản mây'),
        // Tách làm 2 thẻ riêng: trước đây gộp "3 · 2.7 MB" vào một thẻ
        // nên không biết 3 là gì, 2.7 MB là gì (ảnh người dùng gửi).
        kpiCard('a1', fmtNum(d.backups.files), 'File sao lưu'),
        kpiCard('a2', fmtMB(d.backups.bytes), 'Dung lượng sao lưu'),
        kpiCard('a2', fmtNum(d.admins.active) + ' / ' + fmtNum(d.admins.total), 'Quản trị viên'),
      ];
      box.innerHTML = cards.join('');
      $('planDonut').innerHTML = donutHTML([
        { label: 'Miễn phí', value: d.accounts.by_plan.free, color: '#6d28d9' },
        { label: 'Pro trả phí', value: d.accounts.by_plan.pro_paid, color: '#0d9488' },
        { label: 'Pro tặng', value: d.accounts.by_plan.pro_promo, color: '#ea580c' },
        { label: 'Pro (chung)', value: d.accounts.by_plan.pro, color: '#0284c7' },
      ], d.accounts.total);
      $('dailyChart').innerHTML = barsHTML(
        (d.redemptions.daily || []).map(function (x) {
          return { label: fmtDay(x.day), value: x.granted + x.rejected };
        }),
        'Cột = tổng lượt đổi trong ngày (thành công + bị từ chối).'
      );
    } catch (e) {
      box.innerHTML = '<p class="status bad">Lỗi: ' + esc(e.message) + '</p>';
      $('planDonut').innerHTML = '';
      $('dailyChart').innerHTML = '';
    }
  }
  $('reloadStats').addEventListener('click', function () {
    loadStats(); loadHealth(); loadAudit('auditList', 30); loadRecentRedeems();
  });

  // Trạng thái hệ thống: Worker / D1 / KV / R2, kiểm tra thật từng tầng.
  async function loadHealth() {
    var box = $('healthBox');
    if (!box) return;
    box.innerHTML = '<p>Đang kiểm tra…</p>';
    try {
      var d = await api('/api/admin/health');
      var c = d.checks || {};
      var mark = function (ok) { return ok ? '✓' : '✗'; };
      box.innerHTML = '<div class="meta">Worker ' + mark(c.worker) +
        ' · D1 ' + mark(c.d1) + ' · KV cấu hình ' + mark(c.kv) +
        ' · R2 kho chứa ' + mark(c.r2) +
        (c.d1 && c.kv && c.r2 ? ' — mọi tầng đều sống.' : ' — có tầng đang lỗi, xem chi tiết ở từng bảng.') +
        '</div>';
    } catch (e) {
      box.innerHTML = '<p class="status bad">Không kiểm tra được trạng thái: ' + esc(e.message) + '</p>';
    }
  }

  function auditRowCells(a) {
    var detail = null;
    try { detail = a.detail ? JSON.parse(a.detail) : null; } catch (e) { detail = null; }
    return [
      esc(fmtDate(a.at)),
      esc(ACTION_LABELS[a.action] || a.action),
      esc(a.target || '—'),
      esc(a.actor),
      esc(detail && detail.reason ? detail.reason : '—'),
    ];
  }

  var auditOffset = 0;
  async function loadAudit(boxId, limit, offset) {
    var box = $(boxId);
    box.innerHTML = '<p>Đang tải…</p>';
    try {
      var d = await api('/api/admin/audit?limit=' + limit + '&offset=' + (offset || 0));
      box.innerHTML = tableHTML(
        ['Thời gian', 'Việc', 'Đối tượng', 'Người làm', 'Lý do'],
        d.entries.map(auditRowCells),
        'Chưa có hoạt động nào.'
      );
      if (boxId === 'auditFullList') {
        renderPager('auditPager', d.total, d.offset, d.limit, function (next) {
          auditOffset = next; loadAudit('auditFullList', 100, auditOffset);
        });
      }
    } catch (e) { box.innerHTML = '<p class="status bad">Lỗi: ' + esc(e.message) + '</p>'; }
  }
  function loadAuditFull() { auditOffset = 0; loadAudit('auditFullList', 100, auditOffset); }
  $('reloadAudit').addEventListener('click', loadAuditFull);

  async function loadRecentRedeems() {
    var box = $('recentRedeemList');
    box.innerHTML = '<p>Đang tải…</p>';
    try {
      var d = await api('/api/promo/redemptions?limit=20');
      box.innerHTML = tableHTML(
        ['Thời gian', 'Mã', 'Kết quả', 'Tài khoản', 'Lý do'],
        d.redemptions.map(function (r) {
          return [esc(fmtDate(r.redeemed_at)), esc(r.code), esc(r.result), esc(r.account_id), esc(r.reason || '—')];
        }),
        'Chưa có lượt đổi nào.'
      );
    } catch (e) { box.innerHTML = '<p class="status bad">Lỗi: ' + esc(e.message) + '</p>'; }
  }

  // --- Doanh thu ---
  async function loadRevenue() {
    var sum = $('revenueSummary');
    sum.innerHTML = '<p>Đang tải…</p>';
    try {
      var d = await api('/api/admin/revenue');
      if (!d.totals.length && !d.monthly.length) {
        sum.innerHTML = '<p>Chưa có dữ liệu doanh thu. Số liệu xuất hiện khi ' +
          'webhook RevenueCat bắt đầu chảy về (cần nối RevenueCat; Play Store ' +
          'hiện đang tạm gác nên chưa có giao dịch thật).</p>';
        $('revenueChart').innerHTML = '';
        $('revenueMonthly').innerHTML = '';
        $('revenueByProduct').innerHTML = '';
        $('revenueByStore').innerHTML = '';
        return;
      }
      sum.innerHTML = d.totals.map(function (t, i) {
        return kpiCard('a' + (i % 4), esc(fmtMoney(t.gross, t.currency)),
          'Doanh thu gộp' + (t.currency ? ' (' + t.currency + ')' : '') +
          ' · Mới: ' + fmtNum(t.new_paid) + ' · Gia hạn: ' + fmtNum(t.renewals) +
          ' · Huỷ: ' + fmtNum(t.cancellations));
      }).join('');
      // Biểu đồ theo tháng: lấy loại tiền có tổng lớn nhất để khỏi trộn tiền.
      var byCurr = {};
      d.monthly.forEach(function (m) {
        byCurr[m.currency || ''] = (byCurr[m.currency || ''] || 0) + (m.gross || 0);
      });
      var mainCurr = Object.keys(byCurr).sort(function (a, b) { return byCurr[b] - byCurr[a]; })[0];
      var monthlyMain = d.monthly.filter(function (m) { return (m.currency || '') === mainCurr; })
        .slice().reverse();
      $('revenueChart').innerHTML = barsHTML(
        monthlyMain.map(function (m) { return { label: m.month.slice(5), value: Math.round(m.gross || 0) }; }),
        'Doanh thu gộp theo tháng (' + (mainCurr || '') + '). Bảng bên dưới có đủ các loại tiền.'
      );
      $('revenueMonthly').innerHTML = tableHTML(
        ['Tháng', 'Tiền', 'Doanh thu gộp', 'Mới', 'Gia hạn', 'Huỷ', 'Hết hạn'],
        d.monthly.map(function (m) {
          return [esc(m.month), esc(m.currency || '—'), esc(fmtMoney(m.gross, '')), fmtNum(m.new_paid),
            fmtNum(m.renewals), fmtNum(m.cancellations), fmtNum(m.expirations)];
        }),
        'Chưa có dữ liệu theo tháng.'
      );
      $('revenueByProduct').innerHTML = tableHTML(
        ['Sản phẩm', 'Tiền', 'Doanh thu gộp', 'Sự kiện'],
        d.by_product.map(function (p) {
          return [esc(p.product_id || '—'), esc(p.currency || '—'), esc(fmtMoney(p.gross, '')), fmtNum(p.events)];
        }),
        'Chưa có dữ liệu theo sản phẩm.'
      );
      var storeRows = d.by_store.map(function (p) {
        return [esc('Cửa hàng: ' + (p.store || '—')), esc(p.currency || '—'), esc(fmtMoney(p.gross, '')), fmtNum(p.events)];
      });
      var countryRows = d.by_country.map(function (p) {
        return [esc('Quốc gia: ' + p.country), esc(p.currency || '—'), esc(fmtMoney(p.gross, '')), fmtNum(p.events)];
      });
      $('revenueByStore').innerHTML = tableHTML(
        ['Kênh', 'Tiền', 'Doanh thu gộp', 'Sự kiện'],
        storeRows.concat(countryRows),
        'Chưa có dữ liệu theo cửa hàng.'
      ) + (countryRows.length ? '' :
        '<p class="hint">Chưa có dữ liệu theo quốc gia: webhook RevenueCat ' +
        'hiện không gửi quốc gia. Muốn có, xem thêm số liệu quốc gia trên ' +
        'Play Console (mục Thống kê) cho tới khi app gửi quốc gia lên.</p>');
    } catch (e) {
      sum.innerHTML = '<p class="status bad">Lỗi: ' + esc(e.message) + '</p>';
    }
  }
  $('reloadRevenue').addEventListener('click', loadRevenue);

  // --- Mã khuyến mãi ---
  async function loadPromos() {
    var box = $('promoList');
    box.innerHTML = '<p>Đang tải…</p>';
    try {
      var data = await api('/api/promo');
      if (!data.promos.length) { box.innerHTML = '<p>Chưa có mã nào.</p>'; return; }
      box.innerHTML = data.promos.map(function (p) {
        // data-* phục vụ tiêu chí lọc của bảng (không hiện ra ngoài):
        // trạng thái, lượt đã dùng/tối đa, đợt phát hành.
        return '<div class="row" data-code="' + esc(p.code) + '"' +
          ' data-enabled="' + (p.enabled ? '1' : '0') + '"' +
          ' data-used="' + p.used + '" data-max="' + p.max_uses + '"' +
          ' data-days="' + p.days + '"' +
          ' data-starts="' + esc(p.starts_at || '') + '"' +
          ' data-expires="' + esc(p.expires_at || '') + '"' +
          ' data-campaign="' + esc(p.campaign || '') + '">' +
          '<div class="title">' + esc(p.code) + '</div>' +
          '<div class="meta">Quyền lợi: ' + esc(p.entitlement) + ' · ' + p.days + ' ngày · ' +
          'Đã đổi: ' + p.used + '/' + p.max_uses +
          (p.campaign ? ' · Đợt: ' + esc(p.campaign) : '') +
          (p.expires_at ? ' · Hết hạn: ' + fmtDate(p.expires_at) : '') + '</div>' +
          '<div class="actions">' +
          (canWritePromo()
            ? '<button type="button" class="secondary toggle" data-enabled="' + (p.enabled ? 0 : 1) + '">' +
              (p.enabled ? 'Tắt mã' : 'Bật lại mã') + '</button>' +
              '<button type="button" class="secondary edit-promo">Sửa</button>'
            : '') +
          (isAdmin()
            ? '<button type="button" class="secondary delete-promo">Xoá</button>'
            : '') +
          '<button type="button" class="secondary view-redemptions">Xem lượt đổi</button>' +
          '</div><div class="sub-list"></div></div>';
      }).join('');
      box.querySelectorAll('.toggle').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var row = btn.closest('.row');
          var reason = window.prompt('Lý do ' + (btn.dataset.enabled === '1' ? 'bật' : 'tắt') + ' mã (bắt buộc):');
          if (!reason || !reason.trim()) return;
          try {
            await api('/api/promo/' + encodeURIComponent(row.dataset.code), {
              method: 'PATCH',
              body: JSON.stringify({ enabled: btn.dataset.enabled === '1', reason: reason.trim() }),
            });
            loadPromos();
          } catch (e) { alert('Lỗi: ' + e.message); }
        });
      });
      // Sửa mã: mở form sửa ngay trong dòng mã (số ngày, tổng lượt,
      // đợt, bắt đầu/hết hạn). Sửa ngày/lượt chỉ ảnh hưởng lượt đổi
      // sau đó, không đổi hạn của quyền đã cấp trước đó. Lượt tối đa
      // mới không được nhỏ hơn số lượt đã đổi (máy chủ kiểm tra lại).
      box.querySelectorAll('.edit-promo').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var row = btn.closest('.row');
          var sub = row.querySelector('.sub-list');
          var toLocal = function (iso) {
            if (!iso) return '';
            var d = new Date(iso);
            if (isNaN(d.getTime())) return '';
            var pad = function (n) { return (n < 10 ? '0' : '') + n; };
            return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
              'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
          };
          sub.innerHTML = '<form class="edit-promo-form">' +
            '<label>Số ngày hiệu lực <input name="days" type="number" min="1" value="' + row.dataset.days + '" required></label>' +
            '<label>Tổng lượt tối đa <input name="max_uses" type="number" min="0" value="' + row.dataset.max + '" required></label>' +
            '<label>Đợt phát hành <input name="campaign" value="' + esc(row.dataset.campaign) + '"></label>' +
            '<label>Bắt đầu <input name="starts_at" type="datetime-local" value="' + toLocal(row.dataset.starts) + '"></label>' +
            '<label>Hết hạn <input name="expires_at" type="datetime-local" value="' + toLocal(row.dataset.expires) + '"></label>' +
            '<label>Lý do sửa (bắt buộc) <input name="reason" required placeholder="VD: Tăng lượt cho đợt KOL"></label>' +
            '<button type="submit">Lưu sửa</button> ' +
            '<button type="button" class="secondary edit-cancel">Huỷ</button></form>';
          var form = sub.querySelector('.edit-promo-form');
          form.querySelector('.edit-cancel').addEventListener('click', function () { sub.innerHTML = ''; });
          form.addEventListener('submit', async function (ev) {
            ev.preventDefault();
            var f = ev.target;
            var toIso = function (v) { return v ? new Date(v).toISOString() : null; };
            try {
              await api('/api/promo/' + encodeURIComponent(row.dataset.code), {
                method: 'PATCH',
                body: JSON.stringify({
                  days: parseInt(f.days.value, 10),
                  max_uses: parseInt(f.max_uses.value, 10),
                  campaign: f.campaign.value.trim() || null,
                  starts_at: toIso(f.starts_at.value),
                  expires_at: toIso(f.expires_at.value),
                  reason: f.reason.value.trim(),
                }),
              });
              loadPromos();
            } catch (e) { alert('Lỗi: ' + e.message); }
          });
        });
      });
      // Xoá mã: chỉ admin. Lịch sử đổi mã cũ vẫn giữ (không có khoá
      // ngoại), mã đã xoá thì app không đổi được nữa.
      box.querySelectorAll('.delete-promo').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var row = btn.closest('.row');
          var reason = window.prompt('Xoá hẳn mã ' + row.dataset.code +
            ' (không khôi phục được; lịch sử đổi mã cũ vẫn giữ). Nhập lý do xoá (bắt buộc):');
          if (!reason || !reason.trim()) return;
          try {
            await api('/api/promo/' + encodeURIComponent(row.dataset.code), {
              method: 'DELETE', body: JSON.stringify({ reason: reason.trim() }),
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

  // --- Nhật ký đổi mã (có tra cứu) ---
  var logOffset = 0;
  async function loadLog() {
    var box = $('logList');
    box.innerHTML = '<p>Đang tải…</p>';
    try {
      var q = new URLSearchParams();
      if ($('logCode').value.trim()) q.set('code', $('logCode').value.trim());
      if ($('logAccount').value.trim()) q.set('account', $('logAccount').value.trim());
      if ($('logResult').value) q.set('result', $('logResult').value);
      q.set('limit', '100');
      q.set('offset', String(logOffset));
      var data = await api('/api/promo/redemptions?' + q.toString());
      box.innerHTML = tableHTML(
        ['Thời gian', 'Mã', 'Kết quả', 'Tài khoản', 'Lý do', 'Thao tác'],
        data.redemptions.map(function (r) {
          // Thu hồi từng lượt đổi (chỉ admin, chỉ dòng đã cấp thành công
          // và chưa thu hồi): nút hỏi lý do rồi gọi route thu hồi riêng.
          var action = '—';
          if (r.revoked_at) action = 'Đã thu hồi' + (r.revoked_reason ? ' (' + esc(r.revoked_reason) + ')' : '');
          else if (r.result === 'granted' && isAdmin()) {
            action = '<button type="button" class="secondary small redemption-revoke" data-id="' + r.id + '">Thu hồi</button>';
          }
          return [esc(fmtDate(r.redeemed_at)), esc(r.code), esc(r.result), esc(r.account_id), esc(r.reason || '—'), action];
        }),
        'Không tìm thấy lượt đổi nào khớp điều kiện.'
      );
      renderPager('logPager', data.total, data.offset, data.limit, function (next) {
        logOffset = next; loadLog();
      });
    } catch (e) { box.innerHTML = '<p class="status bad">Lỗi: ' + esc(e.message) + '</p>'; }
  }
  $('logSearchBtn').addEventListener('click', function () { logOffset = 0; loadLog(); });
  // Thu hồi từng lượt đổi từ nhật ký (uỷ quyền click vì bảng tải lại sau
  // mỗi lần tra cứu; lý do hỏi bằng prompt như các nút Xoá/Khoá khác).
  $('logList').addEventListener('click', async function (ev) {
    var btn = ev.target.closest('.redemption-revoke');
    if (!btn) return;
    var reason = window.prompt('Lý do thu hồi lượt đổi này (bắt buộc, ghi vào kiểm toán):');
    if (reason === null) return;
    reason = reason.trim();
    if (!reason) { setStatus($('logMsg'), 'Thu hồi cần có lý do.', false); return; }
    try {
      var d = await api('/api/admin/redemptions/' + btn.dataset.id + '/revoke', {
        method: 'POST',
        body: JSON.stringify({ reason: reason }),
      });
      setStatus($('logMsg'), 'Đã thu hồi lượt đổi mã ' + d.code +
        (d.entitlement_cut
          ? ' và cắt quyền Pro tặng của tài khoản.'
          : ' (giữ nguyên Pro hiện tại của tài khoản vì quyền đó không từ lượt này).'), true);
      loadLog();
    } catch (e) { setStatus($('logMsg'), 'Lỗi: ' + e.message, false); }
  });

  // --- Tài khoản app ---
  var appAccountOffset = 0;
  async function loadAppAccounts() {
    var box = $('appAccountList');
    box.innerHTML = '<p>Đang tải…</p>';
    try {
      var plan = $('planFilter').value;
      var d = await api('/api/admin/accounts?limit=100&offset=' + appAccountOffset +
        (plan ? '&plan=' + plan : ''));
      box.innerHTML = tableHTML(
        ['Tài khoản', 'Gói', 'Dung lượng sao lưu', 'Email', 'Tặng tới', 'Trả phí tới', 'Cập nhật', 'Khoá', 'Thao tác'],
        d.accounts.map(function (a) {
          var actions = '';
          if (isAdmin()) {
            actions = a.blocked
              ? '<button type="button" class="secondary small acct-unblock" data-id="' + esc(a.revenuecat_app_user_id) + '">Mở khoá</button> '
              : '<button type="button" class="secondary small acct-block" data-id="' + esc(a.revenuecat_app_user_id) + '">Khoá</button> ';
            actions += '<button type="button" class="secondary small acct-delete" data-id="' + esc(a.revenuecat_app_user_id) + '">Xoá</button>';
          }
          // Dung lượng nối từ tài khoản sao lưu (cần app mới gửi liên
          // kết; chưa nối thì hiện "Chưa nối" thay vì bịa số 0).
          // Ngưỡng cảnh báo khớp cách máy chủ tính hạn mức (MB = 10^6).
          var usage = 'Chưa nối';
          if (a.backup_account_id) {
            var pct = a.backup_tier_mb ? (a.backup_bytes / (a.backup_tier_mb * 1000000)) * 100 : 0;
            usage = (a.backup_bytes / 1048576).toFixed(1) + ' / ' + a.backup_tier_mb + ' MB' +
              (pct >= 95 ? ' · Gần hết (' + pct.toFixed(0) + '%)' :
                pct >= 80 ? ' · Sắp đầy (' + pct.toFixed(0) + '%)' : '');
          }
          return [esc(a.revenuecat_app_user_id), esc(PLAN_LABELS[a.plan_status] || a.plan_status),
            usage,
            esc(a.email || '—'), esc(a.promo_until ? fmtDate(a.promo_until) : '—'),
            esc(a.paid_until ? fmtDate(a.paid_until) : '—'), esc(fmtDate(a.updated_at)),
            a.blocked ? 'ĐÃ KHOÁ' + (a.blocked_reason ? ' (' + esc(a.blocked_reason) + ')' : '') : '—',
            actions || '—'];
        }),
        'Chưa có tài khoản app nào.'
      );
      renderPager('appAccountPager', d.total, d.offset, d.limit, function (next) {
        appAccountOffset = next; loadAppAccounts();
      });
      // Khoá: tài khoản bị khoá thì đổi mã bị từ chối, kiểm tra gói về
      // free, cấp thủ công bị từ chối — gói gốc giữ nguyên nên mở khoá
      // là khôi phục. Xoá: chỉ xoá dòng tài khoản, KHÔNG chặn được
      // (tài khoản xoá vẫn đổi mã lại được) — muốn chặn thì dùng Khoá.
      box.querySelectorAll('.acct-block').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var reason = window.prompt('Lý do khoá tài khoản ' + btn.dataset.id + ' (bắt buộc):');
          if (!reason || !reason.trim()) return;
          try {
            await api('/api/admin/accounts/' + encodeURIComponent(btn.dataset.id) + '/block', {
              method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
            });
            loadAppAccounts();
          } catch (e) { alert('Lỗi: ' + e.message); }
        });
      });
      box.querySelectorAll('.acct-unblock').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          try {
            await api('/api/admin/accounts/' + encodeURIComponent(btn.dataset.id) + '/unblock', {
              method: 'POST', body: JSON.stringify({}),
            });
            loadAppAccounts();
          } catch (e) { alert('Lỗi: ' + e.message); }
        });
      });
      box.querySelectorAll('.acct-delete').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var reason = window.prompt('Xoá hẳn tài khoản ' + btn.dataset.id +
            ' (không khôi phục được; muốn CHẶN thì dùng Khoá thay vì Xoá). Nhập lý do xoá (bắt buộc):');
          if (!reason || !reason.trim()) return;
          try {
            await api('/api/admin/accounts/' + encodeURIComponent(btn.dataset.id), {
              method: 'DELETE', body: JSON.stringify({ reason: reason.trim() }),
            });
            loadAppAccounts();
          } catch (e) { alert('Lỗi: ' + e.message); }
        });
      });
    } catch (e) { box.innerHTML = '<p class="status bad">Lỗi: ' + esc(e.message) + '</p>'; }
  }
  $('reloadAppAccounts').addEventListener('click', function () { appAccountOffset = 0; loadAppAccounts(); });
  $('planFilter').addEventListener('change', function () { appAccountOffset = 0; loadAppAccounts(); });

  async function loadAccountDetail() {
    var box = $('accountDetail');
    var q = $('accountSearch').value.trim();
    if (!q) { box.innerHTML = '<p class="status bad">Nhập ID tài khoản hoặc email cần tra cứu.</p>'; return; }
    box.innerHTML = '<p>Đang tải…</p>';
    try {
      var d = await api('/api/admin/accounts/' + encodeURIComponent(q));
      var a = d.account;
      box.innerHTML = '<div class="row"><div class="title">' + esc(a.revenuecat_app_user_id) + '</div>' +
        '<div class="meta">Gói: ' + esc(PLAN_LABELS[a.plan_status] || a.plan_status) +
        (a.email ? ' · Email: ' + esc(a.email) : '') +
        (a.promo_until ? ' · Tặng tới: ' + fmtDate(a.promo_until) : '') +
        (a.paid_until ? ' · Trả phí tới: ' + fmtDate(a.paid_until) : '') +
        ' · Tạo: ' + fmtDate(a.created_at) + ' · Cập nhật: ' + fmtDate(a.updated_at) +
        (a.blocked ? ' · ĐÃ KHOÁ' + (a.blocked_reason ? ' (' + esc(a.blocked_reason) + ')' : '') : '') +
        (a.backup
          ? ' · Sao lưu: ' + (a.backup.backup_bytes / 1048576).toFixed(1) + ' / ' + a.backup.backup_tier_mb +
            ' MB (' + a.backup.backup_files + ' file)'
          : ' · Sao lưu: chưa nối tài khoản sao lưu') + '</div>' +
        '<div class="actions">' +
        (isAdmin()
          ? '<button type="button" class="secondary goto-grant" data-mode="grant">Cấp quyền lợi</button>' +
            '<button type="button" class="secondary goto-grant" data-mode="revoke">Thu hồi quyền lợi</button>'
          : '') +
        '</div></div>' +
        '<h3>Lượt đổi mã của tài khoản này</h3>' +
        tableHTML(
          ['Thời gian', 'Mã', 'Kết quả', 'Lý do'],
          d.redemptions.map(function (r) {
            return [esc(fmtDate(r.redeemed_at)), esc(r.code), esc(r.result), esc(r.reason || '—')];
          }),
          'Chưa có lượt đổi nào.'
        );
      box.querySelectorAll('.goto-grant').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var form = btn.dataset.mode === 'grant' ? $('grantForm') : $('revokeForm');
          form.account_id.value = a.revenuecat_app_user_id;
          showTab('grant');
          form.reason.focus();
        });
      });
    } catch (e) { box.innerHTML = '<p class="status bad">Lỗi: ' + esc(e.message) + '</p>'; }
  }
  $('accountSearchBtn').addEventListener('click', loadAccountDetail);
  $('accountSearch').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); loadAccountDetail(); }
  });

  // --- Cấp / thu hồi thủ công (chỉ admin, lý do bắt buộc) ---
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
          reason: f.reason.value,
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
          reason: f.reason.value,
        }),
      });
      setStatus($('revokeMsg'), 'Đã thu hồi quyền lợi tặng.', true);
    } catch (e) { setStatus($('revokeMsg'), 'Lỗi: ' + e.message, false); }
  });

  // --- Bảng gói lưu trữ (cờ storage_plans) ---
  var DEFAULT_STORAGE_PLANS = [
    { size_mb: 100, price_vnd: 299000 },
    { size_mb: 200, price_vnd: 349000 },
    { size_mb: 500, price_vnd: 449000 },
    { size_mb: 1000, price_vnd: 599000 },
  ];
  var storagePlansCache = null;

  async function loadStoragePlans() {
    if (storagePlansCache) return storagePlansCache;
    try {
      var data = await api('/api/config', { noAuth: true });
      var plans = Array.isArray(data.flags.storage_plans) ? data.flags.storage_plans : [];
      storagePlansCache = plans.length ? plans : DEFAULT_STORAGE_PLANS;
    } catch (e) {
      storagePlansCache = DEFAULT_STORAGE_PLANS;
    }
    return storagePlansCache;
  }

  function planLabel(p) {
    var size = p.size_mb >= 1000 ? (p.size_mb / 1000) + ' GB' : p.size_mb + ' MB';
    return size + ' · ' + fmtNum(p.price_vnd) + 'đ/năm';
  }

  function renderStoragePlanRows(plans) {
    var box = $('storagePlanRows');
    box.innerHTML = '';
    plans.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'filters plan-row';
      row.innerHTML =
        '<input class="plan-size" type="number" min="1" placeholder="Dung lượng (MB)" value="' + p.size_mb + '">' +
        '<input class="plan-price" type="number" min="0" placeholder="Giá/năm (VNĐ)" value="' + p.price_vnd + '">' +
        '<button type="button" class="secondary small remove-plan">Xoá</button>';
      row.querySelector('.remove-plan').addEventListener('click', function () { row.remove(); });
      box.appendChild(row);
    });
  }

  function collectStoragePlans() {
    var rows = document.querySelectorAll('#storagePlanRows .plan-row');
    var plans = [];
    var seen = {};
    for (var i = 0; i < rows.length; i++) {
      var size = parseInt(rows[i].querySelector('.plan-size').value, 10);
      var price = parseInt(rows[i].querySelector('.plan-price').value, 10);
      if (!Number.isInteger(size) || size < 1) return { error: 'Dung lượng gói phải là số nguyên ≥ 1.' };
      if (!Number.isInteger(price) || price < 0) return { error: 'Giá gói phải là số nguyên ≥ 0.' };
      if (seen[size]) return { error: 'Dung lượng các gói không được trùng nhau.' };
      seen[size] = true;
      plans.push({ size_mb: size, price_vnd: price });
    }
    if (!plans.length) return { error: 'Cần ít nhất một gói lưu trữ.' };
    plans.sort(function (a, b) { return a.size_mb - b.size_mb; });
    return { plans: plans };
  }

  $('addStoragePlan').addEventListener('click', function () {
    var box = $('storagePlanRows');
    var row = document.createElement('div');
    row.className = 'filters plan-row';
    row.innerHTML =
      '<input class="plan-size" type="number" min="1" placeholder="Dung lượng (MB)">' +
      '<input class="plan-price" type="number" min="0" placeholder="Giá/năm (VNĐ)">' +
      '<button type="button" class="secondary small remove-plan">Xoá</button>';
    row.querySelector('.remove-plan').addEventListener('click', function () { row.remove(); });
    box.appendChild(row);
  });

  // --- Cờ cấu hình ---
  // Bản ghi đè giới hạn gói đã nạp từ máy chủ — giữ nguyên để khi lưu,
  // các khoá không có ô nhập riêng (nếu từng có) không bị mất.
  var currentOverride = {};
  async function loadConfig() {
    try {
      var data = await api('/api/config', { noAuth: true });
      var f = $('configForm');
      f.self_promo_enabled.checked = !!data.flags.self_promo_enabled;
      f.min_version.value = data.flags.min_version || '';
      f.maintenance_notice.value = data.flags.maintenance_notice || '';
      currentOverride = data.flags.plan_limits_override || {};
      f.limit_maxActiveItems.value = currentOverride.maxActiveItems ?? '';
      f.limit_maxLocations.value = currentOverride.maxLocations ?? '';
      f.limit_maxItemPhotos.value = currentOverride.maxItemPhotos ?? '';
      f.limit_maxScenePhotos.value = currentOverride.maxScenePhotos ?? '';
      f.limit_allowQrPrintPdf.value = currentOverride.allowQrPrintPdf === true ? 'true' :
        currentOverride.allowQrPrintPdf === false ? 'false' : '';
      // Cờ vận hành sao lưu & ảnh — Worker cũ chưa có thì dùng mặc định.
      // Công tắc khoá/mở (v84): cờ vắng = tắt (khớp mặc định false của Worker).
      f.cloud_backup_enabled.checked = !!data.flags.cloud_backup_enabled;
      f.drive_backup_enabled.checked = !!data.flags.drive_backup_enabled;
      f.drive_keep_backups.value = data.flags.drive_keep_backups ?? 5;
      f.cloud_keep_backups.value = data.flags.cloud_keep_backups ?? 2;
      f.backup_compress_enabled.checked = data.flags.backup_compress_enabled !== false;
      f.backup_max_edge.value = data.flags.backup_max_edge ?? 1024;
      f.backup_quality.value = data.flags.backup_quality ?? 0.7;
      f.photo_max_edge.value = data.flags.photo_max_edge ?? 1280;
      f.photo_quality.value = data.flags.photo_quality ?? 0.75;
      renderStoragePlanRows(
        Array.isArray(data.flags.storage_plans) && data.flags.storage_plans.length
          ? data.flags.storage_plans
          : DEFAULT_STORAGE_PLANS
      );
    } catch (e) { setStatus($('configMsg'), 'Lỗi tải cấu hình: ' + e.message, false); }
  }
  $('configForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var f = ev.target;
    // Ô số để trống = không gửi khoá đó (giữ giá trị cũ trên máy chủ).
    var num = function (v) {
      var n = parseFloat(v);
      return Number.isNaN(n) ? undefined : n;
    };
    // Ghi đè giới hạn gói từ 4 ô số — không còn nhập JSON. Ô trống thì
    // xoá khoá đó khỏi bản ghi đè (về mặc định của gói); các khoá khác
    // trong bản ghi đè cũ được giữ nguyên. Tất cả trống = xoá hết ghi đè.
    var override = Object.assign({}, currentOverride);
    var limitFields = [
      ['maxActiveItems', 'limit_maxActiveItems'],
      ['maxLocations', 'limit_maxLocations'],
      ['maxItemPhotos', 'limit_maxItemPhotos'],
      ['maxScenePhotos', 'limit_maxScenePhotos'],
    ];
    for (var i = 0; i < limitFields.length; i++) {
      var n = num(f[limitFields[i][1]].value);
      if (n === undefined) { delete override[limitFields[i][0]]; continue; }
      if (n < 1) {
        setStatus($('configMsg'), 'Lỗi: số giới hạn gói phải từ 1 trở lên.', false);
        return;
      }
      override[limitFields[i][0]] = Math.round(n);
    }
    // Ghi đè cờ in nhãn QR: chọn trống = xoá ghi đè (về mặc định gói).
    if (f.limit_allowQrPrintPdf.value === '') delete override.allowQrPrintPdf;
    else override.allowQrPrintPdf = f.limit_allowQrPrintPdf.value === 'true';
    if (!Object.keys(override).length) override = null;
    var body = {
      self_promo_enabled: f.self_promo_enabled.checked,
      min_version: f.min_version.value || null,
      maintenance_notice: f.maintenance_notice.value || null,
      plan_limits_override: override,
      backup_compress_enabled: f.backup_compress_enabled.checked,
      cloud_backup_enabled: f.cloud_backup_enabled.checked,
      drive_backup_enabled: f.drive_backup_enabled.checked,
      reason: f.reason.value,
    };
    var dk = num(f.drive_keep_backups.value);
    if (dk !== undefined) body.drive_keep_backups = Math.round(dk);
    var ck = num(f.cloud_keep_backups.value);
    if (ck !== undefined) body.cloud_keep_backups = Math.round(ck);
    var be = num(f.backup_max_edge.value);
    if (be !== undefined) body.backup_max_edge = Math.round(be);
    var bq = num(f.backup_quality.value);
    if (bq !== undefined) body.backup_quality = bq;
    var pe = num(f.photo_max_edge.value);
    if (pe !== undefined) body.photo_max_edge = Math.round(pe);
    var pq = num(f.photo_quality.value);
    if (pq !== undefined) body.photo_quality = pq;
    var sp = collectStoragePlans();
    if (sp.error) { setStatus($('configMsg'), 'Lỗi: ' + sp.error, false); return; }
    body.storage_plans = sp.plans;
    try {
      await api('/api/config', { method: 'PUT', body: JSON.stringify(body) });
      setStatus($('configMsg'), 'Đã lưu cấu hình.', true);
      showPopup('Đã lưu cấu hình', 'Cấu hình app đã được lưu thành công và ghi vào nhật ký kiểm toán.');
      loadConfigHistory();
    } catch (e) { setStatus($('configMsg'), 'Lỗi: ' + e.message, false); }
  });

  // Lịch sử cấu hình: mỗi lần lưu là một bản snapshot, bấm Khôi phục
  // để quay lại đúng bộ cờ của bản đó (cần lý do, chỉ admin).
  async function loadConfigHistory() {
    var box = $('configHistoryList');
    if (!box) return;
    box.innerHTML = '<p>Đang tải…</p>';
    try {
      var d = await api('/api/admin/config/history');
      if (!d.history.length) { box.innerHTML = '<p>Chưa có bản lịch sử nào (lịch sử bắt đầu từ lần lưu tiếp theo).</p>'; return; }
      box.innerHTML = d.history.map(function (h) {
        return '<div class="row"><div class="title">Bản #' + h.id + ' · ' + fmtDate(h.created_at) + '</div>' +
          '<div class="meta">' + esc(h.actor || '—') + (h.reason ? ' · ' + esc(h.reason) : '') + '</div>' +
          '<div class="actions">' +
          (isAdmin() ? '<button type="button" class="secondary restore-config" data-id="' + h.id + '">Khôi phục bản này</button>' : '') +
          '</div></div>';
      }).join('');
      box.querySelectorAll('.restore-config').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var reason = window.prompt('Lý do khôi phục về bản #' + btn.dataset.id + ' (bắt buộc, ghi vào kiểm toán):');
          if (!reason || !reason.trim()) return;
          try {
            await api('/api/admin/config/restore', {
              method: 'POST',
              body: JSON.stringify({ id: parseInt(btn.dataset.id, 10), reason: reason.trim() }),
            });
            setStatus($('configHistoryMsg'), 'Đã khôi phục về bản #' + btn.dataset.id + '.', true);
            loadConfig();
            loadConfigHistory();
          } catch (e) { setStatus($('configHistoryMsg'), 'Lỗi: ' + e.message, false); }
        });
      });
    } catch (e) { box.innerHTML = '<p class="status bad">Lỗi: ' + esc(e.message) + '</p>'; }
  }

  // --- Sao lưu ---
  async function loadBackups() {
    var box = $('backupStats');
    box.innerHTML = '<p>Đang tải…</p>';
    try {
      var data = await api('/api/backups/usage');
      box.innerHTML = '<div class="row"><div class="title">Kho chứa: ' + esc(data.storage) + '</div>' +
        '<div class="meta">Số file: ' + data.files + ' · Tổng dung lượng: ' +
        fmtMB(data.bytes) + '</div></div>';
    } catch (e) { box.innerHTML = '<p class="status bad">Lỗi: ' + esc(e.message) + '</p>'; }
  }

  async function loadBackupAccounts() {
    var box = $('backupAccountList');
    box.innerHTML = '<p>Đang tải…</p>';
    try {
      var plans = await loadStoragePlans();
      var d = await api('/api/admin/backups/accounts');
      box.innerHTML = d.accounts.length
        ? d.accounts.map(function (a) {
            var usedMB = (a.bytes / 1048576).toFixed(1);
            var tierOpts = plans.map(function (p) {
              return '<option value="' + p.size_mb + '"' + (a.tier_mb === p.size_mb ? ' selected' : '') + '>' +
                esc(planLabel(p)) + '</option>';
            }).join('');
            // Cảnh báo dung lượng theo đúng hạn mức máy chủ (MB = 10^6):
            // >= 80% "Sắp đầy", >= 95% "Gần hết". data-used-pct phục vụ
            // select lọc "Sắp đầy / Gần hết" của bảng này.
            var pct = a.tier_mb ? (a.bytes / (a.tier_mb * 1000000)) * 100 : 0;
            var warn = pct >= 95 ? ' · Gần hết (' + pct.toFixed(0) + '%)' :
              pct >= 80 ? ' · Sắp đầy (' + pct.toFixed(0) + '%)' : '';
            return '<div class="row" data-id="' + esc(a.account_id) + '" data-tier="' + a.tier_mb + '"' +
              ' data-used-pct="' + pct.toFixed(1) + '">' +
              '<div class="title">' + esc(a.account_id) + '</div>' +
              '<div class="meta">Đã dùng: ' + usedMB + ' / ' + a.tier_mb + ' MB' + warn +
              ' · Số file: ' + a.files +
              (a.owner_email
                ? ' · Chủ: ' + esc(a.owner_email) + ' (' + esc(PLAN_LABELS[a.owner_plan] || a.owner_plan || '') + ')'
                : ' · Chưa nối tài khoản app') +
              ' · Cập nhật: ' + fmtDate(a.updated_at) + '</div>' +
              '<div class="actions">' +
              '<button type="button" class="secondary view-files">Xem file</button> ' +
              (isAdmin()
                ? '<label>Gói <select class="tier-select">' + tierOpts + '</select></label>'
                : '<span class="meta">Gói: ' + a.tier_mb + ' MB</span>') +
              '</div><div class="sub-list"></div></div>';
          }).join('')
        : '<p>Chưa có tài khoản sao lưu nào.</p>';
      box.querySelectorAll('.row').forEach(function (row) {
        var viewBtn = row.querySelector('.view-files');
        if (viewBtn) {
          viewBtn.addEventListener('click', async function () {
            var sub = row.querySelector('.sub-list');
            try {
              var d = await api('/api/admin/backups/accounts/' + encodeURIComponent(row.dataset.id) + '/files');
              sub.innerHTML = d.files.length
                ? d.files.map(function (f) {
                    return '<div class="meta">' + esc(f.file_name) + ' · ' +
                      (f.size_bytes / 1048576).toFixed(1) + ' MB · ' + fmtDate(f.updated_at) + '</div>';
                  }).join('')
                : '<div class="meta">Chưa có file sao lưu nào (chỉ có metadata — nội dung file không hiện ở đây).</div>';
            } catch (e) { sub.innerHTML = '<div class="meta">Lỗi: ' + esc(e.message) + '</div>'; }
          });
        }
        var sel = row.querySelector('.tier-select');
        if (!sel) return;
        sel.addEventListener('change', async function (ev) {
          try {
            await api('/api/admin/backups/accounts/' + encodeURIComponent(row.dataset.id), {
              method: 'PATCH',
              body: JSON.stringify({ tier_mb: parseInt(ev.target.value, 10) }),
            });
            loadBackupAccounts();
          } catch (e) { alert('Lỗi: ' + e.message); loadBackupAccounts(); }
        });
      });
    } catch (e) { box.innerHTML = '<p class="status bad">Lỗi: ' + esc(e.message) + '</p>'; }
  }
  $('reloadBackups').addEventListener('click', function () {
    loadBackups(); loadBackupAccounts();
  });

  // --- Người dùng quản trị (chỉ admin) ---
  async function loadUsers() {
    var box = $('userList');
    box.innerHTML = '<p>Đang tải…</p>';
    try {
      var data = await api('/api/admin/users');
      if (!data.users.length) { box.innerHTML = '<p>Chưa có người dùng nào.</p>'; return; }
      box.innerHTML = data.users.map(function (u) {
        var roleOpts = ['admin', 'staff', 'viewer'].map(function (r) {
          return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' +
            (ROLE_LABELS[r] || r) + '</option>';
        }).join('');
        return '<div class="row" data-id="' + esc(u.id) + '"' +
          ' data-role="' + esc(u.role) + '" data-active="' + (u.active ? '1' : '0') + '">' +
          '<div class="title">' + esc(u.email) + (u.active ? '' : ' · ĐÃ KHOÁ') + '</div>' +
          '<div class="meta">Vai trò: ' + (ROLE_LABELS[u.role] || u.role) +
          ' · Tạo: ' + fmtDate(u.created_at) +
          ' · Đăng nhập gần nhất: ' + fmtDate(u.last_login_at) + '</div>' +
          '<div class="actions">' +
          '<label>Vai trò <select class="role-select">' + roleOpts + '</select></label> ' +
          '<button type="button" class="secondary toggle-active">' +
          (u.active ? 'Khoá' : 'Mở khoá') + '</button> ' +
          '<button type="button" class="secondary reset-pw">Đặt lại mật khẩu</button> ' +
          '<button type="button" class="secondary delete-user">Xoá</button>' +
          '</div></div>';
      }).join('');
      box.querySelectorAll('.row').forEach(function (row) {
        var id = row.dataset.id;
        row.querySelector('.role-select').addEventListener('change', async function (ev) {
          try {
            await api('/api/admin/users/' + encodeURIComponent(id), {
              method: 'PATCH',
              body: JSON.stringify({ role: ev.target.value }),
            });
            loadUsers();
          } catch (e) { alert('Lỗi: ' + e.message); loadUsers(); }
        });
        row.querySelector('.toggle-active').addEventListener('click', async function (ev) {
          var active = ev.target.textContent.trim() === 'Khoá' ? false : true;
          try {
            await api('/api/admin/users/' + encodeURIComponent(id), {
              method: 'PATCH',
              body: JSON.stringify({ active: active }),
            });
            loadUsers();
          } catch (e) { alert('Lỗi: ' + e.message); }
        });
        row.querySelector('.reset-pw').addEventListener('click', async function () {
          var pw = window.prompt('Mật khẩu mới cho tài khoản này (tối thiểu 8 ký tự):');
          if (!pw) return;
          try {
            await api('/api/admin/users/' + encodeURIComponent(id) + '/reset-password', {
              method: 'POST',
              body: JSON.stringify({ password: pw }),
            });
            alert('Đã đặt lại mật khẩu (mọi phiên của tài khoản này đã bị thu hồi).');
          } catch (e) { alert('Lỗi: ' + e.message); }
        });
        row.querySelector('.delete-user').addEventListener('click', async function () {
          if (!window.confirm('Xoá hẳn tài khoản này? Hành động này không hoàn tác được.')) return;
          try {
            await api('/api/admin/users/' + encodeURIComponent(id), { method: 'DELETE' });
            loadUsers();
          } catch (e) { alert('Lỗi: ' + e.message); }
        });
      });
    } catch (e) { box.innerHTML = '<p class="status bad">Lỗi: ' + esc(e.message) + '</p>'; }
  }
  $('reloadUsers').addEventListener('click', function () { loadUsers(); loadLoginLogs(); });

  // Lịch sử đăng nhập quản trị (chỉ admin — có IP nên server chặn
  // viewer/staff). Tổng hợp theo email + từng lượt, có phân trang.
  var loginLogOffset = 0;
  async function loadLoginLogs() {
    var wrap = $('loginLogWrap');
    if (!wrap) return;
    if (!isAdmin()) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var box = $('loginLogList');
    box.innerHTML = '<p>Đang tải…</p>';
    try {
      var q = new URLSearchParams();
      if ($('loginLogEmail').value.trim()) q.set('email', $('loginLogEmail').value.trim());
      if ($('loginLogResult').value) q.set('success', $('loginLogResult').value);
      q.set('limit', '100');
      q.set('offset', String(loginLogOffset));
      var d = await api('/api/admin/login-logs?' + q.toString());
      $('loginLogSummary').innerHTML = tableHTML(
        ['Email', 'Thành công', 'Thất bại', 'Gần nhất'],
        (d.summary || []).map(function (s) {
          return [esc(s.email), fmtNum(s.ok_count), fmtNum(s.fail_count), esc(fmtDate(s.last_at))];
        }),
        'Chưa có lượt đăng nhập nào được ghi (log bắt đầu từ sau lần deploy này).'
      );
      box.innerHTML = tableHTML(
        ['Thời gian', 'Email', 'Kết quả', 'IP', 'Trình duyệt'],
        (d.logs || []).map(function (l) {
          return [esc(fmtDate(l.created_at)), esc(l.email), l.success ? 'Thành công' : 'Thất bại',
            esc(l.ip || '—'), esc((l.user_agent || '—').slice(0, 80))];
        }),
        'Không tìm thấy lượt đăng nhập nào khớp điều kiện.'
      );
      renderPager('loginLogPager', d.total, d.offset, d.limit, function (next) {
        loginLogOffset = next; loadLoginLogs();
      });
    } catch (e) { box.innerHTML = '<p class="status bad">Lỗi: ' + esc(e.message) + '</p>'; }
  }
  $('loginLogSearchBtn').addEventListener('click', function () { loginLogOffset = 0; loadLoginLogs(); });

  $('createUserForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var f = ev.target;
    try {
      var d = await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          email: f.email.value,
          password: f.password.value,
          role: f.role.value,
        }),
      });
      setStatus($('createUserMsg'), 'Đã thêm ' + d.user.email + '.', true);
      f.reset();
      loadUsers();
    } catch (e) { setStatus($('createUserMsg'), 'Lỗi: ' + e.message, false); }
  });

  // --- Khởi động ---
  async function boot() {
    try {
      var st = await api('/api/auth/status', { noAuth: true });
      if (!st.hasUsers) { showSetup(); return; }
      if (getSettings().session) {
        try {
          var me = await api('/api/auth/me');
          showApp(me.user);
        } catch (e) {
          if (e.status !== 401) showLogin('Lỗi: ' + e.message);
        }
      } else {
        showLogin();
      }
    } catch (e) {
      setStatus($('connStatus'), 'Lỗi kết nối Worker: ' + e.message, false);
      showLogin();
    }
  }

  boot();

  // Đăng ký service worker (PWA) — im lặng nếu trình duyệt không hỗ trợ.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
