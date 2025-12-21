// server/routes/sentiment.js
import express from 'express';
import nlp from '../utils/nlp.js';

const router = express.Router();

// GET /api/sentiment/health
router.get('/health', (req, res) => {
  try {
    const usePy = (process.env.NLP_USE_PYTHON || 'false').toLowerCase() === 'true';
    const useAI = (process.env.NLP_USE_OPENAI || 'false').toLowerCase() === 'true';
    const debug = (process.env.NLP_DEBUG || 'false').toLowerCase() === 'true';
    const pyBin = process.env.PYTHON_BIN || null;
    return res.json({
      python: { enabled: usePy, bin: pyBin },
      openai: { enabled: useAI },
      debug,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /api/sentiment/analyze { text }
router.post('/analyze', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });

    const result = await nlp.analyzeMessage(text);
    if ((process.env.NLP_DEBUG || 'false').toLowerCase() === 'true') {
      console.log('[sentiment] analyze:', { text: text.slice(0, 80), result });
    }
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