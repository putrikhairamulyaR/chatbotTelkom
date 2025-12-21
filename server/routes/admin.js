// server/routes/admin.js
import express from 'express';
import { pool } from '../db.js';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import fsPromises from 'fs/promises';
import { QdrantClient } from '@qdrant/js-client-rest';
import { spawn } from 'child_process';
import multer from 'multer';
import mammoth from 'mammoth';
import { randomUUID } from 'crypto';

// Helper functions untuk extract topic (dari statistics.js)
function extractTopic(message) {
  if (!message || typeof message !== 'string') return null;
  
  let text = message.toLowerCase().trim();
  text = text.replace(/^[?.,!;:\s]+|[?.,!;:\s]+$/g, '');
  text = text.replace(/^(apa|apakah|apa itu|itu apa|tu apa|bagaimana|gimana|kenapa|mengapa|kapan|dimana|di mana|berapa|siapa|tolong|jelaskan|jelas|bisa|boleh)\s+/i, '');
  text = text.replace(/^(tentang|mengenai|soal|perihal|dari|untuk|dengan|oleh)\s+/i, '');
  text = text.replace(/^(halo|hai|hi|hello|assalamualaikum|selamat)\s+/i, '');
  text = text.replace(/\s+(terima kasih|makasih|thanks|thank you)$/i, '');
  
  text = text.replace(/\bkerja praktek\b/g, 'kerja praktik');
  text = text.replace(/\bkp\b/g, 'kerja praktik');
  text = text.replace(/\bpersyaratan\b/g, 'syarat');
  text = text.replace(/\bpengertian\b/g, 'definisi');
  text = text.replace(/\barti\b/g, 'definisi');
  text = text.replace(/\bmaksud\b/g, 'definisi');
  
  const patterns = [
    /(syarat\s+kerja\s+praktik)/i,
    /(definisi\s+kerja\s+praktik)/i,
    /(prosedur\s+kerja\s+praktik)/i,
    /(tahapan\s+kerja\s+praktik)/i,
    /(dokumen\s+kerja\s+praktik)/i,
    /(laporan\s+kerja\s+praktik)/i,
    /(pendaftaran\s+kerja\s+praktik)/i,
    /(pembimbing\s+kerja\s+praktik)/i,
    /(nilai\s+kerja\s+praktik)/i,
    /(jadwal\s+kerja\s+praktik)/i,
    /(format\s+kerja\s+praktik)/i,
    /(kerja\s+praktik)/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  
  if (text.includes('kerja praktik') || text.includes('kp')) {
    const words = text.split(/\s+/);
    const kpIndex = words.findIndex(w => w === 'kerja' || w === 'praktik' || w === 'kp');
    if (kpIndex !== -1) {
      const start = Math.max(0, kpIndex - 2);
      const end = Math.min(words.length, kpIndex + 3);
      const topic = words.slice(start, end).join(' ');
      const cleaned = topic.replace(/\b(apa|itu|yang|di|ke|dari|pada|untuk|dengan|oleh|ini|itu|saya|aku|kamu|dia|kita|mereka|tolong|bisa|boleh|mau|ingin)\b/gi, '').trim();
      if (cleaned.length > 5) {
        return cleaned.split(/\s+/).filter(w => w.length > 2).slice(0, 5).join(' ');
      }
    }
  }
  
  const stopWords = new Set(['yang', 'di', 'ke', 'dari', 'pada', 'untuk', 'dengan', 'oleh', 'ini', 'itu', 'saya', 'aku', 'kamu', 'dia', 'kita', 'mereka']);
  const words = text.split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w));
  if (words.length >= 2) {
    return words.slice(0, 4).join(' ');
  }
  
  return null;
}

function normalizeTopic(topic) {
  if (!topic) return null;
  let t = topic.toLowerCase().trim();
  t = t.replace(/\bkerja praktek\b/g, 'kerja praktik');
  t = t.replace(/\bkp\b/g, 'kerja praktik');
  t = t.replace(/\bpersyaratan\b/g, 'syarat');
  t = t.replace(/\bpengertian\b/g, 'definisi');
  t = t.replace(/\barti\b/g, 'definisi');
  t = t.replace(/\bmaksud\b/g, 'definisi');
  
  const normalizations = {
    'syarat kerja praktik': 'syarat kerja praktik',
    'definisi kerja praktik': 'definisi kerja praktik',
    'prosedur kerja praktik': 'prosedur kerja praktik',
    'tahapan kerja praktik': 'tahapan kerja praktik',
    'dokumen kerja praktik': 'dokumen kerja praktik',
    'laporan kerja praktik': 'laporan kerja praktik',
    'pendaftaran kerja praktik': 'pendaftaran kerja praktik',
    'pembimbing kerja praktik': 'pembimbing kerja praktik',
    'nilai kerja praktik': 'nilai kerja praktik',
    'jadwal kerja praktik': 'jadwal kerja praktik',
    'format kerja praktik': 'format kerja praktik',
  };
  
  if (normalizations[t]) {
    return normalizations[t];
  }
  
  for (const [key, value] of Object.entries(normalizations)) {
    const keyWords = key.split(/\s+/);
    const topicWords = t.split(/\s+/);
    const hasAllKeywords = keyWords.every(kw => topicWords.some(tw => tw.includes(kw) || kw.includes(tw)));
    if (hasAllKeywords && topicWords.length <= keyWords.length + 2) {
      return value;
    }
  }
  
  if (t.includes('kerja praktik')) {
    const words = t.split(/\s+/);
    const kpIndex = words.findIndex(w => w === 'kerja');
    if (kpIndex > 0) {
      const prefix = words.slice(0, kpIndex).join(' ');
      if (prefix === 'syarat') return 'syarat kerja praktik';
      if (prefix === 'definisi') return 'definisi kerja praktik';
      if (prefix === 'prosedur') return 'prosedur kerja praktik';
      if (prefix === 'tahapan') return 'tahapan kerja praktik';
      if (prefix === 'dokumen') return 'dokumen kerja praktik';
      if (prefix === 'laporan') return 'laporan kerja praktik';
    }
  }
  
  return t;
}

const router = express.Router();

// Configure multer for file upload
const DATA_DIR = path.resolve(process.cwd(), '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Metadata directory for resource info (topic/subtopic)
const META_DIR = path.join(DATA_DIR, '.meta');
if (!fs.existsSync(META_DIR)) {
  fs.mkdirSync(META_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch {}
    cb(null, DATA_DIR);
  },
  filename: (req, file, cb) => {
    try {
      const originalName = (req.body?.filename || file.originalname || 'upload').toString();
      const ext = path.extname(originalName);
      const base = path.basename(originalName, ext);
      let finalName = originalName;
      const fullPath = (name) => path.join(DATA_DIR, name);
      if (fs.existsSync(fullPath(finalName))) {
        finalName = `${base}_${Date.now()}${ext}`;
      }
      cb(null, finalName);
    } catch {
      cb(null, file.originalname || `upload_${Date.now()}`);
    }
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // Allow Word uploads too (.docx, .doc) for storage, but embedding will be restricted
    if (['.pdf', '.txt', '.md', '.docx', '.doc'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, TXT, MD, DOCX, and DOC files are allowed'));
    }
  },
});

// Helper functions for PDF processing (from upload-search.js)
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
        // OCR functionality can be added here if needed
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

    return [''];
  } catch (err) {
    console.error('Error reading PDF', filePath, err?.message);
    return [''];
  }
}

async function extractTextFromFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  
  if (ext === '.pdf') {
    const pages = await extractPdfPages(filePath);
    return { type: 'pdf', pages, filename: path.basename(originalName) };
  } else if (ext === '.docx') {
    try {
      const data = await fsPromises.readFile(filePath);
      const res = await mammoth.extractRawText({ buffer: data });
      const txt = (res && res.value) ? String(res.value) : '';
      return { type: 'docx', pages: [txt], filename: path.basename(originalName) };
    } catch (err) {
      console.warn('DOCX extract failed:', err?.message);
      return { type: 'docx', pages: [''], filename: path.basename(originalName) };
    }
  } else {
    const text = await fsPromises.readFile(filePath, 'utf8');
    return { type: 'text', pages: [text], filename: path.basename(originalName) };
  }
}

async function getEmbedding(text, model = 'nomic-embed-text') {
  const fetchImpl = globalThis.fetch || (await import('node-fetch')).default;
  const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const EMBED_SERVICE_URL = (process.env.EMBED_URL || '').replace(/\/$/, '');
  const EMBED_MODEL = process.env.EMBED_MODEL || model;

  // Try Python embed service first if configured (EMBED_URL points to it), then Ollama endpoints
  const candidates = [];
  if (EMBED_SERVICE_URL) {
    candidates.push({ url: `${EMBED_SERVICE_URL}/embed`, body: { model: EMBED_MODEL, input: [text] } });
  }
  // Ollama new and legacy paths
  candidates.push({ url: `${OLLAMA_URL}/api/embed`, body: { model: EMBED_MODEL, input: text, keep_alive: '10m' } });
  candidates.push({ url: `${OLLAMA_URL}/embed`, body: { model: EMBED_MODEL, input: text, keep_alive: '10m' } });

  for (const c of candidates) {
    try {
      const resp = await fetchImpl(c.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(c.body),
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '<no-body>');
        console.warn('Embedding endpoint error:', resp.status, txt.slice(0, 200));
        continue;
      }
      const data = await resp.json().catch(() => null);
      const embedding =
        (Array.isArray(data?.embedding) && data.embedding) ||
        (Array.isArray(data?.embeddings) && data.embeddings?.[0]) ||
        (data?.data?.[0]?.embedding);
      if (embedding && Array.isArray(embedding)) return embedding;
    } catch (err) {
      console.warn('Embedding fetch failed:', err?.message);
    }
  }

  throw new Error('Failed to get embedding from available providers');
}

// Helper: Log audit action (to both audit_log and user_log)
async function logAudit(id_user, action, resourceType, resourceId, details, ip, userAgent = null) {
  try {
    // Log to audit_log (admin actions)
    await pool.query(
      'INSERT INTO audit_log (id_user, action, resource_type, resource_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
      [id_user, action, resourceType, resourceId, JSON.stringify(details), ip]
    );
    
    // Also log to user_log (all user activities)
    try {
      await pool.query(
        'INSERT INTO user_log (id_user, action, resource_type, resource_id, details, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id_user, action, resourceType, resourceId, JSON.stringify(details), ip, userAgent]
      );
    } catch (userLogErr) {
      // If user_log table doesn't exist yet, that's okay
      if (!userLogErr.message.includes("doesn't exist")) {
        console.warn('[audit] Failed to log to user_log:', userLogErr?.message);
      }
    }
  } catch (err) {
    console.error('[audit] Failed to log:', err?.message);
  }
}

/* ==================== DASHBOARD ==================== */
router.get('/dashboard', async (req, res) => {
  try {
    const id_user = req.user?.id_user;

    // 1. Total users
    const [userCount] = await pool.query('SELECT COUNT(*) as count FROM `user`');
    const totalUsers = userCount[0]?.count || 0;

    // 2. Total messages
    const [msgCount] = await pool.query('SELECT COUNT(*) as count FROM conversation_memory');
    const totalMessages = msgCount[0]?.count || 0;

    // 3. Active users (last 7 days)
    const [activeUsers] = await pool.query(
      `SELECT COUNT(DISTINCT id_user) as count 
       FROM conversation_memory 
       WHERE id_user IS NOT NULL 
       AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`
    );
    const activeUsersCount = activeUsers[0]?.count || 0;

    // 4. Usage by hour (penggunaan tertinggi di jam berapa)
    const [hourlyUsage] = await pool.query(
      `SELECT 
         HOUR(created_at) as hour,
         COUNT(*) as count
       FROM conversation_memory
       WHERE sender = 'user'
       GROUP BY HOUR(created_at)
       ORDER BY count DESC, hour ASC`
    );

    // Format hourly data untuk semua 24 jam
    const hourlyData = Array.from({ length: 24 }, (_, i) => {
      const existing = hourlyUsage.find(h => h.hour === i);
      return {
        hour: i,
        hourLabel: `${i}:00`,
        count: existing ? existing.count : 0,
      };
    });

    // Jam dengan penggunaan tertinggi
    const peakHour = hourlyUsage.length > 0 ? hourlyUsage[0] : null;

    // 5. Top topics (topik paling banyak ditanyakan)
    const [userMessages] = await pool.query(
      `SELECT message 
       FROM conversation_memory 
       WHERE sender = 'user' 
         AND message IS NOT NULL 
         AND message != ''
         AND LENGTH(message) > 5
       ORDER BY created_at DESC`
    );
    
    const topicCounts = {};
    for (const row of userMessages) {
      const topic = extractTopic(row.message);
      if (topic) {
        const normalized = normalizeTopic(topic);
        if (normalized) {
          topicCounts[normalized] = (topicCounts[normalized] || 0) + 1;
        }
      }
    }
    
    const topTopics = Object.entries(topicCounts)
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // 6. Most accessed documents (dokumen paling banyak diakses)
    // Track dari sources di conversation_memory atau dari Qdrant
    let mostAccessedDocs = [];
    try {
      const qdrant = new QdrantClient({
        url: process.env.QDRANT_URL || 'http://127.0.0.1:6333',
        checkCompatibility: false,
      });
      const collection = process.env.QDRANT_COLLECTION || 'documents';
      
      // Scroll through points untuk menghitung akses per file
      const docAccessCount = {};
      let nextPageOffset = null;
      let scrollCount = 0;
      const maxScrolls = 50; // Limit untuk performa
      
      do {
        const scrollRes = await qdrant.scroll(collection, {
          limit: 100,
          offset: nextPageOffset,
          with_payload: true,
        });

        for (const point of scrollRes.points || []) {
          const filename = point.payload?.filename;
          if (filename) {
            docAccessCount[filename] = (docAccessCount[filename] || 0) + 1;
          }
        }

        nextPageOffset = scrollRes.next_page_offset;
        scrollCount++;
      } while (nextPageOffset !== null && scrollCount < maxScrolls);

      // Convert to array and sort
      mostAccessedDocs = Object.entries(docAccessCount)
        .map(([filename, accessCount]) => ({ filename, accessCount }))
        .sort((a, b) => b.accessCount - a.accessCount)
        .slice(0, 10);
    } catch (err) {
      console.warn('[admin] Document access tracking error:', err?.message);
    }

    // 7. Top users by message count
    const [topUsers] = await pool.query(
      `SELECT u.id_user, u.username, u.email, COUNT(*) as message_count
       FROM conversation_memory cm
       JOIN \`user\` u ON cm.id_user = u.id_user
       WHERE cm.sender = 'user'
       GROUP BY u.id_user, u.username, u.email
       ORDER BY message_count DESC
       LIMIT 10`
    );

    // 8. Messages per day (last 7 days)
    const [dailyMessages] = await pool.query(
      `SELECT DATE(created_at) as date, COUNT(*) as count 
       FROM conversation_memory 
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       GROUP BY DATE(created_at)
       ORDER BY date DESC`
    );

    // 8b. Sentiment overview (user messages)
    const [sentimentRows] = await pool.query(
      `SELECT sentiment_label as label, COUNT(*) as count
       FROM conversation_memory
       WHERE sender = 'user' AND sentiment_label IS NOT NULL
       GROUP BY sentiment_label`
    );

    const sentimentOverview = { totalUserMessages: 0, positive: 0, neutral: 0, negative: 0, satisfactionRate: 0, avgSentimentScore: 0 };
    for (const r of sentimentRows) {
      const lbl = (r.label || '').toLowerCase();
      const c = Number(r.count || 0);
      if (lbl === 'positive') sentimentOverview.positive += c;
      else if (lbl === 'neutral') sentimentOverview.neutral += c;
      else if (lbl === 'negative') sentimentOverview.negative += c;
    }
    sentimentOverview.totalUserMessages = sentimentOverview.positive + sentimentOverview.neutral + sentimentOverview.negative;
    const denom = Math.max(1, (sentimentOverview.positive + sentimentOverview.negative));
    sentimentOverview.satisfactionRate = Number(((sentimentOverview.positive / denom) * 100).toFixed(1));

    const [avgSentScoreRows] = await pool.query(
      `SELECT AVG(sentiment_score) as avg_score
       FROM conversation_memory
       WHERE sender = 'user' AND sentiment_score IS NOT NULL`
    );
    sentimentOverview.avgSentimentScore = Number((avgSentScoreRows[0]?.avg_score || 0).toFixed(3));

    // 8c. Daily sentiment trend (last 14 days)
    const [dailySentimentRaw] = await pool.query(
      `SELECT DATE(created_at) as date, sentiment_label as label, COUNT(*) as count
       FROM conversation_memory
       WHERE sender = 'user' AND created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY) AND sentiment_label IS NOT NULL
       GROUP BY DATE(created_at), sentiment_label
       ORDER BY DATE(created_at) ASC`
    );
    const dailySentimentMap = new Map();
    for (const r of dailySentimentRaw) {
      const d = String(r.date);
      const lbl = (r.label || '').toLowerCase();
      const c = Number(r.count || 0);
      if (!dailySentimentMap.has(d)) dailySentimentMap.set(d, { date: d, positive: 0, neutral: 0, negative: 0, total: 0 });
      const row = dailySentimentMap.get(d);
      if (lbl === 'positive') row.positive += c; else if (lbl === 'neutral') row.neutral += c; else if (lbl === 'negative') row.negative += c;
      row.total = row.positive + row.neutral + row.negative;
    }
    const sentimentDaily = Array.from(dailySentimentMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    // 8d. Recent negative feedback samples
    const [recentNeg] = await pool.query(
      `SELECT id_user, message, created_at
       FROM conversation_memory
       WHERE sender = 'user' AND sentiment_label = 'negative' AND message IS NOT NULL AND TRIM(message) != ''
       ORDER BY created_at DESC
       LIMIT 5`
    );
    const recentNegativeFeedback = (recentNeg || []).map(r => ({ id_user: r.id_user, message: String(r.message || '').slice(0, 300), created_at: r.created_at }));

    // 9. Qdrant collection stats
    let qdrantStats = { totalPoints: 0, uniqueFiles: 0 };
    try {
      const qdrant = new QdrantClient({
        url: process.env.QDRANT_URL || 'http://127.0.0.1:6333',
        checkCompatibility: false,
      });
      const collection = process.env.QDRANT_COLLECTION || 'documents';
      const info = await qdrant.getCollection(collection);
      qdrantStats.totalPoints = info.points_count || 0;

      // Get unique files
      const scrollRes = await qdrant.scroll(collection, { limit: 1000, with_payload: true });
      const files = new Set();
      for (const point of scrollRes.points || []) {
        if (point.payload?.filename) {
          files.add(point.payload.filename);
        }
      }
      qdrantStats.uniqueFiles = files.size;
    } catch (err) {
      console.warn('[admin] Qdrant stats error:', err?.message);
    }

    if (id_user) await logAudit(id_user, 'VIEW_DASHBOARD', 'dashboard', null, {}, req.ip, req.get('user-agent'));

    return res.json({
      // Summary stats
      totalUsers,
      totalMessages,
      activeUsers: activeUsersCount,
      
      // Usage statistics
      hourlyUsage: hourlyData,
      peakHour: peakHour ? { hour: peakHour.hour, hourLabel: `${peakHour.hour}:00`, count: peakHour.count } : null,
      
      // Top topics
      topTopics,
      
      // Most accessed documents
      mostAccessedDocs,
      
      // Other stats
      dailyMessages,
      topUsers,
      qdrantStats,
      // Satisfaction & sentiment
      sentimentOverview,
      sentimentDaily,
      recentNegativeFeedback,
    });
  } catch (err) {
    console.error('[admin] Dashboard error:', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

/* ==================== USER MANAGEMENT ==================== */

// GET /api/admin/users - List all users
router.get('/users', async (req, res) => {
  try {
    const id_user = req.user?.id_user;
    const [rows] = await pool.query(
      'SELECT id_user, username, nim, prodi, role, created_at FROM `user` ORDER BY created_at DESC'
    );
    await logAudit(id_user, 'LIST_USERS', 'user', null, {}, req.ip, req.get('user-agent'));
    return res.json({ users: rows });
  } catch (err) {
    console.error('[admin] List users error:', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// POST /api/admin/users - Add new user
router.post('/users', async (req, res) => {
  try {
    const id_user = req.user?.id_user;
    const { username, nim, email, password, prodi, role } = req.body;

    if (!username || !password || !nim) {
      return res.status(400).json({ error: 'Username, NIM, and password required' });
    }

    // Check if username or email already exists
    const [existing] = await pool.query(
      'SELECT id_user FROM `user` WHERE username = ? OR email = ? OR nim = ?',
      [username, email || '', nim]
    );
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Username, email, or NIM already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert user
    const [result] = await pool.query(
      'INSERT INTO `user` (username, nim, email, password, prodi, role) VALUES (?, ?, ?, ?, ?, ?)',
      [username, nim, email || null, hashedPassword, prodi || null, role || 'user']
    );

    await logAudit(id_user, 'CREATE_USER', 'user', result.insertId, { username, email }, req.ip, req.get('user-agent'));

    return res.json({ success: true, id_user: result.insertId });
  } catch (err) {
    console.error('[admin] Add user error:', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// PUT /api/admin/users/:id - Update user
router.put('/users/:id', async (req, res) => {
  try {
    const id_user = req.user?.id_user;
    const targetId = parseInt(req.params.id);
    const { username, nim, email, password, prodi, role } = req.body;

    // Check if user exists
    const [existing] = await pool.query('SELECT * FROM `user` WHERE id_user = ?', [targetId]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updates = [];
    const values = [];

    if (username !== undefined) {
      // Check if username already taken by another user
      const [check] = await pool.query(
        'SELECT id_user FROM `user` WHERE username = ? AND id_user != ?',
        [username, targetId]
      );
      if (check.length > 0) {
        return res.status(400).json({ error: 'Username already taken' });
      }
      updates.push('username = ?');
      values.push(username);
    }

    if (nim !== undefined) {
      const [check] = await pool.query(
        'SELECT id_user FROM `user` WHERE nim = ? AND id_user != ?',
        [nim, targetId]
      );
      if (check.length > 0) {
        return res.status(400).json({ error: 'NIM already taken' });
      }
      updates.push('nim = ?');
      values.push(nim);
    }

    if (email !== undefined) {
      return res.status(400).json({ error: 'Email tidak dapat diubah' });
    }

    if (password !== undefined && password.trim()) {
      const hashedPassword = await bcrypt.hash(password, 10);
      updates.push('password = ?');
      values.push(hashedPassword);
    }

    if (prodi !== undefined) {
      updates.push('prodi = ?');
      values.push(prodi);
    }

    if (role !== undefined) {
      updates.push('role = ?');
      values.push(role);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(targetId);
    await pool.query(`UPDATE \`user\` SET ${updates.join(', ')} WHERE id_user = ?`, values);

    await logAudit(id_user, 'UPDATE_USER', 'user', targetId, { updates }, req.ip, req.get('user-agent'));

    return res.json({ success: true });
  } catch (err) {
    console.error('[admin] Update user error:', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// DELETE /api/admin/users/:id - Delete user
router.delete('/users/:id', async (req, res) => {
  try {
    const id_user = req.user?.id_user;
    const targetId = parseInt(req.params.id);

    // Prevent deleting yourself
    if (id_user == targetId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // Check if user exists
    const [existing] = await pool.query('SELECT username, email FROM `user` WHERE id_user = ?', [targetId]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await pool.query('DELETE FROM `user` WHERE id_user = ?', [targetId]);

    await logAudit(id_user, 'DELETE_USER', 'user', targetId, { username: existing[0].username }, req.ip, req.get('user-agent'));

    return res.json({ success: true });
  } catch (err) {
    console.error('[admin] Delete user error:', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

/* ==================== AUDIT LOG ==================== */
router.get('/audit-log', async (req, res) => {
  try {
    const id_user = req.user?.id_user;
    const limit = parseInt(req.query.limit || '100');
    const offset = parseInt(req.query.offset || '0');

    // Use conversation_memory as the source of audit-style logs
    const [rows] = await pool.query(
      `SELECT cm.id, cm.id_user, cm.sender, cm.message, cm.intent, cm.sentiment_score, cm.sentiment_label, cm.created_at,
              u.username, u.email
         FROM conversation_memory cm
         LEFT JOIN \`user\` u ON cm.id_user = u.id_user
        ORDER BY cm.created_at DESC
        LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    const [countRows] = await pool.query('SELECT COUNT(*) as count FROM conversation_memory');
    const total = countRows[0]?.count || 0;

    // Map conversation rows to the existing UI shape
    const logs = rows.map(r => ({
      id: r.id,
      id_user: r.id_user,
      username: r.username,
      email: r.email,
      action: r.sender, // show sender (user/bot/meta)
      resource_type: 'message',
      resource_id: null,
      details: JSON.stringify({
        message: r.message,
        intent: r.intent,
        sentiment_score: r.sentiment_score,
        sentiment_label: r.sentiment_label,
      }),
      ip_address: null,
      created_at: r.created_at,
    }));

    // Keep meta logging best-effort (may fail if audit_log doesn't exist)
    await logAudit(id_user, 'VIEW_AUDIT_LOG', 'conversation_memory', null, { via: 'admin_audit_page' }, req.ip, req.get('user-agent'));

    return res.json({ logs, total, limit, offset });
  } catch (err) {
    console.error('[admin] Audit log error:', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

/* ==================== LOGIN FAILURES ==================== */
// GET /api/admin/login-failures - recent failed login attempts + summary
router.get('/login-failures', async (req, res) => {
  try {
    const id_user = req.user?.id_user;
    const limit = Math.min(parseInt(req.query.limit || '200'), 1000);
    const hours = Math.min(Math.max(parseInt(req.query.hours || '24'), 1), 720); // 1..720 hours

    const [logs] = await pool.query(
      `SELECT l.id, l.created_at, l.key_id, l.ip_address, l.user_agent, l.user_id,
              u.username
         FROM login_fail_log l
    LEFT JOIN \`user\` u ON u.id_user = l.user_id
        ORDER BY l.created_at DESC
        LIMIT ?`,
      [limit]
    );

    const [summary] = await pool.query(
      `SELECT COALESCE(u.username, l.key_id) AS user_key,
              DATE_FORMAT(l.created_at, '%Y-%m-%d %H:00:00') AS hour,
              COUNT(*) AS count
         FROM login_fail_log l
    LEFT JOIN \`user\` u ON u.id_user = l.user_id
        WHERE l.created_at >= (NOW() - INTERVAL ? HOUR)
     GROUP BY user_key, hour
     ORDER BY hour DESC, user_key ASC`,
      [hours]
    );

    await logAudit(id_user, 'LIST_LOGIN_FAILURES', 'login_fail_log', null, { limit, hours }, req.ip, req.get('user-agent'));
    return res.json({ logs, summary, hours });
  } catch (err) {
    console.error('[admin] Login failures error:', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

/* ==================== LOGIN LOCKS (Throttle Status) ==================== */
// GET /api/admin/login-locks - current throttle/lock status per key_id
router.get('/login-locks', async (req, res) => {
  try {
    const id_user = req.user?.id_user;
    const limit = Math.min(parseInt(req.query.limit || '200'), 1000);

    const [rows] = await pool.query(
      `SELECT lt.key_id, lt.fail_count, lt.last_fail, lt.locked_until, lt.user_id, lt.email,
              u.username
         FROM login_throttle lt
    LEFT JOIN \`user\` u ON u.id_user = lt.user_id
        ORDER BY lt.last_fail DESC, lt.fail_count DESC
        LIMIT ?`,
      [limit]
    );

    const now = Date.now();
    const locks = rows.map(r => {
      const lockedUntilMs = r.locked_until ? new Date(r.locked_until).getTime() : null;
      const minutes_remaining = lockedUntilMs && lockedUntilMs > now
        ? Math.ceil((lockedUntilMs - now) / 60000)
        : 0;
      return {
        key_id: r.key_id,
        user_id: r.user_id,
        username: r.username || null,
        email: r.email || null,
        fail_count: r.fail_count,
        last_fail: r.last_fail,
        locked_until: r.locked_until,
        minutes_remaining,
      };
    });

    await logAudit(id_user, 'LIST_LOGIN_LOCKS', 'login_throttle', null, { limit }, req.ip, req.get('user-agent'));
    return res.json({ locks });
  } catch (err) {
    console.error('[admin] Login locks error:', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

/* ==================== RESOURCE MANAGEMENT (Qdrant Documents) ==================== */

// GET /api/admin/resources - List all documents (both in Qdrant and data folder)
router.get('/resources', async (req, res) => {
  try {
    const id_user = req.user?.id_user;
    const qdrant = new QdrantClient({
      url: process.env.QDRANT_URL || 'http://127.0.0.1:6333',
      checkCompatibility: false,
    });
    const collection = process.env.QDRANT_COLLECTION || 'documents';

    // Get files from Qdrant (gracefully handle missing collection or offline Qdrant)
    const qdrantFilesMap = new Map();
    try {
      let nextPageOffset = null;
      do {
        const scrollRes = await qdrant.scroll(collection, {
          limit: 100,
          offset: nextPageOffset,
          with_payload: true,
        });

        for (const point of scrollRes.points || []) {
          const filename = point.payload?.filename;
          if (filename) {
            if (!qdrantFilesMap.has(filename)) {
              qdrantFilesMap.set(filename, {
                filename,
                filepath: point.payload?.filepath || '',
                chunks: 0,
                firstSeen: point.payload?.created_at || null,
                topic: point.payload?.topic || null,
                subtopic: point.payload?.subtopic || null,
              });
            }
            qdrantFilesMap.get(filename).chunks++;
          }
        }

        nextPageOffset = scrollRes.next_page_offset;
      } while (nextPageOffset !== null);
    } catch (qErr) {
      // Common when collection doesn't exist yet or Qdrant is down
      console.warn('[admin] Qdrant unavailable or collection missing for /resources:', qErr?.message);
    }

    // Get files from data folder
    const dataFiles = [];
    try {
      const files = await fsPromises.readdir(DATA_DIR);
      for (const file of files) {
        const filePath = path.join(DATA_DIR, file);
        const stat = await fsPromises.stat(filePath);
        // Include Word documents in listing; embedding remains restricted elsewhere
        if (stat.isFile() && ['.pdf', '.txt', '.md', '.doc', '.docx'].includes(path.extname(file).toLowerCase())) {
          const isEmbedded = qdrantFilesMap.has(file);
          // Try read metadata sidecar
          let topic = null;
          let subtopic = null;
          const metaPath = path.join(META_DIR, `${file}.meta.json`);
          try {
            if (fs.existsSync(metaPath)) {
              const raw = await fsPromises.readFile(metaPath, 'utf8');
              const meta = JSON.parse(raw);
              topic = meta?.topic || null;
              subtopic = meta?.subtopic || null;
            }
          } catch (e) {
            // ignore malformed meta
          }

          dataFiles.push({
            filename: file,
            filepath: filePath,
            chunks: isEmbedded ? qdrantFilesMap.get(file).chunks : 0,
            isEmbedded,
            size: stat.size,
            modified: stat.mtime,
            topic: topic ?? (qdrantFilesMap.get(file)?.topic || null),
            subtopic: subtopic ?? (qdrantFilesMap.get(file)?.subtopic || null),
          });
        }
      }
    } catch (dirErr) {
      console.warn('[admin] Could not read data directory:', dirErr?.message);
    }

    // Combine: files from Qdrant that might not be in data folder anymore
    const allFiles = new Map();
    for (const file of dataFiles) {
      allFiles.set(file.filename, file);
    }
    for (const [filename, qdrantFile] of qdrantFilesMap) {
      if (!allFiles.has(filename)) {
        allFiles.set(filename, {
          ...qdrantFile,
          isEmbedded: true,
          size: 0,
          modified: null,
        });
      }
    }

    const files = Array.from(allFiles.values()).sort((a, b) => {
      return (b.modified || new Date(0)) - (a.modified || new Date(0));
    });

    await logAudit(id_user, 'LIST_RESOURCES', 'resource', null, {}, req.ip, req.get('user-agent'));

    return res.json({ files });
  } catch (err) {
    console.error('[admin] List resources error:', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// DELETE /api/admin/resources/:filename - Delete document from Qdrant
router.delete('/resources/:filename', async (req, res) => {
  try {
    const id_user = req.user?.id_user;
    const rawParam = String(req.params.filename || '');
    let filename = rawParam;
    try {
      filename = decodeURIComponent(rawParam);
    } catch {}

    let qdrant = null;
    const collection = process.env.QDRANT_COLLECTION || 'documents';
    try {
      qdrant = new QdrantClient({
        url: process.env.QDRANT_URL || 'http://127.0.0.1:6333',
        checkCompatibility: false,
      });
    } catch (qcErr) {
      console.warn('[admin] Qdrant client init failed:', qcErr?.message);
      qdrant = null;
    }

    // Delete all points with this filename (graceful if Qdrant unavailable/missing collection)
    let qdrantDeleted = false;
    try {
      if (!qdrant) throw new Error('Qdrant unavailable');
      await qdrant.delete(collection, {
        filter: {
          must: [
            {
              key: 'filename',
              match: { value: filename },
            },
          ],
        },
      });
      // Verify deletion by attempting to scroll for remaining points
      try {
        const verify = await qdrant.scroll(collection, {
          limit: 1,
          with_payload: true,
          filter: { must: [{ key: 'filename', match: { value: filename } }] },
        });
        qdrantDeleted = !verify.points || verify.points.length === 0;
      } catch (verErr) {
        // If verification fails, assume best-effort deletion
        qdrantDeleted = true;
      }
    } catch (delErr) {
      console.warn('[admin] Qdrant delete failed:', delErr?.message);
    }

    // Also try to delete the physical file
    const DATA_DIR = path.resolve(process.cwd(), '..', 'data');
    const filePath = path.join(DATA_DIR, filename);
    try {
      if (fs.existsSync(filePath)) {
        await fsPromises.unlink(filePath);
      }
    } catch (fileErr) {
      console.warn('[admin] Failed to delete physical file:', fileErr?.message);
    }

    // Delete associated meta file if exists
    try {
      const metaPath = path.join(META_DIR, `${filename}.meta.json`);
      if (fs.existsSync(metaPath)) {
        await fsPromises.unlink(metaPath);
      }
    } catch (metaErr) {
      console.warn('[admin] Failed to delete meta file:', metaErr?.message);
    }

    await logAudit(id_user, 'DELETE_RESOURCE', 'resource', filename, { filename, qdrantDeleted }, req.ip, req.get('user-agent'));

    return res.json({ success: true, qdrantDeleted });
  } catch (err) {
    console.error('[admin] Delete resource error:', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// POST /api/admin/resources - Upload PDF/document
router.post('/resources', upload.single('document'), async (req, res) => {
  try {
    const id_user = req.user?.id_user;

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Accept optional topic/subtopic metadata
    const topic = (req.body.topic || '').toString().trim() || null;
    const subtopic = (req.body.subtopic || '').toString().trim() || null;

    // File already saved by multer.diskStorage at the final path
    const finalFilename = file.filename || path.basename(file.originalname);
    const finalTargetPath = file.path || path.join(file.destination || DATA_DIR, finalFilename);

    // Reject duplicate uploads by original filename
    try {
      const requestedName = (req.body?.filename || file.originalname || finalFilename).toString();
      const originalName = path.basename(requestedName);
      const originalPath = path.join(DATA_DIR, originalName);
      if (fs.existsSync(originalPath) && originalName !== finalFilename) {
        // A file with the requested original name already exists.
        // Remove the newly saved (timestamp-suffixed) file and return 409.
        try {
          if (fs.existsSync(finalTargetPath)) {
            await fsPromises.unlink(finalTargetPath);
          }
        } catch (cleanupErr) {
          console.warn('[admin] Cleanup duplicate temp file failed:', cleanupErr?.message);
        }
        await logAudit(id_user, 'UPLOAD_RESOURCE_DUPLICATE', 'resource', originalName, { filename: originalName }, req.ip, req.get('user-agent'));
        return res.status(409).json({ error: 'Dokumen dengan nama tersebut sudah ada. Upload dibatalkan.' });
      }
    } catch (dupErr) {
      console.warn('[admin] Duplicate check error:', dupErr?.message);
    }

    console.log('[admin] Upload saved:', {
      destination: file.destination,
      filename: file.filename,
      computedPath: finalTargetPath,
      size: file.size,
      originalname: file.originalname,
      mimetype: file.mimetype,
    });

    // Write metadata sidecar if provided
    try {
      const metaPath = path.join(META_DIR, `${finalFilename}.meta.json`);
      const meta = { filename: finalFilename, topic, subtopic, updated_at: new Date().toISOString() };
      await fsPromises.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    } catch (metaErr) {
      console.warn('[admin] Failed to write metadata:', metaErr?.message);
    }

    await logAudit(id_user, 'UPLOAD_RESOURCE', 'resource', finalFilename, { filename: finalFilename }, req.ip, req.get('user-agent'));

    return res.json({ 
      success: true, 
      filename: finalFilename,
      topic,
      subtopic,
      saved_path: finalTargetPath,
      message: 'File uploaded successfully. Use the embed button to add it to Qdrant.' 
    });
  } catch (err) {
    console.error('[admin] Upload resource error:', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// POST /api/admin/resources/:filename/embed - Embed document to Qdrant
router.post('/resources/:filename/embed', async (req, res) => {
  try {
    const id_user = req.user?.id_user;

    const filename = decodeURIComponent(req.params.filename);
    const filePath = path.join(DATA_DIR, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Restrict embedding to PDF/TXT/MD/DOCX
    const ext = path.extname(filename).toLowerCase();
    const allowedForEmbed = new Set(['.pdf', '.txt', '.md', '.docx']);
    if (!allowedForEmbed.has(ext)) {
      return res.status(400).json({ error: 'Format file tidak didukung untuk embed. Gunakan PDF/TXT/MD/DOCX.' });
    }

    console.log(`[admin] Embedding ${filename} to Qdrant...`);

    // Option: run CLI ingest pipeline for the specific file
    const useIngest = String(req.query.ingest || process.env.EMBED_VIA_INGEST || 'false').toLowerCase() === 'true';
    if (useIngest) {
      const scriptPath = path.resolve(process.cwd(), 'data ingestion', 'ingest_embeddings.js');
      console.log('[admin] Running ingest script for single file:', filename);
      await new Promise((resolve, reject) => {
        const child = spawn('node', ['--no-deprecation', scriptPath, '--file', filename], {
          cwd: path.resolve(process.cwd()),
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('close', (code) => {
          if (code === 0) resolve(out);
          else reject(new Error(err || `ingest exit code ${code}`));
        });
        child.on('error', reject);
      });

      // Count chunks for this file after ingest
      try {
        const qdrant = new QdrantClient({ url: process.env.QDRANT_URL || 'http://127.0.0.1:6333', checkCompatibility: false });
        const collection = process.env.QDRANT_COLLECTION || 'documents';
        const scrollRes = await qdrant.scroll(collection, {
          limit: 100,
          with_payload: true,
          filter: { must: [{ key: 'filename', match: { value: filename } }] },
        });
        const chunks = (scrollRes.points || []).length;
        await logAudit(id_user, 'EMBED_RESOURCE', 'resource', filename, { filename, chunks, via: 'ingest_script' }, req.ip, req.get('user-agent'));
        return res.json({ success: true, filename, chunks, message: `Successfully embedded via ingest for ${filename}` });
      } catch (postErr) {
        await logAudit(id_user, 'EMBED_RESOURCE', 'resource', filename, { filename, via: 'ingest_script' }, req.ip, req.get('user-agent'));
        return res.json({ success: true, filename, chunks: null, message: `Ingest completed for ${filename}` });
      }
    }

    // Extract text
    const extracted = await extractTextFromFile(filePath, filename);
    if (!extracted.pages || extracted.pages.length === 0 || !extracted.pages.some(p => p.trim())) {
      return res.status(400).json({ error: 'No text could be extracted from the document' });
    }

    // Chunk the text (PDF/TXT/MD); for DOCX, skip chunking and embed as single vector
    const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '1000', 10);
    const CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP || '200', 10);
    const EMBED_TEXT_MAX = parseInt(process.env.EMBED_TEXT_MAX || '3500', 10);
    const PAYLOAD_TEXT_MAX = parseInt(process.env.PAYLOAD_TEXT_MAX || '4200', 10);

    const qdrant = new QdrantClient({
      url: process.env.QDRANT_URL || 'http://127.0.0.1:6333',
      checkCompatibility: false,
    });
    const collection = process.env.QDRANT_COLLECTION || 'documents';

    // Delete existing chunks for this file first
    try {
      await qdrant.delete(collection, {
        filter: {
          must: [{
            key: 'filename',
            match: { value: filename },
          }],
        },
      });
      console.log(`[admin] Deleted existing chunks for ${filename}`);
    } catch (delErr) {
      console.warn('[admin] Could not delete existing chunks:', delErr?.message);
    }

    // Load metadata sidecar if available (allow override via body)
    let topic = null;
    let subtopic = null;
    try {
      const metaPath = path.join(META_DIR, `${filename}.meta.json`);
      if (fs.existsSync(metaPath)) {
        const raw = await fsPromises.readFile(metaPath, 'utf8');
        const meta = JSON.parse(raw);
        topic = meta?.topic || null;
        subtopic = meta?.subtopic || null;
      }
    } catch {}
    if (req.body?.topic) topic = String(req.body.topic).trim() || topic;
    if (req.body?.subtopic) subtopic = String(req.body.subtopic).trim() || subtopic;

    // Process and embed
    const points = [];
    let vectorSize = null;

    if (extracted.type === 'docx') {
      // For Word documents, treat as a single vector (no chunking)
      const fullText = sanitizeForEmbed(extracted.pages.join('\n'));
      if (!fullText || isLowSignal(fullText)) {
        return res.status(400).json({ error: 'Dokumen Word tidak memiliki konten teks yang memadai untuk di-embed' });
      }

      const payloadText = fullText.slice(0, PAYLOAD_TEXT_MAX);
      const embedText = fullText.slice(0, EMBED_TEXT_MAX);

      const embedding = await getEmbedding(embedText);
      if (Array.isArray(embedding)) vectorSize = embedding.length;

      const payload = {
        filename,
        filepath: filePath,
        source: 'admin_upload',
        page: 1,
        chunk_index: 1,
        char_count: fullText.length,
        text: payloadText,
        snippet: fullText.slice(0, 450),
        topic: topic || null,
        subtopic: subtopic || null,
      };

      points.push({ id: randomUUID(), vector: embedding, payload });
    } else {
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
          if (vectorSize == null && Array.isArray(embedding)) {
            vectorSize = embedding.length;
          }
          
          const payload = {
            filename,
            filepath: filePath,
            source: 'admin_upload',
            page: p + 1,
            chunk_index: ci + 1,
            char_count: cleaned.length,
            text: payloadText,
            snippet: cleaned.slice(0, 450),
            topic: topic || null,
            subtopic: subtopic || null,
          };
          
          points.push({ id: randomUUID(), vector: embedding, payload });
        }
      }
    }

    // Ensure collection exists before upsert
    try {
      if (vectorSize != null) {
        try {
          await qdrant.getCollection(collection);
        } catch (infoErr) {
          console.warn('[admin] Qdrant collection missing, creating:', collection, 'size=', vectorSize);
          try {
            await qdrant.createCollection(collection, {
              vectors: { size: vectorSize, distance: 'Cosine' },
            });
          } catch (createErr) {
            console.warn('[admin] Failed to create collection:', createErr?.message);
          }
        }
      }
    } catch (ensureErr) {
      console.warn('[admin] Collection ensure error:', ensureErr?.message);
    }

    // Batch upsert to Qdrant
    const BATCH_SIZE = 10;
    let totalUpserted = 0;
    for (let i = 0; i < points.length; i += BATCH_SIZE) {
      const batch = points.slice(i, i + BATCH_SIZE);
      await qdrant.upsert(collection, { wait: true, points: batch });
      totalUpserted += batch.length;
    }

    await logAudit(id_user, 'EMBED_RESOURCE', 'resource', filename, { filename, chunks: totalUpserted }, req.ip, req.get('user-agent'));

    return res.json({ 
      success: true, 
      filename,
      chunks: totalUpserted,
      message: extracted.type === 'docx' 
        ? 'Successfully embedded Word document as a single vector to Qdrant' 
        : `Successfully embedded ${totalUpserted} chunks to Qdrant` 
    });
  } catch (err) {
    console.error('[admin] Embed resource error:', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

export default router;

