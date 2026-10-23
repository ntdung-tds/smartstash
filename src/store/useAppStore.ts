import { create } from 'zustand';
import { kvGet, kvSet } from '../db/client';
import { listCustomTerms, addCustomTerm, type TermKind } from '../db/taxonomy';
import { registerCustomTerms, setCurrentLang, STATUS_GROUPS } from '../theme';
import { detectDeviceLang } from '../utils';
import type { CustomTerm, ItemStatus, Lang } from '../types';

interface PinnedTerms {
  cats: string[];
  statuses: string[];
  pinnedOnly: boolean;
}

const PINNED_KEY = 'pinned_terms';
const EMPTY_PINNED: PinnedTerms = { cats: [], statuses: [], pinnedOnly: false };

interface AppState {
  /** Tăng mỗi khi dữ liệu thay đổi để các màn hình tự tải lại khi focus */
  refreshTick: number;
  bump: () => void;

  /** Phân loại / trạng thái / tình trạng người dùng tự tạo (bảng custom_terms) */
  customCategories: CustomTerm[];
  customStatuses: CustomTerm[];
  customConditions: CustomTerm[];
  /** Key của các mục đã ghim trên Trang chủ */
  pinnedCats: string[];
  pinnedStatuses: string[];
  /** Công tắc "Đã ghim" trên Trang chủ: bật thì mỗi hàng lọc chỉ hiện mục đã ghim */
  pinnedOnly: boolean;

  /** Cờ đã qua màn giới thiệu (app_kv 'onboarded'). Root layout đọc cổng từ
   * store này (không giữ snapshot riêng) để onboarding lật cờ là cổng mở ngay
   * trong cùng phiên — tránh vòng lặp Redirect sau khi xoá dữ liệu app. */
  onboarded: boolean | null;
  setOnboarded: (value: boolean) => void;

  /** Ngôn ngữ giao diện: chế độ đã chọn + ngôn ngữ hiệu lực đã resolve */
  langMode: 'auto' | Lang;
  lang: Lang;
  loadLanguage: () => Promise<void>;
  setLangMode: (mode: 'auto' | Lang) => Promise<void>;

  loadTaxonomy: () => Promise<void>;
  addCategory: (name: string, icon: string, color: string) => Promise<CustomTerm>;
  addStatus: (name: string, icon: string, color: string) => Promise<CustomTerm>;
  addCondition: (name: string, icon: string, color: string) => Promise<CustomTerm>;
  togglePin: (kind: TermKind, key: string) => Promise<void>;
  setPinnedOnly: (value: boolean) => Promise<void>;
}

async function savePinned(pinned: PinnedTerms): Promise<void> {
  await kvSet(PINNED_KEY, JSON.stringify(pinned));
}

/**
 * Chuẩn hoá danh sách trạng thái đã ghim của Trang chủ:
 * - Nhóm 'grp:lent' VẪN gộp hiển thị: khoá lọc cũ 'LENT_ALL' và mọi khoá
 *   thành viên (LENT, PARTIALLY_LENT) được thay bằng khoá nhóm 'grp:lent' —
 *   chỉ cần MỘT thành viên đã ghim là cả nhóm coi như đã ghim.
 * - Nhóm 'grp:end' KHÔNG còn gộp ở hàng chip (mỗi trạng thái kết thúc có chip
 *   + ghim riêng): khoá nhóm cũ 'grp:end' trong dữ liệu đã lưu được MỞ RỘNG
 *   NGƯỢC thành đủ 5 khoá thành viên (đúng thứ tự members); các khoá thành
 *   viên kết thúc lẻ giữ nguyên, không gộp nữa.
 * Khoá khác (trạng thái đứng riêng, trạng thái tự tạo, EXPIRING) giữ nguyên;
 * thứ tự theo lần xuất hiện đầu tiên.
 */
function normalizePinnedStatuses(list: string[]): string[] {
  const out: string[] = [];
  const push = (k: string) => { if (!out.includes(k)) out.push(k); };
  for (const key of list) {
    if (key === 'LENT_ALL' || key === 'grp:lent'
      || STATUS_GROUPS['grp:lent'].members.includes(key as ItemStatus)) {
      push('grp:lent');
      continue;
    }
    if (key === 'grp:end') {
      for (const m of STATUS_GROUPS['grp:end'].members) push(m);
      continue;
    }
    push(key);
  }
  return out;
}

export const useAppStore = create<AppState>((set, get) => ({
  refreshTick: 0,
  bump: () => set((s) => ({ refreshTick: s.refreshTick + 1 })),

  onboarded: null,
  setOnboarded: (value) => set({ onboarded: value }),

  langMode: 'auto',
  lang: 'vi',

  loadLanguage: async () => {
    try {
      const raw = await kvGet('lang_mode');
      const mode: 'auto' | Lang = raw === 'vi' || raw === 'en' ? raw : 'auto';
      const resolved: Lang = mode === 'auto' ? detectDeviceLang() : mode;
      setCurrentLang(resolved);
      set({ langMode: mode, lang: resolved });
    } catch {
      // DB chưa sẵn sàng — giữ mặc định 'vi'
    }
  },

  setLangMode: async (mode) => {
    const resolved: Lang = mode === 'auto' ? detectDeviceLang() : mode;
    // Cập nhật ngay (state + resolver của theme) rồi mới ghi KV
    setCurrentLang(resolved);
    set({ langMode: mode, lang: resolved });
    await kvSet('lang_mode', mode);
  },

  customCategories: [],
  customStatuses: [],
  customConditions: [],
  pinnedCats: [],
  pinnedStatuses: [],
  pinnedOnly: false,

  loadTaxonomy: async () => {
    try {
      const [cats, statuses, conditions] = await Promise.all([
        listCustomTerms('CATEGORY'),
        listCustomTerms('STATUS'),
        listCustomTerms('CONDITION'),
      ]);
      registerCustomTerms([...cats, ...statuses, ...conditions]);
      let pinned = EMPTY_PINNED;
      const raw = await kvGet(PINNED_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PinnedTerms>;
        const rawStatuses = parsed.statuses ?? [];
        pinned = {
          cats: parsed.cats ?? [],
          statuses: normalizePinnedStatuses(rawStatuses),
          pinnedOnly: !!parsed.pinnedOnly,
        };
        // Ghi lại bản đã chuẩn hoá để các lần đọc sau không còn khoá thành viên lẻ
        if (JSON.stringify(pinned.statuses) !== JSON.stringify(rawStatuses)) {
          await savePinned(pinned);
        }
      }
      set({
        customCategories: cats,
        customStatuses: statuses,
        customConditions: conditions,
        pinnedCats: pinned.cats,
        pinnedStatuses: pinned.statuses,
        pinnedOnly: pinned.pinnedOnly,
      });
    } catch {
      // DB chưa sẵn sàng (màn hình đầu) — lần focus sau sẽ nạp lại
    }
  },

  addCategory: async (name, icon, color) => {
    const term = await addCustomTerm('CATEGORY', name, icon, color);
    await get().loadTaxonomy();
    get().bump();
    return term;
  },

  addStatus: async (name, icon, color) => {
    const term = await addCustomTerm('STATUS', name, icon, color);
    await get().loadTaxonomy();
    get().bump();
    return term;
  },

  addCondition: async (name, icon, color) => {
    const term = await addCustomTerm('CONDITION', name, icon, color);
    await get().loadTaxonomy();
    get().bump();
    return term;
  },

  togglePin: async (kind, key) => {
    const s = get();
    const current = kind === 'CATEGORY' ? s.pinnedCats : s.pinnedStatuses;
    const next = current.includes(key)
      ? current.filter((k) => k !== key)
      : [...current, key];
    const pinned: PinnedTerms = {
      cats: kind === 'CATEGORY' ? next : s.pinnedCats,
      statuses: kind === 'STATUS' ? next : s.pinnedStatuses,
      pinnedOnly: s.pinnedOnly,
    };
    set({ pinnedCats: pinned.cats, pinnedStatuses: pinned.statuses });
    await savePinned(pinned);
  },

  setPinnedOnly: async (value) => {
    const s = get();
    set({ pinnedOnly: value });
    await savePinned({ cats: s.pinnedCats, statuses: s.pinnedStatuses, pinnedOnly: value });
  },
}));
