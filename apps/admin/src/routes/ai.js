import { json, err, readJson } from '../lib/http.js';

// AI qua Gemini gói miễn phí — khách KHÔNG cần key, KHÔNG cài đặt gì.
// App gọi POST /api/ai, Worker giữ key trong secret (gắn trên dashboard
// Cloudflare: Workers → smartstash-admin → Settings → Variables and
// Secrets; KHÔNG nằm trong code, repo hay app) rồi gọi nhà cung cấp.
//
// Nhà cung cấp (28/10/2026, người dùng chốt "Flash-Lite + Groq"):
//   - CHÍNH: Gemini 2.5 Flash-Lite (free ~1000 request/ngày, nhận chữ +
//     ảnh + tiếng trong cùng một API).
//   - DỰ PHÒNG: Groq (free, không cần thẻ) — chỉ gọi khi Gemini lỗi/hết
//     quota: chat bằng gpt-oss-120b (1000/ngày), giọng nói bằng Whisper
//     large-v3-turbo (1000/ngày) rồi tách trường bằng gpt-oss-120b, ảnh
//     bằng qwen3.8-27b có vision (250/ngày). Vì chỉ là dự phòng nên quota
//     Groq hiếm khi chạm tới.
// Quota Gemini tính theo PROJECT (không phải theo key) nên 1 key dùng
// chung cho mọi khách. Worker chặn 2 tầng bằng KV CONFIG (key tự hết
// hạn sau 25h):
//   - mỗi máy (accountId ẩn danh của app): 100 lượt/ngày
//   - toàn hệ thống: 800 lượt/ngày (chừa 200 lượt đệm dưới trần 1000)
// Vượt → 429, app hiện rõ lý do. Chưa gắn secret nào → 503. Chỉ lượt
// gọi THÀNH CÔNG (dù qua nhà cung cấp nào) mới tính vào hạn mức. Đếm
// KV không nguyên tử nên con số là chặn mềm, đủ cho mục đích chống
// cháy quota — không phải thanh toán nên không cần chính xác tuyệt đối.

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const GROQ_CHAT_MODEL = 'openai/gpt-oss-120b';
const GROQ_WHISPER_MODEL = 'whisper-large-v3-turbo';
const GROQ_VISION_MODEL = 'qwen/qwen3.8-27b';
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

function normVision(parsed) {
  return {
    name: typeof parsed.name === 'string' ? parsed.name.trim() : '',
    category: normCategory(parsed.category),
    condition: normCondition(parsed.condition),
    note: typeof parsed.note === 'string' ? parsed.note.trim() : '',
  };
}

function normVoice(parsed) {
  const qty = typeof parsed.quantity === 'number' && parsed.quantity >= 1 ? Math.floor(parsed.quantity) : 1;
  return {
    transcript: typeof parsed.transcript === 'string' ? parsed.transcript : '',
    name: typeof parsed.name === 'string' ? parsed.name.trim() : '',
    quantity: qty,
    unit: typeof parsed.unit === 'string' && parsed.unit.trim() ? parsed.unit.trim() : 'Cái',
    category: normCategory(parsed.category),
    condition: normCondition(parsed.condition),
    position_note: typeof parsed.position_note === 'string' ? parsed.position_note.trim() : '',
  };
}

const CHAT_SYSTEM = `Bạn là trợ lý AI của app SmartStash — Kho Đồ Số, app quản lý đồ đạc cá nhân offline-first (tab Trang chủ, Thêm đồ, Vị trí, Cho mượn, Cài đặt). Trả lời NGẮN GỌN bằng tiếng Việt, hướng dẫn đúng thao tác trong app, không bịa tính năng chưa có. Khi người dùng hỏi đồ ở đâu, chỉ dùng danh sách đồ/vị trí dưới đây; món nào không có trong danh sách thì nói thẳng là không tìm thấy, không đoán.`;

const VISION_PROMPT = `Nhìn ảnh này và trả về DUY NHẤT một JSON: {"name": "tên đồ vật bằng tiếng Việt, ngắn gọn", "category": một trong ${CATEGORIES.join(',')}, "condition": một trong ${CONDITIONS.join(',')}, "note": "mô tả ngắn 1 câu về đồ vật trong ảnh"}. Chỉ đoán đồ vật chính giữa ảnh; nếu không nhận ra thì name để trống.`;

const VOICE_EXTRACT_PROMPT = `Trả về DUY NHẤT một JSON từ bản ghi tiếng Việt sau: {"transcript": "toàn bộ lời nói", "name": "tên đồ vật", "quantity": số lượng (mặc định 1), "unit": "đơn vị, mặc định Cái", "category": một trong ${CATEGORIES.join(',')}, "condition": một trong ${CONDITIONS.join(',')}, "position_note": "ghi chú vị trí nếu người nói nhắc tới, không có thì để trống"}. Nếu không nghe rõ tên đồ thì name để trống.`;

/** Lỗi nội bộ của một nhà cung cấp (để tầng trên quyết định fallback). */
class ProviderError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------- Gemini (chính) ----------

async function callGemini(key, task, body) {
  let parts;
  let systemInstruction;
  let jsonMode = false;
  if (task === 'chat') {
    systemInstruction = `${CHAT_SYSTEM}\n\nĐỒ VÀ VỊ TRÍ HIỆN CÓ:\n${typeof body.context === 'string' ? body.context : '(chưa có món nào)'}`;
    parts = [{ text: body.message }];
  } else if (task === 'vision') {
    jsonMode = true;
    parts = [
      { inline_data: { mime_type: body.imageMime || 'image/jpeg', data: body.imageBase64 } },
      { text: VISION_PROMPT },
    ];
  } else {
    jsonMode = true;
    parts = [
      { inline_data: { mime_type: body.audioMime || 'audio/aac', data: body.audioBase64 } },
      { text: `Nghe đoạn ghi âm tiếng Việt này và trả về DUY NHẤT một JSON: {"transcript": "toàn bộ lời nói", "name": "tên đồ vật", "quantity": số lượng (mặc định 1), "unit": "đơn vị, mặc định Cái", "category": một trong ${CATEGORIES.join(',')}, "condition": một trong ${CONDITIONS.join(',')}, "position_note": "ghi chú vị trí nếu người nói nhắc tới, không có thì để trống"}. Nếu không nghe rõ tên đồ thì name để trống.` },
    ];
  }

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
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) },
    );
  } catch {
    throw new ProviderError('ai_upstream', 'Không gọi được Gemini, thử lại sau.', 502);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 429) {
      throw new ProviderError('ai_quota', 'Gemini đang quá tải (hết quota miễn phí trong phút này), thử lại sau ít phút.', 429);
    }
    throw new ProviderError('ai_upstream', 'Gemini lỗi, thử lại sau.', 502);
  }
  const text = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('');
  if (!text.trim()) throw new ProviderError('ai_empty', 'AI trả về rỗng, thử lại.', 502);
  if (task === 'chat') return { text };
  const parsed = extractJson(text);
  if (!parsed) throw new ProviderError('ai_empty', 'AI không hiểu, thử lại.', 502);
  return { data: task === 'vision' ? normVision(parsed) : normVoice(parsed) };
}

// ---------- Groq (dự phòng) ----------

async function groqChat(key, messages) {
  let res;
  try {
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: GROQ_CHAT_MODEL, messages }),
    });
  } catch {
    throw new ProviderError('ai_upstream', 'Không gọi được Groq, thử lại sau.', 502);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 429) {
      throw new ProviderError('ai_quota', 'Groq đang quá tải, thử lại sau ít phút.', 429);
    }
    throw new ProviderError('ai_upstream', 'Groq lỗi, thử lại sau.', 502);
  }
  const text = data?.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) throw new ProviderError('ai_empty', 'AI trả về rỗng, thử lại.', 502);
  return text;
}

async function callGroq(key, task, body) {
  if (task === 'chat') {
    const messages = [{ role: 'system', content: `${CHAT_SYSTEM}\n\nĐỒ VÀ VỊ TRÍ HIỆN CÓ:\n${typeof body.context === 'string' ? body.context : '(chưa có món nào)'}` }];
    if (Array.isArray(body.history)) {
      for (const h of body.history.slice(-20)) {
        // App gửi history với role 'model' (chuẩn Gemini); Groq cần 'assistant'.
        if (h && (h.role === 'user' || h.role === 'model' || h.role === 'assistant') && typeof h.text === 'string') {
          messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text });
        }
      }
    }
    messages.push({ role: 'user', content: body.message });
    return { text: await groqChat(key, messages) };
  }
  if (task === 'vision') {
    let res;
    try {
      res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: GROQ_VISION_MODEL,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: VISION_PROMPT },
              { type: 'image_url', image_url: { url: `data:${body.imageMime || 'image/jpeg'};base64,${body.imageBase64}` } },
            ],
          }],
        }),
      });
    } catch {
      throw new ProviderError('ai_upstream', 'Không gọi được Groq, thử lại sau.', 502);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 429) throw new ProviderError('ai_quota', 'Groq đang quá tải, thử lại sau ít phút.', 429);
      throw new ProviderError('ai_upstream', 'Groq lỗi, thử lại sau.', 502);
    }
    const text = data?.choices?.[0]?.message?.content ?? '';
    const parsed = extractJson(text);
    if (!parsed) throw new ProviderError('ai_empty', 'AI không hiểu, thử lại.', 502);
    return { data: normVision(parsed) };
  }
  // voice: Whisper nghe → transcript, rồi gpt-oss tách trường.
  const form = new FormData();
  form.append('file', new Blob([b64ToBytes(body.audioBase64)], { type: body.audioMime || 'audio/aac' }), 'audio.m4a');
  form.append('model', GROQ_WHISPER_MODEL);
  let res;
  try {
    res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
  } catch {
    throw new ProviderError('ai_upstream', 'Không gọi được Groq, thử lại sau.', 502);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 429) throw new ProviderError('ai_quota', 'Groq đang quá tải, thử lại sau ít phút.', 429);
    throw new ProviderError('ai_upstream', 'Groq lỗi, thử lại sau.', 502);
  }
  const transcript = typeof data?.text === 'string' ? data.text : '';
  if (!transcript.trim()) throw new ProviderError('ai_empty', 'AI không nghe rõ, thử nói lại.', 502);
  const extracted = await groqChat(key, [
    { role: 'user', content: `${VOICE_EXTRACT_PROMPT}\n\nBẢN GHI:\n${transcript}` },
  ]);
  const parsed = extractJson(extracted);
  if (!parsed) throw new ProviderError('ai_empty', 'AI không hiểu, thử lại.', 502);
  parsed.transcript = transcript;
  return { data: normVoice(parsed) };
}

// ---------- Route ----------

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
  if (task === 'chat' && (typeof body.message !== 'string' || !body.message.trim())) {
    return err('bad_request', 'Thiếu câu hỏi.', 400);
  }
  if (task === 'vision' && (typeof body.imageBase64 !== 'string' || !body.imageBase64)) {
    return err('bad_request', 'Thiếu ảnh.', 400);
  }
  if (task === 'voice' && (typeof body.audioBase64 !== 'string' || !body.audioBase64)) {
    return err('bad_request', 'Thiếu ghi âm.', 400);
  }

  const geminiKey = env.GEMINI_API_KEY;
  const groqKey = env.GROQ_API_KEY;
  if (!geminiKey && !groqKey) {
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

  // Thử Gemini trước, lỗi thì thử Groq; cả hai cùng lỗi thì trả lỗi đầu.
  let result = null;
  let firstErr = null;
  if (geminiKey) {
    try {
      result = await callGemini(geminiKey, task, body);
    } catch (e) {
      firstErr = e instanceof ProviderError ? e : new ProviderError('ai_upstream', 'Gemini lỗi, thử lại sau.', 502);
    }
  }
  if (!result && groqKey) {
    try {
      result = await callGroq(groqKey, task, body);
    } catch (e) {
      if (!firstErr) firstErr = e instanceof ProviderError ? e : new ProviderError('ai_upstream', 'Groq lỗi, thử lại sau.', 502);
    }
  }
  if (!result) {
    const e = firstErr || new ProviderError('ai_upstream', 'AI lỗi, thử lại sau.', 502);
    return err(e.code, e.message, e.status);
  }

  // Thành công mới tính lượt.
  await kv.put(devKey, String(devCount + 1), { expirationTtl: 90000 });
  await kv.put(gloKey, String(gloCount + 1), { expirationTtl: 90000 });
  return json({ ok: true, ...result });
}
