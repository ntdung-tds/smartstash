// Tầng lưu trữ trừu tượng cho tính năng "mây của tôi" (file sao lưu .ssbak).
//
// Nguyên tắc đã chốt:
// - File .ssbak đã được app mã hoá phía client bằng mật khẩu của người dùng
//   (zero-knowledge). Kho chứa — dù là Drive hay R2 — chỉ thấy bản mã.
// - App của khách KHÔNG BAO GIỜ nối thẳng vào kho chứa của chủ sản phẩm.
//   Mọi lượt tải lên/tải xuống đều đi qua Worker này.
// - Adapter đang chạy: R2 (binding BACKUPS trong wrangler.toml). Khi Worker
//   chạy mà chưa bind R2, getStorageAdapter() rơi về adapter Drive — khung
//   CHƯA kích hoạt, trả storage_not_configured (không giả dữ liệu).
// - Adapter Drive hoãn vô thời hạn: gói 30TB của chủ app là Google One CÁ
//   NHÂN — service account không có Drive cá nhân, và điều khoản cấm dùng
//   dịch vụ để bán lại cho bên thứ ba. Muốn dùng Drive làm backend máy chủ
//   phải có Workspace + shared drive, nên tuyến R2 là tuyến chính.
//
// Interface mọi adapter phải tuân theo:
//   put(userId, fileName, bytes) -> { ok, key? } | { ok: false, error }
//   get(userId, fileName)        -> { ok, bytes? } | { ok: false, error }
//   list(userId)                 -> { ok, files: [{ name, size, updatedAt }] } | { ok: false, error }
//   remove(userId, fileName)     -> { ok } | { ok: false, error }
//   usage()                      -> { ok, files, bytes, configured } | { ok: false, error }

export function getStorageAdapter(env) {
  // R2 là adapter chính khi đã bind bucket; chưa bind thì rơi về khung Drive.
  if (env.BACKUPS) return new R2StorageAdapter(env);
  return new DriveStorageAdapter(env);
}

// Adapter R2 — kho chính của "mây của tôi".
// Key trong bucket: <account_id>/<file_name>. Mỗi tài khoản chỉ thấy tiền tố
// của chính mình (mọi route đều kiểm tra quyền sở hữu qua bảng backup_files
// trước khi gọi adapter).
class R2StorageAdapter {
  constructor(env) {
    this.bucket = env.BACKUPS;
  }

  key(userId, fileName) {
    return `${userId}/${fileName}`;
  }

  async put(userId, fileName, bytes) {
    try {
      await this.bucket.put(this.key(userId, fileName), bytes);
      return { ok: true, key: this.key(userId, fileName) };
    } catch (e) {
      return { ok: false, error: 'storage_error', message: e?.message ?? 'R2 put thất bại.' };
    }
  }

  async get(userId, fileName) {
    try {
      const obj = await this.bucket.get(this.key(userId, fileName));
      if (!obj) return { ok: false, error: 'not_found', message: 'Không tìm thấy file sao lưu.' };
      return { ok: true, bytes: await obj.arrayBuffer() };
    } catch (e) {
      return { ok: false, error: 'storage_error', message: e?.message ?? 'R2 get thất bại.' };
    }
  }

  async list(userId) {
    try {
      const res = await this.bucket.list({ prefix: `${userId}/` });
      return {
        ok: true,
        files: (res.objects ?? []).map((o) => ({
          name: o.key.slice(userId.length + 1),
          size: o.size,
          updatedAt: o.uploaded ? o.uploaded.toISOString() : null,
        })),
      };
    } catch (e) {
      return { ok: false, error: 'storage_error', message: e?.message ?? 'R2 list thất bại.' };
    }
  }

  async remove(userId, fileName) {
    try {
      await this.bucket.delete(this.key(userId, fileName));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'storage_error', message: e?.message ?? 'R2 delete thất bại.' };
    }
  }

  // Tổng dung lượng thật do route usage tính từ D1 (bảng backup_files);
  // adapter chỉ báo trạng thái đã cấu hình.
  async usage() {
    return { ok: true, configured: true, files: null, bytes: null };
  }
}

class DriveStorageAdapter {
  constructor(env) {
    this.env = env;
  }

  // Drive chưa được kích hoạt cho tới khi có đủ secrets:
  // DRIVE_CLIENT_EMAIL, DRIVE_PRIVATE_KEY, DRIVE_FOLDER_ID.
  // (Hoãn vô thời hạn — xem ghi chú đầu file về Google One cá nhân.)
  configured() {
    const e = this.env;
    return Boolean(e.DRIVE_CLIENT_EMAIL && e.DRIVE_PRIVATE_KEY && e.DRIVE_FOLDER_ID);
  }

  notConfigured() {
    return {
      ok: false,
      error: 'storage_not_configured',
      message:
        'Adapter Drive chưa được kích hoạt: cần cấu hình DRIVE_CLIENT_EMAIL, ' +
        'DRIVE_PRIVATE_KEY và DRIVE_FOLDER_ID bằng wrangler secret put (xem README).',
    };
  }

  // TODO (khi kích hoạt): lấy access token bằng service account (JWT → OAuth2),
  // rồi dùng Drive API v3 (files.create / files.get / files.list / files.delete)
  // trong thư mục DRIVE_FOLDER_ID, mỗi người dùng một tiền tố tên file riêng.
  async put() { return this.notConfigured(); }
  async get() { return this.notConfigured(); }
  async list() { return this.notConfigured(); }
  async remove() { return this.notConfigured(); }

  async usage() {
    if (!this.configured()) {
      return { ok: true, configured: false, files: 0, bytes: 0 };
    }
    // TODO: khi adapter đã kích hoạt, tính tổng từ Drive API (files.list + size).
    return { ok: true, configured: true, files: null, bytes: null };
  }
}
