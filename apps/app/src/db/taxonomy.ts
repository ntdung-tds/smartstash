import { getDb } from './client';
import { uuid, nowISO } from '../utils';
import type { CustomTerm } from '../types';

export type TermKind = CustomTerm['kind'];

/** Phân loại / trạng thái người dùng tự tạo (bảng custom_terms) */
export async function listCustomTerms(kind: TermKind): Promise<CustomTerm[]> {
  return getDb().getAllAsync<CustomTerm>(
    'SELECT * FROM custom_terms WHERE kind = ? AND is_deleted = 0 ORDER BY created_at ASC',
    [kind],
  );
}

export async function addCustomTerm(
  kind: TermKind,
  name: string,
  icon: string,
  color: string,
): Promise<CustomTerm> {
  // Id chính là giá trị lưu vào items.category / items.status / items.condition
  const prefix = kind === 'CATEGORY' ? 'ct_' : kind === 'STATUS' ? 'st_' : 'cd_';
  const term: CustomTerm = {
    id: prefix + uuid(),
    kind,
    name: name.trim(),
    icon,
    color,
    created_at: nowISO(),
    is_deleted: 0,
    deleted_at: null,
  };
  await getDb().runAsync(
    `INSERT INTO custom_terms (id, kind, name, icon, color, created_at, is_deleted, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`,
    [term.id, term.kind, term.name, term.icon, term.color, term.created_at],
  );
  return term;
}

/** Xoá mềm — đồ đã gắn loại/trạng thái này vẫn hiển thị được nhờ registry dự phòng */
export async function deleteCustomTerm(id: string): Promise<void> {
  const now = nowISO();
  await getDb().runAsync(
    'UPDATE custom_terms SET is_deleted = 1, deleted_at = ? WHERE id = ?',
    [now, id],
  );
}
