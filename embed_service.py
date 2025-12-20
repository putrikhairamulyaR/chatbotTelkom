import os
import argparse
from flask import Flask, request, jsonify
from sentence_transformers import SentenceTransformer
import requests

app = Flask(__name__)

# Choose mode: 'local' for SentenceTransformers; 'ollama' to forward to Ollama
# Default to 'ollama' so we use local Ollama embedding by default.
MODE = os.environ.get('EMBED_MODE', 'ollama')
# normalize mode and allow forcing local-only behavior
MODE = MODE.strip().lower() if isinstance(MODE, str) else 'ollama'
FORCE_LOCAL = os.environ.get('FORCE_LOCAL_EMBED', 'false').strip().lower() in ('1', 'true', 'yes')
OLLAMA_URL = os.environ.get('OLLAMA_URL', 'http://host.docker.internal:11434')
OLLAMA_MODEL = os.environ.get('OLLAMA_MODEL', 'nomic-embed-text')
LOCAL_MODEL = os.environ.get('LOCAL_MODEL', 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')
# Accept either OLLAMA_MODEL or OLLAMA_EMBED_MODEL env var for clarity
if os.environ.get('OLLAMA_EMBED_MODEL'):
    OLLAMA_MODEL = os.environ.get('OLLAMA_EMBED_MODEL')
OLLAMA_API_KEY = os.environ.get('OLLAMA_API_KEY')


def _ollama_post(suffixes, payload, timeout=60, headers=None):
    """
    Try hitting Ollama endpoints (new /api/* first, then legacy paths) until one succeeds.
    """
    last_exc = None
    base = OLLAMA_URL.rstrip('/')
    suffix_list = suffixes if isinstance(suffixes, (list, tuple)) else [suffixes]
    for suffix in suffix_list:
        url = f"{base}{suffix}"
        try:
            resp = requests.post(url, json=payload, timeout=timeout, headers=headers)
            resp.raise_for_status()
            return resp
        except Exception as exc:
            last_exc = exc
    if last_exc:
        raise last_exc
    raise RuntimeError('No Ollama endpoint attempted')

model = None
if MODE == 'local' or FORCE_LOCAL:
    print(f"Starting embed service in LOCAL mode with model={LOCAL_MODEL} (force_local={FORCE_LOCAL})")
    # load local model eagerly so we surface errors early
    model = SentenceTransformer(LOCAL_MODEL)
else:
    print(f"Starting embed service in OLLAMA mode, forwarding to {OLLAMA_URL}")


@app.route('/embed', methods=['POST'])
def embed():
    body = request.get_json(force=True) or {}
    texts = body.get('input') or body.get('texts') or body.get('input_texts') or []
    if not isinstance(texts, list):
        return jsonify({'error': 'input must be a list of strings'}), 400

    if MODE == 'local':
        embeddings = model.encode(texts, show_progress_bar=False)
        return jsonify({'embeddings': [e.tolist() for e in embeddings]})

    # Ollama forwarding
    try:
        headers = {'Content-Type': 'application/json'}
        if OLLAMA_API_KEY:
            headers['Authorization'] = f'Bearer {OLLAMA_API_KEY}'
        resp = _ollama_post(('/api/embed', '/embed'), {"model": OLLAMA_MODEL, "input": texts}, timeout=60, headers=headers)
        data = resp.json()
        # Ollama may return either data.embeddings or data.data[*].embedding
        if 'embeddings' in data:
            return jsonify({'embeddings': data['embeddings']})
        if 'data' in data:
            emb = []
            for d in data['data']:
                if isinstance(d, dict) and 'embedding' in d:
                    emb.append(d['embedding'])
            if emb:
                return jsonify({'embeddings': emb})
        return jsonify({'error': 'unexpected response from ollama', 'body': data}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--port', default=5001, type=int)
    args = parser.parse_args()
    app.run(host=args.host, port=args.port)
