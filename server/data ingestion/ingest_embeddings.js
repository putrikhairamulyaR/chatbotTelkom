import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

import nodeFetch from 'node-fetch';
const fetch = globalThis.fetch || nodeFetch;

import { OpenAI } from 'openai';
import { QdrantClient } from '@qdrant/js-client-rest';
import { createHash } from 'crypto';

dotenv.config();

/* ==================== ENV + DEFAULTS ==================== */
console.log('INGEST START - env preview:');
console.log('  USE_OLLAMA=', process.env.USE_OLLAMA);
console.log('  OPENAI_API_KEY present=', !!process.env.OPENAI_API_KEY);
console.log('  OLLAMA_URL=', process.env.OLLAMA_URL);
console.log('  QDRANT_URL=', process.env.QDRANT_URL);
console.log('  QDRANT_COLLECTION=', process.env.QDRANT_COLLECTION);

const DATA_DIR = path.resolve(process.cwd(), '..', 'data');
console.log('  DATA_DIR=', DATA_DIR);

const COLLECTION = process.env.QDRANT_COLLECTION || 'documents';
const USE_OLLAMA = (process.env.USE_OLLAMA || 'true').toLowerCase() === 'true';

const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || process.env.EMBED_MODEL || 'nomic-embed-text';

const EMBED_MODEL = USE_OLLAMA
  ? OLLAMA_EMBED_MODEL
  : (process.env.EMBED_MODEL || 'text-embedding-3-small');

const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '1000', 10);
const CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP || '200', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '10', 10);

const PAYLOAD_TEXT_MAX = parseInt(process.env.PAYLOAD_TEXT_MAX || '4200', 10);
const EMBED_TEXT_MAX = parseInt(process.env.EMBED_TEXT_MAX || '3500', 10);

// kalau TRUE -> recreate collection tiap ingest (AMAN buat debug)
const FORCE_RECREATE = (process.env.FORCE_RECREATE || 'false').toLowerCase() === 'true';

if (!process.env.QDRANT_URL) throw new Error('QDRANT_URL missing');

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const openai = USE_OLLAMA ? null : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ==================== TOPIC HELPERS ==================== */
/**
 * ✅ TOPIC HARUS SAMA dengan rag.js kamu:
 * kp, ium, kurikulum, magang_berdampak, sosialisasi_registrasi, pendaftaran_sidang
 */
function inferTopicFromPath(fullPath) {
  const rel = path.relative(DATA_DIR, fullPath).replace(/\\/g, '/');
  const parts = rel.split('/').filter(Boolean);

  // kalau ada subfolder dan namanya sesuai topik, pakai itu
  const folder = (parts.length >= 2 ? parts[0] : '').toLowerCase().trim();
  const allowed = new Set([
    'kp',
    'ium',
    'kurikulum',
    'magang_berdampak',
    'sosialisasi_registrasi',
    'pendaftaran_sidang',
  ]);
  if (allowed.has(folder)) return folder;

  // file di root: mapping by filename
  const base = path.basename(fullPath).toLowerCase();

  if (base.includes('ium')) return 'ium';
  if (base === 'kp.pdf' || /\bkp\b/.test(base) || base.includes('kerja')) return 'kp';

  if (base.includes('kurikulum') || base.includes('buku-saku')) return 'kurikulum';

  if (base.includes('magang') && base.includes('berdampak')) return 'magang_berdampak';

  if (base.includes('sosialisasi') && base.includes('registrasi')) return 'sosialisasi_registrasi';

  if ((base.includes('pendaftaran') && base.includes('sidang')) || (base.includes('info') && base.includes('sidang'))) {
    return 'pendaftaran_sidang';
  }

  return 'general';
}

function makeDocId(fullPath) {
  const rel = path.relative(DATA_DIR, fullPath).replace(/\\/g, '/');
  return createHash('sha1').update(rel).digest('hex').slice(0, 16);
}

function makePublicFilename(fullPath) {
  // file kamu ada di /data root, basename cocok untuk /files/<filename>
  return path.basename(fullPath);
}

/**
 * ✅ Qdrant id: UUID string
 */
function sha1ToStableUuid(input) {
  const hex40 = createHash('sha1').update(input).digest('hex'); // 40 hex
  const h = hex40.slice(0, 32).split(''); // 32 hex chars

  // set UUID version = 5
  h[12] = '5';
  // set variant (10xx)
  const v = parseInt(h[16], 16);
  h[16] = ((v & 0x3) | 0x8).toString(16);

  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

function makePointId(doc_id, page, chunk_index) {
  const key = `${doc_id}|p${page}|c${chunk_index}`;
  return sha1ToStableUuid(key);
}

/* ==================== TEXT HELPERS ==================== */
function chunkWithOverlap(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

function sanitizeForEmbed(s) {
  return (s ?? '')
    .replace(/\u0000/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ')
    .replace(/[.]{10,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLowSignal(s) {
  if (!s) return true;
  if (s.length < 30) return true;

  const alnum = (s.match(/[A-Za-z0-9]/g) || []).length;
  const ratio = alnum / Math.max(1, s.length);

  return alnum < 20 || ratio < 0.15;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ==================== PDF EXTRACTION ==================== */
async function extractPdfPages(filePath) {
  try {
    const data = await fsPromises.readFile(filePath);

    let pdfParse = null;
    try {
      const mod = await import('pdf-parse');
      pdfParse = mod && (mod.default || mod);
    } catch {
      pdfParse = null;
    }

    if (!pdfParse) return [''];

    const res = await pdfParse(data);
    const numPages = res.numpages || 0;
    const extractedText = res.text || '';

    const byFormFeed = extractedText.split('\f').map((s) => s.trim()).filter(Boolean);
    if (byFormFeed.length >= Math.max(1, numPages)) return byFormFeed;

    if (numPages > 0) {
      const approx = [];
      const perLen = Math.ceil(extractedText.length / numPages);
      for (let i = 0; i < numPages; i++) {
        approx.push(extractedText.slice(i * perLen, Math.min((i + 1) * perLen, extractedText.length)).trim());
      }
      return approx.filter(Boolean);
    }

    return [extractedText.trim()];
  } catch (err) {
    console.error('Error reading PDF', filePath, err?.message);
    return [''];
  }
}

async function extractTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return { type: 'pdf', pages: await extractPdfPages(filePath) };
  const text = await fsPromises.readFile(filePath, 'utf8');
  return { type: 'text', pages: [text] };
}

async function* walk(dir) {
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/* ==================== QDRANT ==================== */
async function checkQdrantConnection() {
  await qdrant.getCollections();
  return true;
}

// ✅ detect apakah collection pakai named vectors atau single vector
function detectVectorSchema(vectorsConfig) {
  if (!vectorsConfig) return { kind: 'unknown' };
  if (typeof vectorsConfig === 'object' && 'size' in vectorsConfig) return { kind: 'single' }; // {size, distance}
  // named vector: { default: {size, distance}, ... }
  if (typeof vectorsConfig === 'object') return { kind: 'named' };
  return { kind: 'unknown' };
}

async function recreateSingleVectorCollection(vectorSize) {
  console.log(`(Re)Creating collection ${COLLECTION} as SINGLE vector, size=${vectorSize}`);
  await qdrant.recreateCollection(COLLECTION, {
    vectors: { size: vectorSize, distance: 'Cosine' },
  });
}

async function ensureCollection(vectorSize) {
  if (FORCE_RECREATE) {
    await recreateSingleVectorCollection(vectorSize);
    return;
  }

  try {
    const info = await qdrant.getCollection(COLLECTION);
    const vectorsCfg = info?.config?.params?.vectors;
    const schema = detectVectorSchema(vectorsCfg);

    if (schema.kind === 'named') {
      // kalau dulu kebentuk named vector, itu bikin upsert single vector "Bad Request"
      console.log('Collection exists but uses NAMED vectors schema. Recreating to SINGLE vector schema...');
      await recreateSingleVectorCollection(vectorSize);
      return;
    }

    const currentSize = vectorsCfg?.size;
    if (currentSize && currentSize !== vectorSize) {
      console.log(`Vector size mismatch. Recreating: was ${currentSize}, now ${vectorSize}`);
      await recreateSingleVectorCollection(vectorSize);
      return;
    }

    console.log(`✓ Collection ${COLLECTION} OK (size=${currentSize || vectorSize})`);
  } catch {
    console.log('Collection not found. Creating...');
    await qdrant.createCollection(COLLECTION, { vectors: { size: vectorSize, distance: 'Cosine' } });
  }
}

async function upsertWithRetry(points, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // wait:true biar error ketangkep jelas
      await qdrant.upsert(COLLECTION, { wait: true, points });
      return true;
    } catch (e) {
      const msg = e?.message || String(e);
      const detail = e?.response?.data || e?.data;

      if (detail) {
        try {
          console.error('  Upsert error detail:', JSON.stringify(detail).slice(0, 1500));
        } catch {
          console.error('  Upsert error detail:', String(detail).slice(0, 1500));
        }
      }

      const transient =
        msg.includes('ECONNREFUSED') ||
        msg.includes('connect') ||
        msg.includes('UND_ERR_SOCKET') ||
        msg.includes('other side closed') ||
        msg.includes('timeout');

      if (transient && attempt < retries) {
        console.log(`  Upsert failed (attempt ${attempt + 1}/${retries + 1}), retrying...`);
        await sleep(900);
        continue;
      }

      console.error('  Upsert failed:', msg.slice(0, 400));
      return false;
    }
  }
  return false;
}

/* ==================== EMBEDDING ==================== */
function normalizeEmbedding(vec) {
  if (!Array.isArray(vec)) return null;
  const out = vec.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (out.length !== vec.length) return null;
  if (out.length === 0) return null;
  return out;
}

async function fetchOllamaEmbedSingle(urlBase, model, rawText) {
  const baseUrl = (urlBase || '').replace(/\/$/, '');
  const textToUse = sanitizeForEmbed(rawText);

  if (isLowSignal(textToUse)) return { embedding: null, skipped: true };

  const resp = await fetch(`${baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: textToUse, keep_alive: '10m' }),
  });

  const txt = await resp.text();
  if (!resp.ok) return { embedding: null, skipped: true, error: txt };

  let result;
  try {
    result = JSON.parse(txt);
  } catch {
    return { embedding: null, skipped: true, error: `Invalid JSON from embed: ${txt.slice(0, 200)}` };
  }

  const embRaw =
    (Array.isArray(result?.embedding) && result.embedding) ||
    (Array.isArray(result?.embeddings?.[0]) ? result.embeddings[0] : null) ||
    (Array.isArray(result?.data?.[0]?.embedding) ? result.data[0].embedding : null);

  const emb = normalizeEmbedding(embRaw);
  if (emb) return { embedding: emb, skipped: false };

  return { embedding: null, skipped: true, error: 'Embedding not valid array' };
}

async function fetchEmbedUrlBatch(embedBase, model, texts) {
  const base = (embedBase || '').replace(/\/$/, '');
  const candidates = [`${base}/api/embed`, `${base}/embed`];
  for (const url of candidates) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        console.warn(`  embed endpoint ${url} returned ${resp.status}: ${txt.slice(0,200)}`);
        continue;
      }
      const data = await resp.json();
      if (Array.isArray(data?.embeddings)) return data.embeddings.map((e) => normalizeEmbedding(e));
      if (Array.isArray(data?.data)) return data.data.map((d) => normalizeEmbedding(d?.embedding ?? null));
      // For Ollama style single-embedding responses like {embedding: [...]}
      if (Array.isArray(data?.embedding)) return [normalizeEmbedding(data.embedding)];
      return null;
    } catch (err) {
      console.warn(`  EMBED_URL request to ${url} failed:`, err?.message || err);
      continue;
    }
  }
  return null;
}

async function testEmbeddingProvider() {
  const sample = ['hello world'];

  // 1) try EMBED_URL
  if (process.env.EMBED_URL) {
    const got = await fetchEmbedUrlBatch(process.env.EMBED_URL, EMBED_MODEL, sample);
    if (Array.isArray(got) && got[0]) return 'embed_url';
  }

  // 2) try Ollama single (if enabled)
  if (USE_OLLAMA) {
    const r = await fetchOllamaEmbedSingle(OLLAMA_URL, OLLAMA_EMBED_MODEL, sample[0]);
    if (Array.isArray(r?.embedding) && r.embedding.length > 0) return 'ollama';
  }

  // 3) try OpenAI (if available)
  if (openai) {
    try {
      const res = await openai.embeddings.create({ model: EMBED_MODEL, input: sample });
      if (res.data?.length && Array.isArray(res.data[0].embedding)) return 'openai';
    } catch (err) {
      // ignore
    }
  }

  return null;
}

/* ==================== MAIN ==================== */
async function run() {
  if (!USE_OLLAMA && !process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');

  console.log('Checking Qdrant connection...');
  await checkQdrantConnection();
  console.log('✓ Qdrant connection OK');

  if (!fs.existsSync(DATA_DIR)) throw new Error(`DATA_DIR not found: ${DATA_DIR}`);

  const staged = [];

  for await (const file of walk(DATA_DIR)) {
    if (!fs.existsSync(file)) continue;

    const ext = path.extname(file).toLowerCase();
    if (!['.pdf', '.txt', '.md', '.json', '.csv'].includes(ext)) continue;

    const topic = inferTopicFromPath(file);
    const doc_id = makeDocId(file);
    const publicFilename = makePublicFilename(file);

    console.log('Processing', file, 'topic=', topic, 'doc_id=', doc_id, 'filename=', publicFilename);

    try {
      const extracted = await extractTextFile(file);

      for (let p = 0; p < extracted.pages.length; p++) {
        const pageText = extracted.pages[p] || '';
        const chunks = chunkWithOverlap(pageText, CHUNK_SIZE, CHUNK_OVERLAP);

        for (let ci = 0; ci < chunks.length; ci++) {
          const cleaned = sanitizeForEmbed(chunks[ci]);
          if (!cleaned) continue;
          if (isLowSignal(cleaned)) continue;

          const payloadText = cleaned.slice(0, PAYLOAD_TEXT_MAX);
          const embedText = cleaned.slice(0, EMBED_TEXT_MAX);

          const order = (p + 1) * 10000 + (ci + 1);

          const payload = {
            topic,
            doc_id,
            filename: publicFilename,
            original_filename: path.basename(file),
            filepath: path.relative(process.cwd(), file).replace(/\\/g, '/'),
            source: 'local',

            page: p + 1,
            chunk_index: ci + 1,
            order,
            char_count: cleaned.length,

            text: payloadText,
            snippet: cleaned.slice(0, 450),
          };

          const pointId = makePointId(doc_id, payload.page, payload.chunk_index);
          staged.push({ id: pointId, payload, vector: null, embedText });
        }
      }
    } catch (err) {
      console.error('Failed to process', file, err?.message || err);
    }
  }

  console.log(`Prepared ${staged.length} chunks for embedding`);

  let ensured = false;

  // Preflight: test provider availability once before heavy work
  const provider = await testEmbeddingProvider();
  if (!provider) {
    throw new Error('No embedding provider available. Configure EMBED_URL, ensure Ollama model is available, or set OPENAI_API_KEY.');
  }

  for (let i = 0; i < staged.length; i += BATCH_SIZE) {
    const batch = staged.slice(i, i + BATCH_SIZE);
    const texts = batch.map((p) => p.embedText);

    console.log(`Embedding batch ${i}-${Math.min(i + BATCH_SIZE, staged.length)}...`);

    let embeddings = null;

    // 1) Try EMBED_URL (fast batch) if configured
    if (process.env.EMBED_URL) {
      embeddings = await fetchEmbedUrlBatch(process.env.EMBED_URL, EMBED_MODEL, texts);
      if (Array.isArray(embeddings) && embeddings.every((e) => e === null)) embeddings = null;
    }

    // 2) If EMBED_URL not used/failed, try Ollama per-item (if enabled)
    if (!embeddings && USE_OLLAMA) {
      const allEmbeddings = [];
      for (let idx = 0; idx < texts.length; idx++) {
        const t = sanitizeForEmbed(texts[idx]);
        if (isLowSignal(t)) {
          allEmbeddings.push(null);
          continue;
        }
        const r = await fetchOllamaEmbedSingle(OLLAMA_URL, OLLAMA_EMBED_MODEL, t);
        allEmbeddings.push(r?.embedding || null);
        if (idx < texts.length - 1) await sleep(150);
      }
      embeddings = allEmbeddings;
    }

    // 3) Fallback to OpenAI when available
    if (!embeddings && openai) {
      const res = await openai.embeddings.create({ model: EMBED_MODEL, input: texts });
      if (!res.data?.length) throw new Error('Empty embeddings response');
      embeddings = res.data.map((d) => normalizeEmbedding(d.embedding));
    }

    if (!ensured) {
      const firstValid = embeddings.find((e) => Array.isArray(e) && e.length > 0);
      if (firstValid) {
        await ensureCollection(firstValid.length);
        ensured = true;
      } else {
        console.warn('  No valid embeddings in this batch; continuing...');
        continue;
      }
    }

    const upsertPoints = batch
      .map((p, idx) => ({ id: p.id, vector: embeddings[idx], payload: p.payload }))
      .filter((p) => Array.isArray(p.vector) && p.vector.length > 0);

    if (upsertPoints.length === 0) {
      console.log('  No valid vectors in this batch, skipping upsert.');
      continue;
    }

    const ok = await upsertWithRetry(upsertPoints, 2);
    if (ok) console.log(`Upserted ${upsertPoints.length} points to Qdrant`);

    await sleep(120);
  }

  console.log('Ingestion complete ✅');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
