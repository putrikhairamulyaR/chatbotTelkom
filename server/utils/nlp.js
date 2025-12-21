// server/utils/nlp.js
// Python-first NLP: intent detection (JS) + sentiment (Python pipeline)
// Pipeline: Indonesian -> translate -> VADER + TextBlob + SentiWordNet -> aggregate
//
// Env:
//   NLP_USE_PYTHON=true
//   PYTHON_BIN=python3
//   NLP_PY_TIMEOUT_MS=25000
//   NLP_DEBUG=true
//
// Optional fallback heuristic thresholds:
//   NLP_HEURISTIC_POS_TH=0.2
//   NLP_HEURISTIC_NEG_TH=-0.2

import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

dotenv.config();

const INTENT_KEYWORDS = {
  greeting: [
    "hello",
    "hi",
    "hey",
    "selamat",
    "halo",
    "hallo",
    "hai",
    "hy",
    "assalamualaikum",
    "pagi",
    "siang",
    "sore",
    "malam",
    "good morning",
    "morning",
    "good afternoon",
    "afternoon",
    "good evening",
    "evening",
  ],
  goodbye: [
    "bye",
    "bye bye",
    "see you",
    "sampai",
    "sampai jumpa",
    "sampai nanti",
    "dadah",
    "daa",
    "goodbye",
    "terima kasih, bye",
    "makasih, bye",
  ],
  question: [
    "?",
    "apa",
    "apa itu",
    "apakah",
    "mengapa",
    "kenapa",
    "kapan",
    "bagaimana",
    "gimana",
    "gmn",
    "berapa",
    "siapa",
    "dimana",
    "di mana",
    "dapatkah",
    "bisa kah",
    "bolehkah",
  ],
  ask_document: [
    "dokumen",
    "dokumennya",
    "dok",
    "file",
    "pdf",
    "paper",
    "artikel",
    "sumber",
    "referensi",
    "lampiran",
    "berkas",
    "aturan",
    "pedoman",
    "panduan",
    "surat",
    "sk",
    "peraturan",
    "permen",
    "link",
    "contoh",
    "template",
  ],
  complaint: [
    "tidak",
    "tdk",
    "ga",
    "gak",
    "ngga",
    "enggak",
    "tidak bisa",
    "gabisa",
    "nggak bisa",
    "error",
    "gagal",
    "buruk",
    "jelek",
    "sulit",
    "susah",
    "lambat",
    "lemot",
    "lag",
    "down",
    "hang",
    "crash",
    "bug",
    "buggy",
    "salah",
    "tidak akurat",
    "bingung",
    "ribet",
    "mengecewakan",
    "payah",
    "parah",
    "sampah",
    "ampas",
    "najis",
    "trash",
    "garbage",
    "worst",
    "bodoh",
    "tolol",
    "goblok",
    "idiot",
  ],
  feedback: [
    "saran",
    "masukan",
    "feedback",
    "kritik",
    "usul",
    "ide",
    "feature request",
    "bagusnya",
    "sebaiknya",
    "mungkin bisa",
    "tolong tambahkan",
  ],
};

const POSITIVE = [
  "baik",
  "bagus",
  "bagus banget",
  "terima kasih",
  "terimakasih",
  "makasih",
  "thanks",
  "thank you",
  "ok",
  "oke",
  "okay",
  "sip",
  "siap",
  "mantap",
  "mantul",
  "sangat baik",
  "love",
  "great",
  "awesome",
  "excellent",
  "keren",
  "top",
  "nice",
  "helpful",
  "bermanfaat",
];

const NEGATIVE = [
  "nggak",
  "ngga",
  "gak",
  "ga",
  "enggak",
  "tidak",
  "tdk",
  "gagal",
  "error",
  "buruk",
  "jelek",
  "sulit",
  "susah",
  "lambat",
  "lemot",
  "lag",
  "down",
  "hang",
  "crash",
  "bug",
  "buggy",
  "fail",
  "failed",
  "broken",
  "parah",
  "payah",
  "mengecewakan",
  "ribet",
  "bingung",
  "ga jelas",
  "tidak jelas",
  "tidak membantu",
  "ga membantu",
  "tidak sesuai",
  "salah",
  "keliru",
  "tidak akurat",
  "tidak memuaskan",
  "tidak puas",
  "tidak cocok",
  "tidak berguna",
  "tidak relevan",
  "tidak menjawab",
  "jawaban salah",
  "jawaban tidak tepat",
  "jawaban kurang jelas",
  "sampah",
  "ampas",
  "najis",
  "zonk",
  "trash",
  "garbage",
  "worst",
  "bodoh",
  "tolol",
  "goblok",
  "idiot",
];

// ---- Config ----
const USE_PY_SENTIMENT = (process.env.NLP_USE_PYTHON || "false").toLowerCase() === "true";
const NLP_DEBUG = (process.env.NLP_DEBUG || "false").toLowerCase() === "true";
const NLP_PY_TIMEOUT_MS = Number(process.env.NLP_PY_TIMEOUT_MS || 25000);

// IMPORTANT: dotenv can include inline comments in value. Keep only first token.
const PYTHON_BIN_RAW = String(process.env.PYTHON_BIN || "").trim();
const PYTHON_BIN_CONF = PYTHON_BIN_RAW ? PYTHON_BIN_RAW.split(/\s+/)[0] : "";

if (NLP_DEBUG) {
  console.log("[nlp] config:", {
    USE_PY_SENTIMENT,
    PYTHON_BIN: PYTHON_BIN_CONF || "(auto)",
    NLP_PY_TIMEOUT_MS,
  });
}

function normalize(text) {
  return String(text || "").toLowerCase();
}

// OPTIONAL: normalize typos before heuristic/intent (Python pipeline does its own translate)
function normalizeTypoId(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\bbgus\b/g, "bagus")
    .replace(/\bbgt\b/g, "banget");
}

export function detectIntent(text) {
  const t = normalizeTypoId(normalize(text)).trim();
  if (!t) return "unknown";

  const tokens = (t.match(/[a-z0-9]+/gi) || []).map((w) => w.toLowerCase());
  const hasToken = (w) => tokens.includes(String(w || "").toLowerCase());

  if (t.includes("?")) return "question";

  const priorities = ["complaint", "ask_document", "feedback", "greeting", "goodbye"];
  const scores = Object.fromEntries(Object.keys(INTENT_KEYWORDS).map((k) => [k, 0]));

  const countHit = (key) => {
    const k = String(key || "").toLowerCase().trim();
    if (!k) return 0;
    if (k.includes(" ") || /[^a-z0-9]/i.test(k)) return t.includes(k) ? 1 : 0;
    return hasToken(k) ? 1 : 0;
  };

  for (const [intent, keys] of Object.entries(INTENT_KEYWORDS)) {
    let s = 0;
    for (const k of keys) s += countHit(k);
    scores[intent] = s;
  }

  let best = { intent: "unknown", score: 0 };
  for (const intent of priorities) {
    const sc = scores[intent] || 0;
    if (sc > 0 && (sc > best.score || (sc === best.score && best.intent === "unknown"))) {
      best = { intent, score: sc };
    }
  }

  if (best.intent !== "unknown") return best.intent;
  if (tokens.length <= 2) return "short_statement";

  // positive hint => feedback
  for (const p of POSITIVE) {
    if ((p.includes(" ") && t.includes(p)) || (!p.includes(" ") && hasToken(p))) {
      return "feedback";
    }
  }

  return "unknown";
}

// Heuristic sentiment fallback (only used if python fails/off)
export function analyzeSentiment(text) {
  const t = normalizeTypoId(normalize(text));
  if (!t) return { score: 0, label: "neutral" };

  const tokens = (t.match(/[a-z0-9]+/gi) || []).map((w) => w.toLowerCase());
  const hasToken = (w) => tokens.includes(String(w || "").toLowerCase());

  const matchKeyword = (kw) => {
    const k = String(kw || "").toLowerCase();
    if (!k) return false;
    if (k.includes(" ") || /[^a-z0-9]/i.test(k)) return t.includes(k);
    return hasToken(k);
  };

  let raw = 0;
  for (const p of POSITIVE) if (matchKeyword(p)) raw += 1;
  for (const n of NEGATIVE) if (matchKeyword(n)) raw -= 1;

  let score = 0;
  if (raw > 0) score = Math.min(1, raw / 3);
  else if (raw < 0) score = Math.max(-1, raw / 3);

  const POS_TH = Number(process.env.NLP_HEURISTIC_POS_TH || 0.2);
  const NEG_TH = Number(process.env.NLP_HEURISTIC_NEG_TH || -0.2);

  const label = score >= POS_TH ? "positive" : score <= NEG_TH ? "negative" : "neutral";
  return { score, label };
}

// ---- Python sentiment runner ----

function getPythonScriptPath() {
  // server/utils/nlp.js -> server/tools/sentiment_pipeline.py
  const __filename = fileURLToPath(import.meta.url);
  const here = path.dirname(__filename);

  if (process.env.NLP_PY_SCRIPT && process.env.NLP_PY_SCRIPT.trim()) {
    return path.resolve(process.env.NLP_PY_SCRIPT.trim());
  }

  return path.resolve(here, "..", "tools", "sentiment_pipeline.py");
}

function parseJsonLoose(s) {
  const str = String(s || "").trim();
  if (!str) return null;

  try {
    return JSON.parse(str);
  } catch {}

  const unfenced = str.replace(/```(?:json)?/gi, "```");
  if (unfenced.includes("```")) {
    const parts = unfenced.split("```").map((x) => x.trim()).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(parts[i]);
      } catch {}
    }
  }

  const m = str.match(/\{[\s\S]*\}\s*$/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }

  const lines = str.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }

  return null;
}

async function analyzeSentimentPython(text) {
  if (!USE_PY_SENTIMENT) return null;

  const scriptPath = getPythonScriptPath();
  if (!fs.existsSync(scriptPath)) {
    if (NLP_DEBUG) console.warn("[nlp] python script not found:", scriptPath);
    return null;
  }

  const pyBins = [PYTHON_BIN_CONF, "python3", "python", "py"].filter(Boolean);
  const payload = JSON.stringify({ text: String(text || "") });

  for (const bin of pyBins) {
    let proc;
    try {
      proc = spawn(bin, [scriptPath], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (e) {
      if (NLP_DEBUG) console.warn("[nlp] spawn failed bin=", bin, e?.message || e);
      continue;
    }

    let stdout = "";
    let stderr = "";
    let spawnErr = null;

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (e) => (spawnErr = e));

    try {
      proc.stdin.write(payload);
      proc.stdin.end();
    } catch (e) {
      if (NLP_DEBUG) console.warn("[nlp] stdin write failed bin=", bin, e?.message || e);
      try {
        proc.kill();
      } catch {}
      continue;
    }

    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try {
          proc.kill();
        } catch {}
        resolve({ obj: null, code: null, timedOut: true });
      }, NLP_PY_TIMEOUT_MS);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        const obj = parseJsonLoose(stdout);
        resolve({ obj, code, timedOut: false });
      });
    });

    if (NLP_DEBUG) {
      console.log("[nlp] python attempt:", {
        bin,
        scriptPath,
        exitCode: result.code,
        timedOut: result.timedOut,
        spawnError: spawnErr ? (spawnErr.message || String(spawnErr)) : null,
        stderrPreview: (stderr || "").slice(0, 400),
        stdoutPreview: (stdout || "").slice(0, 400),
      });
    }

    const obj = result.obj;
    // Expect python to return: { score:number, label:string, ... }
    if (obj && !obj.error && typeof obj.score === "number" && obj.label) {
      return { score: obj.score, label: obj.label, _raw: obj };
    }
  }

  return null;
}

// ---- Combined ----

export async function analyzeMessage(text) {
  const t = String(text || "").trim();
  const intent = detectIntent(t);

  // Python sentiment (translate + 3 methods)
  if (USE_PY_SENTIMENT) {
    try {
      const py = await analyzeSentimentPython(t);
      if (py) {
        return {
          intent,
          sentiment: { score: py.score, label: py.label },
          meta: { py: py._raw || py },
        };
      }
      // If python fails, fallback heuristic (not always neutral)
      const sentiment = analyzeSentiment(t);
      return { intent, sentiment, meta: { mode: "fallback_heuristic", py: null } };
    } catch (e) {
      if (NLP_DEBUG) console.warn("[nlp] python sentiment error -> heuristic fallback:", e?.message || e);
      const sentiment = analyzeSentiment(t);
      return { intent, sentiment, meta: { mode: "fallback_heuristic", py: null } };
    }
  }

  // If python disabled, just heuristic
  const sentiment = analyzeSentiment(t);
  return { intent, sentiment, meta: { mode: "heuristic" } };
}

export default { detectIntent, analyzeSentiment, analyzeMessage };
