import { getDb } from './client';
import { createLocation, createItem } from './queries';

/** Dữ liệu mẫu cho căn hộ (A.4) + vài món đồ mẫu — chỉ chạy khi DB trống */
export async function seedIfEmpty(): Promise<void> {
  const db = getDb();
  const row = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) as c FROM locations');
  if ((row?.c ?? 0) > 0) return;

  const home = await createLocation({ name: 'Nhà chính', type: 'PROPERTY' });
  const living = await createLocation({ name: 'Phòng khách', type: 'ROOM', parent_id: home.id });
  const bedroom = await createLocation({ name: 'Phòng ngủ', type: 'ROOM', parent_id: home.id });
  const kitchen = await createLocation({ name: 'Bếp', type: 'ROOM', parent_id: home.id });
  const storage = await createLocation({ name: 'Kho tầng 2', type: 'ROOM', parent_id: home.id });

  const shelf = await createLocation({ name: 'Kệ sắt phải', type: 'FURNITURE', parent_id: storage.id });
  const medCabinet = await createLocation({ name: 'Tủ thuốc', type: 'FURNITURE', parent_id: bedroom.id });
  const wardrobe = await createLocation({ name: 'Tủ quần áo', type: 'FURNITURE', parent_id: bedroom.id });

  const boxBlue = await createLocation({ name: 'Hộp nhựa xanh số 2', type: 'CONTAINER', parent_id: shelf.id });
  const boxTet = await createLocation({ name: 'Thùng carton đồ Tết', type: 'CONTAINER', parent_id: shelf.id });
  void living; void kitchen; void wardrobe;

  const kb = await createItem({
    name: 'Bàn phím Logitech K380 dự phòng',
    category: 'ELECTRONICS',
    location_id: boxBlue.id,
    position_note: 'Ngăn trên cùng của hộp, để trong túi vải',
    tags: JSON.stringify(['dự phòng', 'điện tử']),
  });
  void kb;

  await createItem({
    name: 'Thuốc hạ sốt Paracetamol 500mg',
    category: 'MEDICINE',
    location_id: medCabinet.id,
    position_note: 'Ngăn 2, hộp trong suốt',
    quantity: 1,
    unit: 'Vỉ',
    expiry_date: new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10),
  });

  await createItem({
    name: 'Bộ bát đĩa 12 cái',
    category: 'KITCHENWARE',
    location_id: boxTet.id,
    position_note: 'Bọc giấy báo từng cái',
    quantity: 12,
    unit: 'Cái',
  });

  await createItem({
    name: 'Máy khoan cầm tay Bosch',
    category: 'TOOLS',
    location_id: boxBlue.id,
    position_note: 'Kèm hộp mũi khoan',
    purchase_price: 1250000,
  });
}
