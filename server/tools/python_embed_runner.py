import sys
import os
from pathlib import Path
# Ensure project root (two levels up) is on sys.path so `from src...` works
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import glob
import uuid
from sentence_transformers import SentenceTransformer
from src.qdrant_store import upsert_embeddings
import pdfplumber
import sys

# add project root (two levels up from this script) to sys.path so `src` imports work
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

# Config (can also be moved to config.yaml)
EMBEDDING_MODEL = os.environ.get('EMBEDDING_MODEL', 'all-mpnet-base-v2')
DATA_DIR = os.environ.get('DATA_DIR', './data')
COLLECTION = os.environ.get('QDRANT_COLLECTION', 'documents')
CHUNK_SIZE = int(os.environ.get('CHUNK_SIZE', '1000'))
CHUNK_OVERLAP = int(os.environ.get('CHUNK_OVERLAP', '200'))


def chunk_text(text, size=1000, overlap=200):
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + size, len(text))
        chunks.append(text[start:end])
        if end == len(text):
            break
        start = max(0, end - overlap)
    return chunks


def extract_text_from_pdf(path):
    try:
        texts = []
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages:
                t = page.extract_text() or ''
                if t.strip():
                    texts.append(t)
        if texts:
            return '\n\n'.join(texts)
    except Exception as e:
        print('pdfplumber failed:', e)
    # Fallback: try OCR with pytesseract if available (for scanned/image PDFs)
    try:
        import pytesseract
        from PIL import Image
        ocr_texts = []
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages:
                try:
                    img = page.to_image(resolution=300).original
                    text = pytesseract.image_to_string(img)
                    if text and text.strip():
                        ocr_texts.append(text)
                except Exception as pe:
                    # continue to next page
                    print('OCR page failed:', pe)
        if ocr_texts:
            return '\n\n'.join(ocr_texts)
    except Exception as oerr:
        # pytesseract or PIL not available or tesseract engine missing
        # silently return empty so caller can decide
        # print('OCR not available:', oerr)
        pass

    return ''


def main():
    model = SentenceTransformer(EMBEDDING_MODEL)
    files = list(Path(DATA_DIR).glob('**/*'))
    pdf_files = [f for f in files if f.suffix.lower() == '.pdf']
    print('Found', len(pdf_files), 'pdf files')
    total = 0
    for f in pdf_files:
        print('Processing', f)
        text = extract_text_from_pdf(f)
        if not text.strip():
            print('No text extracted, skipping', f)
            continue
        chunks = chunk_text(text, CHUNK_SIZE, CHUNK_OVERLAP)
        ids = [str(uuid.uuid4()) for _ in chunks]
        metadatas = [{'source_file': f.name, 'chunk_index': i} for i in range(len(chunks))]
        embeddings = model.encode(chunks, show_progress_bar=True)
        upsert_embeddings(COLLECTION, embeddings.tolist(), chunks, metadatas, ids)
        total += len(chunks)
        print('Upserted', len(chunks), 'chunks for', f.name)
    print('Done. Total chunks:', total)


if __name__ == '__main__':
    main()
