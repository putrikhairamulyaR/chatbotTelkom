import os
import argparse
from flask import Flask, request, jsonify
from sentence_transformers import SentenceTransformer
import requests

app = Flask(__name__)

# Choose mode: 'local' for SentenceTransformers; 'ollama' to forward to Ollama
# Default to 'local' so the service works out-of-the-box if Ollama embedding
# route is not available on the host.
MODE = os.environ.get('EMBED_MODE', 'local')
# normalize mode and allow forcing local-only behavior
MODE = MODE.strip().lower() if isinstance(MODE, str) else 'local'
FORCE_LOCAL = os.environ.get('FORCE_LOCAL_EMBED', 'true').strip().lower() in ('1', 'true', 'yes')
OLLAMA_URL = os.environ.get('OLLAMA_URL', 'http://host.docker.internal:11434')
OLLAMA_MODEL = os.environ.get('OLLAMA_MODEL', 'all-mpnet-base-v2')
LOCAL_MODEL = os.environ.get('LOCAL_MODEL', 'sentence-transformers/all-MiniLM-L6-v2')
OLLAMA_API_KEY = os.environ.get('OLLAMA_API_KEY')

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
        resp = requests.post(f"{OLLAMA_URL.rstrip('/')}/embed", json={"model": OLLAMA_MODEL, "input": texts}, timeout=60, headers=headers)
        resp.raise_for_status()
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
