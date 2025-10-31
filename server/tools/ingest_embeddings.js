import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import pdfParse from 'pdf-parse';
import { OpenAI } from 'openai';
import { QdrantClient } from '@qdrant/js-client-rest';

dotenv.config();

const DATA_DIR = path.resolve(process.cwd(), '..', 'data');
const COLLECTION = process.env.QDRANT_COLLECTION || 'documents';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const qdrant = new QdrantClient({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY });

function chunkText(text, maxLen = 800) {
  const parts = [];
  let i = 0;
  while (i < text.length) {
    parts.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return parts;
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    const data = fs.readFileSync(filePath);
    const res = await pdfParse(data);
    return res.text;
  }
  // fallback: read as text
  return fs.readFileSync(filePath, 'utf8');
}

async function ensureCollection() {
  try {
    await qdrant.getCollection(COLLECTION);
  } catch (e) {
    console.log('Creating collection', COLLECTION);
    await qdrant.createCollection({
      collection_name: COLLECTION,
      vectors: { size: 1536, distance: 'Cosine' },
    });
  }
}

async function run() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
  if (!process.env.QDRANT_URL) throw new Error('QDRANT_URL missing');

  await ensureCollection();

  const files = fs.readdirSync(DATA_DIR).map(f => path.join(DATA_DIR, f));
  let pts = [];
  for (const file of files) {
    console.log('Processing', file);
    const text = await extractText(file);
    const chunks = chunkText(text, 800);
    for (const [idx, chunk] of chunks.entries()) {
      pts.push({
        id: `${path.basename(file)}_${idx}`,
        payload: { file: path.basename(file), text: chunk },
        vector: null,
      });
    }
  }

  // create embeddings in batches
  const batchSize = 20;
  for (let i = 0; i < pts.length; i += batchSize) {
    const batch = pts.slice(i, i + batchSize);
    const texts = batch.map(p => p.payload.text);
    console.log(`Embedding batch ${i}/${pts.length}`);
    const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: texts });
    for (let j = 0; j < res.data.length; j++) {
      batch[j].vector = res.data[j].embedding;
    }
    // upsert to qdrant
    await qdrant.upsert({ collection_name: COLLECTION, points: batch.map(p => ({ id: p.id, vector: p.vector, payload: p.payload })) });
  }

  console.log('Ingestion complete');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
