"""BugPaw 本机 Whisper 转写服务。"""

import asyncio
import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from faster_whisper import WhisperModel

MAX_AUDIO_BYTES = 25 * 1024 * 1024
MODEL_NAME = os.getenv("WHISPER_MODEL", "base")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
transcription_lock = asyncio.Lock()


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    """模型完成加载后才对外报告健康。"""
    return {"status": "ok", "model": MODEL_NAME}


@app.post("/v1/transcriptions")
async def transcribe(audio: UploadFile = File(...)) -> dict[str, object]:
    """串行转写单个中文音频，避免并发模型推理放大内存峰值。"""
    content = await audio.read(MAX_AUDIO_BYTES + 1)
    if not content:
        raise HTTPException(status_code=400, detail="音频内容为空")
    if len(content) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="音频不能超过 25 MiB")

    suffix = Path(audio.filename or "speech.webm").suffix or ".webm"
    temporary_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temporary:
            temporary.write(content)
            temporary_path = temporary.name
        async with transcription_lock:
            text, language, duration = await asyncio.to_thread(_transcribe_file, temporary_path)
        return {"text": text, "language": language, "duration": duration}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=422, detail="音频无法转写") from error
    finally:
        if temporary_path:
            Path(temporary_path).unlink(missing_ok=True)


def _transcribe_file(path: str) -> tuple[str, str, float]:
    """执行同步模型推理，并合并已完成的文本片段。"""
    segments, info = model.transcribe(
        path,
        language="zh",
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    text = "".join(segment.text for segment in segments).strip()
    return text, info.language, info.duration
