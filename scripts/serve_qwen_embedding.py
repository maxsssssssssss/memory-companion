from __future__ import annotations

import os
import time
from pathlib import Path

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer


MODEL_NAME = os.environ.get(
    "HYBRID_EMBEDDING_MODEL",
    "Qwen/Qwen3-Embedding-0.6B",
)
MODEL_REVISION = os.environ.get(
    "HYBRID_EMBEDDING_MODEL_VERSION",
    "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3",
)
CACHE_FOLDER = os.environ.get(
    "HYBRID_MODEL_CACHE",
    str(
        Path(__file__).resolve().parent.parent
        / ".data"
        / "evaluation"
        / "hybrid-runtime"
        / "huggingface"
        / "hub"
    ),
)
DIMENSION = 1024
BATCH_SIZE = max(1, int(os.environ.get("HYBRID_EMBEDDING_BATCH_SIZE", "8")))
MAX_SEQUENCE_LENGTH = max(
    128,
    int(os.environ.get("HYBRID_EMBEDDING_MAX_SEQUENCE_LENGTH", "2048")),
)
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32


class EmbeddingRequest(BaseModel):
    model: str
    input: str | list[str]
    encoding_format: str = "float"


class EmbeddingItem(BaseModel):
    object: str = "embedding"
    index: int
    embedding: list[float]


class EmbeddingUsage(BaseModel):
    prompt_tokens: int
    total_tokens: int


class EmbeddingResponse(BaseModel):
    object: str = "list"
    data: list[EmbeddingItem]
    model: str
    usage: EmbeddingUsage


app = FastAPI(title="Daily Brief local Qwen embedding service")
model = SentenceTransformer(
    MODEL_NAME,
    revision=MODEL_REVISION,
    cache_folder=CACHE_FOLDER,
    device=DEVICE,
    model_kwargs={"torch_dtype": DTYPE},
    tokenizer_kwargs={"padding_side": "left"},
)
model.max_seq_length = MAX_SEQUENCE_LENGTH


@app.get("/v1/models")
def models() -> dict[str, object]:
    return {
        "object": "list",
        "data": [
            {
                "id": MODEL_NAME,
                "object": "model",
                "created": int(time.time()),
                "owned_by": "local",
                "revision": MODEL_REVISION,
                "dimension": DIMENSION,
                "device": DEVICE,
            }
        ],
    }


@app.post("/v1/embeddings", response_model=EmbeddingResponse)
def embeddings(request: EmbeddingRequest) -> EmbeddingResponse:
    texts = [request.input] if isinstance(request.input, str) else request.input
    if request.model != MODEL_NAME:
        raise HTTPException(status_code=400, detail=f"unsupported model: {request.model}")
    if request.encoding_format != "float":
        raise HTTPException(status_code=400, detail="only float encoding is supported")
    if not texts or any(not isinstance(text, str) or not text.strip() for text in texts):
        raise HTTPException(status_code=400, detail="input must contain non-empty strings")

    with torch.inference_mode():
        vectors = model.encode(
            texts,
            batch_size=BATCH_SIZE,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
    if vectors.ndim != 2 or vectors.shape != (len(texts), DIMENSION):
        raise HTTPException(
            status_code=500,
            detail=f"unexpected embedding shape: {tuple(vectors.shape)}",
        )

    token_count = sum(len(model.tokenizer.encode(text)) for text in texts)
    return EmbeddingResponse(
        data=[
            EmbeddingItem(index=index, embedding=vector.astype(float).tolist())
            for index, vector in enumerate(vectors)
        ],
        model=MODEL_NAME,
        usage=EmbeddingUsage(prompt_tokens=token_count, total_tokens=token_count),
    )
