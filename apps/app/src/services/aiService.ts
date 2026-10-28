/**
 * AI qua Google Gemini (gói miễn phí) — nhánh feature/ai-add, KIỂU MỚI:
 * KHÁCH KHÔNG CẦN KEY, KHÔNG CÀI ĐẶT GÌ.
 *
 * App chỉ gọi Worker của SmartStash (POST /api/ai); Worker giữ key Gemini
 * trong secret, gọi Google và chặn lượt dùng (20 lượt/ngày/máy, 200
 * lượt/ngày toàn hệ thống). Key không nằm trong app, không nằm trong repo.
 * Một client duy nhất cho cả 3 tính năng:
 *  - aiChat: chatbot hỗ trợ (kèm ngữ cảnh đồ/vị trí của người dùng).
 *  - aiDescribePhoto: nhìn ảnh đoán tên/phân loại/tình trạng đồ vật.
 *  - aiTranscribeAndParse: nghe ghi âm rồi tách thành trường của món đồ.
 *
 * Lưu ý thật về gói miễn phí: nội dung gửi lên (tên đồ, ảnh, giọng nói)
 * đi qua Worker tới Google và theo điều khoản free tier có thể được Google
 * dùng để cải thiện sản phẩm — màn Cài đặt AI nói rõ điều này. Ảnh/ghi âm
 * gửi lên chỉ để AI xử lý rồi thôi, Worker không lưu file.
 */

import * as FileSystem from 'expo-file-system/legacy';
import type { ItemCategory, ItemCondition } from '@/types';
import { getCloudApiUrl, getOrCreateCloudAccount } from './storagePlanService';

/** Lỗi AI hiển thị được cho người dùng (thông điệp đã do Worker dịch sẵn). */
export class AiError extends Error {}

async function callAi(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { accountId } = await getOrCreateCloudAccount();
  const base = (await getCloudApiUrl()).trim().replace(/\/$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(`${base}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, accountId }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      throw new AiError(
        typeof data?.message === 'string' && data.message ? data.message : `AI lỗi (HTTP ${res.status})`,
      );
    }
    return data;
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e instanceof Error && e.name === 'AbortError') throw new AiError('AI phản hồi quá chậm, thử lại');
    throw new AiError(e instanceof Error ? `Không gọi được AI (${e.message})` : 'Không gọi được AI');
  } finally {
    clearTimeout(timer);
  }
}

function mimeFor(uri: string, kind: 'audio' | 'image'): string {
  const ext = uri.split('.').pop()?.toLowerCase() ?? '';
  if (kind === 'audio') {
    if (ext === 'wav') return 'audio/wav';
    if (ext === 'mp3') return 'audio/mp3';
    if (ext === 'ogg') return 'audio/ogg';
    return 'audio/aac';
  }
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

async function readBase64(uri: string): Promise<string> {
  return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
}

/** Chatbot: trả lời từ lịch sử chat + ngữ cảnh đồ/vị trí (chuỗi tóm tắt). */
export async function aiChat(
  history: { role: 'user' | 'model'; text: string }[],
  message: string,
  context: string,
): Promise<string> {
  const data = await callAi({ task: 'chat', history, message, context });
  if (typeof data.text !== 'string' || !data.text.trim()) throw new AiError('AI trả về rỗng, thử lại');
  return data.text;
}

export interface VoiceItemDraft {
  transcript: string;
  name: string;
  quantity: number;
  unit: string;
  category: ItemCategory;
  condition: ItemCondition;
  position_note: string;
}

/** Nghe file ghi âm → bản ghi tiếng Việt + tách thành trường món đồ. */
export async function aiTranscribeAndParse(audioUri: string): Promise<VoiceItemDraft> {
  const audioBase64 = await readBase64(audioUri);
  const data = await callAi({ task: 'voice', audioBase64, audioMime: mimeFor(audioUri, 'audio') });
  const d = data.data as Record<string, unknown> | undefined;
  if (!d) throw new AiError('AI không hiểu đoạn ghi âm, thử nói lại rõ hơn');
  return {
    transcript: typeof d.transcript === 'string' ? d.transcript : '',
    name: typeof d.name === 'string' ? d.name : '',
    quantity: typeof d.quantity === 'number' ? d.quantity : 1,
    unit: typeof d.unit === 'string' ? d.unit : 'Cái',
    category: d.category as ItemCategory,
    condition: d.condition as ItemCondition,
    position_note: typeof d.position_note === 'string' ? d.position_note : '',
  };
}

export interface PhotoDraft {
  name: string;
  category: ItemCategory;
  condition: ItemCondition;
  note: string;
}

/** Nhìn ảnh đồ vật → đoán tên/phân loại/tình trạng. */
export async function aiDescribePhoto(photoUri: string): Promise<PhotoDraft> {
  const imageBase64 = await readBase64(photoUri);
  const data = await callAi({ task: 'vision', imageBase64, imageMime: mimeFor(photoUri, 'image') });
  const d = data.data as Record<string, unknown> | undefined;
  if (!d) throw new AiError('AI không nhận ra đồ vật trong ảnh');
  return {
    name: typeof d.name === 'string' ? d.name : '',
    category: d.category as ItemCategory,
    condition: d.condition as ItemCondition,
    note: typeof d.note === 'string' ? d.note : '',
  };
}
