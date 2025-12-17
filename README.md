# Demo LoginPage

Halaman login React minimal yang menggunakan background image di `src/views/image/bg.webp`.

Cara menjalankan:

1. Pastikan Node.js & npm terpasang.
2. Dari direktori proyek jalankan:

```
npm install
npm run dev
```

3. Buka http://localhost:5173

Ganti `src/views/LoginPage.jsx` sesuai kebutuhan dan integrasikan ke aplikasi Anda.

## Advanced Sentiment (Translate → VADER → SentiWordNet)

Opsional: menyalakan analisis sentimen tingkat lanjut (terjemah ke Inggris lalu gabungkan TextBlob, VADER, SentiWordNet) via Python.

- Set environment server: `NLP_USE_PYTHON=true`.
- Install dependensi Python sekali:

```
pip install -r requirements.txt
```

- Server akan memanggil `server/tools/sentiment_pipeline.py`. Jika Python/dependensi tidak tersedia, sistem fallback ke heuristik (atau OpenAI jika `NLP_USE_OPENAI=true`).

- Endpoint uji cepat:

```
curl -X POST http://localhost:3000/api/sentiment/analyze \
	-H "Content-Type: application/json" \
	-d '{"text":"jawaban kamu kurang jelas dan tidak membantu"}'
```
