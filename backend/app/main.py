"""Pixel Kiln API. Local single-user tool — binds to localhost:8100."""

from __future__ import annotations

import base64
import io
import json
import time
import uuid
from collections import OrderedDict
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from PIL import Image
from pydantic import BaseModel, Field

from . import jobs as jobs_mod
from .color_utils import parse_palette_text
from .palettes import PRESET_PALETTES
from .params import OutputParams, ProcessParams
from .pipeline import process_image

app = FastAPI(title="Pixel Kiln")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3100", "http://127.0.0.1:3100"],
    allow_methods=["*"],
    allow_headers=["*"],
)

PRESETS_DIR = Path(__file__).resolve().parent.parent / "presets"
PRESETS_DIR.mkdir(exist_ok=True)

# ---------------------------------------------------------------------------
# Uploaded image cache (workbench source images), tiny LRU
# ---------------------------------------------------------------------------

_images: OrderedDict[str, Image.Image] = OrderedDict()
_IMAGE_CACHE_MAX = 20


@app.post("/api/images")
async def upload_image(file: UploadFile):
    data = await file.read()
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception:
        raise HTTPException(400, "Not a decodable image")
    img = img.convert("RGBA")
    image_id = uuid.uuid4().hex[:12]
    _images[image_id] = img
    while len(_images) > _IMAGE_CACHE_MAX:
        _images.popitem(last=False)
    has_alpha = bool((min(img.getchannel("A").getextrema())) < 255)
    return {"id": image_id, "width": img.width, "height": img.height, "has_alpha": has_alpha}


# ---------------------------------------------------------------------------
# Preview
# ---------------------------------------------------------------------------


class PreviewRequest(BaseModel):
    image_id: str
    params: ProcessParams


@app.post("/api/preview")
def preview(req: PreviewRequest):
    img = _images.get(req.image_id)
    if img is None:
        raise HTTPException(404, "Image not found (re-upload it)")
    t0 = time.perf_counter()
    try:
        with jobs_mod.PROCESS_LOCK:
            result = process_image(img, req.params)
    except ValueError as e:
        raise HTTPException(400, str(e))
    buf = io.BytesIO()
    result.image.save(buf, format="PNG")
    return {
        "png_base64": base64.b64encode(buf.getvalue()).decode(),
        "width": result.out_w,
        "height": result.out_h,
        "palette": result.palette,
        "elapsed_ms": round((time.perf_counter() - t0) * 1000),
    }


# ---------------------------------------------------------------------------
# Palettes
# ---------------------------------------------------------------------------


@app.get("/api/palettes/presets")
def palette_presets():
    return PRESET_PALETTES


@app.post("/api/palettes/parse")
async def palette_parse(file: UploadFile):
    text = (await file.read()).decode("utf-8", errors="replace")
    try:
        colors = parse_palette_text(text, file.filename or "")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"colors": colors}


class SharedPaletteRequest(BaseModel):
    input_dir: str
    size: int = Field(default=16, ge=2, le=64)


@app.post("/api/palettes/shared")
def palette_shared(req: SharedPaletteRequest):
    try:
        files = jobs_mod.list_input_images(req.input_dir)
        if not files:
            raise ValueError(f"No images found in {req.input_dir}")
        return {"colors": jobs_mod.extract_shared_palette(files, req.size), "files": len(files)}
    except ValueError as e:
        raise HTTPException(400, str(e))


# ---------------------------------------------------------------------------
# Presets (named parameter sets, stored as JSON files)
# ---------------------------------------------------------------------------


def _preset_path(name: str) -> Path:
    safe = "".join(c for c in name if c.isalnum() or c in " -_").strip()
    if not safe:
        raise HTTPException(400, "Invalid preset name")
    return PRESETS_DIR / f"{safe}.json"


@app.get("/api/presets")
def list_presets():
    out = {}
    for f in sorted(PRESETS_DIR.glob("*.json")):
        try:
            out[f.stem] = json.loads(f.read_text())
        except json.JSONDecodeError:
            continue
    return out


class SavePresetRequest(BaseModel):
    params: ProcessParams
    output: OutputParams = OutputParams()


@app.put("/api/presets/{name}")
def save_preset(name: str, req: SavePresetRequest):
    _preset_path(name).write_text(req.model_dump_json(indent=2))
    return {"ok": True}


@app.delete("/api/presets/{name}")
def delete_preset(name: str):
    path = _preset_path(name)
    if path.exists():
        path.unlink()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Filesystem browsing (for folder pickers) — restricted to the home directory
# ---------------------------------------------------------------------------

HOME = Path.home().resolve()


@app.get("/api/fs/list")
def fs_list(path: str = ""):
    p = (Path(path).expanduser() if path else HOME).resolve()
    if not p.is_relative_to(HOME):
        raise HTTPException(400, "Path must be inside your home directory")
    if not p.is_dir():
        raise HTTPException(404, f"Not a directory: {p}")
    dirs, images = [], []
    try:
        for entry in sorted(p.iterdir(), key=lambda e: e.name.lower()):
            if entry.name.startswith("."):
                continue
            if entry.is_dir():
                dirs.append(entry.name)
            elif entry.suffix.lower() in jobs_mod.IMAGE_EXTS:
                images.append(entry.name)
    except PermissionError:
        raise HTTPException(403, "Permission denied")
    parent = str(p.parent) if p != HOME else None
    return {"path": str(p), "parent": parent, "dirs": dirs, "images": images}


# ---------------------------------------------------------------------------
# Batch jobs
# ---------------------------------------------------------------------------


class JobRequest(BaseModel):
    input_dir: str
    output_dir: str
    params: ProcessParams
    output: OutputParams = OutputParams()
    skip_existing: bool = True


@app.post("/api/jobs")
def create_job(req: JobRequest):
    try:
        job = jobs_mod.start_job(
            req.input_dir, req.output_dir, req.params, req.output, req.skip_existing
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"job_id": job.id, "total": job.total}


class DryRunRequest(BaseModel):
    input_dir: str
    params: ProcessParams
    limit: int = Field(default=8, ge=1, le=24)


@app.post("/api/jobs/dry-run")
def dry_run(req: DryRunRequest):
    """Process the first N images and return them inline — nothing is written."""
    try:
        files = jobs_mod.list_input_images(req.input_dir)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not files:
        raise HTTPException(400, f"No images found in {req.input_dir}")
    results = []
    for f in files[: req.limit]:
        try:
            with jobs_mod.PROCESS_LOCK:
                r = process_image(Image.open(f), req.params)
            buf = io.BytesIO()
            r.image.save(buf, format="PNG")
            results.append(
                {
                    "file": f.name,
                    "png_base64": base64.b64encode(buf.getvalue()).decode(),
                    "width": r.out_w,
                    "height": r.out_h,
                    "colors": len(r.palette),
                }
            )
        except Exception as e:
            results.append({"file": f.name, "error": str(e)})
    return {"total_in_folder": len(files), "results": results}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    job = jobs_mod.get_job(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    return {
        "id": job.id,
        "status": job.status,
        "completed": job.completed,
        "total": job.total,
        "errors": job.errors,
    }


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    job = jobs_mod.get_job(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    job.cancel_flag.set()
    return {"ok": True}


@app.get("/api/jobs/{job_id}/events")
def job_events(job_id: str):
    job = jobs_mod.get_job(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")

    def stream():
        # Snapshot first so a late-connecting client knows where things stand.
        yield f"data: {json.dumps({'type': 'snapshot', 'completed': job.completed, 'total': job.total, 'status': job.status})}\n\n"
        while True:
            try:
                event = job.events.get(timeout=15)
            except Exception:
                if job.status != "running":
                    break
                yield ": keepalive\n\n"
                continue
            yield f"data: {json.dumps(event)}\n\n"
            if event["type"] in ("done", "error", "cancelled"):
                break

    return StreamingResponse(stream(), media_type="text/event-stream")
