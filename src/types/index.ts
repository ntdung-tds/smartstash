// SmartStash types — theo PRD+SRS v2.1 (A.5, B.14)
export type LocationType = 'PROPERTY' | 'ROOM' | 'FURNITURE' | 'CONTAINER';

export type ItemStatus =
  | 'STORED' // Đang cất
  | 'IN_USE' // Đang dùng
  | 'LENT' // Đã cho mượn (toàn bộ)
  | 'PARTIALLY_LENT' // Đang cho mượn một phần
  | 'CONSIGNED' // Đang gửi bán (KHÔNG kết thúc — món vẫn thuộc quản lý, đang ở chỗ người giữ hộ)
  | 'DAMAGED' // Đã hỏng (vẫn đang quản lý, không phải trạng thái kết thúc)
  | 'SOLD' // Đã bán (kết thúc)
  | 'GIFTED' // Đã tặng (kết thúc)
  | 'DONATED' // Đã bố thí (kết thúc)
  | 'DISPOSED' // Đã vứt bỏ (kết thúc)
  | 'LOST' // Thất lạc (kết thúc) [v2.1]
  | 'USED_UP'; // Đã dùng hết (kết thúc)

export type ItemCondition = 'NEW' | 'GOOD' | 'WORN' | 'NEED_REPAIR' | 'BROKEN';

/** Mức cảnh báo thống nhất cho mọi loại ngày (hạn dùng / hạn trả / bảo hành) */
export type AlertTier = 'OVERDUE' | 'DUE' | 'SOON' | 'WATCH';

export type ItemCategory =
  | 'ELECTRONICS'
  | 'MEDICINE'
  | 'FOOD'
  | 'KITCHENWARE'
  | 'DOCUMENTS'
  | 'CLOTHING'
  | 'TOOLS'
  | 'KIDS'
  | 'HOUSEHOLD'
  | 'SPORTS'
  | 'BOOKS'
  | 'OTHER';

export type MediaKind =
  | 'ITEM_CLOSEUP'
  | 'ITEM_SCENE'
  | 'LOCATION_SCENE'
  | 'RECEIPT'
  | 'LOAN_HANDOVER'
  | 'LOAN_RETURN';

export interface Location {
  id: string;
  parent_id: string | null;
  name: string;
  type: LocationType;
  description: string | null;
  scene_media_id: string | null;
  qr_code: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  household_id: string | null;
  /** Icon tự chọn (tên Ionicons); null = dùng icon mặc định theo loại vị trí */
  icon: string | null;
  /** Thứ tự hiển thị trong nhóm anh em cùng cha (kéo thả sắp xếp); nhỏ = lên trước */
  sort_order: number;
  created_at: string;
  updated_at: string;
  is_deleted: number;
  is_dirty: number;
  deleted_at: string | null;
}

export interface Item {
  id: string;
  name: string;
  /** Key phân loại: built-in (ItemCategory) hoặc id phân loại tự tạo ('ct_…') */
  category: string;
  tags: string | null; // JSON array string
  location_id: string | null;
  position_note: string | null;
  scene_media_id: string | null;
  pin_x: number | null;
  pin_y: number | null;
  /** Key trạng thái: built-in (ItemStatus) hoặc id trạng thái tự tạo ('st_…', nhãn trung tính) */
  status: string;
  /** Key tình trạng vật lý: built-in (ItemCondition) hoặc id tình trạng tự tạo ('cd_…', nhãn trung tính) */
  condition: string;
  /** Ghi chú tự do về tình trạng vật lý của riêng món này */
  condition_note: string | null;
  quantity: number;
  unit: string;
  purchase_price: number | null; // INTEGER VND
  purchase_date: string | null;
  purchase_place: string | null;
  warranty_expiry_date: string | null;
  expiry_date: string | null;
  /** Hoãn nhắc cảnh báo hạn dùng tới ngày này (YYYY-MM-DD); null = không hoãn */
  alert_snoozed_until: string | null;
  receipt_media_id: string | null;
  barcode: string | null;
  sold_price: number | null;
  sold_date: string | null;
  sold_note: string | null;
  /** Người mua khi món kết thúc bằng bán trọn (bán qua lượt mượn / gửi bán cũng ghi vào đây) */
  sold_to: string | null;
  household_id: string | null;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
  is_deleted: number;
  is_dirty: number;
  deleted_at: string | null;
}

export interface MediaFile {
  id: string;
  kind: MediaKind;
  owner_type: 'ITEM' | 'LOCATION' | 'LOAN';
  owner_id: string;
  local_uri: string;
  thumbnail_uri: string;
  drive_file_id: string | null;
  sync_status: 'PENDING' | 'UPLOADING' | 'SYNCED' | 'FAILED' | 'ORPHAN';
  sha256: string | null;
  size_bytes: number | null;
  /** Ghim vị trí riêng của chính ảnh này (tỉ lệ 0–1) — chỉ có nghĩa với ảnh hiện trường */
  pin_x: number | null;
  pin_y: number | null;
  is_primary: number;
  created_at: string;
  updated_at: string;
  is_deleted: number;
  is_dirty: number;
  deleted_at: string | null;
}

export interface Loan {
  id: string;
  item_id: string;
  /** LOAN = cho mượn thông thường; CONSIGNMENT = gửi bán (borrower_name = người giữ hộ) */
  kind: 'LOAN' | 'CONSIGNMENT';
  borrower_name: string;
  borrower_phone: string | null;
  quantity_lent: number;
  quantity_returned: number;
  /** Phần đã "đóng" mà không quay về nhà: tặng/bán/bố thí từ lượt mượn, bán được từ gửi bán, hoặc tự đóng khi món kết thúc */
  quantity_closed: number;
  /** Lý do đóng khi record kết thúc: RETURNED | GIFTED | SOLD | DONATED | TO_CONSIGNMENT | CONSIGNMENT_SOLD | TAKEN_BACK | AUTO_CLOSED */
  close_reason: string | null;
  /** Giá mong muốn khi gửi bán (chỉ dùng cho kind = CONSIGNMENT) */
  expected_price: number | null;
  lent_at: string;
  expected_return_date: string | null;
  /** Hoãn nhắc cảnh báo hạn trả tới ngày này (YYYY-MM-DD); null = không hoãn */
  alert_snoozed_until: string | null;
  returned_at: string | null;
  status: 'ACTIVE' | 'RETURNED' | 'OVERDUE';
  handover_media_id: string | null;
  return_media_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  is_deleted: number;
  is_dirty: number;
  deleted_at: string | null;
}

export interface ItemHistory {
  id: string;
  item_id: string;
  action_type: string;
  from_location_id: string | null;
  to_location_id: string | null;
  old_status: string | null;
  new_status: string | null;
  note: string | null;
  created_at: string;
}

export const CATEGORY_LABELS: Record<ItemCategory, string> = {
  ELECTRONICS: 'Điện tử',
  MEDICINE: 'Thuốc & sức khoẻ',
  FOOD: 'Thực phẩm',
  KITCHENWARE: 'Nhà bếp',
  DOCUMENTS: 'Giấy tờ',
  CLOTHING: 'Thời trang',
  TOOLS: 'Dụng cụ',
  KIDS: 'Trẻ em',
  HOUSEHOLD: 'Gia dụng',
  SPORTS: 'Thể thao',
  BOOKS: 'Sách & học tập',
  OTHER: 'Khác',
};

/** Phân loại / trạng thái do người dùng tự tạo, lưu ở bảng custom_terms */
export interface CustomTerm {
  id: string;
  kind: 'CATEGORY' | 'STATUS' | 'CONDITION';
  name: string;
  icon: string;
  color: string;
  created_at: string;
  is_deleted: number;
  deleted_at: string | null;
}

export const STATUS_LABELS: Record<ItemStatus, string> = {
  STORED: 'Đang cất',
  IN_USE: 'Đang dùng',
  LENT: 'Đã cho mượn',
  PARTIALLY_LENT: 'Cho mượn một phần',
  CONSIGNED: 'Đang gửi bán',
  DAMAGED: 'Đã hỏng',
  SOLD: 'Đã bán',
  GIFTED: 'Đã tặng',
  DONATED: 'Đã bố thí',
  DISPOSED: 'Đã vứt bỏ',
  LOST: 'Thất lạc',
  USED_UP: 'Đã dùng hết',
};

export const CONDITION_LABELS: Record<ItemCondition, string> = {
  NEW: 'Mới nguyên',
  GOOD: 'Tốt',
  WORN: 'Đã dùng — có trầy xước',
  NEED_REPAIR: 'Cần sửa',
  BROKEN: 'Hỏng',
};

export const CONDITION_ICONS: Record<ItemCondition, string> = {
  NEW: 'sparkles-outline',
  GOOD: 'thumbs-up-outline',
  WORN: 'bandage-outline',
  NEED_REPAIR: 'construct-outline',
  BROKEN: 'alert-circle-outline',
};

/** Ghi chú mô tả từng tình trạng vật lý — hiển thị dưới bộ chọn tình trạng trong form */
export const CONDITION_HINTS: Record<ItemCondition, string> = {
  NEW: 'Còn nguyên tem, chưa qua sử dụng.',
  GOOD: 'Hoạt động tốt, không có hư hỏng đáng kể.',
  WORN: 'Vẫn dùng được nhưng có trầy xước hoặc hao mòn thấy rõ.',
  NEED_REPAIR: 'Bị lỗi hoặc hư một phần — cần sửa chữa trước khi dùng tiếp.',
  BROKEN: 'Hư hỏng nặng, hiện không sử dụng được.',
};

export const LOCATION_TYPE_LABELS: Record<LocationType, string> = {
  PROPERTY: 'Nơi ở',
  ROOM: 'Phòng',
  FURNITURE: 'Khu vực / Tủ kệ',
  CONTAINER: 'Vật chứa / Hộp',
};

/** Ngôn ngữ giao diện được hỗ trợ */
export type Lang = 'vi' | 'en';

export const CATEGORY_LABELS_EN: Record<ItemCategory, string> = {
  ELECTRONICS: 'Electronics',
  MEDICINE: 'Medicine & health',
  FOOD: 'Food',
  KITCHENWARE: 'Kitchen',
  DOCUMENTS: 'Documents',
  CLOTHING: 'Clothing',
  TOOLS: 'Tools',
  KIDS: 'Kids',
  HOUSEHOLD: 'Household',
  SPORTS: 'Sports',
  BOOKS: 'Books & study',
  OTHER: 'Other',
};

export const STATUS_LABELS_EN: Record<ItemStatus, string> = {
  STORED: 'Stored',
  IN_USE: 'In use',
  LENT: 'Lent out',
  PARTIALLY_LENT: 'Partially lent',
  CONSIGNED: 'On consignment',
  DAMAGED: 'Damaged',
  SOLD: 'Sold',
  GIFTED: 'Gifted',
  DONATED: 'Donated',
  DISPOSED: 'Disposed',
  LOST: 'Lost',
  USED_UP: 'Used up',
};

export const CONDITION_LABELS_EN: Record<ItemCondition, string> = {
  NEW: 'Brand new',
  GOOD: 'Good',
  WORN: 'Used — some scratches',
  NEED_REPAIR: 'Needs repair',
  BROKEN: 'Broken',
};

export const CONDITION_HINTS_EN: Record<ItemCondition, string> = {
  NEW: 'Still sealed, never used.',
  GOOD: 'Works well, with no significant damage.',
  WORN: 'Still usable, but with visible scratches or wear.',
  NEED_REPAIR: 'Faulty or partially damaged — needs repair before it can be used again.',
  BROKEN: 'Heavily damaged and currently unusable.',
};

export const LOCATION_TYPE_LABELS_EN: Record<LocationType, string> = {
  PROPERTY: 'Home',
  ROOM: 'Room',
  FURNITURE: 'Area / Cabinet',
  CONTAINER: 'Container / Box',
};
