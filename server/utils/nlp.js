// Lightweight NLP helpers: intent detection and sentiment analysis
// No external deps so it works out-of-the-box. Optionally uses OpenAI if configured.

import dotenv from 'dotenv';
import path from 'path';
import { spawn } from 'child_process';

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
const NEGATIVE = ['nggak', 'g','ngga', 'gak', 'ga', 'enggak', 'tidak', 'tdk', 'gagal', 'error', 'buruk', 'buruk sekali', 'jelek', 'jelek banget', 'sulit', 'susah', 'lambat', 'lemot', 'lag', 'down', 'hang', 'crash', 'bug', 'buggy', 'fail', 'broken', 'parah', 'payah', 'mengecewakan', 'ribet', 'bingung', 'ga jelas', 'tidak jelas', 'kurang jelas', 'tidak membantu', 'ga membantu', 'tidak sesuai', 'salah', 'keliru', 'tidak akurat', 'kurang akurat', 'tidak tepat', 'kurang tepat', 'tidak memuaskan', 'kurang memuaskan', 'tidak puas', 'kurang puas', 'tidak cocok', 'kurang cocok', 'tidak berguna', 'ga berguna', 'tidak relevan', 'kurang relevan', 'tidak menjawab', 'ga menjawab', 'tidak menjawab pertanyaan', 'ga menjawab pertanyaan', 'jawabannya salah', 'jawaban salah', 'jawabannya tidak tepat', 'jawaban tidak tepat', 'jawabannya kurang jelas', 'jawaban kurang jelas'];

const USE_OPENAI_NLP = (process.env.NLP_USE_OPENAI || 'false').toLowerCase() === 'true';
const USE_PY_SENTIMENT = (process.env.NLP_USE_PYTHON || 'false').toLowerCase() === 'true';
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

  // Tokenize to avoid substring false positives (e.g., 'tidak' inside a longer word)
  const tokens = (t.match(/[a-z0-9]+/gi) || []).map((w) => w.toLowerCase());
  const hasToken = (w) => tokens.includes(w.toLowerCase());

  // exact punctuation-based question heuristic comes first
  if (t.includes('?')) return 'question';

  // Scoring-based keyword matching with clear priorities
  const priorities = ['complaint', 'ask_document', 'feedback', 'greeting', 'goodbye'];
  const scores = Object.fromEntries(Object.keys(INTENT_KEYWORDS).map((k) => [k, 0]));

  const countHit = (key) => {
    const k = key.toLowerCase().trim();
    if (!k) return 0;
    // Multi-word or phrase: use substring check
    if (k.includes(' ') || /[^a-z0-9]/i.test(k)) return t.includes(k) ? 1 : 0;
    // Single word: token-based exact match
    return hasToken(k) ? 1 : 0;
  };

  for (const [intent, keys] of Object.entries(INTENT_KEYWORDS)) {
    let s = 0;
    for (const k of keys) s += countHit(k);
    scores[intent] = s;
  }

  // praise -> kepuasan (only if not a question)
  let isPraise = false;
  for (const p of POSITIVE) {
    if ((p.includes(' ') && t.includes(p)) || (!p.includes(' ') && hasToken(p))) {
      isPraise = true;
      break;
    }
  }

  // Pick the highest-scoring intent with tie-breakers by priority
  let best = { intent: 'unknown', score: 0 };
  for (const intent of priorities) {
    const sc = scores[intent] || 0;
    if (sc > 0 && (sc > best.score || (sc === best.score && best.intent === 'unknown'))) {
      best = { intent, score: sc };
    }
  }

  if (best.intent !== 'unknown') return best.intent;

  // short heuristics
  if (tokens.length <= 2) return 'short_statement';

  // fallback: kepuasan if praise terms appear
  if (isPraise) return 'kepuasan';

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

  const label = score > 0 ? 'positive' : score < -0.15 ? 'negative' : 'neutral';
  return { score, label };
}

async function analyzeSentimentPython(text) {
  if (!USE_PY_SENTIMENT) return null;
  try {
    const here = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
    const baseDir = path.resolve(here, '..'); // server/utils -> server
    const scriptPath = path.resolve(baseDir, 'tools', 'sentiment_pipeline.py');
    const pyBins = [process.env.PYTHON_BIN || 'python', 'py'];
    const payload = JSON.stringify({ text: String(text || '') });

    for (const bin of pyBins) {
      try {
        const proc = spawn(bin, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => (stdout += d.toString()));
        proc.stderr.on('data', (d) => (stderr += d.toString()));

        proc.stdin.write(payload);
        proc.stdin.end();

        const result = await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            try { proc.kill(); } catch {}
            resolve(null);
          }, 8000);

          proc.on('close', () => {
            clearTimeout(timeout);
            try {
              const obj = JSON.parse(stdout || '{}');
              resolve(obj && !obj.error ? obj : null);
            } catch {
              resolve(null);
            }
          });
        });

        if (result && typeof result.score === 'number' && result.label) {
          return { score: result.score, label: result.label, _raw: result };
        }
      } catch {
        // try next bin
      }
    }
  } catch {
    // ignore and fallback
  }
  return null;
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
  // Try Python pipeline first if enabled
  if (USE_PY_SENTIMENT) {
    try {
      const py = await analyzeSentimentPython(text);
      if (py) {
        let intent = detectIntent(text);
        if (intent === 'unknown' && py.label === 'positive') {
          intent = 'kepuasan';
        }
        return { intent, sentiment: { score: py.score, label: py.label }, meta: { py } };
      }
    } catch {}
  }

  if (USE_OPENAI_NLP) {
    const ai = await analyzeMessageOpenAI(text);
    if (ai) return ai;
  }
  let intent = detectIntent(text);
  const sentiment = analyzeSentiment(text);
  if (intent === 'unknown' && sentiment.score > 0.15) {
    intent = 'kepuasan';
  }
  return { intent, sentiment };
}

export default { detectIntent, analyzeSentiment, analyzeMessage };
