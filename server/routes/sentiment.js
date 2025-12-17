// server/routes/sentiment.js
import express from 'express';
import nlp from '../utils/nlp.js';

const router = express.Router();

// POST /api/sentiment/analyze { text }
router.post('/analyze', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });

    const result = await nlp.analyzeMessage(text);
    return res.json({
      intent: result.intent,
      sentiment: result.sentiment,
      meta: result.meta || null,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

export default router;
