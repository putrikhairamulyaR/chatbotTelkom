// Lightweight NLP helpers: intent detection and sentiment analysis
// No external deps so it works out-of-the-box. Optionally uses OpenAI if configured.
// Prefer Python pipeline for sentiment when NLP_USE_PYTHON=true (no heuristic fallback for sentiment).

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

dotenv.config();

const INTENT_KEYWORDS = {
  greeting: [
    'hello', 'hi', 'hey', 'selamat', 'halo', 'hallo', 'hai', 'hy', 'assalamualaikum',
    'pagi', 'siang', 'sore', 'malam',
    'good morning', 'morning', 'good afternoon', 'afternoon', 'good evening', 'evening'
  ],
  goodbye: ['bye', 'bye bye', 'see you', 'sampai', 'sampai jumpa', 'sampai nanti', 'dadah', 'daa', 'goodbye', 'terima kasih, bye', 'makasih, bye'],
  question: ['?', 'apa', 'apa itu', 'apakah', 'mengapa', 'kenapa', 'kapan', 'bagaimana', 'gimana', 'gmn', 'berapa', 'siapa', 'dimana', 'di mana', 'dapatkah', 'bisa kah', 'bolehkah'],
  ask_document: ['dokumen', 'dokumennya', 'dok', 'file', 'pdf', 'paper', 'artikel', 'sumber', 'referensi', 'lampiran', 'berkas', 'aturan', 'pedoman', 'panduan', 'surat', 'sk', 'peraturan', 'permen', 'link', 'contoh', 'template'],
  complaint: ['tidak', 'tdk', 'ga', 'gak', 'ngga', 'enggak', 'tidak bisa', 'gabisa', 'nggak bisa', 'error', 'gagal', 'buruk', 'jelek', 'sulit', 'susah', 'lambat', 'lemot', 'lag', 'down', 'hang', 'crash', 'bug', 'buggy', 'salah', 'tidak akurat', 'bingung', 'ribet', 'mengecewakan', 'payah', 'parah'],
  feedback: ['saran', 'masukan', 'feedback', 'kritik', 'usul', 'ide', 'feature request', 'bagusnya', 'sebaiknya', 'mungkin bisa', 'tolong tambahkan']
};

const POSITIVE = [
  'baik', 'bagus', 'bagus banget', 'terima kasih', 'terimakasih', 'makasih', 'thanks', 'thank you',
  'ok', 'oke', 'okay', 'okey', 'okeyy', 'sip', 'sippp', 'siap', 'mantap', 'mantul', 'mantap jiwa',
  'sangat baik', 'love', 'great', 'awesome', 'excellent', 'keren', 'top', 'nice', 'helpful', 'bermanfaat'
];

// NEGATIVE as-is (heuristic only; not used when python enabled)
const NEGATIVE = [
  'nggak', 'ngga', 'gak', 'ga', 'enggak', 'tidak', 'tdk', 'gagal', 'error', 'buruk', 'buruk sekali',
  'jelek', 'jelek banget', 'sulit', 'susah', 'lambat', 'lemot', 'lag', 'down', 'hang', 'crash',
  'bug', 'buggy', 'fail', 'broken', 'parah', 'payah', 'mengecewakan', 'ribet', 'bingung',
  'ga jelas', 'tidak jelas', 'kurang jelas', 'tidak membantu', 'ga membantu', 'tidak sesuai',
  'salah', 'keliru', 'tidak akurat', 'kurang akurat', 'tidak tepat', 'kurang tepat',
  'tidak memuaskan', 'kurang memuaskan', 'tidak puas', 'kurang puas', 'tidak cocok', 'kurang cocok',
  'tidak berguna', 'ga berguna', 'tidak relevan', 'kurang relevan', 'tidak menjawab', 'ga menjawab',
  'tidak menjawab pertanyaan', 'ga menjawab pertanyaan', 'jawabannya salah', 'jawaban salah',
  'jawabannya tidak tepat', 'jawaban tidak tepat', 'jawabannya kurang jelas', 'jawaban kurang jelas'
];

const USE_OPENAI_NLP = (process.env.NLP_USE_OPENAI || 'false').toLowerCase() === 'true';
const USE_PY_SENTIMENT = (process.env.NLP_USE_PYTHON || 'false').toLowerCase() === 'true';
const NLP_DEBUG = (process.env.NLP_DEBUG || 'false').toLowerCase() === 'true';

const PYTHON_BIN_CONF = (process.env.PYTHON_BIN || '').trim();
const NLP_PY_TIMEOUT_MS = Number(process.env.NLP_PY_TIMEOUT_MS || 25000);

if (NLP_DEBUG) {
  console.log('[nlp] config:', {
    USE_PY_SENTIMENT,
    USE_OPENAI_NLP,
    PYTHON_BIN: PYTHON_BIN_CONF || '(auto)',
    NLP_PY_TIMEOUT_MS
  });
}

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

  const tokens = (t.match(/[a-z0-9]+/gi) || []).map((w) => w.toLowerCase());
  const hasToken = (w) => tokens.includes(String(w || '').toLowerCase());

  if (t.includes('?')) return 'question';

  const priorities = ['complaint', 'ask_document', 'feedback', 'greeting', 'goodbye'];
  const scores = Object.fromEntries(Object.keys(INTENT_KEYWORDS).map((k) => [k, 0]));

  const countHit = (key) => {
    const k = String(key || '').toLowerCase().trim();
    if (!k) return 0;
    if (k.includes(' ') || /[^a-z0-9]/i.test(k)) return t.includes(k) ? 1 : 0;
    return hasToken(k) ? 1 : 0;
  };

  for (const [intent, keys] of Object.entries(INTENT_KEYWORDS)) {
    let s = 0;
    for (const k of keys) s += countHit(k);
    scores[intent] = s;
  }

  let isPraise = false;
  for (const p of POSITIVE) {
    if ((p.includes(' ') && t.includes(p)) || (!p.includes(' ') && hasToken(p))) {
      isPraise = true;
      break;
    }
  }

  let best = { intent: 'unknown', score: 0 };
  for (const intent of priorities) {
    const sc = scores[intent] || 0;
    if (sc > 0 && (sc > best.score || (sc === best.score && best.intent === 'unknown'))) {
      best = { intent, score: sc };
    }
  }

  if (best.intent !== 'unknown') return best.intent;
  if (tokens.length <= 2) return 'short_statement';
  if (isPraise) return 'kepuasan';
  return 'unknown';
}

// Heuristic sentiment (only used if python disabled and openai disabled)
export function analyzeSentiment(text) {
  const t = normalize(text);
  if (!t) return { score: 0, label: 'neutral' };

  const tokens = (t.match(/[a-z0-9]+/gi) || []).map((w) => w.toLowerCase());
  const hasToken = (w) => tokens.includes(String(w || '').toLowerCase());

  const matchKeyword = (kw) => {
    const k = String(kw || '').toLowerCase();
    if (!k) return false;
    if (k.includes(' ') || /[^a-z0-9]/i.test(k)) return t.includes(k);
    return hasToken(k);
  };

  let score = 0;
  for (const p of POSITIVE) if (matchKeyword(p)) score += 1;
  for (const n of NEGATIVE) if (matchKeyword(n)) score -= 1;

  if (score > 0) score = Math.min(1, score / 3);
  else if (score < 0) score = Math.max(-1, score / 3);

  const label = score > 0 ? 'positive' : score < -0.15 ? 'negative' : 'neutral';
  return { score, label };
}

// ---- Python sentiment runner (robust, cross-platform) ----

function getPythonScriptPath() {
  const __filename = fileURLToPath(import.meta.url);
  const here = path.dirname(__filename);

  // Assumption: nlp.js is in server/utils/nlp.js -> baseDir server
  const baseDir = path.resolve(here, '..');
  return path.resolve(baseDir, 'tools', 'sentiment_pipeline.py');
}

function parseJsonFromStdout(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;

  // Try direct parse first
  try {
    return JSON.parse(s);
  } catch {}

  // If there are logs/noise, try parse last JSON-like line/object
  const lines = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    try {
      const obj = JSON.parse(line);
      return obj;
    } catch {}
  }

  // Try extract last {...} block
  const m = s.match(/\{[\s\S]*\}\s*$/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }

  return null;
}

async function analyzeSentimentPython(text) {
  if (!USE_PY_SENTIMENT) return null;

  const scriptPath = getPythonScriptPath();
  if (!fs.existsSync(scriptPath)) {
    if (NLP_DEBUG) console.warn('[nlp] python script not found:', scriptPath);
    return null;
  }

  const pyBins = [
    PYTHON_BIN_CONF,
    'python3',
    'python',
    'py'
  ].filter(Boolean);

  const payload = JSON.stringify({ text: String(text || '') });

  for (const bin of pyBins) {
    let proc;
    try {
      proc = spawn(bin, [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      });
    } catch (e) {
      if (NLP_DEBUG) console.warn('[nlp] spawn failed bin=', bin, e?.message);
      continue;
    }

    let stdout = '';
    let stderr = '';
    let spawnErr = null;

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (e) => {
      spawnErr = e;
    });

    // Write stdin payload
    try {
      proc.stdin.write(payload);
      proc.stdin.end();
    } catch (e) {
      if (NLP_DEBUG) console.warn('[nlp] stdin write failed bin=', bin, e?.message);
      try { proc.kill(); } catch {}
      continue;
    }

    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try { proc.kill(); } catch {}
        if (NLP_DEBUG) console.warn('[nlp] python timeout bin=', bin);
        resolve({ ok: false, obj: null, code: null, timedOut: true });
      }, NLP_PY_TIMEOUT_MS);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        const obj = parseJsonFromStdout(stdout);
        resolve({ ok: true, obj, code, timedOut: false });
      });
    });

    if (NLP_DEBUG) {
      console.log('[nlp] python attempt:', {
        bin,
        scriptPath,
        exitCode: result.code,
        timedOut: result.timedOut,
        spawnError: spawnErr ? (spawnErr.message || String(spawnErr)) : null,
        stderrPreview: (stderr || '').slice(0, 400),
        stdoutPreview: (stdout || '').slice(0, 400)
      });
    }

    if (!result.ok) continue;
    const obj = result.obj;

    // Must be strict JSON with score + label; if error exists treat as failure
    if (obj && !obj.error && typeof obj.score === 'number' && obj.label) {
      return { score: obj.score, label: obj.label, _raw: obj };
    }
  }

  return null;
}

// ---- OpenAI NLP (optional) ----

async function analyzeMessageOpenAI(text) {
  const client = await ensureOpenAI();
  if (!client) return null;

  const prompt =
    `Analyze the following user message. Return strict JSON with keys: ` +
    `intent (one of greeting, goodbye, question, ask_document, complaint, feedback, short_statement, unknown), ` +
    `sentiment_label (positive|neutral|negative), sentiment_score (number -1..1). ` +
    `Message: "${String(text || '').replace(/"/g, '\\"')}"`;

  try {
    if (client.responses) {
      const resp = await client.responses.create({
        model: process.env.NLP_OPENAI_MODEL || 'gpt-4o-mini',
        input: prompt,
        temperature: 0
      });

      const out =
        (resp && resp.output && resp.output[0] && resp.output[0].content && resp.output[0].content[0] && resp.output[0].content[0].text) ||
        (resp && resp.output_text);

      const parsed = JSON.parse(out || '{}');
      return {
        intent: parsed.intent || 'unknown',
        sentiment: {
          score: typeof parsed.sentiment_score === 'number' ? parsed.sentiment_score : 0,
          label: parsed.sentiment_label || 'neutral'
        }
      };
    }

    if (client.chat && client.chat.completions) {
      const r = await client.chat.completions.create({
        model: process.env.NLP_OPENAI_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0
      });

      const txt = r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
      const parsed = JSON.parse(txt || '{}');
      return {
        intent: parsed.intent || 'unknown',
        sentiment: {
          score: typeof parsed.sentiment_score === 'number' ? parsed.sentiment_score : 0,
          label: parsed.sentiment_label || 'neutral'
        }
      };
    }
  } catch (e) {
    console.warn('[nlp] OpenAI analysis failed, falling back:', e && e.message);
  }

  return null;
}

// ---- Combined ----

export async function analyzeMessage(text) {
  // Prefer Python pipeline for sentiment if enabled; DO NOT fallback to heuristic sentiment
  if (USE_PY_SENTIMENT) {
    const intent = detectIntent(text);
    try {
      const py = await analyzeSentimentPython(text);

      if (py && typeof py.score === 'number' && py.label) {
        return { intent, sentiment: { score: py.score, label: py.label }, meta: { py: py._raw || py } };
      }

      if (NLP_DEBUG) console.warn('[nlp] python sentiment unavailable -> neutral fallback');
      return { intent, sentiment: { score: 0, label: 'neutral' }, meta: { py: null } };
    } catch (e) {
      if (NLP_DEBUG) console.warn('[nlp] python sentiment error -> neutral fallback:', e?.message || e);
      return { intent, sentiment: { score: 0, label: 'neutral' }, meta: { py: null } };
    }
  }

  // If Python not enabled, try OpenAI; else fall back to lightweight heuristic
  if (USE_OPENAI_NLP) {
    const ai = await analyzeMessageOpenAI(text);
    if (ai) return ai;
  }

  const intent = detectIntent(text);
  const sentiment = analyzeSentiment(text);
  return { intent, sentiment };
}

export default { detectIntent, analyzeSentiment, analyzeMessage };