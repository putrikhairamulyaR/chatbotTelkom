# Fast RAG mode (low-latency) ⚡️

This service includes a *fast*, low-latency RAG path that:
- Attempts to synthesize a short answer directly from retrieved document passages (no LLM call)
- Uses an in-memory short-term cache to avoid recomputation for repeated queries

Configuration (env vars):

- FAST_CACHE_ENABLED (default: true) — enable short-term in-memory cache for RAG responses.
- FAST_CACHE_MAX (default: 300) — maximum cached entries.
- FAST_CACHE_TTL_MS (default: 900000) — TTL for cached entries in milliseconds (15 minutes).
- FAST_SYNTHESIS (default: true) — enable LLM-free synthesis path for short answers when confidence is high.
- FAST_SYNTH_MIN_SCORE (default: 0.6) — minimum reranked score to attempt synthesis.

Notes
- The cache is process-local (JS Map). For multi-replica production deployments, use an external store (Redis) to share cache across instances.
- Fast synthesis is conservative: the system tries a synthesis only when the top search hit is confident and the retrieved passages have sufficient sentence coverage. If synthesis fails or the user explicitly asks for "detail", the normal LLM generation path is used.

Testing
- Start server and use `fast: true` in RAG requests to exercise fast-mode locally.

Example curl (fast mode):

```
curl -X POST http://localhost:3000/api/rag \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Apa syarat KP?","fast":true,"id_user":1,"topic":"kp"}'
```
