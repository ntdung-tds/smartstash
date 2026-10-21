import { kvGet, kvSet } from '../db/client';
import {
  countActiveItems, countLocations, createItem, createLoan, createLocation,
  itemsInLocation, listLocations, listLoansForItem, returnLoan,
  setItemStatus, softDeleteItem, softDeleteLocation,
} from '../db/queries';
import { CURRENT_LIMITS } from '../config';
import { rescheduleAllReminders } from './notificationService';
import type { ItemCategory, ItemCondition, LocationType } from '../types';

/**
 * Dữ liệu mẫu để người dùng thử app (~30 món ở 5 vị trí).
 * Mọi id đã tạo được ghi vào app_kv 'demo_seed_ids' — thao tác xoá CHỈ chạm
 * đúng các id đó, không bao giờ đụng tới dữ liệu thật của người dùng.
 */
const DEMO_KEY = 'demo_seed_ids';

interface DemoSeedIds {
  items: string[];
  locations: string[];
}

/** Ngày ISO (YYYY-MM-DD) lệch `days` ngày so với hôm nay (âm = quá khứ) */
function datePlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const DEMO_LOCATIONS: { name: string; type: LocationType; icon: string }[] = [
  { name: 'Tủ lạnh (mẫu)', type: 'FURNITURE', icon: 'snow-outline' },
  { name: 'Kệ bếp (mẫu)', type: 'FURNITURE', icon: 'restaurant-outline' },
  { name: 'Tủ quần áo (mẫu)', type: 'FURNITURE', icon: 'shirt-outline' },
  { name: 'Bàn làm việc (mẫu)', type: 'FURNITURE', icon: 'desktop-outline' },
  { name: 'Garage (mẫu)', type: 'ROOM', icon: 'car-outline' },
];

interface DemoItemSpec {
  name: string;
  category: ItemCategory;
  /** Chỉ số trong DEMO_LOCATIONS */
  loc: number;
  quantity?: number;
  unit?: string;
  price?: number | null;
  boughtDaysAgo?: number;
  condition?: ItemCondition;
  conditionNote?: string;
  /** Số ngày tới ngày hết hạn (âm = đã hết hạn), tính theo hôm nay */
  expiryInDays?: number;
  /** Số ngày tới ngày hết bảo hành */
  warrantyInDays?: number;
  positionNote?: string;
}

// Ngày hết hạn dàn theo kịch bản: 1 món hết hạn hôm qua, 2 món còn 3 ngày,
// 2 món còn 6 ngày (3 mức khẩn), thêm 2 món còn 12 và 20 ngày (mức WATCH —
// "Sắp đến hạn" trong 30 ngày) và vài món còn 30–90 ngày — để khối cảnh báo
// 4 mức có đủ dữ liệu ở mọi mức.
const DEMO_ITEMS: DemoItemSpec[] = [
  // --- Tủ lạnh ---
  { name: 'Sữa tươi Vinamilk 1L', category: 'FOOD', loc: 0, quantity: 2, unit: 'Hộp', price: 32000, boughtDaysAgo: 2, expiryInDays: 3, positionNote: 'Ngăn mát, cửa tủ' },
  { name: 'Trứng gà ta (vỉ 10 quả)', category: 'FOOD', loc: 0, quantity: 1, unit: 'Vỉ', price: 38000, boughtDaysAgo: 3, expiryInDays: 6 },
  { name: 'Nước cam ép nguyên chất', category: 'FOOD', loc: 0, quantity: 1, unit: 'Chai', price: 28000, boughtDaysAgo: 8, expiryInDays: -1 },
  { name: 'Phô mai lát Cheddar', category: 'FOOD', loc: 0, quantity: 2, unit: 'Gói', price: 46000, boughtDaysAgo: 4, expiryInDays: 6 },
  { name: 'Vitamin C 1000mg sủi', category: 'MEDICINE', loc: 0, quantity: 1, unit: 'Tuýp', price: 65000, boughtDaysAgo: 20, expiryInDays: 90, condition: 'NEW' },
  { name: 'Thuốc nhỏ mắt Rohto', category: 'MEDICINE', loc: 0, quantity: 1, unit: 'Lọ', price: 42000, boughtDaysAgo: 15, expiryInDays: 3 },
  // --- Kệ bếp ---
  { name: 'Mì Ý spaghetti 500g', category: 'FOOD', loc: 1, quantity: 3, unit: 'Gói', price: 36000, boughtDaysAgo: 30, expiryInDays: 120 },
  { name: 'Dầu ăn hướng dương 1L', category: 'FOOD', loc: 1, quantity: 1, unit: 'Chai', price: 54000, boughtDaysAgo: 10, expiryInDays: 45 },
  { name: 'Nồi chiên không dầu 5L', category: 'KITCHENWARE', loc: 1, price: 1890000, boughtDaysAgo: 200, warrantyInDays: 545, conditionNote: 'Còn bảo hành hãng, đã vệ sinh khay chiên' },
  { name: 'Máy xay sinh tố', category: 'KITCHENWARE', loc: 1, price: 890000, boughtDaysAgo: 150, warrantyInDays: 215 },
  { name: 'Bộ dao bếp 6 món', category: 'KITCHENWARE', loc: 1, price: 350000, boughtDaysAgo: 500, condition: 'WORN', conditionNote: 'Dao thái hơi cùn, cần mài lại' },
  { name: 'Lõi lọc nước dự phòng', category: 'HOUSEHOLD', loc: 1, quantity: 2, unit: 'Cái', price: 450000, boughtDaysAgo: 60, expiryInDays: 20, positionNote: 'Tủ dưới bồn rửa' },
  // --- Tủ quần áo ---
  { name: 'Áo khoác dạ mùa đông', category: 'CLOTHING', loc: 2, price: 650000, boughtDaysAgo: 380 },
  { name: 'Váy dự tiệc đỏ', category: 'CLOTHING', loc: 2, price: 980000, boughtDaysAgo: 60, condition: 'NEW', conditionNote: 'Còn nguyên tem, chưa mặc lần nào' },
  { name: 'Khăn choàng len', category: 'CLOTHING', loc: 2, quantity: 2, price: 180000, boughtDaysAgo: 90 },
  { name: 'Áo thun trắng (bộ 3 cái)', category: 'CLOTHING', loc: 2, quantity: 3, price: 299000, boughtDaysAgo: 45 },
  { name: 'Kem chống nắng Anessa 60ml', category: 'OTHER', loc: 2, quantity: 1, unit: 'Tuýp', price: 420000, boughtDaysAgo: 100, expiryInDays: 12, conditionNote: 'Để ở ngăn kéo bàn trang điểm' },
  // --- Bàn làm việc ---
  { name: 'Bàn phím cơ Keychron K8', category: 'ELECTRONICS', loc: 3, price: 1750000, boughtDaysAgo: 120, warrantyInDays: 245 },
  { name: 'Tai nghe Sony WH-1000XM4', category: 'ELECTRONICS', loc: 3, price: 5490000, boughtDaysAgo: 300, warrantyInDays: 65, condition: 'WORN', conditionNote: 'Đệm tai trái hơi bong da' },
  { name: 'Ổ cứng SSD Samsung 1TB', category: 'ELECTRONICS', loc: 3, price: 1390000, boughtDaysAgo: 30, warrantyInDays: 700, condition: 'NEW' },
  { name: 'Hộ chiếu & giấy tờ xe', category: 'DOCUMENTS', loc: 3, quantity: 1, unit: 'Bộ', price: null, positionNote: 'Ngăn kéo khoá' },
  { name: 'Sách "Đắc nhân tâm"', category: 'BOOKS', loc: 3, price: 89000, boughtDaysAgo: 200 },
  { name: 'Từ điển Anh – Việt', category: 'BOOKS', loc: 3, price: 120000, boughtDaysAgo: 800, condition: 'WORN' },
  { name: 'Bàn phím Logitech K380 dự phòng', category: 'ELECTRONICS', loc: 3, price: 590000, boughtDaysAgo: 250 },
  // --- Garage ---
  { name: 'Máy khoan pin Bosch', category: 'TOOLS', loc: 4, price: 2150000, boughtDaysAgo: 100, warrantyInDays: 265 },
  { name: 'Bộ cờ lê đa năng 12 món', category: 'TOOLS', loc: 4, price: 420000, boughtDaysAgo: 600, condition: 'WORN', conditionNote: 'Thiếu cờ lê số 10' },
  { name: 'Thang nhôm xếp 5 bậc', category: 'TOOLS', loc: 4, price: 780000, boughtDaysAgo: 350 },
  { name: 'Xe đạp thể thao', category: 'SPORTS', loc: 4, price: 3900000, boughtDaysAgo: 450, conditionNote: 'Mới thay lốp sau' },
  { name: 'Bóng đá size 5', category: 'SPORTS', loc: 4, price: 250000, boughtDaysAgo: 90 },
  { name: 'Bộ Lego lâu đài của bé', category: 'KIDS', loc: 4, price: 550000, boughtDaysAgo: 25, condition: 'NEW' },
  { name: 'Túi đựng đồ du lịch', category: 'OTHER', loc: 4, price: 150000, boughtDaysAgo: 70 },
  { name: 'Robot hút bụi', category: 'HOUSEHOLD', loc: 4, price: 4990000, boughtDaysAgo: 80, warrantyInDays: 285 },
];

/** Tên món được dùng cho các trạng thái/khoản vay đặc biệt sau khi seed */
const LOAN_A_NAME = 'Máy khoan pin Bosch'; // Minh Anh mượn, hẹn trả +2 ngày
const LOAN_B_NAME = 'Bàn phím Logitech K380 dự phòng'; // Tuấn mượn, đã quá hạn 1 ngày
const IN_USE_NAMES = ['Tai nghe Sony WH-1000XM4', 'Robot hút bụi'];
const LOST_NAME = 'Bóng đá size 5';

async function readSeedIds(): Promise<DemoSeedIds | null> {
  const raw = await kvGet(DEMO_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DemoSeedIds;
    if (Array.isArray(parsed.items) && Array.isArray(parsed.locations)) return parsed;
  } catch {
    // dữ liệu hỏng — coi như chưa seed
  }
  return null;
}

export async function seedDemoData(): Promise<{ items: number; locations: number; skipped: boolean }> {
  const existing = await readSeedIds();
  if (existing && existing.items.length + existing.locations.length > 0) {
    return { items: 0, locations: 0, skipped: true };
  }

  const createdLocIds: (string | null)[] = [];
  const createdItemIds: string[] = [];
  const createdItemsByName = new Map<string, string>();

  // --- Vị trí mẫu (dừng êm khi chạm giới hạn gói) ---
  let locRoom = CURRENT_LIMITS.maxLocations - (await countLocations());
  for (const spec of DEMO_LOCATIONS) {
    if (locRoom <= 0) {
      createdLocIds.push(null);
      continue;
    }
    try {
      const loc = await createLocation({ name: spec.name, type: spec.type, parent_id: null, icon: spec.icon });
      createdLocIds.push(loc.id);
      locRoom--;
    } catch {
      createdLocIds.push(null);
      break;
    }
  }

  // --- Món mẫu ---
  let itemRoom = CURRENT_LIMITS.maxActiveItems - (await countActiveItems());
  for (const spec of DEMO_ITEMS) {
    if (itemRoom <= 0) break;
    const locationId = createdLocIds[spec.loc];
    if (!locationId) continue;
    try {
      const item = await createItem({
        name: spec.name,
        category: spec.category,
        location_id: locationId,
        quantity: spec.quantity ?? 1,
        unit: spec.unit ?? 'Cái',
        purchase_price: spec.price ?? null,
        purchase_date: spec.boughtDaysAgo != null ? datePlus(-spec.boughtDaysAgo) : null,
        condition: spec.condition ?? 'GOOD',
        condition_note: spec.conditionNote ?? null,
        expiry_date: spec.expiryInDays != null ? datePlus(spec.expiryInDays) : null,
        warranty_expiry_date: spec.warrantyInDays != null ? datePlus(spec.warrantyInDays) : null,
        position_note: spec.positionNote ?? null,
      });
      createdItemIds.push(item.id);
      createdItemsByName.set(spec.name, item.id);
      itemRoom--;
    } catch {
      break;
    }
  }

  // --- Trạng thái đặc biệt (đi qua setItemStatus để giữ đúng hệ quả) ---
  for (const name of IN_USE_NAMES) {
    const id = createdItemsByName.get(name);
    if (id) {
      try {
        await setItemStatus(id, 'IN_USE');
      } catch {
        // bỏ qua món lỗi
      }
    }
  }
  const lostId = createdItemsByName.get(LOST_NAME);
  if (lostId) {
    try {
      await setItemStatus(lostId, 'LOST');
    } catch {
      // bỏ qua
    }
  }

  // --- Khoản vay mẫu: 1 sắp đến hạn (+2 ngày), 1 đã quá hạn (−1 ngày) ---
  const loanAId = createdItemsByName.get(LOAN_A_NAME);
  if (loanAId) {
    try {
      await createLoan({
        item_id: loanAId,
        borrower_name: 'Minh Anh',
        quantity_lent: 1,
        expected_return_date: datePlus(2),
      });
    } catch {
      // bỏ qua nếu không tạo được khoản vay
    }
  }
  const loanBId = createdItemsByName.get(LOAN_B_NAME);
  if (loanBId) {
    try {
      await createLoan({
        item_id: loanBId,
        borrower_name: 'Tuấn',
        quantity_lent: 1,
        expected_return_date: datePlus(-1),
      });
    } catch {
      // bỏ qua
    }
  }

  const locationIds = createdLocIds.filter((x): x is string => !!x);
  if (createdItemIds.length > 0 || locationIds.length > 0) {
    await kvSet(DEMO_KEY, JSON.stringify({ items: createdItemIds, locations: locationIds } satisfies DemoSeedIds));
  }
  rescheduleAllReminders().catch(() => {});
  return { items: createdItemIds.length, locations: locationIds.length, skipped: false };
}

export async function clearDemoData(): Promise<void> {
  const seed = await readSeedIds();
  if (!seed) return;

  // Trả hết khoản vay đang mở của từng món mẫu rồi mới xoá mềm món,
  // tránh khoản vay mồ côi (listActiveLoans JOIN items nên món đã xoá mềm
  // vẫn hiện nếu khoản vay còn ACTIVE — phải trả trước).
  for (const itemId of seed.items) {
    try {
      const loans = await listLoansForItem(itemId);
      for (const loan of loans) {
        if (loan.status !== 'ACTIVE') continue;
        const remaining = loan.quantity_lent - loan.quantity_returned;
        if (remaining > 0) await returnLoan(loan.id, remaining);
      }
      await softDeleteItem(itemId);
    } catch {
      // món có thể đã bị xoá cứng — bỏ qua, tiếp tục món khác
    }
  }

  // Chỉ xoá vị trí mẫu khi không còn đồ thật / vị trí con của người dùng bên trong
  const allLocs = await listLocations();
  for (const locId of seed.locations) {
    try {
      const hasChild = allLocs.some((l) => l.parent_id === locId);
      if (hasChild) continue;
      const remaining = await itemsInLocation(locId, true);
      if (remaining.length > 0) continue;
      await softDeleteLocation(locId);
    } catch {
      // bỏ qua vị trí lỗi
    }
  }

  await kvSet(DEMO_KEY, '');
  rescheduleAllReminders().catch(() => {});
}
