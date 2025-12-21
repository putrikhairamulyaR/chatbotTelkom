// server/routes/sentiment.js
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import nlp from "../utils/nlp.js";

const router = express.Router();

function boolEnv(name, fallback = false) {
  const v = (process.env[name] ?? String(fallback)).toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function getPythonScriptPath() {
  // sentiment.js ada di server/routes -> baseDir = server
  const __filename = fileURLToPath(import.meta.url);
  const here = path.dirname(__filename);
  const baseDir = path.resolve(here, "..");
  return path.resolve(baseDir, "tools", "sentiment_pipeline.py");
}

// GET /api/sentiment/health
router.get("/health", (req, res) => {
  try {
    const usePy = boolEnv("NLP_USE_PYTHON", false);
    const useAI = boolEnv("NLP_USE_OPENAI", false);
    const debug = boolEnv("NLP_DEBUG", false);

    const pyBin = process.env.PYTHON_BIN || null;
    const scriptPath = getPythonScriptPath();
    const scriptExists = fs.existsSync(scriptPath);

    return res.json({
      ok: true,
      python: {
        enabled: usePy,
        bin: pyBin,
        script: scriptPath,
        scriptExists,
      },
      openai: {
        enabled: useAI,
        apiKeyConfigured: !!process.env.OPENAI_API_KEY,
      },
      debug,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// POST /api/sentiment/analyze
router.post("/analyze", async (req, res) => {
  try {
    const text = String(req.body?.text ?? "").trim();

    if (!text) return res.status(400).json({ error: "Field 'text' is required." });
    if (text.length > 5000) return res.status(413).json({ error: "Text too long (max 5000 chars)." });

    const result = await nlp.analyzeMessage(text);

    if (boolEnv("NLP_DEBUG", false)) {
      console.log("[sentiment] analyze:", {
        text: text.slice(0, 120),
        sentiment: result?.sentiment,
        intent: result?.intent,
      });
    }

    return res.json({
      intent: result?.intent ?? "unknown",
      sentiment: result?.sentiment ?? { score: 0, label: "neutral" },
      meta: result?.meta ?? null,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

export default router;
