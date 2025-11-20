// server/rag.js
import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { pool } from '../db.js';
import nlp from '../utils/nlp.js';

const router = express.Router();

// ---------- Helpers: POST with timeout + retry ----------
async function postWithTimeout(url, body, opts = {}) {
  const timeoutMs = opts.timeoutMs || 15000;
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
    if (retry > 0) {
      return await postWithTimeout(url, body, { timeoutMs, retry: retry - 1, headers });
    }
    throw err;
  }
}

// Call Ollama endpoints with candidate paths and IPv6/IPv4 fallback
async function postOllamaWithFallback(pathSuffix, body, opts = {}) {
  const rawBase = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const baseCandidates = [rawBase];
  // If host.docker.internal is used in some envs, include it as alternative
  if (!rawBase.includes('host.docker.internal')) baseCandidates.push(rawBase.replace('127.0.0.1', 'host.docker.internal'));
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

// Normalize different Ollama/OpenAI response shapes into plain text
async function extractTextFromOllamaResponse(resp) {
  if (!resp) return '';
  if (typeof resp === 'string') return resp;
  if (typeof resp.output === 'string') return resp.output;
  if (typeof resp.text === 'string') return resp.text;
  if (Array.isArray(resp.results) && resp.results[0] && (resp.results[0].content || resp.results[0].text)) {
    return resp.results[0].content || resp.results[0].text || '';
  }
  if (Array.isArray(resp.choices) && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) {
    return resp.choices[0].message.content;
  }
  try { return JSON.stringify(resp); } catch { return String(resp); }
}

// Recent conversation memory
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

// Small talk/greeting detection (simple heuristics)
function isSmallTalk(prompt) {
  if (!prompt) return false;
  const p = prompt.toLowerCase().trim();
  const greetings = ['hai', 'halo', 'hi', 'hey', 'helo'];
  if (p === '__init__') return true;
  if (greetings.includes(p) || greetings.some(g => p.startsWith(g + ' ') || p === g)) return true;
  const small = ['apa', 'ngapain', 'lagi apa', 'kamu siapa', 'siapa kamu', 'perkenalan', 'hello'];
  if (small.includes(p)) return true;
  return false;
}
function smallTalkReply(prompt) {
  const p = (prompt || '').toLowerCase().trim();
  if (p === '__init__') return "Halo 👋 Aku asisten AI kamu. Mau coba tanya sesuatu atau upload dokumen untuk dicari jawabannya.";
  if (p.includes('kamu siapa')) return "Aku asisten AI yang bisa bantu jawab pertanyaan berdasarkan dokumen yang di-upload. 😊";
  if (p === 'apa' || p === 'ngapain' || p === 'lagi apa') return "Aku lagi siap bantu! Mau cari info apa?";
  if (['hai','halo','hi','hey','helo'].includes(p)) return "Hai! 👋 Ada yang bisa aku bantu?";
  return "Hai! Aku di sini siap bantu kamu. Mau tanya apa?";
}

// Main route
router.post('/', async (req, res) => {
  try {
    // Env flags
    const ENABLE_RAG = (process.env.ENABLE_RAG || 'false').toLowerCase() === 'true';
    const ENABLE_RAG_GEN = (process.env.ENABLE_RAG_GEN || 'false').toLowerCase() === 'true';

    // Basic payload
    const { prompt, top_k = 5, id_user: rawIdUser } = req.body || {};
    const id_user = rawIdUser ? Number(rawIdUser) : null;

    // Persist the incoming message intent/sentiment if possible
    let analysis = null;
    try {
      analysis = await nlp.analyzeMessage(prompt || '');
      try {
        await pool.query('INSERT INTO conversation_memory (id_user, sender, message, intent, sentiment_score, sentiment_label) VALUES (?,?,?,?,?,?)', [id_user, 'user', prompt || '', analysis.intent, analysis.sentiment.score, analysis.sentiment.label]);
      } catch (e) {
        console.warn('[rag] failed to persist user memory:', e && e.message ? e.message : e);
      }
    } catch (e) {
      // ignore NLP failures
    }

    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    // QUICK SMALL TALK HANDLING (bypass embedding + RAG)
    // Only bypass for very short greetings, not for actual questions
    const isVeryShortGreeting = prompt.trim().length <= 10 && isSmallTalk(prompt);
    if (isVeryShortGreeting) {
      const reply = smallTalkReply(prompt);
      // persist bot reply
      try {
        await pool.query('INSERT INTO conversation_memory (id_user, sender, message, intent, sentiment_score, sentiment_label) VALUES (?,?,?,?,?,?)', [id_user, 'bot', reply || '', 'smalltalk', null, null]);
      } catch (e) { /* ignore */ }
      return res.json({ answer: reply, sources: [], raw_hits: [], metadata: analysis, context_messages: await getRecentConversation(id_user, 10) });
    }
    
    // Query expansion: improve search by adding synonyms/related terms
    // This makes the search smarter, not just literal word matching
    function expandQuery(query) {
      if (!query || query.trim().length === 0) return query;
      const q = query.toLowerCase().trim();
      const expansions = {
        'mau': ['ingin', 'perlu', 'butuh', 'memerlukan', 'menginginkan'],
        'cara': ['bagaimana', 'metode', 'langkah', 'prosedur', 'tata cara'],
        'apa': ['apa itu', 'definisi', 'pengertian', 'jelaskan'],
        'kapan': ['waktu', 'jadwal', 'periode', 'tanggal'],
        'dimana': ['lokasi', 'tempat', 'posisi'],
        'siapa': ['siapakah', 'pihak', 'orang'],
        'berapa': ['jumlah', 'nominal', 'kuantitas'],
        'kewajiban': ['wajib', 'harus', 'mesti', 'perlu dilakukan', 'tanggung jawab'],
        'aturan': ['peraturan', 'ketentuan', 'regulasi', 'prosedur', 'kebijakan'],
        'mahasiswa': ['siswa', 'pelajar', 'student'],
      };
      
      // Find matching expansion
      for (const [key, synonyms] of Object.entries(expansions)) {
        if (q.includes(key)) {
          // Add synonyms to query for better semantic search
          return `${query} ${synonyms.join(' ')}`;
        }
      }
      return query;
    }
    
    const expandedPrompt = expandQuery(prompt) || prompt;

    // Basic config
    const EMBED_URL = (process.env.EMBED_URL || process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const EMBED_MODEL = process.env.EMBED_MODEL || process.env.OLLAMA_MODEL || 'nomic-embed-text';
    const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3:4b';
    const QDRANT_URL = process.env.QDRANT_URL || 'http://127.0.0.1:6333';
    const COLLECTION = process.env.QDRANT_COLLECTION || 'documents';

    // Get recent conversation (for personalization)
    const recent = await getRecentConversation(id_user, 10);
    const userContext = buildUserContext(recent);

    // If RAG disabled, return friendly fallback or run minimal heuristic
    if (!ENABLE_RAG) {
      // simple conversational fallback (no embedding)
      const fallback = "RAG is disabled on this server. If you'd like to enable retrieval from documents, set ENABLE_RAG=true in your .env and restart.";
      return res.json({ answer: fallback, sources: [], raw_hits: [], metadata: analysis, context_messages: recent });
    }

    // 1) Create embedding for query (use expanded prompt for better semantic search)
    let embedResp;
    try {
      // Use expanded prompt for better semantic matching
      const queryForEmbedding = expandedPrompt || prompt;
      // call candidate embed endpoints
      const embedCandidates = [`${EMBED_URL}/api/embed`, `${EMBED_URL}/embed`];
      let lastErr = null;
      let resp = null;
      for (const url of embedCandidates) {
        try {
          resp = await postWithTimeout(url, { model: EMBED_MODEL, input: [queryForEmbedding] }, { timeoutMs: 20000, retry: 1 });
          if (resp && resp.ok) { embedResp = await resp.json(); break; }
          // if not ok, read body and throw to try next
          const txt = resp ? await resp.text().catch(()=>'<no-body>') : '<no-resp>';
          lastErr = new Error(`Embed failed: ${txt}`);
        } catch (err) {
          lastErr = err;
        }
      }
      if (!embedResp) throw lastErr || new Error('Embedding service not reachable');
    } catch (e) {
      console.error('[rag] embedding error', e && e.message ? e.message : e);
      return res.status(500).json({ error: 'Failed to create embedding: ' + String(e) });
    }

    const qvec = (embedResp.embeddings && embedResp.embeddings[0]) || (embedResp.data && embedResp.data[0] && embedResp.data[0].embedding);
    if (!qvec) return res.status(500).json({ error: 'No embedding returned from embed service' });

    // 2) Query Qdrant with increased limit for better results, then re-rank
    let searchRes;
    try {
      const qdrantModule = await import('@qdrant/js-client-rest');
      const QdrantClient = qdrantModule.QdrantClient || qdrantModule.default?.QdrantClient || qdrantModule.default;
      if (!QdrantClient) {
        throw new Error('QdrantClient not found in @qdrant/js-client-rest module');
      }
      const qdrant = new QdrantClient({ url: QDRANT_URL, checkCompatibility: false });
      // Get more results initially, then we'll re-rank based on relevance
      const initialLimit = Math.max(Number(top_k || 5) * 2, 10);
      searchRes = await qdrant.search(COLLECTION, { vector: qvec, limit: initialLimit, with_payload: true });
      
      // Smart re-ranking: prioritize relevant results and filter out irrelevant ones
      const queryKeywords = prompt.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const queryLower = prompt.toLowerCase();
      
      if (searchRes && searchRes.length > 0) {
        searchRes = searchRes.map(hit => {
          const payload = hit.payload || {};
          const text = (payload.snippet || payload.text || '').toLowerCase();
          const filename = (payload.filename || '').toLowerCase();
          let rerankedScore = hit.score || 0;
          
          // Calculate keyword relevance
          let keywordMatches = 0;
          let exactPhraseMatches = 0;
          
          // Check for exact phrase matches (higher weight)
          if (queryLower.length > 5) {
            const phrases = queryLower.split(/\s+/).filter(p => p.length > 3);
            for (const phrase of phrases) {
              if (text.includes(phrase)) {
                exactPhraseMatches++;
                rerankedScore += 0.15; // Higher boost for phrase match
              }
            }
          }
          
          // Check for individual keyword matches
          for (const keyword of queryKeywords) {
            if (text.includes(keyword)) {
              keywordMatches++;
              rerankedScore += 0.05; // Smaller boost for individual keyword
            }
          }
          
          // Penalize results with irrelevant keywords (e.g., "kerja praktik" when query is about "kewajiban")
          const irrelevantTerms = {
            'kewajiban': ['kerja praktik', 'praktik kerja', 'kp'],
            'aturan': ['kerja praktik', 'praktik kerja', 'kp'],
          };
          
          for (const [queryTerm, irrelevant] of Object.entries(irrelevantTerms)) {
            if (queryLower.includes(queryTerm)) {
              for (const term of irrelevant) {
                if (text.includes(term) && !text.includes(queryTerm)) {
                  rerankedScore -= 0.2; // Penalty for irrelevant terms
                }
              }
            }
          }
          
          // Boost results from relevant filenames
          if (queryLower.includes('kewajiban') || queryLower.includes('aturan')) {
            if (filename.includes('aturan') || filename.includes('peraturan')) {
              rerankedScore += 0.3; // Strong boost for aturan.pdf
            }
            if (filename.includes('kp') && !queryLower.includes('kerja praktik')) {
              rerankedScore -= 0.2; // Penalty for KP.pdf when query is about aturan
            }
          }
          
          // Calculate relevance ratio
          const relevanceRatio = keywordMatches / Math.max(queryKeywords.length, 1);
          
          return { 
            ...hit, 
            reranked_score: rerankedScore,
            keyword_matches: keywordMatches,
            exact_phrase_matches: exactPhraseMatches,
            relevance_ratio: relevanceRatio
          };
        })
        .filter(hit => {
          // Filter out results with very low relevance
          const minScore = 0.3; // Minimum similarity score threshold
          const minRelevanceRatio = 0.2; // At least 20% of keywords should match
          
          if ((hit.reranked_score || hit.score || 0) < minScore) {
            return false;
          }
          
          // If result has very few keyword matches, require higher base score
          if (hit.keyword_matches < 2 && (hit.score || 0) < 0.5) {
            return false;
          }
          
          return true;
        })
        .sort((a, b) => {
          // Sort by reranked score, then by exact phrase matches, then by keyword matches
          const scoreDiff = (b.reranked_score || b.score || 0) - (a.reranked_score || a.score || 0);
          if (Math.abs(scoreDiff) > 0.01) return scoreDiff;
          
          const phraseDiff = (b.exact_phrase_matches || 0) - (a.exact_phrase_matches || 0);
          if (phraseDiff !== 0) return phraseDiff;
          
          return (b.keyword_matches || 0) - (a.keyword_matches || 0);
        });
        
        // Take top_k after re-ranking and filtering
        searchRes = searchRes.slice(0, Number(top_k || 5));
        
        // Log for debugging
        if (searchRes.length > 0) {
          console.log(`[rag] Re-ranked ${searchRes.length} results. Top score: ${searchRes[0].reranked_score?.toFixed(3)} (${searchRes[0].payload?.filename})`);
        }
      }
    } catch (e) {
      console.error('[rag] qdrant search error', e && e.message ? e.message : e);
      return res.status(500).json({ error: 'Failed to query Qdrant: ' + String(e) });
    }

    // 3) Build snippets & sources (bounded sizes)
    // Only use results that meet minimum relevance threshold
    const MIN_RELEVANCE_SCORE = 0.35; // Minimum score to be considered relevant
    const relevantHits = (searchRes || []).filter(hit => {
      const score = hit.reranked_score || hit.score || 0;
      return score >= MIN_RELEVANCE_SCORE;
    });
    
    // If no relevant results, return helpful message instead of random results
    if (relevantHits.length === 0) {
      console.log(`[rag] No relevant results found (min score: ${MIN_RELEVANCE_SCORE})`);
      return res.json({ 
        answer: "Maaf, saya tidak menemukan informasi yang relevan dalam dokumen untuk pertanyaan Anda. Silakan coba dengan kata kunci yang lebih spesifik atau pastikan dokumen yang relevan sudah di-upload.",
        sources: [], 
        raw_hits: [], 
        metadata: analysis, 
        context_messages: recent 
      });
    }
    
    const snippets = [];
    const sources = [];
    const compactHits = [];
    const seenSnippets = new Set();
    for (const hit of relevantHits) {
      const payload = hit.payload || {};
      const rawSnippet = String(payload.snippet || payload.text || '').replace(/\s+/g, ' ').trim();
      const snippet = rawSnippet.slice(0, 800);
      const filename = payload.filename || path.basename(payload.filepath || '');
      const page = payload.page || payload.page_number || null;
      const finalScore = hit.reranked_score || hit.score || 0;
      const dedupKey = `${filename}|${page || '?'}|${snippet}`;
      if (seenSnippets.has(dedupKey)) {
        continue;
      }
      seenSnippets.add(dedupKey);
      snippets.push(`Source: ${filename} (page ${page || '?'})\n${snippet}`);
      sources.push({ filename, filepath: payload.filepath || `data/${filename}`, page, score: finalScore, snippet });
      compactHits.push({ id: hit.id, score: finalScore, filename, page, snippet });
    }

    // 4) Generation: if ENABLE_RAG_GEN true -> call LLM (Ollama), else do heuristic merge
    let answer = '';
    if (ENABLE_RAG_GEN) {
      try {
        const systemPrompt = `You are a helpful, friendly assistant. Answer the user's question using ONLY the provided context snippets. For every factual claim, cite the source filename and page number. If the answer is not contained in the snippets, reply: "Maaf, saya tidak menemukan jawaban dalam dokumen." Keep answer concise (max ~300 words).`;
        const persona = userContext ? `\n\nUser context:\n${userContext}` : '';
        const userPrompt = `User: ${prompt}${persona}\n\nContext:\n${snippets.join('\n\n--\n\n')}\n\nProvide a concise answer and then list sources (filename, page).`;

        const body = {
          model: OLLAMA_MODEL,
          prompt: systemPrompt + '\n\n' + userPrompt,
          max_tokens: 512,
          temperature: 0.0
        };

        const headers = { 'Content-Type': 'application/json' };
        if (process.env.OLLAMA_API_KEY) headers['Authorization'] = `Bearer ${process.env.OLLAMA_API_KEY}`;

        const genResp = await postOllamaWithFallback('generate', body, { timeoutMs: 30000, retry: 1, headers });
        if (!genResp.ok) {
          const txt = await genResp.text().catch(()=>'<no-body>');
          throw new Error('LLM generate error: ' + txt);
        }
        const genBody = await genResp.json().catch(()=>null);
        answer = await extractTextFromOllamaResponse(genBody);
      } catch (e) {
        console.error('[rag] generation error', e && e.message ? e.message : e);
        // fallback to heuristic below
      }
    }

    if (!answer) {
      // Heuristic synthesis from top 2 snippets
      if (!snippets.length) {
        answer = "Maaf — saya tidak menemukan dokumen yang relevan.";
      } else {
        const use = snippets.slice(0, Math.min(2, snippets.length));
        const sentences = use.map(s => {
          const txt = s.replace(/\n/g, ' ').trim();
          const m = txt.match(/([^.?!]*[.?!])/);
          return m ? m[0].trim() : (txt.slice(0, 200));
        });
        answer = sentences.join(' ');
        const srcList = sources.slice(0, Math.min(3, sources.length)).map(s => `${s.filename}${s.page ? ' (p' + s.page + ')' : ''}`).join(', ');
        if (srcList) answer = `${answer}\n\nSumber: ${srcList}`;
      }
    }

    // persist bot answer
    try {
      await pool.query('INSERT INTO conversation_memory (id_user, sender, message, intent, sentiment_score, sentiment_label) VALUES (?,?,?,?,?,?)', [id_user, 'bot', answer || '', 'answer', null, null]);
    } catch (e) {
      console.warn('[rag] failed to persist bot memory:', e && e.message ? e.message : e);
    }

    // attach file URLs if PUBLIC_BASE_URL provided
    const baseUrl = process.env.PUBLIC_BASE_URL || '';
    for (const s of sources) {
      s.url = baseUrl ? `${baseUrl.replace(/\/$/, '')}/files/${s.filename}` : `/files/${s.filename}`;
    }

    return res.json({ answer, sources, raw_hits: compactHits, metadata: analysis, context_messages: recent });
  } catch (err) {
    console.error('[rag] uncaught error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
