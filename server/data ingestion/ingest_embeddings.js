import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

import nodeFetch from 'node-fetch';
const fetch = globalThis.fetch || nodeFetch;

import { OpenAI } from 'openai';
import { QdrantClient } from '@qdrant/js-client-rest';
import { randomUUID, createHash } from 'crypto';

dotenv.config();

/* ==================== ENV + DEFAULTS ==================== */
console.log('INGEST START - env preview:');
console.log('  USE_OLLAMA=', process.env.USE_OLLAMA);
console.log('  OPENAI_API_KEY present=', !!process.env.OPENAI_API_KEY);
console.log('  OLLAMA_URL=', process.env.OLLAMA_URL);
console.log('  QDRANT_URL=', process.env.QDRANT_URL);

const DATA_DIR = path.resolve(process.cwd(), '..', 'data');
const COLLECTION = process.env.QDRANT_COLLECTION || 'documents';

const USE_OLLAMA = (process.env.USE_OLLAMA || 'true').toLowerCase() === 'true';

const EMBED_MODEL = USE_OLLAMA
  ? (process.env.EMBED_MODEL || process.env.OLLAMA_MODEL || 'nomic-embed-text')
  : (process.env.EMBED_MODEL || 'text-embedding-3-small');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.EMBED_MODEL || process.env.OLLAMA_MODEL || 'nomic-embed-text';

const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '1000', 10);
const CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP || '200', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '10', 10);

// hard caps
const PAYLOAD_TEXT_MAX = parseInt(process.env.PAYLOAD_TEXT_MAX || '4200', 10);
const EMBED_TEXT_MAX = parseInt(process.env.EMBED_TEXT_MAX || '3500', 10);

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const openai = USE_OLLAMA ? null : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ==================== TOPIC HELPERS ==================== */
/**
 * data/kp/KP.pdf  -> topic = "kp"
 * data/ium/IUM.pdf -> topic = "ium"
 * fallback: infer from filename
 */
function inferTopicFromPath(fullPath) {
  const rel = path.relative(DATA_DIR, fullPath).replace(/\\/g, '/');
  const parts = rel.split('/').filter(Boolean);

  const folder = (parts.length >= 2 ? parts[0] : '').toLowerCase().trim();
  if (folder) return folder;

  const base = path.basename(fullPath).toLowerCase();
  if (base.includes('ium')) return 'ium';
  if (base.includes('kp')) return 'kp';

  return 'general';
}

/**
 * doc_id harus stabil supaya:
 * - bisa di-filter
 * - aman kalau ada file dengan nama sama di folder beda
 */
function makeDocId(fullPath) {
  const rel = path.relative(DATA_DIR, fullPath).replace(/\\/g, '/');
  return createHash('sha1').update(rel).digest('hex').slice(0, 16);
}

/**
 * filename UI: biar bisa dibuka /files/...
 * kalau ada file sama, tetap aman karena ada doc_id
 */
function makePublicFilename(fullPath) {
  // kamu bisa biarkan basename saja, tapi ini lebih aman:
  // misal: "KP.pdf" -> "kp__KP.pdf" (folderprefix)
  const rel = path.relative(DATA_DIR, fullPath).replace(/\\/g, '/');
  const parts = rel.split('/').filter(Boolean);

  const base = path.basename(fullPath);
  if (parts.length >= 2) {
    const folder = parts[0];
    return `${folder}__${base}`; // contoh: ium__IUM.pdf
  }
  return base;
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

    if (pdfParse) {
      const res = await pdfParse(data);
      const numPages = res.numpages || 0;
      const extractedText = res.text || '';

      const byFormFeed = extractedText.split('\f').map((s) => s.trim()).filter(Boolean);
      if (byFormFeed.length >= Math.max(1, numPages)) return byFormFeed;

      if (numPages > 0) {
        const approx = [];
        const perLen = Math.ceil(extractedText.length / numPages);
        for (let i = 0; i < numPages; i++) {
          approx.push(
            extractedText.slice(i * perLen, Math.min((i + 1) * perLen, extractedText.length)).trim()
          );
        }
        return approx.filter(Boolean);
      }

      return [extractedText.trim()];
    }

    return [''];
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

async function ensureCollectionWithSize(vectorSize) {
  try {
    const info = await qdrant.getCollection(COLLECTION);
    const currentSize = info?.config?.params?.vectors?.size;
    if (currentSize && currentSize !== vectorSize) {
      console.log(`Recreating collection ${COLLECTION} with vector size ${vectorSize} (was ${currentSize})`);
      await qdrant.recreateCollection(COLLECTION, { vectors: { size: vectorSize, distance: 'Cosine' } });
    }
  } catch {
    console.log('Creating collection', COLLECTION, 'with vector size', vectorSize);
    await qdrant.createCollection(COLLECTION, { vectors: { size: vectorSize, distance: 'Cosine' } });
  }
}

async function upsertWithRetry(points, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await qdrant.upsert(COLLECTION, { wait: false, points });
      return true;
    } catch (e) {
      const msg = e?.message || String(e);
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
      console.error('  Upsert failed:', msg.slice(0, 220));
      return false;
    }
  }
  return false;
}

/* ==================== OLLAMA EMBEDDING ==================== */
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

  const result = JSON.parse(txt);
  const emb =
    (Array.isArray(result?.embedding) && result.embedding) ||
    (Array.isArray(result?.embeddings?.[0]) ? result.embeddings[0] : null);

  if (Array.isArray(emb) && emb.length > 0) return { embedding: emb, skipped: false };
  return { embedding: null, skipped: true };
}

/* ==================== MAIN ==================== */
async function run() {
  if (!USE_OLLAMA && !process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
  if (!process.env.QDRANT_URL) throw new Error('QDRANT_URL missing');

  console.log('Checking Qdrant connection...');
  await checkQdrantConnection();
  console.log('✓ Qdrant connection OK');

  const points = [];

  for await (const file of walk(DATA_DIR)) {
    if (!fs.existsSync(file)) continue;

    const ext = path.extname(file).toLowerCase();
    if (!['.pdf', '.txt', '.md', '.json', '.csv'].includes(ext)) continue;

    const topic = inferTopicFromPath(file);
    const doc_id = makeDocId(file);
    const publicFilename = makePublicFilename(file);

    console.log('Processing', file, 'topic=', topic, 'doc_id=', doc_id);

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

          // order stabil untuk continue mode: per doc_id
          const order = (p + 1) * 10000 + (ci + 1);

          const payload = {
            topic,
            doc_id,                 // ✅ penting
            filename: publicFilename, // ✅ aman buat /files/...
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

          points.push({ id: randomUUID(), payload, vector: null, embedText });
        }
      }
    } catch (err) {
      console.error('Failed to process', file, err?.message || err);
    }
  }

  console.log(`Prepared ${points.length} chunks for embedding`);

  let ensured = false;

  for (let i = 0; i < points.length; i += BATCH_SIZE) {
    const batch = points.slice(i, i + BATCH_SIZE);
    const texts = batch.map((p) => p.embedText);

    console.log(`Embedding batch ${i}-${Math.min(i + BATCH_SIZE, points.length)}...`);

    let embeddings = null;

    if (USE_OLLAMA) {
      const allEmbeddings = [];
      for (let idx = 0; idx < texts.length; idx++) {
        const t = sanitizeForEmbed(texts[idx]);
        if (isLowSignal(t)) {
          allEmbeddings.push(null);
          continue;
        }
        const r = await fetchOllamaEmbedSingle(OLLAMA_URL, OLLAMA_EMBED_MODEL, t);
        allEmbeddings.push(Array.isArray(r?.embedding) ? r.embedding : null);
        if (idx < texts.length - 1) await sleep(250);
      }
      embeddings = allEmbeddings;
    } else {
      const res = await openai.embeddings.create({ model: EMBED_MODEL, input: texts });
      if (!res.data?.length) throw new Error('Empty embeddings response');
      embeddings = res.data.map((d) => d.embedding);
    }

    if (!ensured) {
      const firstValid = embeddings.find((e) => Array.isArray(e) && e.length > 0);
      if (firstValid) {
        await ensureCollectionWithSize(firstValid.length);
        ensured = true;
      } else {
        console.warn('  No valid embeddings in this batch; continuing...');
        continue;
      }
    }

    const upsertPoints = batch
      .map((p, idx) => ({ ...p, vector: embeddings[idx] }))
      .filter((p) => Array.isArray(p.vector) && p.vector.length > 0)
      .map((p) => ({ id: p.id, vector: p.vector, payload: p.payload }));

    if (upsertPoints.length === 0) {
      console.log('  No valid vectors in this batch, skipping upsert.');
      continue;
    }

    const ok = await upsertWithRetry(upsertPoints, 2);
    if (ok) console.log(`Upserted ${upsertPoints.length} points to Qdrant`);

    await sleep(250);
  }

  console.log('Ingestion complete ✅');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
