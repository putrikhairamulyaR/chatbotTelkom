// Lightweight NLP helpers: intent detection and sentiment analysis
// No external deps so it works out-of-the-box. Optionally uses OpenAI if configured.

import dotenv from 'dotenv';

dotenv.config();

const INTENT_KEYWORDS = {
  greeting: ['hello', 'hi', 'hey', 'selamat', 'halo', 'hallo', 'hai', 'hy', 'assalamualaikum', 'pagi', 'siang', 'sore', 'malam', 'good morning', 'morning', 'good afternoon', 'afternoon', 'good evening', 'evening'],
  goodbye: ['bye', 'bye bye', 'see you', 'sampai', 'sampai jumpa', 'sampai nanti', 'dadah', 'daa', 'goodbye', 'terima kasih, bye', 'makasih, bye'],
  question: ['?', 'apa', 'apa itu', 'apakah', 'mengapa', 'kenapa', 'kapan', 'bagaimana', 'gimana', 'gmn', 'berapa', 'siapa', 'dimana', 'di mana', 'dapatkah', 'bisa kah', 'bolehkah'],
  ask_document: ['dokumen', 'dokumennya', 'dok', 'file', 'pdf', 'paper', 'artikel', 'sumber', 'referensi', 'lampiran', 'berkas', 'aturan', 'pedoman', 'panduan', 'surat', 'sk', 'peraturan', 'permen', 'link', 'contoh', 'template'],
  complaint: ['tidak', 'tdk', 'ga', 'gak', 'ngga', 'enggak', 'tidak bisa', 'gabisa', 'nggak bisa', 'error', 'gagal', 'buruk', 'jelek', 'sulit', 'susah', 'lambat', 'lemot', 'lag', 'down', 'hang', 'crash', 'bug', 'buggy', 'salah', 'tidak akurat', 'bingung', 'ribet', 'mengecewakan', 'payah', 'parah'],
  feedback: ['saran', 'masukan', 'feedback', 'kritik', 'usul', 'ide', 'feature request', 'bagusnya', 'sebaiknya', 'mungkin bisa', 'tolong tambahkan']
};

const POSITIVE = ['baik', 'bagus', 'bagus banget', 'terima kasih', 'terimakasih', 'makasih', 'thanks', 'thank you', 'ok', 'oke', 'okay', 'okey', 'okeyy', 'sip', 'sippp', 'siap', 'mantap', 'mantul', 'mantap jiwa', 'sangat baik', 'love', 'great', 'awesome', 'excellent', 'keren', 'top', 'nice', 'helpful', 'bermanfaat'];
const NEGATIVE = ['nggak', 'ngga', 'gak', 'ga', 'enggak', 'tidak', 'tdk', 'gagal', 'error', 'buruk', 'buruk sekali', 'jelek', 'jelek banget', 'sulit', 'susah', 'lambat', 'lemot', 'lag', 'down', 'hang', 'crash', 'bug', 'buggy', 'fail', 'broken', 'parah', 'payah', 'mengecewakan', 'ribet', 'bingung', 'ga jelas', 'tidak jelas', 'kurang jelas', 'tidak membantu', 'ga membantu', 'tidak sesuai', 'salah', 'keliru', 'tidak akurat', 'kurang akurat', 'tidak tepat', 'kurang tepat', 'tidak memuaskan', 'kurang memuaskan', 'tidak puas', 'kurang puas', 'tidak cocok', 'kurang cocok', 'tidak berguna', 'ga berguna', 'tidak relevan', 'kurang relevan', 'tidak menjawab', 'ga menjawab', 'tidak menjawab pertanyaan', 'ga menjawab pertanyaan', 'jawabannya salah', 'jawaban salah', 'jawabannya tidak tepat', 'jawaban tidak tepat', 'jawabannya kurang jelas', 'jawaban kurang jelas'];

const USE_OPENAI_NLP = (process.env.NLP_USE_OPENAI || 'false').toLowerCase() === 'true';
let openai = null;
let openaiInitTried = false;

async function ensureOpenAI() {
  if (!USE_OPENAI_NLP || openai) return openai;
  if (openaiInitTried) return openai;
  openaiInitTried = true;
  try {
    const mod = await import('openai');
    const OpenAIClient = mod && (mod.default || mod.OpenAI || mod);
    openai = new OpenAIClient({ apiKey: process.env.OPENAI_API_KEY });
  } catch (e) {
    console.warn('[nlp] OpenAI client unavailable, falling back to heuristics:', e && e.message);
    openai = null;
  }
  return openai;
}

function normalize(text) {
  return String(text || '').toLowerCase();
}

export function detectIntent(text) {
  const t = normalize(text);
  if (!t) return 'unknown';

  // exact punctuation-based question heuristic
  if (t.includes('?')) return 'question';

  // keyword match
  for (const [intent, keys] of Object.entries(INTENT_KEYWORDS)) {
    for (const k of keys) {
      if (t.includes(k)) return intent;
    }
  }

  // short heuristics
  if (t.split(' ').length <= 2) {
    return 'short_statement';
  }
  return 'unknown';
}

// simple sentiment: +1..-1
export function analyzeSentiment(text) {
  const t = normalize(text);
  if (!t) return { score: 0, label: 'neutral' };
  let score = 0;
  for (const p of POSITIVE) if (t.includes(p)) score += 1;
  for (const n of NEGATIVE) if (t.includes(n)) score -= 1;

  // scale to -1..1
  if (score > 0) score = Math.min(1, score / 3);
  else if (score < 0) score = Math.max(-1, score / 3);

  const label = score > 0.15 ? 'positive' : score < -0.15 ? 'negative' : 'neutral';
  return { score, label };
}

async function analyzeMessageOpenAI(text) {
  const client = await ensureOpenAI();
  if (!client) return null;
  const prompt = `Analyze the following user message. Return strict JSON with keys: intent (one of greeting, goodbye, question, ask_document, complaint, feedback, short_statement, unknown), sentiment_label (positive|neutral|negative), sentiment_score (number -1..1). Message: "${String(text || '').replace(/"/g, '\\"')}"`;
  try {
    if (client.responses) {
      const resp = await client.responses.create({ model: process.env.NLP_OPENAI_MODEL || 'gpt-4o-mini', input: prompt, temperature: 0 });
      const out = (resp && resp.output && resp.output[0] && resp.output[0].content && resp.output[0].content[0] && resp.output[0].content[0].text) || (resp && resp.output_text);
      const parsed = JSON.parse(out || '{}');
      return {
        intent: parsed.intent || 'unknown',
        sentiment: { score: typeof parsed.sentiment_score === 'number' ? parsed.sentiment_score : 0, label: parsed.sentiment_label || 'neutral' }
      };
    }
    if (client.chat && client.chat.completions) {
      const r = await client.chat.completions.create({ model: process.env.NLP_OPENAI_MODEL || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0 });
      const txt = r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
      const parsed = JSON.parse(txt || '{}');
      return {
        intent: parsed.intent || 'unknown',
        sentiment: { score: typeof parsed.sentiment_score === 'number' ? parsed.sentiment_score : 0, label: parsed.sentiment_label || 'neutral' }
      };
    }
  } catch (e) {
    console.warn('[nlp] OpenAI analysis failed, fallback to heuristic:', e && e.message);
  }
  return null;
}

// convenience combined function
export async function analyzeMessage(text) {
  if (USE_OPENAI_NLP) {
    const ai = await analyzeMessageOpenAI(text);
    if (ai) return ai;
  }
  const intent = detectIntent(text);
  const sentiment = analyzeSentiment(text);
  return { intent, sentiment };
}

export default { detectIntent, analyzeSentiment, analyzeMessage };
