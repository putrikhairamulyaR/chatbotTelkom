import express from 'express';
import dotenv from 'dotenv';
import { pool } from './db.js';
import nlp from './utils/nlp.js';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
app.use(cors());

const MIN_CONFIDENCE = Number(process.env.RAG_MIN_SCORE || '0.4');
const NO_DATA_MESSAGE = 'Untuk saat ini kami belum bisa memproses pertanyaan Anda, silakan ajukan pertanyaan ulang.';
const RULE_KEYWORDS = ['aturan', 'peraturan', 'pasal', 'ketentuan', 'policy', 'rule', 'tatib'];
const KP_KEYWORDS = ['kp', 'kerja praktek', 'kerja praktik', 'magang'];
const RULE_FILENAME = process.env.RULE_FILENAME || 'aturan.pdf';
const KP_FILENAME = process.env.KP_FILENAME || 'KP.pdf';

function buildFilenameFilter(prompt) {
  const text = (prompt || '').toLowerCase();
  if (!text) return null;
  const matches = keywords => keywords.some(k => text.includes(k));
  if (matches(RULE_KEYWORDS)) return { must: [{ key: 'filename', match: { value: RULE_FILENAME } }] };
  if (matches(KP_KEYWORDS)) return { must: [{ key: 'filename', match: { value: KP_FILENAME } }] };
  return null;
}

// Custom raw body catcher + tolerant JSON parsing.
// This prevents Express from returning 400 on malformed JSON so we can log the raw payload
// and handle it gracefully in routes.
app.use((req, res, next) => {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    const ct = (req.headers['content-type'] || '').toLowerCase();
    if (ct.includes('application/json')) {
      try {
        req.body = data ? JSON.parse(data) : {};
      } catch (err) {
        // Try a tolerant conversion for JS-like object literals e.g. {prompt:Lingkup pekerjaan KP,top_k:3}
        console.warn('[raw-json] JSON parse failed:', err.message, 'rawPreview:', String(data).slice(0,500));
        try {
          const tolerant = (raw) => {
            // Add quotes around unquoted keys: {key: -> {"key":
            let s = raw.trim();
            // If it doesn't start with {, return as-is
            if (!s.startsWith('{')) return raw;
            // Quote keys
            s = s.replace(/([,{\s])([A-Za-z0-9_\-]+)\s*:/g, '$1"$2":');
            // Quote unquoted string values (stop at , or })
            s = s.replace(/:\s*([^\",\]\}\s][^,\}]*) (?=[,\}])/g, (m, p1) => {
              const v = p1.trim();
              // if it's a number, boolean, or null leave it
              if (/^-?\d+(?:\.\d+)?$/.test(v) || /^(true|false|null)$/.test(v)) return ':' + v;
              // otherwise quote
              // escape any double quotes inside
              const esc = v.replace(/"/g, '\\"');
              return ':"' + esc + '"';
            });
            return s;
          };
          const converted = tolerant(data);
          req.body = converted ? JSON.parse(converted) : {};
          console.warn('[raw-json] tolerant parse succeeded, body keys:', Object.keys(req.body));
        } catch (err2) {
          console.warn('[raw-json] tolerant parse also failed:', err2.message, 'rawPreview:', String(data).slice(0,500));
          req.body = {};
        }
      }
    } else {
      // for other content-types, leave body empty but store raw
      req.body = {};
    }
    next();
  });
});

// Lightweight health endpoint for debugging (does not trigger RAG)
app.get('/health', (req, res) => {
  return res.json({ ok: true, pid: process.pid, env: process.env.NODE_ENV || 'development' });
});

// pool is imported from server/db.js

// shared login handler: accept either username OR email
async function handleLogin(req, res) {
  const { username, email, password } = req.body || {};
  // normalize inputs (trim whitespace) to be more forgiving
  const usernameTrim = username ? String(username).trim() : '';
  const emailTrim = email ? String(email).trim() : '';
  const passwordRaw = password ? String(password).trim() : '';
  console.log('[auth] handleLogin called with:', { username: usernameTrim || undefined, email: emailTrim || undefined, password: passwordRaw ? '***' : undefined });
  const idValue = usernameTrim || emailTrim;
  if (!idValue || !passwordRaw) return res.status(400).json({ error: 'Username/email and password required' });

  const field = usernameTrim ? 'username' : 'email';
  try {
    const [rows] = await pool.query(`SELECT * FROM ` + '\`user\`' + ` WHERE ${field} = ? LIMIT 1`, [idValue]);
    console.log('[auth] SQL rows:', rows && rows.length ? '[found ' + rows.length + ']' : '[]');
    const user = rows[0];
    if (!user) {
      console.log('[auth] no user found for', field, idValue);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // try bcrypt compare first (recommended)
    let match = false;
    try {
      match = await bcrypt.compare(passwordRaw, user.password || '');
    } catch (e) {
      match = false;
    }
    // fallback: if bcrypt fails or returns false, allow plain-text comparison
    if (!match && user.password) {
      // log a short warning so developer knows there's a plain-text password in DB
      if (passwordRaw === user.password) {
        console.warn(`Warning: authenticating user ${user.email || user.username} using plain-text password fallback.`);
        match = true;
      }
    }
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    // success: return minimal user info (do NOT include password)
    const { id_user, username: userName, email: userEmail, prodi } = user;
    return res.json({ id_user, username: userName, email: userEmail, prodi });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}

app.post('/api/login', handleLogin);
// alias route so callers that POST /login still work (e.g. tests/Postman)
app.post('/login', handleLogin);

// Serve raw PDF files from project data folder
app.get('/files/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.resolve(process.cwd(), '..', 'data', filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// Mount RAG router (extracted to server/routes/rag.js)
// Mount RAG router only when explicitly enabled via ENABLE_RAG=true
const ENABLE_RAG = (process.env.ENABLE_RAG || 'false').toLowerCase() === 'true';
console.log('[server] ENABLE_RAG=', ENABLE_RAG);
if (ENABLE_RAG) {
  // dynamic import at runtime (top-level await is allowed in ESM)
  const mod = await import('./routes/rag.js');
  const ragRouter = mod && (mod.default || mod);
  if (ragRouter) app.use('/api/rag', ragRouter);
} else {
  console.log('[server] RAG router not mounted; set ENABLE_RAG=true to enable');
  // Provide a lightweight mock endpoint so the frontend can test without enabling full RAG
  app.post('/api/rag', (req, res) => {
    // Accept several possible request field names sent by the frontend
    (async () => {
      try {
        const body = req.body || {};
        console.log('[mock /api/rag] received body:', JSON.stringify(body).slice(0,1000));
        const candidate = body.prompt || body.question || body.q || body.message || body.text || '';
        const q = candidate ? String(candidate).trim() : '';

        // For any incoming question, perform an embed -> Qdrant lookup and synthesize an answer from snippets.
        if (q) {
          // analyze incoming user message (intent + sentiment) and persist to conversation_memory
          try {
            const analysis = await nlp.analyzeMessage(q);
            // id_user may be provided in request body (if frontend sends it after login)
            const id_user = body.id_user ? Number(body.id_user) : null;
            try {
              await pool.query(
                'INSERT INTO conversation_memory (id_user, sender, message, intent, sentiment_score, sentiment_label) VALUES (?,?,?,?,?,?)',
                [id_user, 'user', q, analysis.intent, analysis.sentiment.score, analysis.sentiment.label]
              );
            } catch (e) {
              console.warn('[mock /api/rag] failed to persist conversation memory:', e && e.message ? e.message : e);
            }

            // store analysis metadata to include in response
            body._analysis = analysis;
          } catch (e) {
            console.warn('[mock /api/rag] NLP analysis failed:', e && e.message ? e.message : e);
          }

          // Fetch recent conversation for personalization (last 10)
          let recent = [];
          if (body.id_user) {
            try {
              const [rows] = await pool.query(
                'SELECT sender, message FROM conversation_memory WHERE id_user = ? ORDER BY id DESC LIMIT 10',
                [Number(body.id_user)]
              );
              recent = rows || [];
            } catch (_) {}
          }

          // call embed service
          const EMBED_URL = process.env.EMBED_URL || 'http://embed:5001';
          const QDRANT_URL = process.env.QDRANT_URL || 'http://qdrant:6333';
          const EMBED_MODEL = process.env.EMBED_MODEL || 'sentence-transformers/all-MiniLM-L6-v2';

          // get embedding for the question
          const embedResp = await fetch(`${EMBED_URL.replace(/\/$/, '')}/embed`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: EMBED_MODEL, input: [q] })
          });
          if (!embedResp.ok) {
            const txt = await embedResp.text().catch(() => '<no-body>');
            console.error('[mock /api/rag] embed error:', txt);
            return res.status(502).json({ error: 'Embed service error' });
          }
          const embedBody = await embedResp.json().catch(() => null);
          const qvec = (embedBody && (embedBody.embeddings && embedBody.embeddings[0])) || (embedBody && embedBody.data && embedBody.data[0] && embedBody.data[0].embedding);
          if (!qvec) return res.status(502).json({ error: 'No embedding returned' });

          // query qdrant
          const { QdrantClient } = await import('@qdrant/js-client-rest');
          const qdrant = new QdrantClient({ url: QDRANT_URL, checkCompatibility: false });
          const top_k = Number(body.top_k || 3);
          const collectionName = process.env.QDRANT_COLLECTION || 'documents';
          const qdrantFilter = buildFilenameFilter(q);
          let searchRes = null;
          try {
            const searchPayload = { vector: qvec, limit: top_k, with_payload: true };
            if (qdrantFilter) searchPayload.filter = qdrantFilter;
            searchRes = await qdrant.search(collectionName, searchPayload);
          } catch (e) {
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

          const confidentHits = (searchRes || []).filter(hit => typeof hit?.score === 'number' && hit.score >= MIN_CONFIDENCE);
          if (!confidentHits.length) {
            const fallbackAnswer = NO_DATA_MESSAGE;
            try {
              await pool.query(
                'INSERT INTO conversation_memory (id_user, sender, message, intent, sentiment_score, sentiment_label) VALUES (?,?,?,?,?,?)',
                [body.id_user ? Number(body.id_user) : null, 'bot', fallbackAnswer, 'no_data', null, null]
              );
            } catch (e) {
              console.warn('[mock /api/rag] failed to persist fallback memory:', e && e.message ? e.message : e);
            }
            return res.json({ answer: fallbackAnswer, sources: [], raw_hits: [], metadata: body._analysis || null, context_messages: recent });
          }

          // build snippets and sources
          const snippets = [];
          const sources = [];
          const compactHits = [];
          for (const hit of confidentHits) {
            const payload = hit.payload || {};
            const snippet = String(payload.snippet || payload.text || '').slice(0, 800);
            const filename = payload.filename || payload.filepath || 'unknown';
            const page = payload.page || payload.page_number || null;
            snippets.push(`Source: ${filename} (page ${page})\n${snippet}`);
            sources.push({ filename, filepath: payload.filepath || `data/${filename}`, page, score: hit.score, snippet });
            compactHits.push({ id: hit.id, score: hit.score, filename, page, snippet });
          }

          // Synthesize a concise answer from top snippets (no external LLM), with a light personalization prefix if sentiment negative
          const sentimentLabel = body._analysis && body._analysis.sentiment && body._analysis.sentiment.label;
          const tonePrefix = sentimentLabel === 'negative'
            ? 'Saya mengerti kekhawatiran Anda. '
            : 'Saya menemukan beberapa poin yang relevan. ';
          const use = snippets.slice(0, Math.min(2, snippets.length));
          const sentences = use.map(s => {
            const txt = String(s).replace(/\n/g, ' ').trim();
            const m = txt.match(/([^.?!]*[.?!])/);
            return m ? m[0].trim() : txt.slice(0, 200);
          });
          const srcList = sources.slice(0, Math.min(3, sources.length)).map(s => `${s.filename}${s.page ? ' (hal. ' + s.page + ')' : ''}`).join(', ');
          const answer = `${tonePrefix}${sentences.join(' ')} Saya merujuk pada ${srcList}.`;

          // persist bot answer as memory and include metadata
          try {
            const botText = answer;
            try {
              await pool.query(
                'INSERT INTO conversation_memory (id_user, sender, message, intent, sentiment_score, sentiment_label) VALUES (?,?,?,?,?,?)',
                [body.id_user ? Number(body.id_user) : null, 'bot', botText, 'answer', null, null]
              );
            } catch (e) {
              console.warn('[mock /api/rag] failed to persist bot memory:', e && e.message ? e.message : e);
            }
          } catch (e) {
            /* ignore */
          }

          return res.json({ answer, sources, raw_hits: compactHits, metadata: body._analysis || null, context_messages: recent });
        }

        // default behavior
        const answer = q
          ? `Mock answer: I received your question (${q.slice(0,120)}) but RAG is disabled in this environment.`
          : 'Mock answer: no question provided.';
        return res.json({ answer, sources: [], raw_hits: [] });
      } catch (err) {
        console.error('[mock /api/rag] error', err);
        return res.status(500).json({ error: String(err) });
      }
    })();
  });
}

const port = process.env.PORT || 4000;
const distPath = path.resolve(process.cwd(), '..', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}
app.listen(port, () => console.log(`Server listening on ${port}`));
