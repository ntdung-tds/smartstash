// Tầng lưu trữ trừu tượng cho tính năng "mây của tôi" (file sao lưu .ssbak).
//
// Nguyên tắc đã chốt:
// - File .ssbak đã được app mã hoá phía client bằng mật khẩu của người dùng
//   (zero-knowledge). Kho chứa — dù là Drive hay R2 — chỉ thấy bản mã.
// - App của khách KHÔNG BAO GIỜ nối thẳng vào kho chứa của chủ sản phẩm.
//   Mọi lượt tải lên/tải xuống đều đi qua Worker này.
// - Adapter hiện tại là Drive: KHUNG CHƯA KÍCH HOẠT. Nó chỉ trả trạng thái
//   not_configured cho tới khi chủ app điền đủ thông tin xác thực Drive vào
//   Worker secrets (xem README mục "Kích hoạt adapter Drive"). KHÔNG giả dữ liệu.
//
// Interface mọi adapter phải tuân theo:
//   put(userId, fileName, bytes) -> { ok, key? } | { ok: false, error: 'storage_not_configured' }
//   get(userId, fileName)        -> { ok, bytes? } | { ok: false, error }
//   list(userId)                 -> { ok, files: [{ name, size, updatedAt }] } | { ok: false, error }
//   remove(userId, fileName)     -> { ok } | { ok: false, error }
//   usage()                      -> { ok, files, bytes, configured } | { ok: false, error }
//
// Adapter R2 (giai đoạn sau): khi chuyển sang R2, chỉ cần thêm một adapter mới
// tuân theo interface trên và đổi một dòng trong getStorageAdapter() —
// app và API không đổi. Binding R2 đã được chừa sẵn (comment) trong wrangler.toml.

export function getStorageAdapter(env) {
  // Giai đoạn đầu: Drive. Khi đã có adapter R2, đổi hàm này trả về R2Adapter.
  return new DriveStorageAdapter(env);
}

class DriveStorageAdapter {
  constructor(env) {
    this.env = env;
  }

  // Drive chưa được kích hoạt cho tới khi có đủ secrets:
  // DRIVE_CLIENT_EMAIL, DRIVE_PRIVATE_KEY, DRIVE_FOLDER_ID.
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
  // Xoay vòng giữ 5 bản mới nhất cho mỗi người dùng ở tầng này.
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
