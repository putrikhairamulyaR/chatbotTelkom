import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { OpenAI } from 'openai';
import { QdrantClient } from '@qdrant/js-client-rest';
import { randomUUID } from 'crypto';

dotenv.config();

// Debug: print effective config so we can see whether USE_OLLAMA is enabled
console.log('INGEST START - env preview:');
console.log('  USE_OLLAMA=', process.env.USE_OLLAMA);
console.log('  OPENAI_API_KEY present=', !!process.env.OPENAI_API_KEY);
console.log('  OLLAMA_URL=', process.env.OLLAMA_URL);
console.log('  QDRANT_URL=', process.env.QDRANT_URL);

const DATA_DIR = path.resolve(process.cwd(), '..', 'data');
const COLLECTION = process.env.QDRANT_COLLECTION || 'documents';
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '1000', 10);
const CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP || '200', 10);

const USE_OLLAMA = (process.env.USE_OLLAMA || 'false').toLowerCase() === 'true';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'all-mpnet-base-v2';
const qdrant = new QdrantClient({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY, checkCompatibility: false });
const openai = USE_OLLAMA ? null : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function chunkWithOverlap(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
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

async function extractPdfPages(filePath) {
	try {
		const data = await fsPromises.readFile(filePath);
		let pdfParse = null;
		try {
			// dynamic import so any module-top execution is caught here
			const mod = await import('pdf-parse');
			pdfParse = mod && (mod.default || mod);
		} catch (impErr) {
			console.warn('Warning: pdf-parse import failed, will attempt fallback pdfminer for', filePath, impErr && impErr.message);
			pdfParse = null;
		}

		if (pdfParse) {
			const res = await pdfParse(data);
			const numPages = res.numpages || 0;
			const byFormFeed = res.text.split('\f').map(s => s.trim()).filter(Boolean);
			if (byFormFeed.length >= Math.max(1, numPages)) {
				return byFormFeed;
			}
			if (numPages > 0) {
				const approx = [];
				const perLen = Math.ceil(res.text.length / numPages);
				for (let i = 0; i < numPages; i++) {
					const start = i * perLen;
					approx.push(res.text.slice(start, Math.min(start + perLen, res.text.length)).trim());
				}
				return approx.filter(Boolean);
			}
			return [res.text.trim()];
		}

		// fallback to pdfminer if pdf-parse isn't usable
		try {
			const { extract_text: pdfminer_extract_text } = await import('pdfminer.high_level');
			const text = (await pdfminer_extract_text(filePath)) || '';
			// naive split into pages by form feed
			const pages = text.split('\f').map(s => s.trim()).filter(Boolean);
			if (pages.length) return pages;
			return [text.trim()];
		} catch (pmErr) {
			console.error('Failed to extract PDF with both pdf-parse and pdfminer for', filePath, pmErr && pmErr.message);
			return [''];
		}
	} catch (err) {
		console.error('Error reading PDF', filePath, err && err.message);
		return [''];
	}
}

async function extractTextFile(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === '.pdf') {
		return { type: 'pdf', pages: await extractPdfPages(filePath) };
	}
	if (ext === '.docx') {
		try {
			const mammoth = await import('mammoth');
			const { value } = await mammoth.extractRawText({ path: filePath });
			return { type: 'docx', pages: [value.trim()] };
		} catch (e) {
			console.error('Failed to extract text from DOCX', filePath, e.message);
			return { type: 'docx', pages: [''] };
		}
	}
	const text = await fsPromises.readFile(filePath, 'utf8');
	return { type: 'text', pages: [text] };
}

async function *walk(dir) {
	const entries = await fsPromises.readdir(dir, { withFileTypes: true });
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			yield* walk(full);
		} else {
			yield full;
		}
	}
}

async function ensureCollectionWithSize(vectorSize) {
	try {
		const info = await qdrant.getCollection(COLLECTION);
		const currentSize = info && info.config && info.config.params && info.config.params.vectors && info.config.params.vectors.size;
		if (currentSize && currentSize !== vectorSize) {
			console.log(`Recreating collection ${COLLECTION} with vector size ${vectorSize} (was ${currentSize})`);
			await qdrant.recreateCollection(COLLECTION, { vectors: { size: vectorSize, distance: 'Cosine' } });
		}
	} catch (e) {
		console.log('Creating collection', COLLECTION, 'with vector size', vectorSize);
		await qdrant.createCollection(COLLECTION, { vectors: { size: vectorSize, distance: 'Cosine' } });
	}
}

async function run() {
	// If not using Ollama, OpenAI API key is required. Qdrant URL is always required.
	if (!USE_OLLAMA && !process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
	if (!process.env.QDRANT_URL) throw new Error('QDRANT_URL missing');

	const points = [];
	for await (const file of walk(DATA_DIR)) {
		// Defensive: skip files that don't exist (prevent ENOENT crashes)
		if (!fs.existsSync(file)) {
			console.warn('Skipping missing file:', file);
			continue;
		}
		const ext = path.extname(file).toLowerCase();
		// only process common text-like files and pdfs
		if (!['.pdf', '.txt', '.md', '.json', '.csv','.docx'].includes(ext)) {
			console.log('Skipping unsupported file', file);
			continue;
		}

		console.log('Processing', file);
		try {
			const extracted = await extractTextFile(file);
			for (let p = 0; p < extracted.pages.length; p++) {
				const pageText = extracted.pages[p] || '';
				const chunks = chunkWithOverlap(pageText, CHUNK_SIZE, CHUNK_OVERLAP);
				for (let ci = 0; ci < chunks.length; ci++) {
					const chunk = chunks[ci].trim();
					if (!chunk) continue;
					/*const id = `${path.basename(file)}::p${p + 1}::c${ci + 1}`;*/
					const id = randomUUID();
					const payload = {
						filename: path.basename(file),
						filepath: path.relative(process.cwd(), file),
						source: 'local',
						page: p + 1,
						chunk_index: ci + 1,
						snippet: chunk.slice(0, 200)
					};
					points.push({ id, payload, vector: null, text: chunk });
				}
			}
		} catch (err) {
			console.error('Failed to process', file, err.message || err);
		}
	}

	console.log(`Prepared ${points.length} chunks for embedding`);

	const batchSize = parseInt(process.env.BATCH_SIZE || '30', 10);
	let ensured = false;
	let inferredVectorSize = null;
	for (let i = 0; i < points.length; i += batchSize) {
		const batch = points.slice(i, i + batchSize);
		const texts = batch.map(p => p.text);
		console.log(`Embedding batch ${i}-${Math.min(i + batchSize, points.length)}...`);
		let embeddings = null;
		if (USE_OLLAMA) {
			// Call local Ollama HTTP embed endpoint with a resilient fetch helper that
			// retries using 127.0.0.1 if localhost resolves to ::1 and connection is refused.
			async function fetchOllamaEmbed(urlBase, payload) {
				const tryUrl = u => `${u.replace(/\/$/, '')}/embed`;
				const doFetch = async (u) => {
					const resp = await fetch(tryUrl(u), {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(payload),
					});
					if (!resp.ok) {
						const txt = await resp.text();
						throw new Error(`Ollama embed error: ${resp.status} ${txt}`);
					}
					return resp.json();
				};

				try {
					return await doFetch(urlBase);
				} catch (err) {
					// If connection refused to ::1, try IPv4 127.0.0.1 fallback
					const cause = err && err.cause;
					if (cause && cause.code === 'ECONNREFUSED' && String(cause.address).includes('::1')) {
						const ipv4 = urlBase.replace('localhost', '127.0.0.1');
						console.log('Ollama connection refused on ::1, retrying with', ipv4);
						return await doFetch(ipv4);
					}
					throw err;
				}
			}

			const respBody = await fetchOllamaEmbed(OLLAMA_URL, { model: OLLAMA_MODEL, input: texts });
			embeddings = respBody.embeddings || respBody.data || null;
		} else {
			const res = await openai.embeddings.create({ model: EMBED_MODEL, input: texts });
			if (!res.data || !res.data.length) {
				throw new Error('Empty embeddings response');
			}
			embeddings = res.data.map(d => d.embedding);
		}
		if (!embeddings) throw new Error('No embeddings returned');

		// Ensure collection with correct vector size before first upsert
		if (!ensured) {
			inferredVectorSize = (embeddings && embeddings[0]) ? embeddings[0].length : null;
			if (!inferredVectorSize) throw new Error('Cannot infer embedding vector size');
			await ensureCollectionWithSize(inferredVectorSize);
			ensured = true;
		}

		for (let j = 0; j < embeddings.length; j++) {
			batch[j].vector = embeddings[j];
		}

		const upsertPoints = batch.map(p => ({ id: p.id, vector: p.vector, payload: p.payload }));
		await qdrant.upsert(COLLECTION, { points: upsertPoints, wait: true });
		console.log(`Upserted ${upsertPoints.length} points to Qdrant`);
		// small delay between batches to be nice to APIs (optional)
		await new Promise(r => setTimeout(r, 200));
	}

	console.log('Ingestion complete');
}

run().catch(err => {
	console.error(err);
	process.exit(1);
});
