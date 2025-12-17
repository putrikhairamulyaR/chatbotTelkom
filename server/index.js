// server/index.js
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

import { pool } from './db.js';
import nlp from './utils/nlp.js';

import filesRouter from './routes/files.js';
import { handleLogin } from './controllers/authController.js';

dotenv.config();

const app = express();
app.use(cors());

/**
 * Custom raw body catcher + tolerant JSON parsing.
 * Pasang DI ATAS semua route POST yang butuh req.body (login/rag/statistics).
 */
app.use((req, res, next) => {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return next();

  const ct = (req.headers['content-type'] || '').toLowerCase();
  // Only handle JSON bodies here; let multer/busboy handle multipart/form-data and others
  if (!ct.includes('application/json')) return next();

  let data = '';
  req.setEncoding('utf8');

  req.on('data', (chunk) => {
    data += chunk;
  });

  req.on('end', () => {
    req.rawBody = data;
    req.body = {};

    try {
      req.body = data ? JSON.parse(data) : {};
    } catch (err) {
      console.warn(
        '[raw-json] JSON parse failed:',
        err.message,
        'rawPreview:',
        String(data).slice(0, 200)
      );

      // Tolerant conversion untuk JS-like object literals:
      // {prompt:Lingkup pekerjaan KP,top_k:3}
      try {
        let s = String(data || '').trim();
        if (s.startsWith('{') || s.startsWith('[')) {
          // Quote keys: {key: -> {"key":
          s = s.replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":');
          // ganti single-quote jadi double-quote
          s = s.replace(/'/g, '"');
          req.body = JSON.parse(s);
        }
      } catch (e2) {
        console.warn('[raw-json] tolerant parse failed:', e2.message);
        req.body = {};
      }
    }

    next();
  });
});

/* -------------------- Routes dasar -------------------- */
app.use('/api/files', filesRouter);
app.post('/api/login', handleLogin);

/* -------------------- Init DB helpers -------------------- */

// Helper: Ensure admin user exists
async function ensureAdminUser() {
  try {
    // Cek user admin berdasarkan username=199 (sesuaikan kalau beda)
    const [rows] = await pool.query(
      'SELECT id_user, username FROM `user` WHERE username = ? LIMIT 1',
      ['199']
    );

    if (!rows || rows.length === 0) {
      // coba insert dengan kolom role (kalau ada)
      try {
        await pool.query(
          'INSERT INTO `user` (username, password, email, prodi, role) VALUES (?,?,?,?,?)',
          ['199', '123', 'admin@telkom.ac.id', 'Admin', 'admin']
        );
      } catch (insertErr) {
        // fallback tanpa role
        await pool.query(
          'INSERT INTO `user` (username, password, email, prodi) VALUES (?,?,?,?)',
          ['199', '123', 'admin@telkom.ac.id', 'Admin']
        );
      }
      console.log('[init] ✓ Admin user created: username=199, password=123');
      return;
    }

    // kalau sudah ada, update biar konsisten
    try {
      await pool.query(
        'UPDATE `user` SET password = ?, email = ?, prodi = ?, role = ? WHERE username = ?',
        ['123', 'admin@telkom.ac.id', 'Admin', 'admin', '199']
      );
    } catch (updateErr) {
      // fallback tanpa role
      await pool.query(
        'UPDATE `user` SET password = ?, email = ?, prodi = ? WHERE username = ?',
        ['123', 'admin@telkom.ac.id', 'Admin', '199']
      );
    }

    console.log('[init] ✓ Admin user verified/updated: username=199, password=123');
  } catch (err) {
    console.error('[init] ✗ Failed to ensure admin user:', err?.message);
    console.error('[init] Error details:', err);
  }
}

// Helper: Ensure user_log table exists
async function ensureUserLogTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS \`user_log\` (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_user INT NULL,
        action VARCHAR(100) NOT NULL,
        resource_type VARCHAR(50),
        resource_id VARCHAR(255),
        details TEXT,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (id_user),
        INDEX (action),
        INDEX (created_at),
        FOREIGN KEY (id_user) REFERENCES \`user\`(id_user) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[init] ✓ user_log table verified');
  } catch (err) {
    console.warn('[init] Could not ensure user_log table:', err?.message);
  }
}

// Run on startup (top-level)
await ensureAdminUser();
await ensureUserLogTable();
// Ensure NIM column exists in `user` table
async function ensureUserNimColumn() {
  try {
    const [columns] = await pool.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user' AND COLUMN_NAME = 'nim'"
    );
    if (!columns || columns.length === 0) {
      await pool.query("ALTER TABLE `user` ADD COLUMN nim VARCHAR(100) NULL AFTER username");
      console.log('[init] ✓ nim column added to user table');
    }
  } catch (err) {
    console.warn('[init] Could not ensure nim column:', err?.message);
  }
}

await ensureUserNimColumn();

/* -------------------- Statistics router -------------------- */
const statsMod = await import('./routes/statistics.js');
const statsRouter = statsMod && (statsMod.default || statsMod);
if (statsRouter) app.use('/api/statistics', statsRouter);

/* -------------------- Admin router -------------------- */
const adminMod = await import('./routes/admin.js');
const adminRouter = adminMod && (adminMod.default || adminMod);
if (adminRouter) app.use('/api/admin', adminRouter);

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

          const searchRes = await qdrant.search(collectionName, {
            vector: qvec,
            limit: top_k,
            with_payload: true,
          });

          const snippets = [];
          const sources = [];
          const compactHits = [];

          for (const hit of searchRes) {
            const payload = hit.payload || {};
            const snippet = String(payload.snippet || payload.text || '').slice(0, 800);
            const filename = payload.filename || payload.filepath || 'unknown';
            const page = payload.page || payload.page_number || null;

            snippets.push(`Source: ${filename} (page ${page})\n${snippet}`);
            sources.push({
              filename,
              filepath: payload.filepath || `data/${filename}`,
              page,
              score: hit.score,
              snippet,
            });
            compactHits.push({ id: hit.id, score: hit.score, filename, page, snippet });
          }

          let answer = '';
          const sentimentLabel = body._analysis?.sentiment?.label;
          const sentimentScore = body._analysis?.sentiment?.score || 0;
          const isNegativeSentiment = sentimentLabel === 'negative' || sentimentScore < -0.15;

          // Deteksi ketidakpuasan dengan jawaban
          const qLower = String(q).toLowerCase();
          const isDissatisfied =
            isNegativeSentiment ||
            qLower.includes('kurang jelas') ||
            qLower.includes('tidak membantu') ||
            qLower.includes('tidak sesuai') ||
            qLower.includes('salah') ||
            qLower.includes('tidak akurat') ||
            qLower.includes('tidak memuaskan') ||
            qLower.includes('tidak puas') ||
            qLower.includes('tidak berguna') ||
            qLower.includes('tidak relevan') ||
            qLower.includes('tidak menjawab') ||
            qLower.includes('jawabannya salah') ||
            qLower.includes('jawaban salah') ||
            qLower.includes('masih bingung') ||
            qLower.includes('belum jelas') ||
            qLower.includes('belum paham');

          const empatheticPrefix = isDissatisfied
            ? 'Saya mengerti kekhawatiran Anda. Mari saya coba jelaskan dengan lebih jelas dan detail:\n\n'
            : '';

          if (!snippets.length) {
            answer =
              empatheticPrefix +
              'Maaf, tidak menemukan dokumen yang relevan. Silakan coba dengan kata kunci yang lebih spesifik.';
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

            answer = empatheticPrefix + sentences.join(' ') + `\n\nSumber: ${srcList}`;
          }

          try {
            await pool.query(
              'INSERT INTO conversation_memory (id_user, sender, message, intent, sentiment_score, sentiment_label) VALUES (?,?,?,?,?,?)',
              [body.id_user ? Number(body.id_user) : null, 'bot', answer, 'answer', null, null]
            );
          } catch (e) {
            console.warn('[mock /api/rag] failed to persist bot memory:', e?.message || e);
          }

          return res.json({
            answer,
            sources,
            raw_hits: compactHits,
            metadata: body._analysis || null,
            context_messages: recent,
          });
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
