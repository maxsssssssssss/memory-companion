from __future__ import annotations

import os
import time
from pathlib import Path

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import CrossEncoder


MODEL_NAME = os.environ.get(
    "HYBRID_RERANKER_MODEL",
    "Qwen/Qwen3-Reranker-0.6B",
)
MODEL_REVISION = os.environ.get(
    "HYBRID_RERANKER_MODEL_VERSION",
    "e61197ed45024b0ed8a2d74b80b4d909f1255473",
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
BATCH_SIZE = max(1, int(os.environ.get("HYBRID_RERANKER_BATCH_SIZE", "8")))
MAX_SEQUENCE_LENGTH = max(
    128,
    int(os.environ.get("HYBRID_RERANKER_MAX_SEQUENCE_LENGTH", "2048")),
)
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32


class RerankerDocument(BaseModel):
    id: str = Field(min_length=1)
    text: str = Field(min_length=1)


class RerankRequest(BaseModel):
    model: str
    revision: str
    query: str = Field(min_length=1)
    documents: list[RerankerDocument] = Field(min_length=1, max_length=64)


class RerankResponse(BaseModel):
    model: str
    revision: str
    scores: list[float]
    latency_ms: float
    gpu_peak_memory_mb: float


load_started_at = time.perf_counter()
model = CrossEncoder(
    MODEL_NAME,
    revision=MODEL_REVISION,
    cache_folder=CACHE_FOLDER,
    device=DEVICE,
    max_length=MAX_SEQUENCE_LENGTH,
    model_kwargs={"torch_dtype": DTYPE},
    tokenizer_kwargs={"padding_side": "left"},
)
if model.tokenizer.pad_token_id is None:
    model.tokenizer.pad_token = model.tokenizer.eos_token
if getattr(model.model.config, "pad_token_id", None) is None:
    model.model.config.pad_token_id = model.tokenizer.pad_token_id
MODEL_LOAD_TIME_MS = (time.perf_counter() - load_started_at) * 1000

app = FastAPI(title="Daily Brief local Qwen reranker service")


def cuda_memory() -> tuple[float, float, float]:
    if DEVICE != "cuda":
        return 0.0, 0.0, 0.0
    divisor = 1024 * 1024
    return (
        torch.cuda.memory_allocated() / divisor,
        torch.cuda.memory_reserved() / divisor,
        torch.cuda.max_memory_allocated() / divisor,
    )


@app.get("/v1/models")
def models() -> dict[str, object]:
    allocated, reserved, peak = cuda_memory()
    return {
        "object": "list",
        "data": [
            {
                "id": MODEL_NAME,
                "object": "model",
                "created": int(time.time()),
                "owned_by": "local",
                "revision": MODEL_REVISION,
                "device": DEVICE,
                "batch_size": BATCH_SIZE,
                "max_sequence_length": MAX_SEQUENCE_LENGTH,
                "model_load_time_ms": MODEL_LOAD_TIME_MS,
                "gpu_memory_allocated_mb": allocated,
                "gpu_memory_reserved_mb": reserved,
                "gpu_peak_memory_mb": peak,
            }
        ],
    }


@app.post("/v1/rerank", response_model=RerankResponse)
def rerank(request: RerankRequest) -> RerankResponse:
    if request.model != MODEL_NAME:
        raise HTTPException(status_code=400, detail=f"unsupported model: {request.model}")
    if request.revision != MODEL_REVISION:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported revision: {request.revision}",
        )

    pairs = [(request.query, document.text) for document in request.documents]
    started_at = time.perf_counter()
    if DEVICE == "cuda":
        torch.cuda.reset_peak_memory_stats()
    try:
        with torch.inference_mode():
            raw_scores = model.predict(
                pairs,
                batch_size=min(BATCH_SIZE, len(pairs)),
                convert_to_numpy=True,
                show_progress_bar=False,
            )
    except torch.OutOfMemoryError as error:
        if DEVICE == "cuda":
            torch.cuda.empty_cache()
        raise HTTPException(status_code=503, detail="CUDA out of memory") from error
    except RuntimeError as error:
        if "out of memory" in str(error).lower():
            if DEVICE == "cuda":
                torch.cuda.empty_cache()
            raise HTTPException(status_code=503, detail="CUDA out of memory") from error
        raise HTTPException(
            status_code=500,
            detail=f"{type(error).__name__}: {error}",
        ) from error
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"{type(error).__name__}: {error}",
        ) from error

    scores = np.asarray(raw_scores, dtype=np.float64).reshape(-1)
    if scores.shape != (len(pairs),) or not np.isfinite(scores).all():
        raise HTTPException(
            status_code=500,
            detail=f"unexpected reranker score shape: {tuple(scores.shape)}",
        )
    _, _, peak = cuda_memory()
    return RerankResponse(
        model=MODEL_NAME,
        revision=MODEL_REVISION,
        scores=scores.astype(float).tolist(),
        latency_ms=(time.perf_counter() - started_at) * 1000,
        gpu_peak_memory_mb=peak,
    )
