import os
import re
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
from langdetect import detect
from qdrant_client import QdrantClient
import requests

app = FastAPI(title='Embed + RAG Service')

EMBED_MODEL = os.environ.get('LOCAL_MODEL', 'sentence-transformers/all-MiniLM-L6-v2')
EMBED_SERVICE = os.environ.get('EMBED_URL', None)  # if provided, can forward embedding calls
QDRANT_URL = os.environ.get('QDRANT_URL', 'http://qdrant:6333')
QDRANT_COLLECTION = os.environ.get('QDRANT_COLLECTION', 'documents')
OLLAMA_URL = os.environ.get('OLLAMA_URL', 'http://host.docker.internal:11434')
OLLAMA_API_KEY = os.environ.get('OLLAMA_API_KEY')
ENABLE_REWRITE = (os.environ.get('ENABLE_RAG_REWRITE', 'true').lower() == 'true')
ENABLE_GEN = (os.environ.get('ENABLE_RAG_GEN', 'false').lower() == 'true')


class RagRequest(BaseModel):
    question: str
    top_k: Optional[int] = 5


class RagResponse(BaseModel):
    answer: str
    sources: List[dict]
    raw_hits: List[dict]


def sanitize(text: str) -> str:
    # Basic sanitization: remove control chars and script tags, trim
    if not text:
        return ''
    s = re.sub(r"<script.*?>.*?</script>", ' ', text, flags=re.IGNORECASE | re.DOTALL)
    s = re.sub(r'[\x00-\x1f\x7f]', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


print('Loading embedding model:', EMBED_MODEL)
local_model = None
try:
    local_model = SentenceTransformer(EMBED_MODEL)
except Exception as e:
    print('Warning: could not load local SentenceTransformer model:', e)
    local_model = None


def detect_language(text: str) -> str:
    try:
        return detect(text)
    except Exception:
        return 'unknown'


def embed_texts(texts: List[str]) -> List[List[float]]:
    # If EMBED_SERVICE is provided, forward to it (useful for single embed service)
    if EMBED_SERVICE:
        resp = requests.post(f"{EMBED_SERVICE.rstrip('/')}/embed", json={"model": EMBED_MODEL, "input": texts}, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        if 'embeddings' in data:
            return data['embeddings']
        if 'data' in data:
            return [d.get('embedding') for d in data['data'] if isinstance(d, dict) and 'embedding' in d]
        raise RuntimeError('Unexpected embed service response')

    if not local_model:
        raise RuntimeError('No local embedding model available')
    emb = local_model.encode(texts, show_progress_bar=False)
    # convert numpy arrays to lists when needed
    return [e.tolist() if hasattr(e, 'tolist') else list(e) for e in emb]


def qdrant_search(vector: List[float], top_k: int = 5):
    client = QdrantClient(url=QDRANT_URL)
    res = client.search(collection_name=QDRANT_COLLECTION, query_vector=vector, limit=top_k, with_payload=True)
    return res


def call_ollama_generate(prompt: str, model: str = 'gemma3:4b', max_tokens: int = 512) -> str:
    headers = {'Content-Type': 'application/json'}
    if OLLAMA_API_KEY:
        headers['Authorization'] = f'Bearer {OLLAMA_API_KEY}'
    resp = requests.post(f"{OLLAMA_URL.rstrip('/')}/generate", json={"model": model, "prompt": prompt, "max_tokens": max_tokens}, headers=headers, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    # Try to extract text
    if isinstance(data, str):
        return data
    if data.get('output'):
        return data['output']
    if data.get('text'):
        return data['text']
    if isinstance(data.get('results'), list) and data['results'] and data['results'][0].get('content'):
        return data['results'][0]['content']
    if isinstance(data.get('choices'), list) and data['choices'] and data['choices'][0].get('message') and data['choices'][0]['message'].get('content'):
        return data['choices'][0]['message']['content']
    return str(data)


@app.post('/rag', response_model=RagResponse)
def rag_endpoint(req: RagRequest):
    q_raw = req.question
    if not q_raw or not q_raw.strip():
        raise HTTPException(status_code=400, detail='question is required')

    # 1) preprocessing
    q_clean = sanitize(q_raw)
    lang = detect_language(q_clean)

    # 2) optional rewrite via Ollama
    q_for_embed = q_clean
    if ENABLE_REWRITE and OLLAMA_API_KEY:
        try:
            rewrite_prompt = f"Rewrite the user question to be concise and clear for semantic search:\nUser question: {q_clean}\nProvide the rewritten query only."
            rewritten = call_ollama_generate(rewrite_prompt, model='gemma3:4b', max_tokens=128)
            if rewritten and isinstance(rewritten, str) and len(rewritten.strip()) > 0:
                q_for_embed = rewritten.strip()
        except Exception as e:
            print('Ollama rewrite failed, using original question:', e)

    # 3) embedding
    try:
        qvecs = embed_texts([q_for_embed])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Embedding error: {e}')
    qvec = qvecs[0]

    # 4) similarity search
    top_k = int(req.top_k or 5)
    try:
        hits = qdrant_search(qvec, top_k=top_k)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'Qdrant search error: {e}')

    snippets = []
    sources = []
    compact_hits = []
    for h in hits:
        payload = getattr(h, 'payload', None) or h.get('payload', {}) if isinstance(h, dict) else {}
        snippet = str(payload.get('snippet') or payload.get('text') or '')[:800]
        filename = payload.get('filename') or payload.get('filepath') or 'unknown'
        page = payload.get('page') or payload.get('page_number') or None
        snippets.append(f"Source: {filename} (page {page})\n{snippet}")
        sources.append({'filename': filename, 'filepath': payload.get('filepath') or f"data/{filename}", 'page': page, 'score': getattr(h, 'score', None) or h.get('score')})
        compact_hits.append({'id': getattr(h, 'id', None) or h.get('id'), 'score': getattr(h, 'score', None) or h.get('score'), 'filename': filename, 'page': page, 'snippet': snippet})

    # 5) generation: if enabled, call Ollama with context; otherwise synthesize short answer
    answer = ''
    if ENABLE_GEN and OLLAMA_API_KEY:
        try:
            system_prompt = 'You are an assistant that answers using ONLY the provided contextual snippets. Cite sources where appropriate.'
            user_prompt = f"User: {q_clean}\n\nContext:\n{('\n\n--\n\n').join(snippets)}\n\nProvide a concise answer and then list sources (filename, page)."
            gen = call_ollama_generate(system_prompt + '\n\n' + user_prompt, model='gemma3:4b', max_tokens=512)
            answer = gen
        except Exception as e:
            print('Ollama generate failed, falling back to snippet summary:', e)

    if not answer:
        if len(snippets) == 0:
            answer = 'Maaf, saya tidak menemukan dokumen yang relevan untuk pertanyaan ini.'
        else:
            use = snippets[:min(2, len(snippets))]
            sentences = []
            for s in use:
                t = s.replace('\n', ' ').strip()
                m = re.search(r'([^.?!]*[.?!])', t)
                sentences.append(m.group(0).strip() if m else t[:200])
            src_list = ', '.join([f"{s['filename']}{' (p'+str(s['page'])+')' if s['page'] else ''}" for s in sources[:3]])
            answer = ' '.join(sentences) + f"\n\nSumber: {src_list}"

    return {'answer': answer, 'sources': sources, 'raw_hits': compact_hits}


if __name__ == '__main__':
    import uvicorn
    uvicorn.run('embed_rag_service:app', host='0.0.0.0', port=5002, reload=False)
