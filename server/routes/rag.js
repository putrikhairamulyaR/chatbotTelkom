// server/routes/rag.js
import express from 'express';
import nodeFetch from 'node-fetch';
import fs from "fs";
const fetch = globalThis.fetch || nodeFetch;

import { pool } from '../db.js';
import nlp from '../utils/nlp.js';
import { verifyToken } from '../utils/jwt.js';

const router = express.Router();
let topic = 'Belum ada';

/* ==================== Config (tuning) ==================== */
const CFG = {
  ENABLE_RAG: (process.env.ENABLE_RAG || 'false').toLowerCase() === 'true',
  ENABLE_RAG_GEN: (process.env.ENABLE_RAG_GEN || 'false').toLowerCase() === 'true',

  OLLAMA_URL: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'qwen2.5:3b-instruct',

  EMBED_URL: (process.env.EMBED_URL || process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
  EMBED_MODEL: process.env.EMBED_MODEL || 'nomic-embed-text',

  QDRANT_URL: process.env.QDRANT_URL || 'http://127.0.0.1:6333',
  QDRANT_COLLECTION: process.env.QDRANT_COLLECTION || 'documents',

  // perf limits
  TOP_K_DEFAULT: Number(process.env.TOP_K_DEFAULT || 8),
  RAG_MIN_SCORE: Number(process.env.RAG_MIN_SCORE || 0.33),

  // context building
  NEIGHBORS_NORMAL: Number(process.env.RAG_NEIGHBORS_NORMAL || 6),
  NEIGHBORS_DETAIL: Number(process.env.RAG_NEIGHBORS_DETAIL || 24),

  EXTRAS_NORMAL: Number(process.env.RAG_EXTRAS_NORMAL || 4),
  EXTRAS_DETAIL: Number(process.env.RAG_EXTRAS_DETAIL || 8),

  MAXCHARS_NORMAL: Number(process.env.RAG_MAXCHARS_NORMAL || 6000),
  MAXCHARS_DETAIL: Number(process.env.RAG_MAXCHARS_DETAIL || 12000),

  MINSENT_NORMAL: Number(process.env.RAG_MINSENT_NORMAL || 8),
  MINSENT_DETAIL: Number(process.env.RAG_MINSENT_DETAIL || 16),

  // generation
  NUM_PREDICT_NORMAL: Number(process.env.RAG_NUM_PREDICT || 1600),
  NUM_PREDICT_DETAIL: Number(process.env.RAG_NUM_PREDICT_DETAIL || 2200),
  TEMPERATURE: Number(process.env.RAG_TEMPERATURE || 0.25),

  // continue
  CONTINUE_TAKE_N: Number(process.env.RAG_CONTINUE_TAKE_N || 5),

  // timeouts
  HTTP_TIMEOUT_MS: Number(process.env.HTTP_TIMEOUT_MS || 25000),
  GEN_TIMEOUT_MS: Number(process.env.GEN_TIMEOUT_MS || 120000),

  // debug
  DEBUG_TIMINGS: (process.env.DEBUG_TIMINGS || 'false').toLowerCase() === 'true',

  PUBLIC_BASE_URL: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
};

/* ==================== HTTP Helpers ==================== */
async function postWithTimeout(url, body, opts = {}) {
  const timeoutMs = opts.timeoutMs || CFG.HTTP_TIMEOUT_MS;
  const retry = typeof opts.retry === 'number' ? opts.retry : 1;
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});

  const doPost = async () => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(id);
      return resp;
    } catch (err) {
      clearTimeout(id);
      throw err;
    }
  };

  try {
    return await doPost();
  } catch (err) {
    if (retry > 0) return await postWithTimeout(url, body, { timeoutMs, retry: retry - 1, headers });
    throw err;
  }
}

async function postOllamaWithFallback(pathSuffix, body, opts = {}) {
  const rawBase = (CFG.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const baseCandidates = [rawBase];
  if (!rawBase.includes('host.docker.internal')) {
    baseCandidates.push(rawBase.replace('127.0.0.1', 'host.docker.internal'));
  }

  let lastErr = null;
  for (const base of baseCandidates) {
    const clean = pathSuffix.replace(/^\/+/, '');
    const candidates = [`${base}/api/${clean}`, `${base}/${clean}`];
    for (const url of candidates) {
      try {
        return await postWithTimeout(url, body, opts);
      } catch (err) {
        lastErr = err;
      }
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('Failed to contact Ollama endpoint');
}

/* ==================== Language Detection ==================== */

/**
 * Deteksi bahasa input teks (Indonesia/English)
 * Rule-based menggunakan kata kunci dan karakteristik bahasa
 * 
 * @param {string} text - Teks input dari user
 * @returns {string} - 'indonesia' atau 'english'
 */
function detectLanguage(text) {
  if (!text || typeof text !== 'string') {
    return 'indonesia'; // default ke bahasa Indonesia
  }

  const cleanedText = text.toLowerCase().trim();
  if (cleanedText.length < 2) {
    return 'indonesia'; // teks terlalu pendek
  }

  // Hitung indikator untuk setiap bahasa
  let indonesiaScore = 0;
  let englishScore = 0;

  // Kata kunci bahasa Indonesia yang umum
  const indonesiaKeywords = [
    // Kata tanya
    'apa', 'siapa', 'dimana', 'kapan', 'kenapa', 'mengapa', 'bagaimana', 'berapa',
    // Kata sambung & partikel
    'yang', 'dengan', 'untuk', 'dari', 'pada', 'ke', 'di', 'dan', 'atau', 'tapi', 
    'tetapi', 'namun', 'jika', 'kalau', 'karena', 'sebab', 'maka', 'agar', 'supaya',
    // Kata umum
    'saya', 'aku', 'kamu', 'anda', 'dia', 'kami', 'kita', 'mereka', 'ini', 'itu',
    'sini', 'situ', 'sana', 'bisa', 'dapat', 'harus', 'perlu', 'ingin', 'mau',
    'sudah', 'telah', 'sedang', 'akan', 'belum', 'tidak', 'bukan', 'jangan',
    // Kata spesifik domain chatbot
    'kerja', 'praktik', 'praktek', 'kp', 'kape', 'kerja_praktik', 'kerja_praktek',
    'ium', 'informatika', 'untuk', 'masyarakat', 'informatika_untuk_masyarakat',
    'kurikulum', 'silabus', 'mata_kuliah', 'sks', 'kurikulum_pendidikan',
    'magang', 'internship', 'praktik_kerja', 'berdampak', 'magang_berdampak',
    'panduan', 'panduan_magang', 'bimbingan', 'mentor', 'perusahaan',
    'sosialisasi', 'registrasi', 'daftar_ulang', 'krs', 'kartu_rencana_studi',
    'pendaftaran', 'sidang', 'skripsi', 'tugas_akhir', 'seminar', 'ujian',
    'proposal', 'hasil', 'munaqosah', 'yudisium', 'wisuda',
    'informasi', 'info', 'detail', 'jelas', 'penjelasan', 'klarifikasi',
    'bantuan', 'support', 'dukungan', 'bimbingan', 'konsultasi', 'tutorial',
    'tolong', 'bantu', 'mohon', 'permohonan', 'request', 'minta',
    'terima', 'kasih', 'thanks', 'thank', 'makasih', 'sukses',
    'silahkan', 'sila', 'please', 'tolong', 'bantu',
  ];

  // Kata kunci bahasa Inggris yang umum
  const englishKeywords = [
    // Question words
    'what', 'who', 'where', 'when', 'why', 'how', 'which', 'whom', 'whose',
    // Common words
    'the', 'a', 'an', 'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall', 'should',
    'can', 'could', 'may', 'might', 'must', 'and', 'or', 'but', 'so', 'because',
    'if', 'then', 'else', 'for', 'of', 'in', 'on', 'at', 'by', 'with', 'to',
    'from', 'about', 'into', 'over', 'under', 'between', 'among',
    // Pronouns
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
    'my', 'your', 'his', 'her', 'its', 'our', 'their', 'mine', 'yours', 'hers',
    'ours', 'theirs', 'this', 'that', 'these', 'those',
    // Common verbs in chatbot - English version
    'work', 'practice', 'internship', 'curriculum', 'information', 'help',
    'please', 'thank', 'sorry', 'hello', 'hi', 'good', 'morning', 'afternoon',
    'evening', 'night', 'yes', 'no', 'ok', 'okay', 'thanks',

    // Translated words from Indonesian menu items
    'assistant', 'practicum', 'list', 'services', 'available', 'faculty', 
    'information', 'technology', 'code', 'ethics', 'rules', 'regulations',
    'completeness', 'completion', 'graduation', 'competition', 'contest',
    'organization', 'student', 'organization', 'data', 'change', 'modification',
    'student', 'assessment', 'evaluation', 'graduate', 'achievement', 'award',
    'certificate', 'letter', 'active', 'status', 'credit', 'activities',
    'thesis', 'final', 'project', 'intern', 'internship', 'guidance', 'registration',
    'seminar', 'defense'
  ];

  // Cek kata kunci
  const words = cleanedText.split(/\s+/);
  
  words.forEach(word => {
    const cleanWord = word.replace(/[^\w]/g, '');
    if (cleanWord.length < 2) return;

    if (indonesiaKeywords.includes(cleanWord)) {
      indonesiaScore += 2;
    }
    if (englishKeywords.includes(cleanWord)) {
      englishScore += 2;
    }
  });

  // Cek pola karakteristik bahasa
  // Bahasa Indonesia sering menggunakan "ng" di akhir kata
  if (/\b\w*ng\b/i.test(cleanedText)) {
    indonesiaScore += 1;
  }

  // Bahasa Indonesia sering menggunakan "nya" di akhir kata
  if (/\b\w*nya\b/i.test(cleanedText)) {
    indonesiaScore += 2;
  }

  // Bahasa Indonesia sering menggunakan "di-" prefix
  if (/\bdi\w+/i.test(cleanedText)) {
    indonesiaScore += 1;
  }

  // Bahasa Indonesia sering menggunakan "me-", "pe-", "ber-" prefix
  if (/\b(me|pe|ber)\w+/i.test(cleanedText)) {
    indonesiaScore += 1;
  }

  // Cek kata tanya spesifik
  if (/\bapa\b|\bbagaimana\b|\bdimana\b|\bkapan\b|\bkenapa\b|\bmengapa\b|\bsiapa\b|\bberapa\b/i.test(cleanedText)) {
    indonesiaScore += 3;
  }

  // Cek kata tanya bahasa Inggris
  if (/\bwhat\b|\bhow\b|\bwhere\b|\bwhen\b|\bwhy\b|\bwho\b|\bwhich\b|\bwhom\b|\bwhose\b/i.test(cleanedText)) {
    englishScore += 3;
  }

  // Cek artikel bahasa Inggris (the, a, an)
  if (/\bthe\b|\ba\b|\ban\b/i.test(cleanedText)) {
    englishScore += 2;
  }

  // Cek kata kerja bantu bahasa Inggris
  if (/\bis\b|\bare\b|\bam\b|\bwas\b|\bwere\b|\bhave\b|\bhas\b|\bhad\b|\bdo\b|\bdoes\b|\bdid\b/i.test(cleanedText)) {
    englishScore += 2;
  }

  // Aturan khusus untuk kata pendek yang ambigu
  const ambiguousWords = ['ok', 'ya', 'no', 'hi', 'hai', 'hello', 'halo'];
  words.forEach(word => {
    if (ambiguousWords.includes(word)) {
      // Netral, tidak tambah score
    }
  });

  // Tambah score berdasarkan panjang kata rata-rata (bahasa Inggris cenderung lebih pendek)
  const avgWordLength = words.reduce((sum, w) => sum + w.length, 0) / words.length;
  if (avgWordLength < 4.5) {
    englishScore += 1;
  } else {
    indonesiaScore += 1;
  }

  // Debug (opsional)
  if (CFG.DEBUG_TIMINGS) {
    console.log(`[LANG DETECT] Indo: ${indonesiaScore}, Eng: ${englishScore}, Text: "${cleanedText.substring(0, 50)}..."`);
  }

  // Keputusan akhir
  if (englishScore > indonesiaScore) {
    return 'english';
  } else {
    return 'indonesia';
  }
}

async function translateEnglishToIndonesian(englishText) {
  if (!englishText || typeof englishText !== 'string') {
    return englishText;
  }

  // Clean the text
  const cleanText = englishText.trim();
  if (!cleanText) return '';

  // Skip if text is very short (likely not needing translation)
  if (cleanText.length < 10) {
    return cleanText;
  }

  try {
    const body = {
      model: CFG.OLLAMA_MODEL, // Use the configured model
      stream: false,
      prompt: `TRANSLATE ENGLISH TO INDONESIAN

Translate the following English text to formal, natural Indonesian.
IMPORTANT RULES:
1. Keep the meaning EXACT - no additions, no omissions
2. Use formal Indonesian (bahasa Indonesia baku)
3. Maintain bullet points, numbering, and formatting
4. Translate all the words (names, places, acronyms), e.g Informatics for Society course translate to Matakuliah Informatika Untuk Masyarakat
5. Output ONLY the translation, no explanations
6. Just output the sentence no additional words

English text:
${cleanText}

Indonesian translation:`,
      temperature: 0.1, // Low temperature for accurate translation
      num_predict: Math.min(cleanText.length * 3, 4000), // Adjust based on input length
    };

    console.log(`[TRANSLATE] Translating: "${cleanText.substring(0, 80)}..."`);

    const response = await postOllamaWithFallback('generate', body, {
      timeoutMs: 60000,
      retry: 1,
    });

    if (!response.ok) {
      console.warn('[TRANSLATE] Translation request failed');
      return cleanText; // Return original on failure
    }

    const data = await response.json();
    const translated = extractTextFromOllamaResponse(data);

    // Clean the translated output
    let result = translated.trim();
    
    // Remove common prefix artifacts
    const prefixesToRemove = [
      'Terjemahan:',
      'Translation:',
      'Indonesian translation:',
      'Hasil terjemahan:',
      'Berikut terjemahannya:',
    ];

    prefixesToRemove.forEach(prefix => {
      if (result.toLowerCase().startsWith(prefix.toLowerCase())) {
        result = result.slice(prefix.length).trim();
      }
    });

    // Remove quotes if present
    result = result.replace(/^["']|["']$/g, '').trim();

    console.log(`[TRANSLATE] Original: "${cleanText.substring(0, 60)}..."`);
    console.log(`[TRANSLATE] Translated: "${result.substring(0, 60)}..."`);

    return result || cleanText; // Fallback to original if empty

  } catch (error) {
    console.error('[TRANSLATE] Error:', error?.message || error);
    return cleanText; // Return original on error
  }
}


async function polishAnswerWithGemma(answer) {
  if (!answer || answer.length < 80) return answer;

  try {
    const body = {
      model: 'gemma2:2b',
      stream: false,
      prompt: `Perbaiki tata bahasa dan kerapihan teks berikut tanpa mengubah makna atau menambah informasi baru.

Aturan:
- Bahasa Indonesia formal dan natural
- Rapikan paragraf
- Jika definisi: buat 1 paragraf pembuka yang jelas
- Hapus potongan metadata dokumen (tanggal, tempat, nomor bab)
- Jangan menambah fakta baru

Teks:
${answer}`,
      temperature: 0.2,
      num_predict: 700,
    };

    const resp = await postOllamaWithFallback('generate', body, {
      timeoutMs: 60000,
      retry: 1,
    });

    if (resp.ok) {
      const data = await resp.json();
      const polished = extractTextFromOllamaResponse(data);
      if (polished && polished.trim()) return cleanAnswer(polished);
    }
  } catch (e) {
    console.warn('[polish] fallback to raw answer');
  }

  return answer;
}

function extractTextFromOllamaResponse(resp) {
  if (!resp) return '';
  if (typeof resp === 'string') return resp;
  if (typeof resp.response === 'string') return resp.response;
  if (typeof resp.output === 'string') return resp.output;
  if (typeof resp.text === 'string') return resp.text;

  if (Array.isArray(resp.choices) && resp.choices[0]?.message?.content) {
    return resp.choices[0].message.content;
  }
  if (Array.isArray(resp.results) && resp.results[0] && (resp.results[0].content || resp.results[0].text)) {
    return resp.results[0].content || resp.results[0].text || '';
  }
  try {
    return JSON.stringify(resp);
  } catch {
    return String(resp);
  }
}

/* ==================== Cleaner (jangan bunuh bullet/citations) ==================== */
export function cleanAnswer(text) {
  if (!text || typeof text !== 'string') return '';
  let s = text.trim();

  s = s.replace(/^\s*(berikut|berdasarkan dokumen|menurut dokumen|dari dokumen)\b[:\s-]*/i, '');

  s = s.replace(/([^\n])(\d+\.\s)/g, '$1\n$2');
  s = s.replace(/([^\n])([-•]\s)/g, '$1\n$2');

  s = s
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trimEnd())
    .filter((line) => line.length > 0 || line === '')
    .join('\n');

  s = s.replace(/\n{3,}/g, '\n\n');

  s = s.replace(/(\n\d+\.\s[^\n]+)\n{2,}(\d+\.)/g, '$1\n$2');
  s = s.replace(/(\n[-•]\s[^\n]+)\n{2,}([-•])/g, '$1\n$2');
  s = s.replace(/(\n\d+\.\s[^\n]+)\n{2,}([-•])/g, '$1\n$2');
  s = s.replace(/(\n[-•]\s[^\n]+)\n{2,}(\d+\.)/g, '$1\n$2');

  s = s.replace(/([^\n]\.)\n{2,}(\d+\.)/g, '$1\n$2');
  s = s.replace(/([^\n]\.)\n{2,}([-•])/g, '$1\n$2');

  s = s
    .split('\n')
    .map((line) => line.replace(/\s+([.,!?;:])/g, '$1'))
    .join('\n');

  s = s.replace(/^\n+|\n+$/g, '');

  return s.trim();
}

/* ==================== Conversation Memory ==================== */
async function getRecentConversation(id_user, limit = 30) {
  if (!id_user) return [];
  try {
    const [rows] = await pool.query(
      'SELECT sender, message FROM conversation_memory WHERE id_user = ? ORDER BY id DESC LIMIT ?',
      [id_user, Number(limit)]
    );
    return rows || [];
  } catch {
    return [];
  }
}

async function persistMessage(id_user, sender, message, intent = null, sentiment_score = null, sentiment_label = null) {
  try {
    await pool.query(
      'INSERT INTO conversation_memory (id_user, sender, message, intent, sentiment_score, sentiment_label) VALUES (?,?,?,?,?,?)',
      [id_user, sender, message || '', intent, sentiment_score, sentiment_label]
    );
  } catch {}
}

function getLastBotAnswer(recentDesc) {
  for (const m of recentDesc || []) {
    if ((m?.sender || '').toLowerCase() !== 'bot') continue;
    const msg = (m?.message || '').trim();
    if (!msg) continue;
    if (msg.toLowerCase().includes('rag is disabled')) continue;
    return msg;
  }
  return '';
}

function pickLastUserQuestion(recentDesc) {
  for (const m of recentDesc || []) {
    if ((m?.sender || '').toLowerCase() !== 'user') continue;
    const msg = (m?.message || '').trim();
    if (!msg) continue;
    if (isSummaryRequest(msg)) continue;
    return msg;
  }
  return '';
}

/* ==================== Small talk + INIT MENU ==================== */
function isSmallTalk(prompt) {
  if (!prompt) return false;
  const p = prompt.toLowerCase().trim();

  const hasTopic = /\b(asisten\s+praktikum|daftar\s+layanan|informasi\s+fit|kode\s+etik|kelengkapan\s+sidang|kompetisi|magang|organisasi|perubahan\s+data|penilaian\s+wisudawan|skl|surat\s+keterangan\s+aktif|tak|tugas\s+akhir|kerja\s+praktik|kerja\s+praktek|informatika\s+untuk\s+masyarakat)\b/i.test(p);
  const hasQuestion = /[?]|apa\s|bagaimana|kenapa|kapan|siapa|dimana|berapa|gimana|mengapa|bisa\s+tolong|tolong\s+bantu|caranya|cara\s+untuk|prosedur|proses|syarat|persyaratan|dokumen|berkas/i.test(p);

  if (hasTopic || hasQuestion) return false;

  const exactGreetings = [
    '__init__', 'hai', 'halo', 'hi', 'hey', 'helo',
    'selamat pagi', 'selamat siang', 'selamat sore', 'selamat malam',
    'assalamualaikum', "assalamu'alaikum",
  ];
  if (exactGreetings.includes(p)) return true;

  if (p.length <= 20) {
    const greetingWords = ['hai', 'halo', 'hi', 'hey', 'helo', 'selamat', 'assalamualaikum', "assalamu'alaikum"];
    const words = p.split(/\s+/).filter((w) => w.length > 0);
    const hasGreeting = words.some((w) => greetingWords.includes(w));
    if (hasGreeting && words.length <= 3) return true;
  }

  return false;
}

function toTitleCase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const STATIC_TOPIC_ALIASES = {
  asisten_praktikum: ['asisten praktikum', 'asisten_praktikum', 'asisten dan praktikum', 'Asisten Praktikum Dan Praktikum'],
  daftar_layanan: ['daftar layanan', 'daftar_layanan', 'daftar layanan yang tersedia', 'layanan tersedia'],
  informasi_fit: ['informasi fit', 'informasi_fit', 'fit'],
  kode_etik: ['kode etik', 'kode_etik', 'kode etik dan aturan', 'aturan'],
  kelengkapan_sidang: ['kelengkapan sidang', 'kelengkapan_sidang'],
  kompetisi: ['kompetisi'],
  magang: ['magang'],
  organisasi: ['organisasi'],
  perubahan_data: ['perubahan data', 'perubahan_data', 'perubahan data mahasiswa'],
  penilaian_wisudawan: ['penilaian wisudawan', 'penilaian_wisudawan', 'penilaian wisudawan berprestasi', 'wisudawan berprestasi'],
  skl: ['skl', 'surat keterangan lulus'],
  surat_aktif: ['surat keterangan aktif', 'surat_aktif', 'surat aktif'],
  tak: ['tak', 'tambahan aktivitas kurikulum'],
  tugas_akhir: ['tugas akhir', 'tugas_akhir', 'skripsi', 'ta']
};

const STATIC_TOPIC_SLUGS = new Set(Object.keys(STATIC_TOPIC_ALIASES));

function canonicalStaticSlug(s) {
  const t = String(s || '').trim().toLowerCase();
  for (const [slug, aliases] of Object.entries(STATIC_TOPIC_ALIASES)) {
    if (aliases.includes(t)) return slug;
    const tUnderscore = t.replace(/\s+/g, '_');
    if (aliases.includes(tUnderscore)) return slug;
    const tSpaced = t.replace(/_/g, ' ');
    if (aliases.includes(tSpaced)) return slug;
  }
  return null;
}

function smallTalkReply(extraTopics = []) {
  const base = `Halo! Saya asisten chatbot yang siap membantu Anda.

Topik yang tersedia:

  - Asisten Praktikum Dan Praktikum
  - Daftar Layanan Yang tersedia
  - informasi FIT
  - Kode Etik dan Aturan
  - Kelengkapan Sidang
  - Kompetisi
  - Magang
  - Organisasi
  - Perubahan data mahasiswa
  - Penilaian Wisudawan berprestasi
  - SKL
  - surat Keterangan Aktif
  - TAK
  - Tugas Akhir`;

  const dyn = (extraTopics || [])
   .map((t) => String(t || '').trim().toLowerCase())
   .filter(Boolean);

  if (!dyn.length) return base + '\n.';

  const unique = Array.from(new Set(dyn));
  const filtered = unique.filter((t) => {
    const slug = canonicalStaticSlug(t);
    return !slug || !STATIC_TOPIC_SLUGS.has(slug);
  });

  if (!filtered.length) return base + '\n.';

  const bullets = filtered
   .slice(0, 12)
    .map((t) => `- ${toTitleCase(t)}\n  Ketik: ${t.replace(/\s+/g, '_')}`)
   .join('\n\n');

  return base + `

Topik dari dokumen (otomatis):
${bullets}
.`;
}

/* ==================== User intent phrases ==================== */
function isSummaryRequest(text) {
  const t = (text || '').toLowerCase();
  return (
    t.includes('terlalu panjang') ||
    t.includes('kepanjangan') ||
    t.includes('panjang banget') ||
    t.includes('ringkas') ||
    t.includes('singkat') ||
    t.includes('tl;dr') ||
    t.includes('poin poin') ||
    t.includes('poin-poin') ||
    t.includes('bullet') ||
    t.includes('diringkas')
  );
}

function isMoreDetailFeedback(text) {
  const t = (text || '').toLowerCase();
  return (
    t.includes('terlalu pendek') ||
    t.includes('kependet') ||
    t.includes('kurang panjang') ||
    t.includes('kurang lengkap') ||
    t.includes('kurang detail') ||
    t.includes('masih kurang') ||
    t.includes('jelasin lebih') ||
    t.includes('jelaskan lebih') ||
    t.includes('perjelas') ||
    t.includes('tambahin') ||
    t.includes('lebih detail') ||
    t.includes('lebih lengkap') ||
    t.includes('lanjutin penjelasan') ||
    t.includes('lanjut penjelasan')
  );
}

function isExplicitDetailCommand(text) {
  const t = (text || '').toLowerCase().trim();
  return t === 'detail' || t === 'detail ya' || t.startsWith('detail ');
}

function isYes(text) {
  const t = (text || '').toLowerCase().trim();
  return ['ya', 'iya', 'y', 'lanjut', 'lanjutin', 'boleh', 'ok', 'oke', 'gas', 'mau'].some(
    (x) => t === x || t.startsWith(x + ' ')
  );
}

function isNo(text) {
  const t = (text || '').toLowerCase().trim();
  return ['tidak', 'gak', 'ga', 'nggak', 'stop', 'cukup', 'udah', 'selesai'].some(
    (x) => t === x || t.startsWith(x + ' ')
  );
}

function isTopicMenuRequest(text) {
  const t = (text || '').toLowerCase().trim();
  return (
    t === 'menu' ||
    t === 'topik' ||
    t.includes('ganti topik') ||
    t.includes('topik lain') ||
    t.includes('pilih topik') ||
    t.includes('kembali') ||
    t.includes('balik')
  );
}

function looksLikeQuestion(text) {
  const t = (text || '').toLowerCase();
  if (!t.trim()) return false;
  if (t.includes('?')) return true;
  return /(apa|bagaimana|kenapa|kapan|siapa|dimana|berapa|gimana|mengapa|syarat|prosedur|cara|alur)\b/i.test(t);
}

/* ==================== Progressive disclosure marker ==================== */
const CONT_MARKER_PREFIX = '__CONTINUE__:';
function makeContMarker(obj) {
  return CONT_MARKER_PREFIX + JSON.stringify(obj);
}
function parseContMarker(s) {
  if (!s || typeof s !== 'string') return null;
  if (!s.startsWith(CONT_MARKER_PREFIX)) return null;
  try {
    return JSON.parse(s.slice(CONT_MARKER_PREFIX.length));
  } catch {
    return null;
  }
}
function getPendingContinuation(recentDesc) {
  for (const m of recentDesc || []) {
    if ((m?.sender || '').toLowerCase() !== 'meta') continue;
    const parsed = parseContMarker(m?.message);
    if (parsed && parsed.status === 'pending') return parsed;
  }
  return null;
}

/* ==================== Topic selection () ==================== */
const TOPIC_MARKER_PREFIX = '__TOPIC__:';
function makeTopicMarker(topic) {
  return TOPIC_MARKER_PREFIX + JSON.stringify({
    topic: topic ?? null,
    cleared: topic == null,
    set_at: Date.now(),
  });
}
function parseTopicMarker(s) {
  if (!s || typeof s !== 'string') return null;
  if (!s.startsWith(TOPIC_MARKER_PREFIX)) return null;
  try {
    return JSON.parse(s.slice(TOPIC_MARKER_PREFIX.length));
  } catch {
    return null;
  }
}
function getStoredTopic(recentDesc) {
  for (const m of recentDesc || []) {
    if ((m?.sender || '').toLowerCase() !== 'meta') continue;
    const parsed = parseTopicMarker(m?.message);
    if (!parsed) continue;
    if (parsed.cleared) return null; // STOP: topik sudah di-reset
    if (parsed?.topic) return String(parsed.topic).toLowerCase();
  }
  return null;
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // hapus simbol
    .replace(/\s+/g, ' ')    // spasi berlebih
    .trim();
}

function similarity(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0)
  );

  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }

  return 1 - dp[a.length][b.length] / Math.max(a.length, b.length);
}

function fuzzyIncludes(text, keyword, threshold = 0.75) {
  const words = text.split(' ');
  return words.some(w => similarity(w, keyword) >= threshold);
}

function parseTopicChoice(text) {
  const t = normalize(text);
  console.log(t);

  // if (t === '1') return 'asisten_praktikum';
  // if (t === '2') return 'daftar_layanan';
  // if (t === '3') return 'informasi_fit';
  // if (t === '4') return 'kode_etik';
  // if (t === '5') return 'kelengkapan_sidang';
  // if (t === '6') return 'kompetisi';
  // if (t === '7') return 'magang';
  // if (t === '8') return 'organisasi';
  // if (t === '9') return 'perubahan_data';
  // if (t === '10') return 'penilaian_wisudawan';
  // if (t === '11') return 'skl';
  // if (t === '12') return 'surat_aktif';
  // if (t === '13') return 'tak';
  // if (t === '14') return 'tugas_akhir';

  // Mapping berdasarkan teks
  if (
    t.includes('asisten praktikum') ||
    t.includes('asisten') ||
    fuzzyIncludes(t, 'asisten') ||
    fuzzyIncludes(t, 'praktikum')
  ) return 'Asisten Praktikum Dan Praktikum';

  if (
    t.includes('daftar layanan') ||
    t.includes('layanan tersedia') ||
    fuzzyIncludes(t, 'layanan') ||
    fuzzyIncludes(t, 'daftar')
  ) return 'Daftar Layanan Yang tersedia';

  if (
    t.includes('informasi fit') ||
    t.includes('fit') ||
    fuzzyIncludes(t, 'informasi') ||
    fuzzyIncludes(t, 'fit')
  ) return 'informasi FIT';

  if (
    t.includes('kode etik') ||
    t.includes('aturan') ||
    fuzzyIncludes(t, 'etik') ||
    fuzzyIncludes(t, 'aturan')
  ) return 'Kode Etik dan Aturan';

  if (
    t.includes('kelengkapan sidang') ||
    fuzzyIncludes(t, 'kelengkapan') ||
    fuzzyIncludes(t, 'sidang')
  ) return 'kelengkapan sidang';

  if (
    t.includes('kompetisi') ||
    fuzzyIncludes(t, 'kompetisi') ||
    fuzzyIncludes(t, 'lomba')
  ) return 'Kompetisi';

  if (
    t.includes('magang') ||
    fuzzyIncludes(t, 'magang') ||
    fuzzyIncludes(t, 'internship')
  ) return 'Magang';

  if (
    t.includes('organisasi') ||
    fuzzyIncludes(t, 'organisasi') ||
    fuzzyIncludes(t, 'himpunan')
  ) return 'Organisasi';

  if (
    t.includes('perubahan data') ||
    t.includes('data mahasiswa') ||
    fuzzyIncludes(t, 'perubahan') ||
    fuzzyIncludes(t, 'data')
  ) return 'Perubahan data mahasiswa';

  if (
    t.includes('penilaian wisudawan') ||
    t.includes('wisudawan berprestasi') ||
    fuzzyIncludes(t, 'wisudawan') ||
    fuzzyIncludes(t, 'prestasi')
  ) return 'Penilaian Wisudawan berprestasi';

  if (
    t.includes('skl') ||
    t.includes('surat keterangan lulus') ||
    fuzzyIncludes(t, 'skl') ||
    fuzzyIncludes(t, 'lulus')
  ) return 'SKL';

  if (
    t.includes('surat keterangan aktif') ||
    t.includes('surat aktif') ||
    fuzzyIncludes(t, 'surat') ||
    fuzzyIncludes(t, 'aktif')
  ) return 'surat Keterangan Aktif';

  if (
    t.includes('tak') ||
    t.includes('tambahan aktivitas kurikulum') ||
    fuzzyIncludes(t, 'tak')
  ) return 'TAK';

  if (
    t.includes('tugas akhir') ||
    t.includes('skripsi') ||
    t.includes('ta') ||
    fuzzyIncludes(t, 'tugas akhir') ||
    fuzzyIncludes(t, 'skripsi')
  ) return 'Tugas Akhir';

  return null;
}

function inferTopicFromPrompt(prompt) {
  if (!prompt) return null;
  const t = String(prompt || '').toLowerCase().trim();

  // Mapping untuk semua item menu
  if (/\basisten\s+praktikum\b/i.test(t)) return 'asisten_praktikum';
  if (t.includes('asisten praktikum')) return 'asisten_praktikum';

  if (/\bdaftar\s+layanan\b/i.test(t)) return 'daftar_layanan';
  if (t.includes('daftar layanan')) return 'daftar_layanan';

  if (/\binformasi\s+fit\b/i.test(t)) return 'informasi_fit';
  if (t.includes('informasi fit')) return 'informasi_fit';

  if (/\bkode\s+etik\b/i.test(t)) return 'kode_etik';
  if (t.includes('kode etik')) return 'kode_etik';

  if (/\bkelengkapan\s+sidang\b/i.test(t)) return 'kelengkapan_sidang';
  if (t.includes('kelengkapan sidang')) return 'kelengkapan_sidang';

  if (/\bkompetisi\b/i.test(t)) return 'kompetisi';
  if (t.includes('kompetisi')) return 'kompetisi';

  if (/\bmagang\b/i.test(t)) return 'magang';
  if (t.includes('magang')) return 'magang';

  if (/\borganisasi\b/i.test(t)) return 'organisasi';
  if (t.includes('organisasi')) return 'organisasi';

  if (/\bperubahan\s+data\b/i.test(t)) return 'perubahan_data';
  if (t.includes('perubahan data')) return 'perubahan_data';

  if (/\bpenilaian\s+wisudawan\b/i.test(t)) return 'penilaian_wisudawan';
  if (t.includes('penilaian wisudawan')) return 'penilaian_wisudawan';

  if (/\bskl\b/i.test(t)) return 'skl';
  if (t.includes('skl')) return 'skl';

  if (/\bsurat\s+keterangan\s+aktif\b/i.test(t)) return 'surat_aktif';
  if (t.includes('surat keterangan aktif')) return 'surat_aktif';

  if (/\btak\b/i.test(t)) return 'tak';
  if (t.includes('tak')) return 'tak';

  if (/\btugas\s+akhir\b/i.test(t)) return 'tugas_akhir';
  if (t.includes('tugas akhir')) return 'tugas_akhir';

  return null;
}

/* ==================== Dynamic Topics (from Qdrant) ==================== */
async function listDynamicTopics(maxCount = 12) {
  try {
    const qdrant = await createQdrantClient();
    const sc = await qdrant.scroll(CFG.QDRANT_COLLECTION, {
      limit: Math.max(100, maxCount * 20),
      with_payload: true,
      with_vector: false,
    });
    const points = sc?.points || sc?.result?.points || sc?.result || [];
    const set = new Set();
    for (const p of points) {
      const tp = (p?.payload?.topic ?? '').toString().trim().toLowerCase();
      if (tp) set.add(tp);
      if (set.size >= maxCount) break;
    }
    return Array.from(set).sort().slice(0, maxCount);
  } catch {
    return [];
  }
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function resolveDynamicTopicFromPrompt(prompt) {
  const p = String(prompt || '').toLowerCase().trim();
  if (!p) return null;
  try {
    const topics = await listDynamicTopics(50);
    for (const raw of topics) {
      const t = String(raw || '').toLowerCase().trim();
      const tSpace = t.replace(/_/g, ' ');
      const variants = [t, tSpace];
      for (const v of variants) {
        const re = new RegExp(`\\b${escapeRegex(v)}\\b`, 'i');
        if (re.test(p) || p === v) return t; // return canonical dynamic key (lowercase, underscores preserved if any)
      }
    }
    return null;
  } catch {
    return null;
  }
}

/* ==================== MODE marker (STAY TOPIC) ==================== */
const MODE_MARKER_PREFIX = '__MODE__:';
function makeModeMarker(mode) {
  return MODE_MARKER_PREFIX + JSON.stringify({ mode, set_at: Date.now() });
}
function parseModeMarker(s) {
  if (!s || typeof s !== 'string') return null;
  if (!s.startsWith(MODE_MARKER_PREFIX)) return null;
  try {
    return JSON.parse(s.slice(MODE_MARKER_PREFIX.length));
  } catch {
    return null;
  }
}
function getStoredMode(recentDesc) {
  for (const m of recentDesc || []) {
    if ((m?.sender || '').toLowerCase() !== 'meta') continue;
    const parsed = parseModeMarker(m?.message);
    if (parsed?.mode) return String(parsed.mode).toLowerCase();
  }
  return null;
}

/* ==================== Query expansion ==================== */
function expandQuery(query) {
  if (!query) return query;
  const q = query.toLowerCase();
  if (q.includes('apa itu') || q.includes('itu apa') || q.includes('tu apa') || q.startsWith('apa ')) {
    return `${query} definisi pengertian adalah merupakan didefinisikan`;
  }
  return query;
}

function looksLikeDefinitionText(text) {
  const t = (text || '').toLowerCase();
  return t.includes(' adalah ') || t.includes(' merupakan ') || t.includes(' didefinisikan ');
}

/* ==================== Qdrant Helpers ==================== */
async function createQdrantClient() {
  const qdrantModule = await import('@qdrant/js-client-rest');
  const QdrantClient = qdrantModule.QdrantClient || qdrantModule.default?.QdrantClient || qdrantModule.default;
  if (!QdrantClient) throw new Error('QdrantClient not found in @qdrant/js-client-rest module');
  return new QdrantClient({ url: CFG.QDRANT_URL, checkCompatibility: false });
}

function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function countSentences(text) {
  const t = (text || '').trim();
  if (!t) return 0;
  const parts = t.split(/[.!?]+/).map((x) => x.trim()).filter(Boolean);
  return parts.length;
}

function buildDocFilter({ topic, filename }) {
  const must = [];
  
  if (topic) {
    must.push({
      key: 'topic',
      match: { value: topic } 
    });
  }
  
  if (filename) {
    must.push({ 
      key: 'filename', 
      match: { value: filename } 
    });
  }
  
  console.log('Filter topic:', topic);
  console.log('Filter filename:', filename);
  console.log('Complete filter:', must);
  
  return must.length ? { must } : null;
}

/* ==================== Context Builder ==================== */
async function fetchNeighborsAfterAnchor(qdrant, collection, anchorPayload, filter, opts = {}) {
  const filename = anchorPayload?.filename;
  if (!filename) return [];

  const count = Number(opts.count || 6);

  if (typeof anchorPayload?.order === 'number') {
    const from = anchorPayload.order + 1;
    const to = anchorPayload.order + Math.max(30, count * 10);

    const must = [
      ...(filter?.must || []),
      { key: 'filename', match: { value: filename } },
      { key: 'order', range: { gte: from, lte: to } },
    ];

    const sc = await qdrant.scroll(collection, {
      limit: Math.max(30, count * 6),
      with_payload: true,
      with_vector: false,
      filter: { must },
    });

    const points = sc?.points || sc?.result?.points || sc?.result || [];
    const sorted = [...points].sort((a, b) => Number(a?.payload?.order || 0) - Number(b?.payload?.order || 0));
    return sorted.slice(0, count);
  }

  const page = Number(anchorPayload?.page || 0);
  const ci = Number(anchorPayload?.chunk_index || 0);
  if (page > 0 && ci > 0) {
    const must = [
      ...(filter?.must || []),
      { key: 'filename', match: { value: filename } },
      { key: 'page', match: { value: page } },
      { key: 'chunk_index', range: { gte: ci + 1, lte: ci + Math.max(25, count * 8) } },
    ];

    const sc = await qdrant.scroll(collection, {
      limit: Math.max(30, count * 6),
      with_payload: true,
      with_vector: false,
      filter: { must },
    });

    const points = sc?.points || sc?.result?.points || sc?.result || [];
    const sorted = [...points].sort((a, b) => Number(a?.payload?.chunk_index || 0) - Number(b?.payload?.chunk_index || 0));
    return sorted.slice(0, count);
  }

  return [];
}

function buildAnchorPlusNeighborsText(anchorPayload, neighborPoints, opts = {}) {
  const maxChars = Number(opts.maxChars || 6000);
  const minSentences = Number(opts.minSentences || 8);

  const parts = [];
  const anchorText = normalizeText(anchorPayload?.text || anchorPayload?.snippet || '');
  if (anchorText) parts.push(anchorText);

  for (const np of neighborPoints || []) {
    const t = normalizeText(np?.payload?.text || '');
    if (t) parts.push(t);

    const joined = parts.join(' ');
    if (countSentences(joined) >= minSentences) break;
    if (joined.length >= maxChars) break;
  }

  let joined = parts.join(' ').trim();
  if (joined.length > maxChars) joined = joined.slice(0, maxChars);
  return joined;
}

async function fetchNextByCursor(qdrant, collection, marker, filter, opts = {}) {
  const filename = marker?.filename;
  if (!filename) return [];

  const takeN = Number(opts.takeN || 5);

  if (typeof marker.cursor_order === 'number') {
    const must = [
      ...(filter?.must || []),
      { key: 'filename', match: { value: filename } },
      { key: 'order', range: { gte: marker.cursor_order, lte: marker.cursor_order + 220 } },
    ];

    const sc = await qdrant.scroll(collection, {
      limit: Math.max(30, takeN * 6),
      with_payload: true,
      with_vector: false,
      filter: { must },
    });

    const points = sc?.points || sc?.result?.points || sc?.result || [];
    const sorted = [...points].sort((a, b) => Number(a?.payload?.order || 0) - Number(b?.payload?.order || 0));
    return sorted.slice(0, takeN);
  }

  const page = Number(marker.cursor_page || 0);
  const chunkIndex = Number(marker.cursor_chunk_index || 0);
  if (page > 0 && chunkIndex > 0) {
    const must = [
      ...(filter?.must || []),
      { key: 'filename', match: { value: filename } },
      { key: 'page', match: { value: page } },
      { key: 'chunk_index', range: { gte: chunkIndex, lte: chunkIndex + 70 } },
    ];

    const sc = await qdrant.scroll(collection, {
      limit: Math.max(30, takeN * 6),
      with_payload: true,
      with_vector: false,
      filter: { must },
    });

    const points = sc?.points || sc?.result?.points || sc?.result || [];
    const sorted = [...points].sort((a, b) => Number(a?.payload?.chunk_index || 0) - Number(b?.payload?.chunk_index || 0));
    return sorted.slice(0, takeN);
  }

  return [];
}

function ensureClosingQuestion(answer, topic) {
  const closing =
`Apakah masih ingin bertanya tentang topik ${String(topic || '').toUpperCase()}?
- Balas: "lanjut" kalau masih topik ini
- Balas: "ganti topik" atau "menu" kalau mau pilih topik lain`;

  const a = (answer || '').trim();
  if (!a) return closing;
  if (a.toLowerCase().includes('ganti topik') || a.toLowerCase().includes('menu')) return a;
  return `${a}\n\n${closing}`;
}

/* ==================== Embedding helper ==================== */
async function embedText(input) {
  const candidates = [`${CFG.EMBED_URL}/api/embed`, `${CFG.EMBED_URL}/embed`];

  let lastErr = null;
  for (const url of candidates) {
    try {
      const r = await postWithTimeout(
        url,
        { model: CFG.EMBED_MODEL, input, keep_alive: '10m' },
        { timeoutMs: CFG.HTTP_TIMEOUT_MS, retry: 1 }
      );
      if (r.ok) return await r.json();
      lastErr = new Error(await r.text().catch(() => 'embed failed'));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Embedding failed');
}

/* ==================== MAIN ROUTE ==================== */
router.post('/', async (req, res) => {
  const timings = {};
  const tick = (k) => {
    if (!CFG.DEBUG_TIMINGS) return;
    timings[k] = Date.now();
  };

  try {
    tick('start');

    const {
      prompt,
      top_k: rawTopK = CFG.TOP_K_DEFAULT,
      id_user: rawIdUser,
      currentTopic: rawTopic,
      filename: rawFilename,
    } = req.body || {};

    

    const language = detectLanguage(prompt);
    
    let finalPrompt = prompt;
    console.log(finalPrompt);
    if (language == 'english') {
      finalPrompt = await translateEnglishToIndonesian(prompt);
    }

    const top_k = Number(rawTopK || CFG.TOP_K_DEFAULT);
    let id_user = rawIdUser ? Number(rawIdUser) : null;

    // Prefer id_user from JWT if Authorization header present
    try {
      const auth = req.headers?.authorization || '';
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      if (m) {
        const payload = verifyToken(m[1]);
        if (payload && payload.id_user) id_user = Number(payload.id_user);
      }
    } catch {}

    // Require id_user to properly attribute conversation_memory rows
    if (!id_user || Number.isNaN(id_user)) {
      return res.status(401).json({ error: 'Login required. Provide Bearer token or id_user.' });
    }

    let currentTopic = rawTopic ? String(rawTopic).trim().toLowerCase() : null;

    function isTemplateQuery(prompt, topic) {
      if (topic == 'Belum ada') return false;
      const text = prompt.toLowerCase();
      const keywords = ['template', 'tamplate', 'format', 'contoh dokumen', 'formulir', 'blanko'];
      return keywords.some(keyword => text.includes(keyword));
    }

    currentTopic = parseTopicChoice(finalPrompt); 
    
    
    if (topic !== 'Belum ada' && isTemplateQuery(finalPrompt, topic)) {
        //ubah disini
    }
    

    console.log(isTemplateQuery(prompt, topic), currentTopic);
    if (topic == 'Belum ada' || (topic != currentTopic && currentTopic != null)) {
      topic = currentTopic
    }

    async function peekMetadata(collectionName) {
      const qdrant = await createQdrantClient();
      
      const result = await qdrant.scroll(collectionName, {
        limit: 1, // Kita cuma butuh satu contoh
        with_payload: true,
        with_vector: false
      });

      if (result.points.length > 0) {
        console.log("Struktur Metadata Anda:", Object.keys(result.points[0].payload));
        console.log("Contoh Isi:", result.points[0].payload);
      } else {
        console.log("Koleksi kosong.");
      }
    }

    peekMetadata(CFG.QDRANT_COLLECTION);

    if (topic !== 'Belum ada' && isTemplateQuery(finalPrompt, topic)) {
      // Ambil daftar file .docx untuk topik ini dari Qdrant
      const qdrant = await createQdrantClient();
      const COLLECTION = CFG.QDRANT_COLLECTION;

      // Filter untuk topik saat ini
      const filter = buildDocFilter({ topic, filename: null });

      // Scroll untuk mendapatkan semua dokumen dengan topik ini
      const sc = await qdrant.scroll(COLLECTION, {
        limit: 1000, // Angka yang cukup besar, sesuaikan dengan kebutuhan
        with_payload: true,
        with_vector: false,
        filter: filter || undefined,
      });

      const points = sc?.points || sc?.result?.points || sc?.result || [];

      // Kumpulkan nama file unik yang berakhiran .docx
      const docxFiles = new Set();
      for (const p of points) {
        const filename = p?.payload?.filename;
        if (typeof filename === 'string' && filename.toLowerCase().endsWith('.docx')) {
          docxFiles.add(filename);
        }
      }

      // Jika ada file .docx, buat daftar link
      if (docxFiles.size > 0) {
        const fileLinks = Array.from(docxFiles).map(filename => {
          const url = CFG.PUBLIC_BASE_URL ? `${CFG.PUBLIC_BASE_URL}/data/${filename}` : `/data/${filename}`;
          return `- [${filename}](${url})`;
        }).join('\n');

        const answer = `Berikut adalah template dokumen untuk topik ${topic}:\n\n${fileLinks}\n\nSilakan unduh melalui link di atas.`;
        
        await persistMessage(id_user, 'bot', answer, 'answer', null, null);
        return res.json({
          answer,
          sources: [],
          raw_hits: [],
          metadata: analysis,
          context_messages: recentDesc,
          ...(CFG.DEBUG_TIMINGS ? { timings } : {}),
        });
      } else {
        const answer = `Maaf, tidak ditemukan template dokumen (file .docx) untuk topik ${topic}.`;
        await persistMessage(id_user, 'bot', answer, 'answer', null, null);
        return res.json({
          answer,
          sources: [],
          raw_hits: [],
          metadata: analysis,
          context_messages: recentDesc,
          ...(CFG.DEBUG_TIMINGS ? { timings } : {}),
        });
      }
    }
    
    console.log(`[RAG DEBUG] User: ${id_user}, Topic: ${topic}`);
    const filenameFilter = rawFilename ? String(rawFilename).trim() : null;
    console.log(`[RAG DEBUG] User: ${id_user}, Topic: ${filenameFilter}`);

    if (!finalPrompt) return res.status(400).json({ error: 'prompt required' });

    // sentiment/intent logging (optional)
    let analysis = null;
    try {
      analysis = await nlp.analyzeMessage(finalPrompt || '');
      await persistMessage(id_user, 'user', finalPrompt || '', analysis.intent, analysis.sentiment.score, analysis.sentiment.label);
    } catch {
      await persistMessage(id_user, 'user', finalPrompt || '', null, null, null);
    }

    const recentDesc = await getRecentConversation(id_user, 30);
    const pending = getPendingContinuation(recentDesc);

    // mode tersimpan
    let mode = getStoredMode(recentDesc) || 'idle';

    /* ========= MENU / GANTI TOPIK ========= */
    if (isTopicMenuRequest(finalPrompt)) {
      await persistMessage(id_user, 'meta', makeTopicMarker(null), 'meta', null, null);
      await persistMessage(id_user, 'meta', makeModeMarker('idle'), 'meta', null, null);

      const dynTopics = await listDynamicTopics(12);
      const reply = smallTalkReply(dynTopics);
      
      await persistMessage(id_user, 'bot', reply, 'answer', null, null);
      return res.json({
        answer: reply,
        sources: [],
        raw_hits: [],
        metadata: analysis,
        context_messages: recentDesc,
        ...(CFG.DEBUG_TIMINGS ? { timings } : {}),
      });
    }

    /* ========= TOPIC DETECTION / SELECTION ========= */

    // kalau user menyebut topik di finalPrompt (contoh: "kurikulum ...?")
    if (!topic) {
      const inferred = inferTopicFromPrompt(finalPrompt);
      if (inferred) {
        topic = inferred;
        await persistMessage(id_user, 'meta', makeTopicMarker(inferred), 'meta', null, null);

        // kalau finalPrompt itu beneran pertanyaan, langsung masuk "in_topic"
        // kalau cuma nyebut topik aja, masuk "awaiting_question"
        if (looksLikeQuestion(finalPrompt)) {
          await persistMessage(id_user, 'meta', makeModeMarker('in_topic'), 'meta', null, null);
          mode = 'in_topic';
        } else {
          await persistMessage(id_user, 'meta', makeModeMarker('awaiting_question'), 'meta', null, null);
          mode = 'awaiting_question';
          const msg = `Oke, topik aktif: ${topic.toUpperCase()}.\n\nSilakan ketik pertanyaan kamu terkait topik ini.`;
          await persistMessage(id_user, 'bot', msg, 'answer', null, null);
          return res.json({ answer: msg, sources: [], raw_hits: [], metadata: analysis, context_messages: recentDesc });
        }
      }
    } else {
      const msg = `Oke :D, topik aktif: ${topic.toUpperCase()}.\n\nSilakan ketik pertanyaan kamu terkait topik ini.`;
      await persistMessage(id_user, 'bot', msg, 'answer', null, null);
    }

    // kalau belum ada, ambil dari memory
    if (!topic) topic = getStoredTopic(recentDesc);

    // pilihan eksplisit (1/2/3/4/...)
    if (!topic) {
      const chosen = parseTopicChoice(finalPrompt);
      if (chosen) {
        topic = chosen;
        await persistMessage(id_user, 'meta', makeTopicMarker(chosen), 'meta', null, null);
        await persistMessage(id_user, 'meta', makeModeMarker('awaiting_question'), 'meta', null, null);
        mode = 'awaiting_question';

        let msg = '';
        switch (chosen) {
          case 'asisten praktikum dan praktikum':
            msg = 'Baik, topik aktif: ASISTEN PRAKTIKUM.\n\nSilakan tulis pertanyaan terkait Asisten Praktikum.';
            break;
          case 'daftar_layanan':
            msg = 'Baik, topik aktif: DAFTAR LAYANAN YANG TERSEDIA.\n\nSilakan tulis pertanyaan terkait Daftar Layanan.';
            break;
          case 'informasi_fit':
            msg = 'Baik, topik aktif: INFORMASI FIT.\n\nSilakan tulis pertanyaan terkait Informasi FIT.';
            break;
          case 'kode_etik':
            msg = 'Baik, topik aktif: KODE ETIK DAN ATURAN.\n\nSilakan tulis pertanyaan terkait Kode Etik dan Aturan.';
            break;
          case 'kelengkapan_sidang':
            msg = 'Baik, topik aktif: KELENGKAPAN SIDANG.\n\nSilakan tulis pertanyaan terkait Kelengkapan Sidang.';
            break;
          case 'kompetisi':
            msg = 'Baik, topik aktif: KOMPETISI.\n\nSilakan tulis pertanyaan terkait Kompetisi.';
            break;
          case 'magang':
            msg = 'Baik, topik aktif: MAGANG.\n\nSilakan tulis pertanyaan terkait Magang.';
            break;
          case 'organisasi':
            msg = 'Baik, topik aktif: ORGANISASI.\n\nSilakan tulis pertanyaan terkait Organisasi.';
            break;
          case 'perubahan_data':
            msg = 'Baik, topik aktif: PERUBAHAN DATA MAHASISWA.\n\nSilakan tulis pertanyaan terkait Perubahan Data Mahasiswa.';
            break;
          case 'penilaian_wisudawan':
            msg = 'Baik, topik aktif: PENILAIAN WISUDAWAN BERPRESTASI.\n\nSilakan tulis pertanyaan terkait Penilaian Wisudawan Berprestasi.';
            break;
          case 'skl':
            msg = 'Baik, topik aktif: SKL.\n\nSilakan tulis pertanyaan terkait SKL (Surat Keterangan Lulus).';
            break;
          case 'surat_aktif':
            msg = 'Baik, topik aktif: SURAT KETERANGAN AKTIF.\n\nSilakan tulis pertanyaan terkait Surat Keterangan Aktif.';
            break;
          case 'tak':
            msg = 'Baik, topik aktif: TAK.\n\nSilakan tulis pertanyaan terkait TAK (Tambahan Aktivitas Kurikulum).';
            break;
          case 'tugas_akhir':
            msg = 'Baik, topik aktif: TUGAS AKHIR.\n\nSilakan tulis pertanyaan terkait Tugas Akhir.';
            break;
          default:
            msg = 'Topik tidak dikenali. Silakan pilih topik yang tersedia dari menu.';
        }

        await persistMessage(id_user, 'bot', msg, 'answer', null, null);
        return res.json({
          answer: msg,
          sources: [],
          raw_hits: [],
          metadata: analysis,
          context_messages: recentDesc,
          ...(CFG.DEBUG_TIMINGS ? { timings } : {}),
        });
      }

      // coba cocokan dengan topik dinamis dari dokumen
      const dynChosen = await resolveDynamicTopicFromPrompt(finalPrompt);
      if (dynChosen) {
        topic = dynChosen;
        await persistMessage(id_user, 'meta', makeTopicMarker(dynChosen), 'meta', null, null);
        await persistMessage(id_user, 'meta', makeModeMarker('awaiting_question'), 'meta', null, null);
        mode = 'awaiting_question';

        const msg = `Baik, topik aktif: ${toTitleCase(dynChosen)}.\n\nSilakan tulis pertanyaan terkait topik ini.`;
        await persistMessage(id_user, 'bot', msg, 'answer', null, null);
        return res.json({
          answer: msg,
          sources: [],
          raw_hits: [],
          metadata: analysis,
          context_messages: recentDesc,
          ...(CFG.DEBUG_TIMINGS ? { timings } : {}),
        });
      }
    }

    // kalau greeting tapi sudah ada topik: jangan munculin menu, stay.
    if (topic && isSmallTalk(finalPrompt)) {
      const msg = `Halo! Topik aktif sekarang: ${topic.toUpperCase()}.\n\nSilakan ketik pertanyaan kamu tentang topik ini.\nKalau mau ganti, ketik: "menu" atau "ganti topik".`;
      await persistMessage(id_user, 'bot', msg, 'answer', null, null);
      return res.json({ answer: msg, sources: [], raw_hits: [], metadata: analysis, context_messages: recentDesc });
    }

    // kalau belum ada topic sama sekali: baru tampilkan menu
    const lockedTopic = topic || getStoredTopic(recentDesc);
    if (!lockedTopic) {
      const dynTopics = await listDynamicTopics(12);
      const reply = smallTalkReply(dynTopics);
      await persistMessage(id_user, 'bot', reply, 'answer', null, null);
      return res.json({
        answer: reply, lockedTopic,
        sources: [],
        raw_hits: [],
        metadata: analysis,
        context_messages: recentDesc,
        ...(CFG.DEBUG_TIMINGS ? { timings } : {}),
      });
    }

    function shouldStayInTopic(topic, finalPrompt) {
      if (!topic) return false;
      if (isTopicMenuRequest(finalPrompt)) return false;

      // eksplisit pindah topik
      const explicitTopic = inferTopicFromPrompt(finalPrompt) || parseTopicChoice(finalPrompt);
      if (explicitTopic && explicitTopic !== topic) return false;

      return true;
    }

    // kalau user sudah pilih topik tapi belum nanya beneran: tahan, jangan jalanin RAG.
    if (!shouldStayInTopic(topic, finalPrompt)){
      if (mode === 'awaiting_question'){
        if (topic) {
          await persistMessage(id_user, 'meta', makeModeMarker('in_topic'), 'meta', null, null);
          mode = 'in_topic';
        } else if (!looksLikeQuestion(finalPrompt)) {
          const p = (finalPrompt || '').trim().toLowerCase();
          const looksEmpty = p.length < 3 || ['ok', 'oke', 'iya', 'ya', 'siap', 'baik'].includes(p);

          if (looksEmpty) {
            const msg = `Oke, topik aktif: ${topic.toUpperCase()}.\n\nSilakan ketik pertanyaan kamu terkait topik ini.\nKalau mau ganti topik, ketik: "menu".`;
            await persistMessage(id_user, 'bot', msg, 'answer', null, null);
            return res.json({ answer: msg, sources: [], raw_hits: [], metadata: analysis, context_messages: recentDesc });
          }

          // kalau user ngetik kalimat tapi bukan pertanyaan, tetap minta pertanyaan
          const msg = `Topik aktif: ${topic.toUpperCase()}.\n\nTolong tuliskan pertanyaan kamu (contoh: "Apa syarat ...?" / "Bagaimana prosedur ...?").\nKalau mau ganti topik, ketik: "menu".`;
          await persistMessage(id_user, 'bot', msg, 'answer', null, null);
          return res.json({ answer: msg, sources: [], raw_hits: [], metadata: analysis, context_messages: recentDesc });
        }
      }
    }

    // kalau sampai sini berarti: ada topik dan user mulai nanya → set mode in_topic
    if (mode !== 'in_topic') {
      await persistMessage(id_user, 'meta', makeModeMarker('in_topic'), 'meta', null, null);
      mode = 'in_topic';
    }

    /* ==================== RAG ENABLE CHECK ==================== */
    if (!CFG.ENABLE_RAG) {
      const fallback = 'RAG is disabled. Set ENABLE_RAG=true di .env lalu restart.';
      await persistMessage(id_user, 'bot', fallback, 'answer', null, null);
      return res.json({
        answer: fallback,
        sources: [],
        raw_hits: [],
        metadata: analysis,
        context_messages: recentDesc,
        ...(CFG.DEBUG_TIMINGS ? { timings } : {}),
      });
    }

    /* ==================== SUMMARY MODE ==================== */
    if (isSummaryRequest(finalPrompt)) {
      const lastAnswer = getLastBotAnswer(recentDesc);
      if (!lastAnswer) {
        const msg = 'Saya belum menemukan jawaban sebelumnya untuk diringkas.';
        await persistMessage(id_user, 'bot', msg, 'answer', null, null);
        return res.json({ answer: msg, sources: [], raw_hits: [], metadata: analysis, context_messages: recentDesc });
      }

      let summarized = '';
      if (CFG.ENABLE_RAG_GEN) {
        try {
          const body = {
            model: CFG.OLLAMA_MODEL,
            stream: false,
            prompt: `Ringkas teks berikut jadi poin-poin yang mudah dipahami.
Aturan:
- Output WAJIB bullet points (•).
- Bahasa Indonesia sederhana.
- Pertahankan sitasi yang sudah ada.
- Jangan menambah informasi baru.

Teks:
${lastAnswer}`,
            num_predict: 600,
            temperature: 0.2,
          };
          const genResp = await postOllamaWithFallback('generate', body, { timeoutMs: CFG.GEN_TIMEOUT_MS, retry: 1 });
          if (genResp.ok) {
            const genBody = await genResp.json();
            summarized = extractTextFromOllamaResponse(genBody);
          }
        } catch {}
      }

      if (!summarized) {
        const trimmed = normalizeText(lastAnswer);
        summarized = `• ${trimmed.slice(0, 320)}${trimmed.length > 320 ? '…' : ''}`;
      }

      const msg = `${cleanAnswer(summarized)}\n\nKalau ingin versi lebih panjang, balas: "detail" atau "lanjut".\n\n[Kalo membutuhkan dokumen lebih rinci](https://info-bif.telkomuniversity.ac.id/links)`;
      await persistMessage(id_user, 'bot', msg, 'answer', null, null);
      return res.json({ answer: msg, sources: [], raw_hits: [], metadata: analysis, context_messages: recentDesc });
    }

    /* ==================== CONTINUE MODE ==================== */
    if (pending && pending.status === 'pending') {
      if (isNo(finalPrompt)) {
        const msg = 'Baik, saya berhenti di sini. Jika ada hal lain, silakan tanya lagi.\n\nKalau mau ganti topik, ketik: "menu".';
        await persistMessage(id_user, 'meta', makeContMarker({ ...pending, status: 'done', done_at: Date.now() }), 'meta', null, null);
        await persistMessage(id_user, 'bot', msg, 'answer', null, null);
        return res.json({ answer: msg, sources: [], raw_hits: [], metadata: analysis, context_messages: recentDesc });
      }

      const wantsMore =
        isYes(finalPrompt) ||
        isMoreDetailFeedback(finalPrompt) ||
        isExplicitDetailCommand(finalPrompt) ||
        (finalPrompt || '').toLowerCase().includes('lanjut');

      if (!wantsMore) {
        const msg = 'Balas "lanjut" untuk lanjut, atau "stop" untuk berhenti.\nKalau mau ganti topik, ketik: "menu".';
        await persistMessage(id_user, 'bot', msg, 'answer', null, null);
        return res.json({ answer: msg, sources: [], raw_hits: [], metadata: analysis, context_messages: recentDesc });
      }

      tick('qdrant_client');
      const qdrant = await createQdrantClient();
      const COLLECTION = CFG.QDRANT_COLLECTION;
      

      const markerFilter = buildDocFilter({ topic: pending.topic || topic, filename: pending.filename });
      tick('continue_fetch');
      const points = await fetchNextByCursor(qdrant, COLLECTION, pending, markerFilter, { takeN: CFG.CONTINUE_TAKE_N });

      const context = points
        .map((p) => `SOURCE: ${p?.payload?.filename || 'doc'} (p${p?.payload?.page || '?'})\n${normalizeText(p?.payload?.text || '')}`)
        .filter(Boolean)
        .join('\n\n---\n\n');

      const usedSources = points
        .map((p) => ({
          filename: p?.payload?.filename,
          page: p?.payload?.page,
          order: p?.payload?.order,
          chunk_index: p?.payload?.chunk_index,
          topic: p?.payload?.topic,
        }))
        .filter((s) => s.filename);

      let answer = '';
      if (CFG.ENABLE_RAG_GEN && context) {
        tick('continue_gen');
        const body = {
          model: CFG.OLLAMA_MODEL,
          stream: false,
          prompt: `Kamu adalah asisten AI profesional yang menjawab pertanyaan berdasarkan dokumen yang diberikan. Jawaban HARUS enak dibaca dan hanya dari Context yang tersedia.

ATURAN OUTPUT:
- Fokus pada topik yang ditanyakan, jangan membahas topik lain
- Kalau prosedur/syarat: bullet points + 1 paragraf penjelas
- Sitasi per kalimat faktual: (NamaFile.pdf pXX)
- Jangan mengarang. Kalau kurang data, bilang "di potongan dokumen yang tersedia belum terlihat".

Pertanyaan user: ${pending.last_question || '(lanjutan)'}
Instruksi: lanjutkan penjelasan (tambahkan detail yang relevan) berdasarkan Context berikut.

Context:
${context}

Tutup jawaban dengan:
"Apakah penjelasan ini sudah cukup, atau masih ada bagian lain yang ingin Anda ketahui?"`,
          num_predict: CFG.NUM_PREDICT_NORMAL,
          temperature: CFG.TEMPERATURE,
        };

        const genResp = await postOllamaWithFallback('generate', body, { timeoutMs: CFG.GEN_TIMEOUT_MS, retry: 1 });
        if (genResp.ok) {
          const genBody = await genResp.json();
          answer = cleanAnswer(extractTextFromOllamaResponse(genBody) || '');
        }
      }

      if (!answer) {
        const rawText = normalizeText(points.map((p) => p?.payload?.text || '').join(' '));
        answer = rawText.slice(0, 5200).trim();
      }

      answer = await polishAnswerWithGemma(answer);
      answer = ensureClosingQuestion(answer, topic);
      answer = `${answer}\n\nINI UPDATED (lanjutan)`;


      const last = points[points.length - 1];
      const lastOrder = typeof last?.payload?.order === 'number' ? Number(last.payload.order) : null;
      const lastChunkIndex = Number(last?.payload?.chunk_index || 0);
      const lastPage = Number(last?.payload?.page || 0);

      const nextMarker = { ...pending, updated_at: Date.now(), status: 'pending' };
      if (lastOrder !== null) nextMarker.cursor_order = lastOrder + 1;
      else if (lastPage && lastChunkIndex) {
        nextMarker.cursor_page = lastPage;
        nextMarker.cursor_chunk_index = lastChunkIndex + 1;
      }

      await persistMessage(id_user, 'meta', makeContMarker(nextMarker), 'meta', null, null);

      const answerWithLink = `${answer}\n\n[Kalo membutuhkan dokumen lebih rinci](https://info-bif.telkomuniversity.ac.id/links)`;
      await persistMessage(id_user, 'bot', answerWithLink, 'answer', null, null);

      return res.json({
        answer: answerWithLink,
        sources: usedSources.map((s) => ({
          ...s,
          url: CFG.PUBLIC_BASE_URL ? `${CFG.PUBLIC_BASE_URL}/data/${s.filename}` : `/data/${s.filename}`,
        })),
        raw_hits: [],
        metadata: analysis,
        context_messages: recentDesc,
        ...(CFG.DEBUG_TIMINGS ? { timings } : {}),
      });
    }



const SERVICE_INDEX = JSON.parse(fs.readFileSync("./services.index.json")).services;

const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

const findService = q => {
  const t = norm(q);
  return SERVICE_INDEX.find(s => t.includes(norm(s.name)) || t.includes(norm(s.key))) || null;
};

const renderCard = s => {
  const email = s.contacts.emails?.[0] || "-";
  const phone = s.contacts.phones?.[0] || "-";
  return `**${s.name}**\n- Deskripsi: ${s.desc}\n- Email: ${email}\n- Telepon/WA: ${phone}`;
};

if (/kontak|nomor|email|telepon|wa|whatsapp/i.test(finalPrompt)) {
  const svc = findService(finalPrompt);
  if (svc) {
    return res.json({ answer: renderCard(svc) });
  }
}

    /* ==================== DEFAULT (RAG) ==================== */
    const wantsDetail = isExplicitDetailCommand(finalPrompt) || isMoreDetailFeedback(finalPrompt);

    if (isExplicitDetailCommand(finalPrompt) && !pickLastUserQuestion(recentDesc)) {
      const msg = 'Boleh. Kirim pertanyaannya dulu, nanti saya jawab versi detail.';
      await persistMessage(id_user, 'bot', msg, 'answer', null, null);
      return res.json({ answer: msg, sources: [], raw_hits: [], metadata: analysis, context_messages: recentDesc });
    }


    let userQuery = finalPrompt;

    if (isExplicitDetailCommand(finalPrompt)) {
      const lastQ = pickLastUserQuestion(recentDesc);
      if (lastQ) userQuery = `${lastQ}\nTolong jawab versi lebih lengkap dan rinci.`;
    }

    const effectivePrompt = expandQuery(userQuery);

    tick('qdrant_client');
    const qdrant = await createQdrantClient();
    const COLLECTION = CFG.QDRANT_COLLECTION;

    console.log(COLLECTION);
    const docFilter = buildDocFilter({ topic, filename: filenameFilter });

    tick('embed');
    const embedResp = await embedText(effectivePrompt);

    const qvec =
      (Array.isArray(embedResp?.embedding) && embedResp.embedding) ||
      (Array.isArray(embedResp?.embeddings) && Array.isArray(embedResp.embeddings?.[0]) ? embedResp.embeddings[0] : null) ||
      embedResp?.data?.[0]?.embedding ||
      null;

    if (!qvec) return res.status(500).json({ error: 'No embedding returned from embed service' });

    tick('qdrant_search');
    const initialLimit = Math.max(top_k * 3, 18);
    let hits = await qdrant.search(COLLECTION, {
      vector: qvec,
      limit: initialLimit,
      with_payload: true,
      filter: docFilter || undefined,
    });

    const qLower = String(userQuery).toLowerCase();
    const keywords = qLower.split(/\s+/).filter((w) => w.length > 2);

    const isDefQ =
      qLower.includes('apa') ||
      qLower.includes('pengertian') ||
      qLower.includes('definisi') ||
      qLower.includes('itu apa') ||
      qLower.includes('tu apa');

    hits = (hits || [])
      .map((h) => {
        const pay = h?.payload || {};
        const text = String(pay?.text || pay?.snippet || '').toLowerCase();
        const filename = String(pay?.filename || '').toLowerCase();
        const payTopic = String(pay?.topic || '').toLowerCase();

        let s = h?.score || 0;
        let km = 0;

        for (const kw of keywords) {
          if (text.includes(kw)) {
            km++;
            s += 0.03;
          }
        }

        if (isDefQ && looksLikeDefinitionText(text)) s += 0.25;
        if (filename && keywords.some((k) => filename.includes(k))) s += 0.02;

        if (topic && payTopic === topic) s += 0.35;
        if (topic && payTopic && payTopic !== topic) s -= 0.25;

        return { ...h, reranked_score: s, keyword_matches: km };
      })
      .sort((a, b) => (b.reranked_score || b.score || 0) - (a.reranked_score || a.score || 0));

    const relevant = hits
      .filter((h) => (h.reranked_score || h.score || 0) >= CFG.RAG_MIN_SCORE)
      .slice(0, Math.max(top_k, 10));

    if (!relevant.length) {
      const msg = `Maaf, saya belum menemukan bagian dokumen yang relevan di topik ${topic?.toUpperCase()}. Coba tulis kata kunci yang lebih spesifik.\n\nKalau mau ganti topik, ketik: "menu".`;
      await persistMessage(id_user, 'bot', msg, 'answer', null, null);
      return res.json({ answer: msg, sources: [], raw_hits: [], metadata: analysis, context_messages: recentDesc });
    }

    const anchor = relevant[0];
    const anchorPayload = anchor?.payload || {};

    const neighborCount = wantsDetail ? CFG.NEIGHBORS_DETAIL : CFG.NEIGHBORS_NORMAL;
    tick('neighbors');
    const neighbors = await fetchNeighborsAfterAnchor(qdrant, COLLECTION, anchorPayload, docFilter, { count: neighborCount });

    const focusedText = buildAnchorPlusNeighborsText(anchorPayload, neighbors, {
      maxChars: wantsDetail ? CFG.MAXCHARS_DETAIL : CFG.MAXCHARS_NORMAL,
      minSentences: wantsDetail ? CFG.MINSENT_DETAIL : CFG.MINSENT_NORMAL,
    });

    const contextBlocks = [];
    if (focusedText && focusedText.trim()) {
      contextBlocks.push(`SOURCE: ${anchorPayload.filename || 'doc'} (p${anchorPayload.page || '?'})\n${focusedText}`);
    }

    const extraCount = wantsDetail ? CFG.EXTRAS_DETAIL : CFG.EXTRAS_NORMAL;
    const extras = relevant
      .slice(1, extraCount + 1)
      .map((h) => {
        const p = h?.payload || {};
        const t = normalizeText(p.text || p.snippet || '').slice(0, wantsDetail ? 1400 : 1000);
        if (!t || !t.trim()) return '';
        return `SOURCE: ${p.filename || 'doc'} (p${p.page || '?'})\n${t}`;
      })
      .filter(Boolean);

    contextBlocks.push(...extras);

    const sources = [];
    for (const pt of [anchor, ...neighbors]) {
      const pay = pt?.payload || {};
      if (!pay.filename) continue;
      sources.push({
        filename: pay.filename,
        page: pay.page,
        order: pay.order,
        chunk_index: pay.chunk_index,
        topic: pay.topic,
      });
    }
    for (const h of relevant.slice(1, extraCount + 1)) {
      const pay = h?.payload || {};
      if (!pay.filename) continue;
      if (!sources.some((s) => s.filename === pay.filename && s.page === pay.page && s.chunk_index === pay.chunk_index)) {
        sources.push({
          filename: pay.filename,
          page: pay.page,
          order: pay.order,
          chunk_index: pay.chunk_index,
          topic: pay.topic,
        });
      }
    }

    console.log(language);
    let answer = '';
    if (CFG.ENABLE_RAG_GEN && contextBlocks.length > 0) {
      tick('gen');
      try {
        const contextText = contextBlocks.join('\n\n---\n\n');
        console.log(contextText);
        const body = {
          model: CFG.OLLAMA_MODEL,
          stream: false,
          prompt: `Anda adalah asisten AI profesional yang menjawab pertanyaan berdasarkan dokumen yang diberikan.

## ATURAN UTAMA:
1. **Jawaban HARUS berdasarkan Context yang tersedia** - jangan gunakan pengetahuan eksternal
2. **Beri sitasi** untuk setiap kalimat faktual dengan format: (NamaFile.pdf halamanXX)
3. **Jika informasi tidak ada di Context**, katakan: "Di dokumen yang tersedia, informasi ini belum terlihat"
4. **Fokus pada topik**: ${topic} - jangan membahas dokumen topik lain
5. **Jangan mengarang informasi** apapun

## FORMAT JAWABAN:
- **Struktur**: Jawab langsung ke inti pertanyaan
- **Poin-poin**: Jika ada daftar, gunakan format:
  1. [poin pertama]
  2. [poin kedua] 
  3. [poin ketiga]

  atau jika tidak berurut pakai: 

  - [poin pertama]
  - [poin kedua] 
  - [poin ketiga]
- **Paragraf**: Jarak antar poin maksimal 1 baris kosong

## GAYA BAHASA:
${wantsDetail 
  ? '- **Mode detail**: Lebih lengkap dan rinci, tetap ringkas per poin\n- **Prosedur/syarat**: Gunakan format poin berurutan' 
  : '- **Definisi**: 4–7 kalimat ringkas\n- **Penjelasan umum**: 7–12 kalimat\n- **Prosedur/syarat**: Format poin'}

## CONTEXT YANG TERSEDIA:
${contextText}

## PERTANYAAN USER:
${userQuery}

## INSTRUKSI AKHIR:
1. Jawab berdasarkan Context di atas
2. Pastikan setiap fakta memiliki sitasi
3. Gunakan bahasa Indonesia yang formal dan rapi
4. Misalkan tidak menemukan jawabannya maka berikan informasi yang cukup mirip dan tambahkan "Berikut informasi yang mungkin sesuai."
5. Tutup dengan: "Apakah penjelasan ini sudah cukup, atau ada bagian lain yang ingin Anda ketahui?"
6. Buatlah jawaban ini dalam bahasa ${language}`,
          num_predict: wantsDetail ? CFG.NUM_PREDICT_DETAIL : CFG.NUM_PREDICT_NORMAL,
          temperature: CFG.TEMPERATURE,
        };

        const genResp = await postOllamaWithFallback('generate', body, { timeoutMs: CFG.GEN_TIMEOUT_MS, retry: 1 });
        if (genResp && genResp.ok) {
          const genBody = await genResp.json();
          const extracted = extractTextFromOllamaResponse(genBody);
          if (extracted && extracted.trim()) answer = cleanAnswer(extracted);
        }
      } catch (genErr) {
        console.error('[rag] Generation error:', genErr?.message || genErr);
      }
    }

    if (!answer || !answer.trim()) {
      if (focusedText && focusedText.trim()) answer = cleanAnswer(focusedText);
      else if (contextBlocks.length > 0 && contextBlocks[0]) {
        const firstContext = contextBlocks[0].replace(/^SOURCE:.*?\n/, '').trim();
        answer = cleanAnswer(firstContext.slice(0, 2000));
      } else {
        answer = 'Maaf, saya tidak dapat menemukan informasi yang relevan untuk pertanyaan Anda. Silakan coba dengan kata kunci yang lebih spesifik.';
      }
    }

    // answer = await polishAnswerWithGemma(answer);
    answer = ensureClosingQuestion(answer, topic);
    answer = `${answer}\n\nUPDATED v2 `;


    const nextMarker = {
      status: 'pending',
      filename: anchorPayload.filename,
      topic: anchorPayload.topic || topic || null,
      created_at: Date.now(),
      last_question: userQuery,
    };

    if (typeof anchorPayload.order === 'number') {
      const lastOrder = neighbors.length
        ? Number(neighbors[neighbors.length - 1]?.payload?.order || anchorPayload.order)
        : Number(anchorPayload.order);
      nextMarker.cursor_order = lastOrder + 1;
    } else {
      const lastChunk = neighbors.length ? neighbors[neighbors.length - 1]?.payload : anchorPayload;
      nextMarker.cursor_page = Number(lastChunk?.page || anchorPayload.page || 0);
      nextMarker.cursor_chunk_index = Number(lastChunk?.chunk_index || anchorPayload.chunk_index || 0) + 1;
    }

    await persistMessage(id_user, 'meta', makeContMarker(nextMarker), 'meta', null, null);

    const uniqueFilenames = [...new Set(sources.map((s) => s.filename).filter(Boolean))];
    const firstFile = uniqueFilenames[0] || anchorPayload.filename || 'document';
    const docUrl = CFG.PUBLIC_BASE_URL ? `${CFG.PUBLIC_BASE_URL}/data/${firstFile}` : `/data/${firstFile}`;

    const finalAnswer =
      `${answer}\n\n---\n\n` +
      `[Link dokumen: ${firstFile}](${docUrl})\n\n` +
      `Jika masih kurang detail, balas "lanjut" (bertahap) atau "detail" (lebih panjang).\n\n` +
      `[Kalo membutuhkan dokumen lebih rinci](https://linktr.ee/fit.telkomuniversity)`;

    await persistMessage(id_user, 'bot', finalAnswer, 'answer', null, null);

    return res.json({
      answer: finalAnswer,
      sources: sources.map((s) => ({
        ...s,
        url: CFG.PUBLIC_BASE_URL ? `${CFG.PUBLIC_BASE_URL}/data/${s.filename}` : `/data/${s.filename}`,
      })),
      raw_hits: relevant.slice(0, top_k).map((h) => ({
        id: h.id,
        score: h.reranked_score || h.score || 0,
        filename: h?.payload?.filename,
        page: h?.payload?.page,
        order: h?.payload?.order,
        chunk_index: h?.payload?.chunk_index,
        topic: h?.payload?.topic,
      })),
      metadata: analysis,
      context_messages: recentDesc,
      ...(CFG.DEBUG_TIMINGS ? { timings } : {}),
    });
  } catch (err) {
    console.error('[rag] error:', err?.stack || err);
    return res.status(500).json({ error: String(err) });
  }
});

export default router;