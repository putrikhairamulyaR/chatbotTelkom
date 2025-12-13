// server/routes/statistics.js
import express from 'express';
import { pool } from '../db.js';

const router = express.Router();

// Helper function untuk mengekstrak topik dari pesan user
function extractTopic(message) {
  if (!message || typeof message !== 'string') return null;
  
  let text = message.toLowerCase().trim();
  
  // Hapus tanda tanya dan karakter khusus di awal/akhir
  text = text.replace(/^[?.,!;:\s]+|[?.,!;:\s]+$/g, '');
  
  // Hapus kata tanya umum di awal
  text = text.replace(/^(apa|apakah|apa itu|itu apa|tu apa|bagaimana|gimana|kenapa|mengapa|kapan|dimana|di mana|berapa|siapa|tolong|jelaskan|jelas|bisa|boleh)\s+/i, '');
  
  // Hapus kata penghubung di awal
  text = text.replace(/^(tentang|mengenai|soal|perihal|dari|untuk|dengan|oleh)\s+/i, '');
  
  // Hapus kata sapaan
  text = text.replace(/^(halo|hai|hi|hello|assalamualaikum|selamat)\s+/i, '');
  
  // Hapus kata terima kasih
  text = text.replace(/\s+(terima kasih|makasih|thanks|thank you)$/i, '');
  
  // Normalisasi variasi kata
  text = text.replace(/\bkerja praktek\b/g, 'kerja praktik');
  text = text.replace(/\bkp\b/g, 'kerja praktik');
  text = text.replace(/\bpersyaratan\b/g, 'syarat');
  text = text.replace(/\bpengertian\b/g, 'definisi');
  text = text.replace(/\barti\b/g, 'definisi');
  text = text.replace(/\bmaksud\b/g, 'definisi');
  
  // Cari pola topik umum
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
    /(syarat\s+kerja\s+praktik)/i,
    /(kerja\s+praktik)/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  
  // Jika ada kata "kerja praktik" atau "kp", ambil konteks sekitarnya
  if (text.includes('kerja praktik') || text.includes('kp')) {
    const words = text.split(/\s+/);
    const kpIndex = words.findIndex(w => w === 'kerja' || w === 'praktik' || w === 'kp');
    
    if (kpIndex !== -1) {
      // Ambil 1-2 kata sebelum dan sesudah
      const start = Math.max(0, kpIndex - 2);
      const end = Math.min(words.length, kpIndex + 3);
      const topic = words.slice(start, end).join(' ');
      
      // Bersihkan kata umum
      const cleaned = topic.replace(/\b(apa|itu|yang|di|ke|dari|pada|untuk|dengan|oleh|ini|itu|saya|aku|kamu|dia|kita|mereka|tolong|bisa|boleh|mau|ingin)\b/gi, '').trim();
      
      if (cleaned.length > 5) {
        return cleaned.split(/\s+/).filter(w => w.length > 2).slice(0, 5).join(' ');
      }
    }
  }
  
  // Ambil kata-kata penting (minimal 3 karakter, bukan kata umum)
  const stopWords = new Set(['yang', 'di', 'ke', 'dari', 'pada', 'untuk', 'dengan', 'oleh', 'ini', 'itu', 'saya', 'aku', 'kamu', 'dia', 'kita', 'mereka']);
  const words = text.split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w));
  
  if (words.length >= 2) {
    return words.slice(0, 4).join(' ');
  }
  
  return null;
}

// Helper function untuk normalisasi topik (mengelompokkan topik yang mirip)
function normalizeTopic(topic) {
  if (!topic) return null;
  
  let t = topic.toLowerCase().trim();
  
  // Normalisasi variasi penulisan
  t = t.replace(/\bkerja praktek\b/g, 'kerja praktik');
  t = t.replace(/\bkp\b/g, 'kerja praktik');
  t = t.replace(/\bpersyaratan\b/g, 'syarat');
  t = t.replace(/\bpengertian\b/g, 'definisi');
  t = t.replace(/\barti\b/g, 'definisi');
  t = t.replace(/\bmaksud\b/g, 'definisi');
  
  // Mapping topik yang mirip
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
  
  // Cek apakah ada normalisasi langsung
  if (normalizations[t]) {
    return normalizations[t];
  }
  
  // Cek apakah mengandung kata kunci yang bisa dinormalisasi
  for (const [key, value] of Object.entries(normalizations)) {
    // Jika topik mengandung kata kunci utama
    const keyWords = key.split(/\s+/);
    const topicWords = t.split(/\s+/);
    
    // Cek apakah semua kata kunci ada di topik
    const hasAllKeywords = keyWords.every(kw => topicWords.some(tw => tw.includes(kw) || kw.includes(tw)));
    
    if (hasAllKeywords && topicWords.length <= keyWords.length + 2) {
      return value;
    }
  }
  
  // Jika mengandung "kerja praktik" tapi belum dinormalisasi, coba normalisasi manual
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

// GET /api/statistics - Get usage statistics
router.get('/', async (req, res) => {
  try {
    // 1. Total users
    const [userCount] = await pool.query('SELECT COUNT(*) as count FROM `user`');
    const totalUsers = userCount[0]?.count || 0;

    // 2. Total messages (user + bot)
    const [msgCount] = await pool.query('SELECT COUNT(*) as count FROM conversation_memory');
    const totalMessages = msgCount[0]?.count || 0;

    // 3. Total user messages
    const [userMsgCount] = await pool.query(
      "SELECT COUNT(*) as count FROM conversation_memory WHERE sender = 'user'"
    );
    const totalUserMessages = userMsgCount[0]?.count || 0;

    // 4. Total bot messages
    const [botMsgCount] = await pool.query(
      "SELECT COUNT(*) as count FROM conversation_memory WHERE sender = 'bot'"
    );
    const totalBotMessages = botMsgCount[0]?.count || 0;

    // 5. Unique active users (users who sent at least one message)
    const [activeUsers] = await pool.query(
      "SELECT COUNT(DISTINCT id_user) as count FROM conversation_memory WHERE sender = 'user' AND id_user IS NOT NULL"
    );
    const uniqueActiveUsers = activeUsers[0]?.count || 0;

    // 6. Top topics (topik paling banyak ditanyakan dari konten pesan)
    const [userMessages] = await pool.query(
      `SELECT message 
       FROM conversation_memory 
       WHERE sender = 'user' 
         AND message IS NOT NULL 
         AND message != ''
         AND LENGTH(message) > 5
       ORDER BY created_at DESC`
    );
    
    // Ekstrak dan kelompokkan topik
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
    
    // Convert ke array dan sort
    const topTopics = Object.entries(topicCounts)
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // 7. Usage by hour (penggunaan per jam)
    const [hourlyUsage] = await pool.query(
      `SELECT 
         HOUR(created_at) as hour,
         COUNT(*) as count
       FROM conversation_memory
       WHERE sender = 'user'
       GROUP BY HOUR(created_at)
       ORDER BY hour`
    );

    // 8. Usage by day (last 7 days)
    const [dailyUsage] = await pool.query(
      `SELECT 
         DATE(created_at) as date,
         COUNT(*) as count
       FROM conversation_memory
       WHERE sender = 'user'
         AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       GROUP BY DATE(created_at)
       ORDER BY date`
    );

    // 9. Sentiment distribution
    const [sentimentDist] = await pool.query(
      `SELECT 
         sentiment_label,
         COUNT(*) as count
       FROM conversation_memory
       WHERE sender = 'user' AND sentiment_label IS NOT NULL
       GROUP BY sentiment_label`
    );

    // 10. Most active users
    const [mostActiveUsers] = await pool.query(
      `SELECT 
         u.username,
         u.email,
         COUNT(*) as message_count
       FROM conversation_memory cm
       JOIN \`user\` u ON cm.id_user = u.id_user
       WHERE cm.sender = 'user'
       GROUP BY u.id_user, u.username, u.email
       ORDER BY message_count DESC
       LIMIT 10`
    );

    return res.json({
      summary: {
        totalUsers,
        totalMessages,
        totalUserMessages,
        totalBotMessages,
        uniqueActiveUsers,
      },
      topTopics: topTopics.map(item => ({
        topic: item.topic,
        count: item.count,
      })),
      hourlyUsage: hourlyUsage.map(item => ({
        hour: item.hour,
        count: item.count,
      })),
      dailyUsage: dailyUsage.map(item => ({
        date: item.date,
        count: item.count,
      })),
      sentimentDistribution: sentimentDist.map(item => ({
        label: item.sentiment_label,
        count: item.count,
      })),
      mostActiveUsers: mostActiveUsers.map(item => ({
        username: item.username,
        email: item.email,
        messageCount: item.message_count,
      })),
    });
  } catch (err) {
    console.error('[statistics] error:', err?.stack || err);
    return res.status(500).json({ error: String(err) });
  }
});

export default router;

