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
if (process.env.USE_OLLAMA && process.env.USE_OLLAMA.toLowerCase() === 'true') {
	console.log('  OLLAMA_EMBED_MODEL=', process.env.EMBED_MODEL || process.env.OLLAMA_MODEL || 'nomic-embed-text');
}

const DATA_DIR = path.resolve(process.cwd(), '..', 'data');
const COLLECTION = process.env.QDRANT_COLLECTION || 'documents';
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '1000', 10);
const CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP || '200', 10);

const USE_OLLAMA = (process.env.USE_OLLAMA || 'false').toLowerCase() === 'true';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
// For embedding, prioritize EMBED_MODEL, fallback to OLLAMA_MODEL if EMBED_MODEL not set
const OLLAMA_EMBED_MODEL = process.env.EMBED_MODEL || process.env.OLLAMA_MODEL || 'nomic-embed-text';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'all-mpnet-base-v2'; // Keep for reference
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
			const extractedText = res.text || '';
			
			// Check if PDF has very little text (likely scanned/image-based PDF)
			const textLength = extractedText.trim().length;
			const minTextPerPage = 50; // Minimum expected text per page
			const isLikelyScanned = textLength < (numPages * minTextPerPage);
			
			if (isLikelyScanned && textLength < 100) {
				console.log(`  PDF appears to be scanned/image-based (only ${textLength} chars extracted), attempting OCR...`);
				// Try OCR as fallback
				const ocrText = await extractPdfWithOCR(filePath);
				if (ocrText && ocrText.trim().length > textLength) {
					console.log(`  OCR extracted ${ocrText.trim().length} characters`);
					// Split OCR text by pages if we know page count
					if (numPages > 0) {
						const perPage = Math.ceil(ocrText.length / numPages);
						const pages = [];
						for (let i = 0; i < numPages; i++) {
							const start = i * perPage;
							pages.push(ocrText.slice(start, Math.min(start + perPage, ocrText.length)).trim());
						}
						return pages.filter(Boolean);
					}
					return [ocrText.trim()];
				}
			}
			
			const byFormFeed = extractedText.split('\f').map(s => s.trim()).filter(Boolean);
			if (byFormFeed.length >= Math.max(1, numPages)) {
				return byFormFeed;
			}
			if (numPages > 0) {
				const approx = [];
				const perLen = Math.ceil(extractedText.length / numPages);
				for (let i = 0; i < numPages; i++) {
					const start = i * perLen;
					approx.push(extractedText.slice(start, Math.min(start + perLen, extractedText.length)).trim());
				}
				return approx.filter(Boolean);
			}
			return [extractedText.trim()];
		}

		// fallback to pdfminer if pdf-parse isn't usable
		try {
			const { extract_text: pdfminer_extract_text } = await import('pdfminer.high_level');
			const text = (await pdfminer_extract_text(filePath)) || '';
			// naive split into pages by form feed
			const pages = text.split('\f').map(s => s.trim()).filter(Boolean);
			if (pages.length) return pages;
			// If still no text, try OCR
			if (text.trim().length < 100) {
				console.log(`  PDF has minimal text, attempting OCR...`);
				const ocrText = await extractPdfWithOCR(filePath);
				if (ocrText && ocrText.trim().length > text.trim().length) {
					return [ocrText.trim()];
				}
			}
			return [text.trim()];
		} catch (pmErr) {
			console.error('Failed to extract PDF with both pdf-parse and pdfminer for', filePath, pmErr && pmErr.message);
			// Last resort: try OCR
			console.log('  Attempting OCR as last resort...');
			const ocrText = await extractPdfWithOCR(filePath);
			if (ocrText && ocrText.trim().length > 0) {
				return [ocrText.trim()];
			}
			return [''];
		}
	} catch (err) {
		console.error('Error reading PDF', filePath, err && err.message);
		// Try OCR as fallback
		try {
			const ocrText = await extractPdfWithOCR(filePath);
			if (ocrText && ocrText.trim().length > 0) {
				return [ocrText.trim()];
			}
		} catch (ocrErr) {
			console.error('OCR also failed:', ocrErr && ocrErr.message);
		}
		return [''];
	}
}

// OCR extraction using OCR.space API (free tier available) or Tesseract.js
async function extractPdfWithOCR(filePath) {
	// Method 1: Try OCR.space API (free, no installation needed)
	const OCR_SPACE_API_KEY = process.env.OCR_SPACE_API_KEY || 'helloworld'; // Free tier key
	const OCR_SPACE_URL = 'https://api.ocr.space/parse/image';
	
	try {
		const fileData = await fsPromises.readFile(filePath);
		const base64Data = fileData.toString('base64');
		
		const formData = new URLSearchParams();
		formData.append('apikey', OCR_SPACE_API_KEY);
		formData.append('base64Image', `data:application/pdf;base64,${base64Data}`);
		formData.append('filetype', 'pdf');
		formData.append('OCREngine', '2'); // OCR Engine 2 is more accurate
		formData.append('isOverlayRequired', 'false');
		formData.append('detectOrientation', 'true');
		
		const response = await fetch(OCR_SPACE_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: formData.toString(),
		});
		
		if (response.ok) {
			const result = await response.json();
			if (result.ParsedResults && result.ParsedResults.length > 0) {
				// Combine all parsed text from all pages
				const allText = result.ParsedResults.map(r => r.ParsedText || '').join('\n\n');
				return allText;
			}
		}
	} catch (apiErr) {
		console.warn('  OCR.space API failed, trying Tesseract.js...', apiErr.message);
	}
	
	// Method 2: Try Tesseract.js (requires installation: npm install tesseract.js pdf-poppler or pdf2pic)
	try {
		// Check if tesseract.js is available
		const tesseract = await import('tesseract.js').catch(() => null);
		if (!tesseract) {
			throw new Error('Tesseract.js not installed. Install with: npm install tesseract.js');
		}
		
		// For PDF, we need to convert to images first
		// Try pdf2pic or use a simpler approach with pdf-parse + canvas
		console.warn('  Tesseract.js OCR requires PDF-to-image conversion. Consider using OCR.space API or install pdf2pic.');
		return null;
	} catch (tessErr) {
		console.warn('  Tesseract.js not available:', tessErr.message);
	}
	
	return null;
}

async function extractTextFile(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === '.pdf') {
		return { type: 'pdf', pages: await extractPdfPages(filePath) };
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

async function checkQdrantConnection() {
	try {
		// Try to get collections list to verify connection
		await qdrant.getCollections();
		return true;
	} catch (e) {
		const errMsg = e.message || String(e);
		if (errMsg.includes('ECONNREFUSED') || errMsg.includes('connect')) {
			throw new Error(
				`Cannot connect to Qdrant at ${process.env.QDRANT_URL || 'http://127.0.0.1:6333'}\n` +
				`  Possible causes:\n` +
				`  - Qdrant service not running\n` +
				`  - Wrong QDRANT_URL in .env file\n` +
				`  - Firewall blocking connection\n\n` +
				`  To start Qdrant:\n` +
				`  - Docker: docker run -p 6333:6333 qdrant/qdrant\n` +
				`  - Or install and run Qdrant locally`
			);
		}
		throw e;
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
		if (e.message && (e.message.includes('ECONNREFUSED') || e.message.includes('connect'))) {
			throw new Error(`Qdrant connection lost. Please ensure Qdrant is running at ${process.env.QDRANT_URL || 'http://127.0.0.1:6333'}`);
		}
		console.log('Creating collection', COLLECTION, 'with vector size', vectorSize);
		await qdrant.createCollection(COLLECTION, { vectors: { size: vectorSize, distance: 'Cosine' } });
	}
}

async function run() {
	// If not using Ollama, OpenAI API key is required. Qdrant URL is always required.
	if (!USE_OLLAMA && !process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
	if (!process.env.QDRANT_URL) throw new Error('QDRANT_URL missing');

	// Check Qdrant connection early to fail fast
	console.log('Checking Qdrant connection...');
	try {
		await checkQdrantConnection();
		console.log('✓ Qdrant connection OK');
	} catch (e) {
		console.error('✗ Qdrant connection failed:', e.message);
		throw e;
	}

	const points = [];
	for await (const file of walk(DATA_DIR)) {
		// Defensive: skip files that don't exist (prevent ENOENT crashes)
		if (!fs.existsSync(file)) {
			console.warn('Skipping missing file:', file);
			continue;
		}
		const ext = path.extname(file).toLowerCase();
		// only process common text-like files and pdfs
		if (!['.pdf', '.txt', '.md', '.json', '.csv'].includes(ext)) {
			console.log('Skipping unsupported file', file);
			continue;
		}
		// Process all PDF files (removed KP.pdf filter)

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

	// Reduce batch size to avoid connection issues with large payloads
	const batchSize = parseInt(process.env.BATCH_SIZE || '10', 10);
	let ensured = false;
	let inferredVectorSize = null;
	for (let i = 0; i < points.length; i += batchSize) {
		const batch = points.slice(i, i + batchSize);
		const texts = batch.map(p => p.text);
		console.log(`Embedding batch ${i}-${Math.min(i + batchSize, points.length)}...`);
		let embeddings = null;
		if (USE_OLLAMA) {
			// Ollama embeddings API only accepts single string (not batch)
			// Format: POST /api/embeddings with { model: "...", prompt: "..." }
			async function fetchOllamaEmbedSingle(urlBase, model, text) {
				const doFetch = async (fullUrl, payload) => {
					const resp = await fetch(fullUrl, {
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

				const attemptBase = async (baseUrl) => {
					const clean = baseUrl.replace(/\/$/, '');
					// Ollama embeddings API endpoint: /api/embed (NOT /api/embeddings)
					// Payload: { model: "...", input: "..." } where input is a string (not array)
					const candidates = [
						// Standard Ollama endpoint with input field
						{ url: `${clean}/api/embed`, payload: { model, input: text } },
						// Alternative endpoint path
						{ url: `${clean}/embed`, payload: { model, input: text } },
						// Try with prompt field (for older/newer versions)
						{ url: `${clean}/api/embed`, payload: { model, prompt: text } },
						// Legacy endpoints
						{ url: `${clean}/api/embeddings`, payload: { model, input: text } },
						{ url: `${clean}/api/embeddings`, payload: { model, prompt: text } },
					];
					let lastErr = null;
					for (const candidate of candidates) {
						try {
							const result = await doFetch(candidate.url, candidate.payload);
							// Ollama response format: { embedding: [...] }
							if (result && result.embedding && Array.isArray(result.embedding)) {
								return result;
							}
							// Also check for alternative formats
							if (result && (result.embeddings || result.data)) {
								return result;
							}
							throw new Error('Invalid response format: missing embedding array');
						} catch (err) {
							lastErr = err;
							// Only log if not a 404/400 (too noisy otherwise)
							if (!err.message || (!err.message.includes('404') && !err.message.includes('400'))) {
								console.log(`  Failed endpoint: ${candidate.url} - ${err.message?.substring(0, 150)}`);
							}
						}
					}
					if (lastErr) throw lastErr;
					throw new Error('Failed to fetch Ollama embed: no candidates attempted');
				};

				try {
					return await attemptBase(urlBase);
				} catch (err) {
					// If connection refused to ::1, try IPv4 127.0.0.1 fallback
					const cause = err && err.cause;
					if (cause && cause.code === 'ECONNREFUSED' && String(cause.address).includes('::1')) {
						const ipv4 = urlBase.replace('localhost', '127.0.0.1').replace(/\[::1\]/, '127.0.0.1');
						console.log('  Ollama connection refused on ::1, retrying with', ipv4);
						return await attemptBase(ipv4);
					}
					throw err;
				}
			}

			// Process embeddings one by one (Ollama doesn't support batch)
			console.log('  Processing embeddings individually (Ollama requires single prompts)...');
			const allEmbeddings = [];
			for (let idx = 0; idx < texts.length; idx++) {
				const text = texts[idx];
				if (idx % 10 === 0 && idx > 0) {
					console.log(`  Processed ${idx}/${texts.length} embeddings...`);
				}
				try {
					const respBody = await fetchOllamaEmbedSingle(OLLAMA_URL, OLLAMA_EMBED_MODEL, text);
					// Extract embedding array from response
					const emb = respBody.embedding || 
						(respBody.embeddings && Array.isArray(respBody.embeddings) && respBody.embeddings[0]) || 
						(respBody.data && Array.isArray(respBody.data) && respBody.data[0] && respBody.data[0].embedding) || 
						(respBody.data && Array.isArray(respBody.data) && respBody.data[0]) ||
						null;
					if (!emb || !Array.isArray(emb)) {
						throw new Error(`No valid embedding array in response: ${JSON.stringify(respBody).substring(0, 200)}`);
					}
					allEmbeddings.push(emb);
					// Small delay between calls to avoid overwhelming Ollama
					if (idx < texts.length - 1) await new Promise(r => setTimeout(r, 100));
				} catch (err) {
					const errorMsg = err.message || String(err);
					// Provide helpful error message if all endpoints failed
					if (errorMsg.includes('404') || errorMsg.includes('Failed to fetch Ollama embed') || errorMsg.includes('not found')) {
						throw new Error(
							`Failed to get embedding for text ${idx + 1}/${texts.length}: ${errorMsg}\n` +
							`  Possible causes:\n` +
							`  - Ollama service not running (check: curl ${OLLAMA_URL}/api/tags)\n` +
							`  - Embedding model "${OLLAMA_EMBED_MODEL}" not available (try: ollama pull ${OLLAMA_EMBED_MODEL})\n` +
							`  - Wrong endpoint (tried /api/embed, /embed, /api/embeddings)\n` +
							`  Note: Make sure you're using an embedding model, not a generation model like gemma2:2b`
						);
					}
					throw new Error(`Failed to get embedding for text ${idx + 1}/${texts.length}: ${errorMsg}`);
				}
			}
			embeddings = allEmbeddings;
			console.log(`  Successfully processed ${allEmbeddings.length} embeddings`);
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
		
		// Retry logic for upsert with fallback to individual upserts
		async function upsertWithRetry(points, retries = 2) {
			for (let attempt = 0; attempt <= retries; attempt++) {
				try {
					// Use wait: false to avoid timeout on large payloads
					await qdrant.upsert(COLLECTION, { wait: false, points: points });
					return true;
				} catch (e) {
					const errMsg = e.message || String(e);
					const cause = e.cause || {};
					const isConnectionError = errMsg.includes('ECONNREFUSED') || 
						errMsg.includes('connect') || 
						errMsg.includes('other side closed') ||
						errMsg.includes('UND_ERR_SOCKET') ||
						cause.code === 'UND_ERR_SOCKET';
					
					if (isConnectionError) {
						if (attempt < retries) {
							console.log(`  Upsert failed (attempt ${attempt + 1}/${retries + 1}), retrying after 1s...`);
							await new Promise(r => setTimeout(r, 1000));
							// Re-check connection before retry
							try {
								await qdrant.getCollections();
							} catch (connErr) {
								throw new Error(`Qdrant connection lost. Please ensure Qdrant is running at ${process.env.QDRANT_URL || 'http://127.0.0.1:6333'}`);
							}
							continue;
						} else {
							// Final attempt failed, try individual upserts
							console.log(`  Batch upsert failed after ${retries + 1} attempts, trying individual upserts...`);
							return false;
						}
					}
					throw e;
				}
			}
			return false;
		}

		const batchSuccess = await upsertWithRetry(upsertPoints);
		
		if (!batchSuccess) {
			// Fallback: upsert one by one
			console.log(`  Upserting ${upsertPoints.length} points individually...`);
			let successCount = 0;
			for (const point of upsertPoints) {
				try {
					await qdrant.upsert(COLLECTION, { wait: false, points: [point] });
					successCount++;
					// Small delay between individual upserts
					await new Promise(r => setTimeout(r, 50));
				} catch (e) {
					const errMsg = e.message || String(e);
					console.error(`  Failed to upsert point ${point.id}: ${errMsg.substring(0, 100)}`);
					// Continue with next point instead of failing completely
				}
			}
			console.log(`  Successfully upserted ${successCount}/${upsertPoints.length} points individually`);
		} else {
			console.log(`Upserted ${upsertPoints.length} points to Qdrant`);
		}
		
		// Delay between batches to avoid overwhelming Qdrant
		await new Promise(r => setTimeout(r, 500));
	}

	console.log('Ingestion complete');
}

run().catch(err => {
	console.error(err);
	process.exit(1);
});
