import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { pool } from '../db.js';
import nlp from '../utils/nlp.js';

const router = express.Router();

// Helper: POST with timeout and basic retries (1 retry)
async function postWithTimeout(url, body, opts = {}) {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs || 15000;
  const retry = opts.retry || 1;

  const doPost = async () => {
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
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
    if (retry > 0) {
      return await postWithTimeout(url, body, { timeoutMs, retry: retry - 1 });
    }
    throw err;
  }
}

// Normalize Ollama-like responses into text string
async function extractTextFromOllamaResponse(resp) {
  // resp is the parsed JSON body
  if (!resp) return '';
  if (typeof resp === 'string') return resp;
  if (resp.output && typeof resp.output === 'string') return resp.output;
  if (resp.text && typeof resp.text === 'string') return resp.text;
  if (Array.isArray(resp.results) && resp.results[0] && resp.results[0].content) return resp.results[0].content;
  if (Array.isArray(resp.choices) && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) return resp.choices[0].message.content;
  // fallback to JSON string
  try { return JSON.stringify(resp); } catch { return String(resp); }
}

async function getRecentConversation(id_user, limit = 10) {
  if (!id_user) return [];
  try {
    const [rows] = await pool.query('SELECT sender, message FROM conversation_memory WHERE id_user = ? ORDER BY id DESC LIMIT ?', [id_user, Number(limit)]);
    return rows || [];
  } catch (e) {
    return [];
  }
}

function buildUserContext(messages) {
  if (!messages || !messages.length) return '';
  const last = messages.slice(-5).map(m => `${m.sender}: ${m.message}`).join('\n');
  return `Recent conversation:\n${last}`;
}

router.post('/', async (req, res) => {
  try {
    // Safety: disable RAG by default unless ENABLE_RAG=true is explicitly set in env.
    // This avoids accidental heavy work when environment variables aren't set or during debugging.
    const ENABLE_RAG = (process.env.ENABLE_RAG || 'false').toLowerCase() === 'true';
    console.log('[rag] ENABLE_RAG=', ENABLE_RAG);
    if (!ENABLE_RAG) {
      return res.status(503).json({ error: 'RAG disabled (set ENABLE_RAG=true to enable)' });
    }
    const { prompt, top_k = 5, id_user: rawIdUser } = req.body || {};
    const id_user = rawIdUser ? Number(rawIdUser) : null;

    // analyze and persist the incoming prompt (intent + sentiment)
    let analysis = null;
    try {
      analysis = await nlp.analyzeMessage(prompt || '');
      try {
        await pool.query('INSERT INTO conversation_memory (id_user, sender, message, intent, sentiment_score, sentiment_label) VALUES (?,?,?,?,?,?)', [id_user, 'user', prompt || '', analysis.intent, analysis.sentiment.score, analysis.sentiment.label]);
      } catch (e) {
        console.warn('[rag] failed to persist user memory:', e && e.message ? e.message : e);
      }
    } catch (e) {
      console.warn('[rag] NLP analysis failed:', e && e.message ? e.message : e);
    }
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    const EMBED_URL = process.env.EMBED_URL || 'http://embed:5001';
    const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';

    // Fetch recent memory for personalization
    const recent = await getRecentConversation(id_user, 10);
    const userContext = buildUserContext(recent);

    // 1) embed the query
    const embedResp = await postWithTimeout(`${EMBED_URL.replace(/\/$/, '')}/embed`, { model: process.env.EMBED_MODEL || 'all-mpnet-base-v2', input: [prompt] }, { timeoutMs: 15000 });
    if (!embedResp.ok) {
      const txt = await embedResp.text().catch(() => '<no-body>');
      throw new Error('Embed service error: ' + txt);
    }
    const embedBody = await embedResp.json();
    const qvec = (embedBody.embeddings && embedBody.embeddings[0]) || (embedBody.data && embedBody.data[0] && embedBody.data[0].embedding);
    if (!qvec) throw new Error('No embedding returned');

    // 2) query qdrant for nearest
    const { QdrantClient } = await import('@qdrant/js-client-rest');
    const qdrant = new QdrantClient({ url: process.env.QDRANT_URL || 'http://qdrant:6333', checkCompatibility: false });
    const collectionName = process.env.QDRANT_COLLECTION || 'documents';

    let searchRes = null;
    try {
      searchRes = await qdrant.search(collectionName, { vector: qvec, limit: Number(top_k), with_payload: true });
    } catch (e) {
      // Try to detect vector size mismatch and return a helpful error
      try {
        const info = await qdrant.getCollection(collectionName);
        const expected = (info && info.vectors_count) ? undefined : (info && info.config && info.config.params && info.config.params.vectors && info.config.params.vectors.size);
        const got = Array.isArray(qvec) ? qvec.length : undefined;
        if (got && expected && e && String(e).toLowerCase().includes('bad request')) {
          return res.status(400).json({ error: 'Vector size mismatch between query and collection', expected, got, hint: 'Pastikan EMBED_MODEL sama dengan model saat ingestion, lalu jalankan ulang ingestion.' });
        }
      } catch (_) {}
      throw e;
    }

    // 3) build context and sources
    // Keep only a compact, bounded representation of hits to avoid returning very large
    // payloads (Qdrant payloads may contain full document text which can OOM when
    // stringified). We still build short snippets for context but cap their length.
    const snippets = [];
    const sources = [];
    const compactHits = [];
    for (const hit of searchRes) {
      const payload = hit.payload || {};
      // create a bounded snippet (max 800 chars)
      const snippet = String(payload.snippet || payload.text || '').slice(0, 800);
      const filename = payload.filename || path.basename(payload.filepath || '');
      const page = payload.page || payload.page_number || null;
      snippets.push(`Source: ${filename} (page ${page})\n${snippet}`);
      sources.push({ filename, filepath: payload.filepath || `data/${filename}`, page, score: hit.score, snippet });
      compactHits.push({ id: hit.id, score: hit.score, filename, page, snippet });
    }

    // attach URL path (optionally make absolute using PUBLIC_BASE_URL)
    const baseUrl = process.env.PUBLIC_BASE_URL || '';
    for (const s of sources) { s.url = baseUrl ? `${baseUrl.replace(/\/$/, '')}/files/${s.filename}` : `/files/${s.filename}`; }

    // 4) generation step (with optional personalization context)
    const ENABLE_RAG_GEN = (process.env.ENABLE_RAG_GEN || 'false').toLowerCase() === 'true';
    let answer = '';
    if (ENABLE_RAG_GEN) {
      const systemPrompt = `You are an assistant that answers user questions using ONLY the provided contextual snippets. For each assertion, cite the source with filename and page number. If the answer is not in the snippets, say you don't know.`;
      const persona = userContext ? `\n\nUser context (recent messages):\n${userContext}` : '';
      const userPrompt = `User: ${prompt}${persona}\n\nContext:\n${snippets.join('\n\n--\n\n')}\n\nProvide a concise answer and then list sources (filename, page).`;

      const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
      const ollamaHeaders = { 'Content-Type': 'application/json' };
      if (process.env.OLLAMA_API_KEY) ollamaHeaders['Authorization'] = `Bearer ${process.env.OLLAMA_API_KEY}`;
      const genResp = await postWithTimeout(`${OLLAMA_URL.replace(/\/$/, '')}/generate`, { model: process.env.OLLAMA_MODEL || 'gemma3:4b', prompt: systemPrompt + '\n\n' + userPrompt, max_tokens: 512 }, { timeoutMs: 30000, retry: 1, headers: ollamaHeaders });
      if (!genResp.ok) {
        const txt = await genResp.text().catch(() => '<no-body>');
        throw new Error('LLM generate error: ' + txt);
      }
      const genBody = await genResp.json().catch(() => null);
      answer = await extractTextFromOllamaResponse(genBody);
    } else {
      // Fallback: produce a concise synthesized answer from the top snippets without calling an LLM.
      if (snippets.length === 0) {
        answer = "I'm sorry — I couldn't find any relevant documents.";
      } else {
        // Use the first 2 snippets to form a short answer and cite sources
        const use = snippets.slice(0, Math.min(2, snippets.length));
        // Heuristic: extract the first sentence from each snippet
        const sentences = use.map(s => {
          const txt = String(s).replace(/\n/g, ' ').trim();
          const m = txt.match(/([^.?!]*[.?!])/);
          return m ? m[0].trim() : (txt.slice(0, 200));
        });
        answer = sentences.join(' ');
        // Append a short source list
        const srcList = sources.slice(0, Math.min(3, sources.length)).map(s => `${s.filename}${s.page ? ' (p' + s.page + ')' : ''}`).join(', ');
        answer = `${answer} \n\nSources: ${srcList}`;
      }
    }

    // persist bot answer text to memory with optional intent tag
    try {
      await pool.query('INSERT INTO conversation_memory (id_user, sender, message, intent, sentiment_score, sentiment_label) VALUES (?,?,?,?,?,?)', [id_user, 'bot', answer || '', 'answer', null, null]);
    } catch (e) {
      console.warn('[rag] failed to persist bot memory:', e && e.message ? e.message : e);
    }

    return res.json({ answer, sources, raw_hits: compactHits, metadata: analysis, context_messages: recent });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
