// server/index.js
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

import { pool } from './db.js';
import nlp from './utils/nlp.js';

import filesRouter from './routes/files.js';

dotenv.config();

const app = express();
app.use(cors());

/**
 * Custom raw body catcher + tolerant JSON parsing.
 * Pasang DI ATAS semua route POST yang butuh req.body (login/rag/statistics).
 */
app.use((req, res, next) => {
  // Biar GET/static ga kena overhead
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return next();

  let data = '';
  req.setEncoding('utf8');

  req.on('data', chunk => {
    data += chunk;
  });

  req.on('end', () => {
    req.rawBody = data;

    const ct = (req.headers['content-type'] || '').toLowerCase();
    if (ct.includes('application/json')) {
      try {
        req.body = data ? JSON.parse(data) : {};
      } catch (err) {
        console.warn(
          '[raw-json] JSON parse failed:',
          err.message,
          'rawPreview:',
          String(data).slice(0, 500)
        );

        // Tolerant conversion for JS-like object literals:
        // {prompt:Lingkup pekerjaan KP,top_k:3}
        try {
          const tolerant = (raw) => {
            let s = raw.trim();
            if (!s.startsWith('{')) return raw;

            // Quote keys: {key: -> {"key":
            s = s.replace(/([,{\s])([A-Za-z0-9_\-]+)\s*:/g, '$1"$2":');

            // Quote unquoted string values (stop at , or })
            // NOTE: versi kamu ada spasi sebelum (?=...), ini dibenerin.
            s = s.replace(/:\s*([^",\]\}\s][^,\}]*)\s*(?=[,\}])/g, (m, p1) => {
              const v = String(p1 || '').trim();
              if (/^-?\d+(?:\.\d+)?$/.test(v) || /^(true|false|null)$/i.test(v)) {
                return ':' + v;
              }
              const esc = v.replace(/"/g, '\\"');
              return ':"' + esc + '"';
            });

            return s;
          };

          const converted = tolerant(data);
          req.body = converted ? JSON.parse(converted) : {};
          console.warn('[raw-json] tolerant parse succeeded, body keys:', Object.keys(req.body));
        } catch (err2) {
          console.warn(
            '[raw-json] tolerant parse also failed:',
            err2.message,
            'rawPreview:',
            String(data).slice(0, 500)
          );
          req.body = {};
        }
      }
    } else {
      req.body = {};
    }

    next();
  });
});

/* -------------------- Health -------------------- */
app.get('/health', (req, res) => {
  return res.json({ ok: true, pid: process.pid, env: process.env.NODE_ENV || 'development' });
});

/* -------------------- Files router --------------------
 * Ini yang handle:
 * - GET /files/KP.pdf
 * - GET /files/KP.pdf?download=1
 */
app.use('/', filesRouter);

/* -------------------- Auth -------------------- */
async function handleLogin(req, res) {
  const { username, email, password } = req.body || {};
  const usernameTrim = username ? String(username).trim() : '';
  const emailTrim = email ? String(email).trim() : '';
  const passwordRaw = password ? String(password).trim() : '';

  console.log('[auth] handleLogin called with:', {
    username: usernameTrim || undefined,
    email: emailTrim || undefined,
    password: passwordRaw ? '***' : undefined,
  });

  const idValue = usernameTrim || emailTrim;
  if (!idValue || !passwordRaw) {
    return res.status(400).json({ error: 'Username/email and password required' });
  }

  const field = usernameTrim ? 'username' : 'email';

  try {
    const [rows] = await pool.query(
      `SELECT * FROM ` + '\`user\`' + ` WHERE ${field} = ? LIMIT 1`,
      [idValue]
    );

    console.log('[auth] SQL rows:', rows && rows.length ? `[found ${rows.length}]` : '[]');

    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    let match = false;
    try {
      match = await bcrypt.compare(passwordRaw, user.password || '');
    } catch {
      match = false;
    }

    // fallback plaintext
    if (!match && user.password && passwordRaw === user.password) {
      console.warn(
        `Warning: authenticating user ${user.email || user.username} using plain-text password fallback.`
      );
      match = true;
    }

    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const { id_user, username: userName, email: userEmail, prodi } = user;
    return res.json({ id_user, username: userName, email: userEmail, prodi });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}

app.post('/api/login', handleLogin);
app.post('/login', handleLogin);

/* -------------------- Statistics router -------------------- */
const statsMod = await import('./routes/statistics.js');
const statsRouter = statsMod && (statsMod.default || statsMod);
if (statsRouter) app.use('/api/statistics', statsRouter);

/* -------------------- RAG router -------------------- */
const ENABLE_RAG = (process.env.ENABLE_RAG || 'false').toLowerCase() === 'true';
console.log('[server] ENABLE_RAG=', ENABLE_RAG);

if (ENABLE_RAG) {
  const mod = await import('./routes/rag.js');
  const ragRouter = mod && (mod.default || mod);
  if (ragRouter) app.use('/api/rag', ragRouter);
} else {
  console.log('[server] RAG router not mounted; set ENABLE_RAG=true to enable');

  app.post('/api/rag', (req, res) => {
    (async () => {
      try {
        const body = req.body || {};
        console.log('[mock /api/rag] received body:', JSON.stringify(body).slice(0, 1000));

        const candidate = body.prompt || body.question || body.q || body.message || body.text || '';
        const q = candidate ? String(candidate).trim() : '';

        if (q) {
          // analyze + persist user memory
          try {
            const analysis = await nlp.analyzeMessage(q);
            const id_user = body.id_user ? Number(body.id_user) : null;

            try {
              await pool.query(
                'INSERT INTO conversation_memory (id_user, sender, message, intent, sentiment_score, sentiment_label) VALUES (?,?,?,?,?,?)',
                [id_user, 'user', q, analysis.intent, analysis.sentiment.score, analysis.sentiment.label]
              );
            } catch (e) {
              console.warn('[mock /api/rag] failed to persist conversation memory:', e?.message || e);
            }

            body._analysis = analysis;
          } catch (e) {
            console.warn('[mock /api/rag] NLP analysis failed:', e?.message || e);
          }

          // recent conversation
          let recent = [];
          if (body.id_user) {
            try {
              const [rows] = await pool.query(
                'SELECT sender, message FROM conversation_memory WHERE id_user = ? ORDER BY id DESC LIMIT 10',
                [Number(body.id_user)]
              );
              recent = rows || [];
            } catch {}
          }

          const EMBED_URL = process.env.EMBED_URL || 'http://embed:5001';
          const QDRANT_URL = process.env.QDRANT_URL || 'http://qdrant:6333';
          const EMBED_MODEL = process.env.EMBED_MODEL || 'sentence-transformers/all-MiniLM-L6-v2';

          const embedResp = await fetch(`${EMBED_URL.replace(/\/$/, '')}/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: EMBED_MODEL, input: [q] }),
          });

          if (!embedResp.ok) {
            const txt = await embedResp.text().catch(() => '<no-body>');
            console.error('[mock /api/rag] embed error:', txt);
            return res.status(502).json({ error: 'Embed service error' });
          }

          const embedBody = await embedResp.json().catch(() => null);
          const qvec =
            (embedBody && embedBody.embeddings && embedBody.embeddings[0]) ||
            (embedBody && embedBody.data && embedBody.data[0] && embedBody.data[0].embedding);

          if (!qvec) return res.status(502).json({ error: 'No embedding returned' });

          const { QdrantClient } = await import('@qdrant/js-client-rest');
          const qdrant = new QdrantClient({ url: QDRANT_URL, checkCompatibility: false });

          const top_k = Number(body.top_k || 3);
          const collectionName = process.env.QDRANT_COLLECTION || 'documents';

          const searchRes = await qdrant.search(collectionName, { vector: qvec, limit: top_k, with_payload: true });

          const snippets = [];
          const sources = [];
          const compactHits = [];

          for (const hit of searchRes) {
            const payload = hit.payload || {};
            const snippet = String(payload.snippet || payload.text || '').slice(0, 800);
            const filename = payload.filename || payload.filepath || 'unknown';
            const page = payload.page || payload.page_number || null;

            snippets.push(`Source: ${filename} (page ${page})\n${snippet}`);
            sources.push({ filename, filepath: payload.filepath || `data/${filename}`, page, score: hit.score, snippet });
            compactHits.push({ id: hit.id, score: hit.score, filename, page, snippet });
          }

          let answer = '';
          const sentimentLabel = body._analysis?.sentiment?.label;
          const prefix = sentimentLabel === 'negative' ? 'Saya mengerti ini penting. ' : '';

          if (!snippets.length) {
            answer = prefix + 'Maaf, tidak menemukan dokumen yang relevan.';
          } else {
            const use = snippets.slice(0, Math.min(2, snippets.length));
            const sentences = use.map(s => {
              const txt = String(s).replace(/\n/g, ' ').trim();
              const m = txt.match(/([^.?!]*[.?!])/);
              return m ? m[0].trim() : txt.slice(0, 200);
            });
            const srcList = sources
              .slice(0, Math.min(3, sources.length))
              .map(s => `${s.filename}${s.page ? ' (p' + s.page + ')' : ''}`)
              .join(', ');

            answer = prefix + sentences.join(' ') + `\n\nSumber: ${srcList}`;
          }

          try {
            await pool.query(
              'INSERT INTO conversation_memory (id_user, sender, message, intent, sentiment_score, sentiment_label) VALUES (?,?,?,?,?,?)',
              [body.id_user ? Number(body.id_user) : null, 'bot', answer, 'answer', null, null]
            );
          } catch (e) {
            console.warn('[mock /api/rag] failed to persist bot memory:', e?.message || e);
          }

          return res.json({ answer, sources, raw_hits: compactHits, metadata: body._analysis || null, context_messages: recent });
        }

        return res.json({ answer: 'Mock answer: no question provided.', sources: [], raw_hits: [] });
      } catch (err) {
        console.error('[mock /api/rag] error', err);
        return res.status(500).json({ error: String(err) });
      }
    })();
  });
}

/* -------------------- Static build -------------------- */
const port = process.env.PORT || 4000;
const distPath = path.resolve(process.cwd(), '..', 'dist');

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(port, () => console.log(`Server listening on ${port}`));
