// server/routes/rag.js
import express from 'express';
import nodeFetch from 'node-fetch';
const fetch = globalThis.fetch || nodeFetch;

import { pool } from '../db.js';
import nlp from '../utils/nlp.js';

const router = express.Router();

/* ==================== Config (tuning) ==================== */
const CFG = {
  ENABLE_RAG: (process.env.ENABLE_RAG || 'false').toLowerCase() === 'true',
  ENABLE_RAG_GEN: (process.env.ENABLE_RAG_GEN || 'false').toLowerCase() === 'true',

  OLLAMA_URL: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'gemma3:4b',

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
    // retry only for network/timeout-like failures
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

  // Buang pembuka yang template banget
  s = s.replace(/^\s*(berikut|berdasarkan dokumen|menurut dokumen|dari dokumen)\b[:\s-]*/i, '');

  // Normalisasi format poin-poin: pastikan setiap poin di baris terpisah
  // Deteksi pola poin: "1. ", "2. ", atau "- ", "• "
  s = s.replace(/([^\n])(\d+\.\s)/g, '$1\n$2'); // Pastikan poin angka di baris baru jika tidak
  s = s.replace(/([^\n])([-•]\s)/g, '$1\n$2'); // Pastikan bullet di baris baru jika tidak

  // Rapikan spasi per baris (jangan rusak bullet/newline)
  s = s
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trimEnd())
    .filter(line => line.length > 0 || line === '') // Hapus baris yang hanya whitespace
    .join('\n');

  // Hapus terlalu banyak baris kosong (maksimal 1 baris kosong berturut-turut)
  s = s.replace(/\n{3,}/g, '\n\n');

  // Pastikan jarak antar poin tidak terlalu jauh (maksimal 1 baris kosong)
  // Pola: poin diikuti oleh 2+ baris kosong lalu poin berikutnya
  s = s.replace(/(\n\d+\.\s[^\n]+)\n{2,}(\d+\.)/g, '$1\n$2'); // Poin angka ke poin angka
  s = s.replace(/(\n[-•]\s[^\n]+)\n{2,}([-•])/g, '$1\n$2'); // Bullet ke bullet
  s = s.replace(/(\n\d+\.\s[^\n]+)\n{2,}([-•])/g, '$1\n$2'); // Poin angka ke bullet
  s = s.replace(/(\n[-•]\s[^\n]+)\n{2,}(\d+\.)/g, '$1\n$2'); // Bullet ke poin angka

  // Pastikan jarak antara paragraf dan poin juga tidak terlalu jauh
  s = s.replace(/([^\n]\.)\n{2,}(\d+\.)/g, '$1\n$2'); // Paragraf ke poin angka
  s = s.replace(/([^\n]\.)\n{2,}([-•])/g, '$1\n$2'); // Paragraf ke bullet

  // Rapikan spasi sebelum tanda baca (per baris)
  s = s
    .split('\n')
    .map((line) => line.replace(/\s+([.,!?;:])/g, '$1'))
    .join('\n');

  // Hapus baris kosong di awal dan akhir
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
  
  // Cek apakah ada topik atau pertanyaan dalam pesan
  const hasTopic = /\b(kp|ium|kerja\s+praktik|kerja\s+praktek|informatika\s+untuk\s+masyarakat)\b/i.test(p);
  const hasQuestion = /[?]|apa\s|bagaimana|kenapa|kapan|siapa|dimana|berapa|gimana|mengapa/i.test(p);
  
  // Jika ada topik atau pertanyaan, bukan smalltalk
  if (hasTopic || hasQuestion) return false;
  
  // Exact match untuk greeting singkat (prioritas tertinggi)
  const exactGreetings = ['__init__', 'hai', 'halo', 'hi', 'hey', 'helo', 'selamat pagi', 'selamat siang', 'selamat sore', 'selamat malam', 'assalamualaikum', 'assalamu\'alaikum'];
  if (exactGreetings.includes(p)) return true;
  
  // Jika panjang <= 20 dan hanya mengandung greeting words
  if (p.length <= 20) {
    const greetingWords = ['hai', 'halo', 'hi', 'hey', 'helo', 'selamat', 'assalamualaikum', 'assalamu\'alaikum'];
    const words = p.split(/\s+/).filter(w => w.length > 0);
    const hasGreeting = words.some(w => greetingWords.includes(w));
    // Jika hanya greeting words tanpa kata lain yang berarti (maksimal 3 kata)
    if (hasGreeting && words.length <= 3) return true;
  }
  
  return false;
}

function smallTalkReply(prompt) {
  const p = (prompt || '').toLowerCase().trim();
  return `Halo! Saya asisten chatbot yang siap membantu Anda.



Silakan pilih topik yang ingin Anda tanyakan:

1. Kerja Praktik (KP)

   Ketik: 1 atau KP

2. Informatika Untuk Masyarakat (IUM)

   Ketik: 2 atau IUM

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

// "kurang detail" -> jangan langsung tarik 500 chunk; cukup naikkan detail level / arahkan ke "lanjut"
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

/* ==================== Topic selection (KP/IUM) ==================== */
const TOPIC_MARKER_PREFIX = '__TOPIC__:';
function makeTopicMarker(topic) {
  return TOPIC_MARKER_PREFIX + JSON.stringify({ topic, set_at: Date.now() });
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
    if (parsed?.topic) return String(parsed.topic).toLowerCase();
  }
  return null;
}
function parseTopicChoice(text) {
  const t = String(text || '').toLowerCase().trim();
  if (t === '1') return 'kp';
  if (t === '2') return 'ium';
  if (t === 'kp' || t.includes('kerja praktik') || t.includes('kerja praktek')) return 'kp';
  if (t === 'ium' || t.includes('informatika untuk masyarakat')) return 'ium';
  return null;
}
function inferTopicFromPrompt(prompt) {
  if (!prompt) return null;
  const t = String(prompt || '').toLowerCase().trim();
  
  // Cek IUM dengan berbagai variasi - prioritas tinggi
  if (/\bium\b/i.test(t)) return 'ium';
  if (t.includes('informatika untuk masyarakat')) return 'ium';
  if (/\binformatika\s+untuk\s+masyarakat\b/i.test(t)) return 'ium';
  
  // Cek KP dengan berbagai variasi - prioritas tinggi
  if (/\bkp\b/i.test(t)) return 'kp';
  if (t.includes('kerja praktik')) return 'kp';
  if (t.includes('kerja praktek')) return 'kp';
  if (/\bkerja\s+praktik\b/i.test(t)) return 'kp';
  if (/\bkerja\s+praktek\b/i.test(t)) return 'kp';
  
  // Variasi dengan kata depan
  if (/(?:tentang|mengenai|soal|perihal|dari|tentang|mau\s+tanya\s+tentang|ingin\s+tahu\s+tentang)\s+(?:ium|informatika\s+untuk\s+masyarakat)/i.test(t)) return 'ium';
  if (/(?:tentang|mengenai|soal|perihal|dari|tentang|mau\s+tanya\s+tentang|ingin\s+tahu\s+tentang)\s+(?:kp|kerja\s+praktik|kerja\s+praktek)/i.test(t)) return 'kp';
  
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

/**
 * Filter builder: biar KP/IUM ga kecampur.
 * - kalau client ngirim { topic: "kp" } -> filter by topic
 * - kalau client ngirim { filename: "KP.pdf" } -> filter by filename
 */
function buildDocFilter({ topic, filename }) {
  const must = [];
  if (topic) must.push({ key: 'topic', match: { value: String(topic).toLowerCase() } });
  if (filename) must.push({ key: 'filename', match: { value: String(filename) } });
  return must.length ? { must } : null;
}

/* ==================== Context Builder (dibatasi biar ngebut) ==================== */
async function fetchNeighborsAfterAnchor(qdrant, collection, anchorPayload, filter, opts = {}) {
  const filename = anchorPayload?.filename;
  if (!filename) return [];

  const count = Number(opts.count || 6);

  // prefer order if exists
  if (typeof anchorPayload?.order === 'number') {
    const from = anchorPayload.order + 1;
    const to = anchorPayload.order + Math.max(30, count * 10); // bounded

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

  // fallback: page + chunk_index
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

function ensureClosingQuestion(answer) {
  const closing = 'Apakah penjelasan ini sudah cukup, atau masih ada bagian lain yang ingin Anda ketahui?';
  const a = (answer || '').trim();
  if (!a) return closing;
  if (a.toLowerCase().includes('apakah penjelasan ini sudah cukup')) return a;
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
      topic: rawTopic,
      filename: rawFilename,
    } = req.body || {};

    const top_k = Number(rawTopK || CFG.TOP_K_DEFAULT);
    const id_user = rawIdUser ? Number(rawIdUser) : null;

    let topic = rawTopic ? String(rawTopic).trim().toLowerCase() : null;
    const filenameFilter = rawFilename ? String(rawFilename).trim() : null;

    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    // sentiment/intent logging (optional)
    let analysis = null;
    try {
      analysis = await nlp.analyzeMessage(prompt || '');
      await persistMessage(id_user, 'user', prompt || '', analysis.intent, analysis.sentiment.score, analysis.sentiment.label);
    } catch {
      await persistMessage(id_user, 'user', prompt || '', null, null, null);
    }

    const recentDesc = await getRecentConversation(id_user, 30);
    const pending = getPendingContinuation(recentDesc);

    /* ========= TOPIC GATING ========= */
    // CEK SMALLTALK/GREETING DULU - jika hanya greeting tanpa topik, langsung tampilkan menu
    const isOnlyGreeting = isSmallTalk(prompt);
    
    // Cek topik dari prompt dulu (sebelum memory) untuk mendeteksi topik yang disebutkan bersama greeting
    let inferredTopic = null;
    if (!topic) {
      inferredTopic = inferTopicFromPrompt(prompt);
      if (inferredTopic) {
        topic = inferredTopic;
        await persistMessage(id_user, 'meta', makeTopicMarker(inferredTopic), 'meta', null, null);
        if (CFG.DEBUG_TIMINGS) console.log('[rag] Topic inferred from prompt:', inferredTopic, 'for prompt:', prompt);
      }
    }
    
    // Jika hanya greeting tanpa topik (baik dari prompt maupun memory), tampilkan menu
    if (isOnlyGreeting && !topic) {
      const reply = smallTalkReply(prompt);
      if (CFG.DEBUG_TIMINGS) {
        console.log('[rag] Returning smalltalk menu:', reply);
      }
      await persistMessage(id_user, 'bot', reply, 'smalltalk', null, null);
      return res.json({
        answer: reply,
        sources: [],
        raw_hits: [],
        metadata: analysis,
        context_messages: await getRecentConversation(id_user, 10),
        ...(CFG.DEBUG_TIMINGS ? { timings } : {}),
      });
    }

    // PRIORITAS 1: Cek topik dari memory (jika belum ada dari prompt)
    if (!topic) topic = getStoredTopic(recentDesc);
    
    // PRIORITAS 3: Cek pilihan eksplisit (1/2/KP/IUM) - hanya jika belum ada topik
    if (!topic) {
      const chosen = parseTopicChoice(prompt);
      if (chosen) {
        topic = chosen;
        await persistMessage(id_user, 'meta', makeTopicMarker(chosen), 'meta', null, null);

        const msg =
          chosen === 'ium'
            ? 'Baik, kita akan fokus pada dokumen Informatika Untuk Masyarakat (IUM).\n\nSilakan tanyakan apa pun terkait IUM.'
            : 'Baik, kita akan fokus pada dokumen Kerja Praktik (KP).\n\nSilakan tanyakan apa pun terkait KP.';

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

    if (!topic) {
      const msg = `Halo! Saya asisten chatbot yang siap membantu Anda.



Silakan pilih topik yang ingin Anda tanyakan:

1. Kerja Praktik (KP)

   Ketik: 1 atau KP

2. Informatika Untuk Masyarakat (IUM)

   Ketik: 2 atau IUM

.`;
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
    if (isSummaryRequest(prompt)) {
      const lastAnswer = getLastBotAnswer(recentDesc);
      if (!lastAnswer) {
        const msg = 'Saya belum menemukan jawaban sebelumnya untuk diringkas.';
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

      const msg = `${cleanAnswer(summarized)}\n\nKalau ingin versi lebih panjang, balas: "detail" atau "lanjut".`;
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

    /* ==================== CONTINUE MODE ==================== */
    if (pending && pending.status === 'pending') {
      if (isNo(prompt)) {
        const msg = 'Baik, saya berhenti di sini. Jika ada hal lain, silakan tanya lagi.';
        await persistMessage(id_user, 'meta', makeContMarker({ ...pending, status: 'done', done_at: Date.now() }), 'meta', null, null);
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

      // "kurang detail" / "detail" / "lanjut" -> lanjutkan by cursor (cepet & bertahap)
      const wantsMore = isYes(prompt) || isMoreDetailFeedback(prompt) || isExplicitDetailCommand(prompt) || (prompt || '').toLowerCase().includes('lanjut');
      if (!wantsMore) {
        const msg = 'Balas "lanjut" untuk lanjut, atau "stop" untuk berhenti.';
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

Tutup jawaban dengan: "Apakah penjelasan ini sudah cukup, atau masih ada bagian lain yang ingin Anda ketahui?"`,
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

      answer = ensureClosingQuestion(answer);

      // update cursor
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
      await persistMessage(id_user, 'bot', answer, 'answer', null, null);

      return res.json({
        answer,
        sources: usedSources.map((s) => ({
          ...s,
          url: CFG.PUBLIC_BASE_URL ? `${CFG.PUBLIC_BASE_URL}/files/${s.filename}` : `/files/${s.filename}`,
        })),
        raw_hits: [],
        metadata: analysis,
        context_messages: recentDesc,
        ...(CFG.DEBUG_TIMINGS ? { timings } : {}),
      });
    }

    /* ==================== DEFAULT (RAG) ==================== */
    // Detail level:
    // - normal: cepat
    // - detail: lebih panjang tapi tetap dibatasi (bukan 500 chunk)
    const wantsDetail = isExplicitDetailCommand(prompt) || isMoreDetailFeedback(prompt);

    // kalau user cuma bilang "detail" tapi belum ada pertanyaan sebelumnya
    if (isExplicitDetailCommand(prompt) && !pickLastUserQuestion(recentDesc)) {
      const msg = 'Boleh. Kirim pertanyaannya dulu, nanti saya jawab versi detail.';
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

    // kalau user bilang "detail" setelah jawaban sebelumnya, pakai pertanyaan terakhir sebagai basis
    let userQuery = prompt;
    if (isExplicitDetailCommand(prompt)) {
      const lastQ = pickLastUserQuestion(recentDesc);
      if (lastQ) userQuery = `${lastQ}\nTolong jawab versi lebih lengkap dan rinci.`;
    }

    const effectivePrompt = expandQuery(userQuery);

    tick('qdrant_client');
    const qdrant = await createQdrantClient();
    const COLLECTION = CFG.QDRANT_COLLECTION;

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

        // anti-nyasar topic
        if (topic && payTopic === topic) s += 0.35;
        if (topic && payTopic && payTopic !== topic) s -= 0.25;

        return { ...h, reranked_score: s, keyword_matches: km };
      })
      .sort((a, b) => (b.reranked_score || b.score || 0) - (a.reranked_score || a.score || 0));

    const relevant = hits
      .filter((h) => (h.reranked_score || h.score || 0) >= CFG.RAG_MIN_SCORE)
      .slice(0, Math.max(top_k, 10));

    if (!relevant.length) {
      const msg = `Maaf, saya belum menemukan bagian dokumen yang relevan di dokumen ${topic?.toUpperCase() || 'yang dipilih'}. Coba tulis kata kunci yang lebih spesifik.`;
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

    // anchor + neighbors (dibatasi)
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
    // Pastikan focusedText tidak kosong sebelum ditambahkan
    if (focusedText && focusedText.trim()) {
      contextBlocks.push(`SOURCE: ${anchorPayload.filename || 'doc'} (p${anchorPayload.page || '?'})\n${focusedText}`);
    }

    const extraCount = wantsDetail ? CFG.EXTRAS_DETAIL : CFG.EXTRAS_NORMAL;
    const extras = relevant.slice(1, extraCount + 1).map((h) => {
      const p = h?.payload || {};
      const t = normalizeText(p.text || p.snippet || '').slice(0, wantsDetail ? 1400 : 1000);
      if (!t || !t.trim()) return '';
      return `SOURCE: ${p.filename || 'doc'} (p${p.page || '?'})\n${t}`;
    }).filter(Boolean);

    contextBlocks.push(...extras);
    
    // Validasi: pastikan ada context sebelum generasi
    if (contextBlocks.length === 0) {
      console.warn('[rag] No context blocks available for generation');
    }

    // sources list
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

    // generate answer
    let answer = '';
    if (CFG.ENABLE_RAG_GEN && contextBlocks.length > 0) {
      tick('gen');
      try {
        const contextText = contextBlocks.join('\n\n---\n\n');
        if (!contextText || !contextText.trim()) {
          console.warn('[rag] Context text is empty, skipping generation');
        } else {
          const body = {
            model: CFG.OLLAMA_MODEL,
            stream: false,
            prompt: `Kamu adalah asisten AI profesional yang menjawab pertanyaan berdasarkan dokumen yang diberikan. Jawaban HARUS rapi dan hanya berdasarkan Context yang tersedia.

ATURAN UTAMA:
- Jawab langsung (tanpa "Berikut..." / "Berdasarkan dokumen...")
- Fokus pada topik yang ditanyakan
- Sitasi per kalimat faktual: (NamaFile.pdf pXX)
- Jangan mengarang. Kalau tidak ada di context, bilang "di potongan dokumen yang tersedia belum terlihat".
- Topik aktif: "${topic}" (jangan menyebut dokumen topik lain)

FORMAT POIN-POIN (PENTING):
- Jika ada daftar/poin-poin, SETIAP POIN HARUS di baris terpisah
- Gunakan format: 1. Poin pertama\n2. Poin kedua\n3. Poin ketiga
- JARAK ANTAR POIN: maksimal 1 baris kosong (tidak boleh lebih)
- Jangan membuat jarak terlalu jauh antar poin

Gaya jawaban:
${wantsDetail ? '- Buat lebih lengkap dan rinci, tetap ringkas per poin, boleh 3–6 paragraf.\n- Kalau ada prosedur/syarat: gunakan format poin-poin dengan setiap poin di baris terpisah, jarak antar poin maksimal 1 baris kosong.' : '- Untuk definisi: 4–7 kalimat.\n- Untuk penjelasan umum: 7–12 kalimat.\n- Untuk prosedur/syarat: gunakan format poin-poin dengan setiap poin di baris terpisah, jarak antar poin maksimal 1 baris kosong.\n- Format poin: setiap poin harus di baris terpisah, gunakan angka (1., 2., 3.) untuk setiap poin.'}

Pertanyaan: ${userQuery}

Context:
${contextText}

Tutup jawaban dengan:
"Apakah penjelasan ini sudah cukup, atau masih ada bagian lain yang ingin Anda ketahui?"`,
            num_predict: wantsDetail ? CFG.NUM_PREDICT_DETAIL : CFG.NUM_PREDICT_NORMAL,
            temperature: CFG.TEMPERATURE,
          };

          const genResp = await postOllamaWithFallback('generate', body, { timeoutMs: CFG.GEN_TIMEOUT_MS, retry: 1 });
          if (genResp && genResp.ok) {
            const genBody = await genResp.json();
            const extracted = extractTextFromOllamaResponse(genBody);
            if (extracted && extracted.trim()) {
              answer = cleanAnswer(extracted);
            } else {
              console.warn('[rag] Generated answer is empty');
            }
          } else {
            console.warn('[rag] Generation failed, status:', genResp?.status, 'using fallback');
          }
        }
      } catch (genErr) {
        console.error('[rag] Generation error:', genErr?.message || genErr);
        // Fall through to use focusedText
      }
    } else if (!CFG.ENABLE_RAG_GEN) {
      console.warn('[rag] RAG generation is disabled (ENABLE_RAG_GEN=false)');
    }

    // Fallback: gunakan focusedText jika generasi gagal atau tidak diaktifkan
    if (!answer || !answer.trim()) {
      if (focusedText && focusedText.trim()) {
        answer = cleanAnswer(focusedText);
      } else if (contextBlocks.length > 0 && contextBlocks[0]) {
        // Fallback ke context block pertama jika focusedText kosong
        const firstContext = contextBlocks[0].replace(/^SOURCE:.*?\n/, '').trim();
        answer = cleanAnswer(firstContext.slice(0, 2000));
      } else {
        answer = 'Maaf, saya tidak dapat menemukan informasi yang relevan untuk pertanyaan Anda. Silakan coba dengan kata kunci yang lebih spesifik.';
      }
    }
    
    answer = ensureClosingQuestion(answer);

    // store continuation marker
    const nextMarker = {
      status: 'pending',
      filename: anchorPayload.filename,
      topic: anchorPayload.topic || topic || null,
      created_at: Date.now(),
      last_question: userQuery,
    };

    if (typeof anchorPayload.order === 'number') {
      const lastOrder = neighbors.length ? Number(neighbors[neighbors.length - 1]?.payload?.order || anchorPayload.order) : Number(anchorPayload.order);
      nextMarker.cursor_order = lastOrder + 1;
    } else {
      const lastChunk = neighbors.length ? neighbors[neighbors.length - 1]?.payload : anchorPayload;
      nextMarker.cursor_page = Number(lastChunk?.page || anchorPayload.page || 0);
      nextMarker.cursor_chunk_index = Number(lastChunk?.chunk_index || anchorPayload.chunk_index || 0) + 1;
    }

    await persistMessage(id_user, 'meta', makeContMarker(nextMarker), 'meta', null, null);

    // Pastikan answer tidak kosong
    if (!answer || !answer.trim()) {
      answer = 'Maaf, saya tidak dapat menemukan informasi yang relevan untuk pertanyaan Anda. Silakan coba dengan kata kunci yang lebih spesifik.';
    }

    // append doc link (tanpa memodifikasi sitasi isi jawaban)
    const uniqueFilenames = [...new Set(sources.map((s) => s.filename).filter(Boolean))];
    const firstFile = uniqueFilenames[0] || anchorPayload.filename || 'document';
    const docUrl = CFG.PUBLIC_BASE_URL ? `${CFG.PUBLIC_BASE_URL}/files/${firstFile}` : `/files/${firstFile}`;

    const finalAnswer = `${answer}\n\n---\n\n[Link dokumen: ${firstFile}](${docUrl})\n\nJika masih kurang detail, balas "lanjut" (bertahap) atau "detail" (lebih panjang).`;

    await persistMessage(id_user, 'bot', finalAnswer, 'answer', null, null);

    return res.json({
      answer: finalAnswer,
      sources: sources.map((s) => ({
        ...s,
        url: CFG.PUBLIC_BASE_URL ? `${CFG.PUBLIC_BASE_URL}/files/${s.filename}` : `/files/${s.filename}`,
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
