// server/routes/upload-search.js
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import fsPromises from 'fs/promises';
import { randomUUID } from 'crypto';
import nodeFetch from 'node-fetch';
const fetch = globalThis.fetch || nodeFetch;

const router = express.Router();

// Import RAG functions
import { cleanAnswer } from './rag.js';

// Helper functions (copied from ingest_embeddings.js)
function chunkWithOverlap(text, size = 1000, overlap = 200) {
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

async function extractPdfPages(filePath) {
  try {
    const data = await fsPromises.readFile(filePath);
    let pdfParse = null;
    try {
      const mod = await import('pdf-parse');
      pdfParse = mod && (mod.default || mod);
    } catch (impErr) {
      console.warn('Warning: pdf-parse import failed:', impErr?.message);
      pdfParse = null;
    }

    if (pdfParse) {
      const res = await pdfParse(data);
      const numPages = res.numpages || 0;
      const extractedText = res.text || '';

      const textLength = extractedText.trim().length;
      const minTextPerPage = 50;
      const isLikelyScanned = textLength < (numPages * minTextPerPage);

      if (isLikelyScanned && textLength < 100) {
        console.log(`  PDF appears scanned, attempting OCR...`);
        const ocrText = await extractPdfWithOCR(filePath);
        if (ocrText && ocrText.trim().length > textLength) {
          const finalText = ocrText.trim();
          if (numPages > 0) {
            const perPage = Math.ceil(finalText.length / numPages);
            return Array.from({ length: numPages }, (_, i) => finalText.slice(i * perPage, (i + 1) * perPage).trim()).filter(Boolean);
          }
          return [finalText];
        }
      }

      const byFormFeed = extractedText.split('\f').map(s => s.trim()).filter(Boolean);
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
    }

    // fallback
    try {
      const { extract_text: pdfminer_extract_text } = await import('pdfminer.high_level');
      const text = (await pdfminer_extract_text(filePath)) || '';
      const pages = text.split('\f').map(s => s.trim()).filter(Boolean);
      return pages.length ? pages : [text.trim()];
    } catch (pmErr) {
      console.error('PDF extract failed:', pmErr?.message);
      const ocrText = await extractPdfWithOCR(filePath);
      return ocrText?.trim() ? [ocrText.trim()] : [''];
    }
  } catch (err) {
    console.error('Error reading PDF', filePath, err?.message);
    return [''];
  }
}

async function extractPdfWithOCR(filePath) {
  const OCR_SPACE_API_KEY = process.env.OCR_SPACE_API_KEY || 'helloworld';
  const OCR_SPACE_URL = 'https://api.ocr.space/parse/image';

  try {
    const fileData = await fsPromises.readFile(filePath);
    const base64Data = fileData.toString('base64');

    const formData = new URLSearchParams();
    formData.append('apikey', OCR_SPACE_API_KEY);
    formData.append('base64Image', `data:application/pdf;base64,${base64Data}`);
    formData.append('filetype', 'pdf');
    formData.append('OCREngine', '2');
    formData.append('isOverlayRequired', 'false');
    formData.append('detectOrientation', 'true');

    const response = await fetch(OCR_SPACE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });

    if (response.ok) {
      const result = await response.json();
      if (result.ParsedResults?.length) {
        return result.ParsedResults.map(r => r.ParsedText || '').join('\n\n');
      }
    }
  } catch (apiErr) {
    console.warn('  OCR.space failed:', apiErr?.message);
  }

  return null;
}

// Ensure uploads/temp directory exists
const uploadsDir = path.resolve(process.cwd(), 'uploads', 'temp');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file upload
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.pdf', '.txt', '.md'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, TXT, and MD files are allowed'));
    }
  },
});

// Helper: Calculate cosine similarity
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Helper: Get embedding from Ollama
async function getEmbedding(text, model = 'nomic-embed-text') {
  const EMBED_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const EMBED_MODEL = process.env.EMBED_MODEL || model;
  
  const candidates = [
    `${EMBED_URL}/api/embed`,
    `${EMBED_URL}/embed`,
  ];
  
  for (const url of candidates) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input: text, keep_alive: '10m' }),
      });
      
      if (resp.ok) {
        const data = await resp.json();
        const embedding = 
          (Array.isArray(data?.embedding) && data.embedding) ||
          (Array.isArray(data?.embeddings) && data.embeddings?.[0]) ||
          (data?.data?.[0]?.embedding);
        
        if (embedding) return embedding;
      }
    } catch (err) {
      console.warn('Embedding fetch failed:', err?.message);
    }
  }
  
  throw new Error('Failed to get embedding');
}

// Helper: Extract text from uploaded file
async function extractTextFromFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  
  if (ext === '.pdf') {
    const pages = await extractPdfPages(filePath);
    return { type: 'pdf', pages, filename: path.basename(originalName) };
  } else {
    const text = await fsPromises.readFile(filePath, 'utf8');
    return { type: 'text', pages: [text], filename: path.basename(originalName) };
  }
}

// Helper: Background job to save to Qdrant
async function saveToQdrantInBackground(filePath, originalName, id_user) {
  // This will run in background, don't await
  (async () => {
    try {
      // Move file to data folder first
      const DATA_DIR = path.resolve(process.cwd(), '..', 'data');
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      
      const filename = path.basename(originalName);
      const targetPath = path.join(DATA_DIR, filename);
      
      // If file already exists, add timestamp
      let finalTargetPath = targetPath;
      if (fs.existsSync(targetPath)) {
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);
        finalTargetPath = path.join(DATA_DIR, `${base}_${Date.now()}${ext}`);
      }
      
      // Copy file to data folder
      await fsPromises.copyFile(filePath, finalTargetPath);
      console.log(`[Background] Copied file to ${finalTargetPath}`);
      
      const { QdrantClient } = await import('@qdrant/js-client-rest');
      const qdrant = new QdrantClient({ 
        url: process.env.QDRANT_URL || 'http://127.0.0.1:6333', 
        checkCompatibility: false 
      });
      
      const COLLECTION = process.env.QDRANT_COLLECTION || 'documents';
      const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '1000', 10);
      const CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP || '200', 10);
      const EMBED_TEXT_MAX = parseInt(process.env.EMBED_TEXT_MAX || '3500', 10);
      const PAYLOAD_TEXT_MAX = parseInt(process.env.PAYLOAD_TEXT_MAX || '4200', 10);
      
      // Extract text from the file in data folder
      const extracted = await extractTextFromFile(finalTargetPath, originalName);
      const finalFilename = path.basename(finalTargetPath);
      
      // Process and chunk
      const points = [];
      for (let p = 0; p < extracted.pages.length; p++) {
        const pageText = extracted.pages[p] || '';
        const chunks = chunkWithOverlap(pageText, CHUNK_SIZE, CHUNK_OVERLAP);
        
        for (let ci = 0; ci < chunks.length; ci++) {
          const cleaned = sanitizeForEmbed(chunks[ci]);
          if (!cleaned || isLowSignal(cleaned)) continue;
          
          const payloadText = cleaned.slice(0, PAYLOAD_TEXT_MAX);
          const embedText = cleaned.slice(0, EMBED_TEXT_MAX);
          
          // Get embedding
          const embedding = await getEmbedding(embedText);
          
          const payload = {
            filename: finalFilename,
            filepath: finalTargetPath,
            source: 'upload',
            page: p + 1,
            chunk_index: ci + 1,
            char_count: cleaned.length,
            text: payloadText,
            snippet: cleaned.slice(0, 450),
          };
          
          points.push({
            id: randomUUID(),
            vector: embedding,
            payload,
          });
        }
      }
      
      // Batch upsert to Qdrant
      const BATCH_SIZE = 10;
      for (let i = 0; i < points.length; i += BATCH_SIZE) {
        const batch = points.slice(i, i + BATCH_SIZE);
        await qdrant.upsert(COLLECTION, { wait: true, points: batch });
      }
      
      console.log(`[Background] Saved ${points.length} chunks from ${finalFilename} to Qdrant`);
      
      // Clean up temp file
      try {
        await fsPromises.unlink(filePath);
      } catch {}
      
    } catch (err) {
      console.error('[Background] Failed to save to Qdrant:', err?.message);
    }
  })();
}

/* ==================== MAIN ROUTE: Upload + Search ==================== */
router.post('/', upload.single('document'), async (req, res) => {
  try {
    const { prompt, id_user } = req.body;
    const file = req.file;
    
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    
    if (!file) {
      return res.status(400).json({ error: 'document file is required' });
    }
    
    const filePath = file.path;
    const originalName = file.originalname;
    
    try {
      // 1) Extract text from uploaded file
      console.log(`[Upload-Search] Extracting text from ${originalName}...`);
      const extracted = await extractTextFromFile(filePath, originalName);
      
      if (!extracted.pages || extracted.pages.length === 0 || !extracted.pages.some(p => p.trim())) {
        return res.status(400).json({ error: 'No text could be extracted from the document' });
      }
      
      // 2) Chunk the text
      const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '1000', 10);
      const CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP || '200', 10);
      const EMBED_TEXT_MAX = parseInt(process.env.EMBED_TEXT_MAX || '3500', 10);
      const PAYLOAD_TEXT_MAX = parseInt(process.env.PAYLOAD_TEXT_MAX || '4200', 10);
      
      const allChunks = [];
      for (let p = 0; p < extracted.pages.length; p++) {
        const pageText = extracted.pages[p] || '';
        const chunks = chunkWithOverlap(pageText, CHUNK_SIZE, CHUNK_OVERLAP);
        
        for (let ci = 0; ci < chunks.length; ci++) {
          const cleaned = sanitizeForEmbed(chunks[ci]);
          if (!cleaned || isLowSignal(cleaned)) continue;
          
          const embedText = cleaned.slice(0, EMBED_TEXT_MAX);
          const payloadText = cleaned.slice(0, PAYLOAD_TEXT_MAX);
          
          allChunks.push({
            text: payloadText,
            embedText,
            page: p + 1,
            chunk_index: ci + 1,
            filename: extracted.filename,
          });
        }
      }
      
      if (allChunks.length === 0) {
        return res.status(400).json({ error: 'No valid chunks extracted from document' });
      }
      
      // 3) Get query embedding
      console.log(`[Upload-Search] Getting query embedding...`);
      const queryEmbedding = await getEmbedding(prompt);
      
      // 4) Get chunk embeddings and calculate similarity
      console.log(`[Upload-Search] Processing ${allChunks.length} chunks...`);
      const chunkEmbeddings = await Promise.all(
        allChunks.map(chunk => getEmbedding(chunk.embedText))
      );
      
      // 5) Calculate similarities and rank
      const scoredChunks = allChunks.map((chunk, idx) => ({
        ...chunk,
        score: cosineSimilarity(queryEmbedding, chunkEmbeddings[idx]),
      })).sort((a, b) => b.score - a.score);
      
      // 6) Get top chunks
      const top_k = Math.min(parseInt(req.body.top_k || '5'), scoredChunks.length);
      const topChunks = scoredChunks.slice(0, top_k).filter(c => c.score > 0.3); // min similarity threshold
      
      if (topChunks.length === 0) {
        return res.json({
          answer: 'Maaf, saya tidak menemukan bagian yang relevan dalam dokumen yang diupload.',
          sources: [],
          raw_hits: [],
        });
      }
      
      // 7) Generate answer using top chunks
      const ENABLE_RAG_GEN = (process.env.ENABLE_RAG_GEN || 'false').toLowerCase() === 'true';
      let answer = '';
      
      if (ENABLE_RAG_GEN) {
        const context = topChunks.map(c => 
          `SOURCE: ${c.filename} (p${c.page})\n${c.text}`
        ).join('\n\n---\n\n');
        
        const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
        const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3:4b';
        
        try {
          const genResp = await fetch(`${OLLAMA_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: OLLAMA_MODEL,
              prompt: `Kamu adalah asisten AI profesional yang membantu menjawab pertanyaan berdasarkan dokumen yang diberikan.

PETUNJUK:
1. Jawab langsung ke inti tanpa pembuka berlebihan
2. Fokus pada topik yang ditanyakan, jangan membahas topik lain yang tidak relevan
3. Gunakan bahasa yang jelas dan profesional
4. Cantumkan sitasi di akhir kalimat faktual: (${extracted.filename} pXX)
5. HANYA gunakan informasi dari Context
6. Gunakan kalimat lengkap dan tata bahasa yang benar
7. Jika pertanyaan tentang topik A, jangan membahas topik B yang tidak relevan

Pertanyaan: ${prompt}

Context:
${context}

Jawab dengan profesional dan jelas, fokus pada topik yang ditanyakan:`,
              stream: false,
              num_predict: 1500,
              temperature: 0.3,
            }),
          });
          
          if (genResp.ok) {
            const genBody = await genResp.json();
            const rawAnswer = genBody.response || genBody.text || '';
            answer = cleanAnswer(rawAnswer);
          }
        } catch (genErr) {
          console.warn('[Upload-Search] Generation failed:', genErr?.message);
        }
      }
      
      // Fallback: use top chunk text
      if (!answer) {
        const topText = topChunks[0].text;
        answer = topText.slice(0, 1000).trim();
        if (answer && !answer.match(/[.!?]$/)) answer += '.';
      }
      
      // 8) Format answer with citations
      const uniquePages = [...new Set(topChunks.map(c => c.page).filter(p => p != null))].sort((a, b) => a - b);
      const pagesText = uniquePages.length > 0 ? `page ${uniquePages.join(', ')}` : '';
      
      if (pagesText) {
        // Remove existing citations
        answer = answer.replace(/\s*\([^)]*p\d+[^)]*\)/g, '').trim();
        
        // Add citation at end of last sentence
        const lastSentenceMatch = answer.match(/([^.!?]+[.!?]?)$/);
        if (lastSentenceMatch) {
          const lastSentence = lastSentenceMatch[1];
          const beforeLast = answer.slice(0, -lastSentence.length);
          answer = beforeLast + lastSentence.replace(/[.!?]?$/, '') + ` (${pagesText})`;
          if (!lastSentence.match(/[.!?]$/)) {
            answer += '.';
          }
        } else {
          answer += ` (${pagesText})`;
        }
      }
      
      // Add document link
      const baseUrl = process.env.PUBLIC_BASE_URL || '';
      const docUrl = baseUrl ? `${baseUrl.replace(/\/$/, '')}/files/${extracted.filename}` : `/files/${extracted.filename}`;
      answer += `\n\n[Link ke dokumen](${docUrl})`;
      
      // Add continuation question
      if (!answer.includes('lanjutkan') && !answer.includes('lanjut')) {
        answer += '\n\nApakah ada bagian lain yang ingin Anda ketahui lebih lanjut?';
      }
      
      // 9) Prepare sources
      const sources = topChunks.map(c => ({
        filename: c.filename,
        page: c.page,
        score: c.score,
        url: baseUrl ? `${baseUrl.replace(/\/$/, '')}/files/${c.filename}` : `/files/${c.filename}`,
      }));
      
      // 10) Start background job to save to Qdrant
      saveToQdrantInBackground(filePath, originalName, id_user);
      
      return res.json({
        answer,
        sources,
        raw_hits: topChunks.map(c => ({
          filename: c.filename,
          page: c.page,
          score: c.score,
        })),
      });
      
    } catch (err) {
      console.error('[Upload-Search] Error:', err);
      // Clean up temp file on error
      try {
        await fsPromises.unlink(filePath);
      } catch {}
      return res.status(500).json({ error: String(err?.message || err) });
    }
    
  } catch (err) {
    console.error('[Upload-Search] Error:', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

export default router;

