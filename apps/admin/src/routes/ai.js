import { json, err, readJson } from '../lib/http.js';

// AI qua Gemini gói miễn phí — khách KHÔNG cần key, KHÔNG cài đặt gì.
// App gọi POST /api/ai, Worker giữ key trong secret GEMINI_API_KEY (gắn
// trên dashboard Cloudflare: Workers → smartstash-admin → Settings →
// Variables and Secrets; KHÔNG nằm trong code, repo hay app) rồi gọi Google.
//
// Giới hạn để khỏi cháy quota free chung. Quota Gemini tính theo PROJECT
// (không phải theo key) nên 1 key dùng chung cho mọi khách. Model chốt
// 28/10/2026 là Flash-Lite (free ~1000 request/ngày, vẫn nhận chữ + ảnh
// + tiếng) thay cho Flash (chỉ ~250/ngày — 100 lượt/máy nuôi được có 2
// máy nặng). Vì vậy Worker chặn 2 tầng bằng KV CONFIG (key tự hết hạn
// sau 25h):
//   - mỗi máy (accountId ẩn danh của app): 100 lượt/ngày
//   - toàn hệ thống: 800 lượt/ngày (chừa 200 lượt đệm dưới trần 1000)
// Vượt → 429, app hiện rõ lý do. Chưa gắn secret → 503, app báo AI chưa
// được bật. Chỉ lượt gọi Gemini THÀNH CÔNG mới tính vào hạn mức (lỗi
// mạng/key sai không đốt lượt của khách). Đếm KV không nguyên tử nên
// con số là chặn mềm, đủ cho mục đích chống cháy quota — không phải
// thanh toán nên không cần chính xác tuyệt đối.

const MODEL = 'gemini-2.5-flash-lite';
const PER_DEVICE_PER_DAY = 100;
const GLOBAL_PER_DAY = 800;

const CATEGORIES = ['ELECTRONICS', 'MEDICINE', 'FOOD', 'KITCHENWARE', 'DOCUMENTS', 'CLOTHING', 'TOOLS', 'KIDS', 'HOUSEHOLD', 'SPORTS', 'BOOKS', 'OTHER'];
const CONDITIONS = ['NEW', 'GOOD', 'WORN', 'NEED_REPAIR', 'BROKEN'];

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normCategory(v) {
  return typeof v === 'string' && CATEGORIES.includes(v) ? v : 'OTHER';
}

function normCondition(v) {
  return typeof v === 'string' && CONDITIONS.includes(v) ? v : 'GOOD';
}

const CHAT_SYSTEM = `Bạn là trợ lý AI của app SmartStash — Kho Đồ Số, app quản lý đồ đạc cá nhân offline-first (tab Trang chủ, Thêm đồ, Vị trí, Cho mượn, Cài đặt). Trả lời NGẮN GỌN bằng tiếng Việt, hướng dẫn đúng thao tác trong app, không bịa tính năng chưa có. Khi người dùng hỏi đồ ở đâu, chỉ dùng danh sách đồ/vị trí dưới đây; món nào không có trong danh sách thì nói thẳng là không tìm thấy, không đoán.`;

export async function handleAi(request, env) {
  const body = await readJson(request);
  if (body.__invalid) return err('bad_request', 'Dữ liệu gửi lên không hợp lệ.', 400);
  const { task, accountId } = body;
  if (!['chat', 'vision', 'voice'].includes(task)) {
    return err('bad_request', 'Nhiệm vụ AI không hợp lệ.', 400);
  }
  if (typeof accountId !== 'string' || !accountId || accountId.length > 64) {
    return err('bad_request', 'Thiếu mã máy.', 400);
  }
  const key = env.GEMINI_API_KEY;
  if (!key) {
    return err('ai_not_configured', 'AI chưa được bật trên máy chủ, thử lại sau.', 503);
  }

  const day = new Date().toISOString().slice(0, 10);
  const kv = env.CONFIG;
  const devKey = `ai:day:${day}:device:${accountId}`;
  const gloKey = `ai:day:${day}:global`;
  const devCount = parseInt((await kv.get(devKey)) || '0', 10);
  if (devCount >= PER_DEVICE_PER_DAY) {
    return err('ai_limit', 'Hôm nay bạn đã dùng hết 100 lượt AI miễn phí, mai thử lại nhé.', 429);
  }
  const gloCount = parseInt((await kv.get(gloKey)) || '0', 10);
  if (gloCount >= GLOBAL_PER_DAY) {
    return err('ai_limit', 'Hôm nay hệ thống đã hết lượt AI miễn phí, mai thử lại nhé.', 429);
  }

  let parts;
  let systemInstruction;
  let jsonMode = false;
  if (task === 'chat') {
    if (typeof body.message !== 'string' || !body.message.trim()) {
      return err('bad_request', 'Thiếu câu hỏi.', 400);
    }
    systemInstruction = `${CHAT_SYSTEM}\n\nĐỒ VÀ VỊ TRÍ HIỆN CÓ:\n${typeof body.context === 'string' ? body.context : '(chưa có món nào)'}`;
    parts = [{ text: body.message }];
  } else if (task === 'vision') {
    if (typeof body.imageBase64 !== 'string' || !body.imageBase64) {
      return err('bad_request', 'Thiếu ảnh.', 400);
    }
    jsonMode = true;
    parts = [
      { inline_data: { mime_type: body.imageMime || 'image/jpeg', data: body.imageBase64 } },
      { text: `Nhìn ảnh này và trả về DUY NHẤT một JSON: {"name": "tên đồ vật bằng tiếng Việt, ngắn gọn", "category": một trong ${CATEGORIES.join(',')}, "condition": một trong ${CONDITIONS.join(',')}, "note": "mô tả ngắn 1 câu về đồ vật trong ảnh"}. Chỉ đoán đồ vật chính giữa ảnh; nếu không nhận ra thì name để trống.` },
    ];
  } else {
    if (typeof body.audioBase64 !== 'string' || !body.audioBase64) {
      return err('bad_request', 'Thiếu ghi âm.', 400);
    }
    jsonMode = true;
    parts = [
      { inline_data: { mime_type: body.audioMime || 'audio/aac', data: body.audioBase64 } },
      { text: `Nghe đoạn ghi âm tiếng Việt này và trả về DUY NHẤT một JSON: {"transcript": "toàn bộ lời nói", "name": "tên đồ vật", "quantity": số lượng (mặc định 1), "unit": "đơn vị, mặc định Cái", "category": một trong ${CATEGORIES.join(',')}, "condition": một trong ${CONDITIONS.join(',')}, "position_note": "ghi chú vị trí nếu người nói nhắc tới, không có thì để trống"}. Nếu không nghe rõ tên đồ thì name để trống.` },
    ];
  }

  // Lịch sử chat (nếu có): chỉ task chat mới kèm, tối đa 20 lượt gần nhất
  // để prompt không phình; mỗi lượt là { role: 'user'|'model', text }.
  const contents = [];
  if (task === 'chat' && Array.isArray(body.history)) {
    for (const h of body.history.slice(-20)) {
      if (h && (h.role === 'user' || h.role === 'model') && typeof h.text === 'string') {
        contents.push({ role: h.role, parts: [{ text: h.text }] });
      }
    }
  }
  contents.push({ role: 'user', parts });

  const geminiBody = { contents };
  if (systemInstruction) geminiBody.system_instruction = { parts: [{ text: systemInstruction }] };
  if (jsonMode) geminiBody.generationConfig = { response_mime_type: 'application/json' };

  let res;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) },
    );
  } catch {
    return err('ai_upstream', 'Không gọi được Gemini, thử lại sau.', 502);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 429) {
      return err('ai_quota', 'Gemini đang quá tải (hết quota miễn phí trong phút này), thử lại sau ít phút.', 429);
    }
    return err('ai_upstream', 'Gemini lỗi, thử lại sau.', 502);
  }
  const text = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('');
  if (!text.trim()) return err('ai_empty', 'AI trả về rỗng, thử lại.', 502);

  // Thành công mới tính lượt.
  await kv.put(devKey, String(devCount + 1), { expirationTtl: 90000 });
  await kv.put(gloKey, String(gloCount + 1), { expirationTtl: 90000 });

  if (task === 'chat') return json({ ok: true, text });
  const parsed = extractJson(text);
  if (!parsed) return err('ai_empty', 'AI không hiểu, thử lại.', 502);
  if (task === 'vision') {
    return json({
      ok: true,
      data: {
        name: typeof parsed.name === 'string' ? parsed.name.trim() : '',
        category: normCategory(parsed.category),
        condition: normCondition(parsed.condition),
        note: typeof parsed.note === 'string' ? parsed.note.trim() : '',
      },
    });
  }
  const qty = typeof parsed.quantity === 'number' && parsed.quantity >= 1 ? Math.floor(parsed.quantity) : 1;
  return json({
    ok: true,
    data: {
      transcript: typeof parsed.transcript === 'string' ? parsed.transcript : '',
      name: typeof parsed.name === 'string' ? parsed.name.trim() : '',
      quantity: qty,
      unit: typeof parsed.unit === 'string' && parsed.unit.trim() ? parsed.unit.trim() : 'Cái',
      category: normCategory(parsed.category),
      condition: normCondition(parsed.condition),
      position_note: typeof parsed.position_note === 'string' ? parsed.position_note.trim() : '',
    },
  });
}
