from qdrant_client import QdrantClient
from qdrant_client.http import models as rest_models
from qdrant_client.http.exceptions import UnexpectedResponse
import os


def get_client():
    url = os.environ.get('QDRANT_URL', 'http://localhost:6333')
    api_key = os.environ.get('QDRANT_API_KEY') or None
    return QdrantClient(url=url, api_key=api_key)


def ensure_collection(client: QdrantClient, collection_name: str, vector_size: int = 1536):
    try:
        info = client.get_collection(collection_name)
        return info
    except Exception:
        client.recreate_collection(collection_name=collection_name, vectors_config=rest_models.VectorParams(size=vector_size, distance=rest_models.Distance.COSINE))
        return client.get_collection(collection_name)


def upsert_embeddings(collection_name, embeddings, texts, metadatas, ids):
    client = get_client()
    # target vector size from embeddings if available
    vector_size = len(embeddings[0]) if embeddings else 1536
    try:
        ensure_collection(client, collection_name, vector_size=vector_size)
    except Exception:
        pass

    points = []
    for _id, vector, payload in zip(ids, embeddings, metadatas):
        points.append(rest_models.PointStruct(id=_id, vector=vector, payload=payload))

    try:
        client.upsert(collection_name=collection_name, points=points)
    except UnexpectedResponse as e:
        # Try to detect dimension mismatch and recreate collection with correct size then retry
        msg = str(e)
        if 'expected dim' in msg or 'Vector inserting error' in msg:
            try:
                # recreate collection with the correct vector size
                client.recreate_collection(collection_name=collection_name, vectors_config=rest_models.VectorParams(size=vector_size, distance=rest_models.Distance.COSINE))
                # retry upsert
                client.upsert(collection_name=collection_name, points=points)
                return
            except Exception as e2:
                raise
        raise
