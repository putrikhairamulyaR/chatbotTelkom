// Simple smoke test for fast RAG path and cache
// Usage: node server/tools/fast_rag_check.js

import fetch from 'node-fetch';

const URL = process.env.URL || 'http://localhost:3000/api/rag';
const payload = { prompt: 'Apa syarat KP?', fast: true, id_user: 9999, topic: 'kp' };

async function run() {
  console.log('Hitting', URL, 'payload', payload);
  const t1 = Date.now();
  const r1 = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body1 = await r1.json();
  const dt1 = Date.now() - t1;
  console.log('First response in', dt1, 'ms, status', r1.status);

  // second call — should be cached
  const t2 = Date.now();
  const r2 = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body2 = await r2.json();
  const dt2 = Date.now() - t2;
  console.log('Second response in', dt2, 'ms, status', r2.status);

  console.log('\nFirst answer snippet:', (body1.answer || '').slice(0, 300));
  console.log('\nSecond answer snippet:', (body2.answer || '').slice(0, 300));
}

run().catch((e) => { console.error(e); process.exit(1); });
