"""Batch job runner: in-memory registry, one worker thread per job,
SSE-consumable event queues. This is a local single-user tool — no persistence."""

from __future__ import annotations

import queue
import threading
import traceback
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image

from .color_utils import extract_palette, rgb_array_to_hex
from .params import OutputParams, ProcessParams
from .pipeline import process_image, save_result

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

# Torch/CPU work is serialized so a batch job and workbench previews don't
# stomp each other.
PROCESS_LOCK = threading.Lock()


def list_input_images(input_dir: str) -> list[Path]:
    p = Path(input_dir).expanduser()
    if not p.is_dir():
        raise ValueError(f"Not a directory: {input_dir}")
    return sorted(f for f in p.iterdir() if f.suffix.lower() in IMAGE_EXTS and f.is_file())


def extract_shared_palette(paths: list[Path], size: int) -> list[str]:
    """One palette for the whole set: pool opaque pixels from every image."""
    samples: list[np.ndarray] = []
    for path in paths:
        img = Image.open(path).convert("RGBA")
        img.thumbnail((128, 128), Image.Resampling.BILINEAR)
        arr = np.asarray(img)
        opaque = arr[arr[:, :, 3] > 128][:, :3]
        if len(opaque):
            samples.append(opaque)
    if not samples:
        raise ValueError("No opaque pixels found in input images")
    palette = extract_palette(np.concatenate(samples), size)
    return rgb_array_to_hex(palette)


@dataclass
class Job:
    id: str
    total: int
    status: str = "running"  # running | done | error | cancelled
    completed: int = 0
    errors: list[dict] = field(default_factory=list)
    events: "queue.Queue[dict]" = field(default_factory=queue.Queue)
    cancel_flag: threading.Event = field(default_factory=threading.Event)


_jobs: dict[str, Job] = {}


def get_job(job_id: str) -> Job | None:
    return _jobs.get(job_id)


def start_job(
    input_dir: str,
    output_dir: str,
    params: ProcessParams,
    output: OutputParams,
    skip_existing: bool = True,
) -> Job:
    files = list_input_images(input_dir)
    if not files:
        raise ValueError(f"No images found in {input_dir}")
    out_dir = Path(output_dir).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    job = Job(id=uuid.uuid4().hex[:12], total=len(files))
    _jobs[job.id] = job

    def emit(event: dict) -> None:
        job.events.put(event)

    def run() -> None:
        try:
            for i, f in enumerate(files):
                if job.cancel_flag.is_set():
                    job.status = "cancelled"
                    emit({"type": "cancelled", "completed": job.completed})
                    return
                ext = {"png": ".png", "webp": ".webp", "bmp": ".bmp"}[output.format]
                out_path = out_dir / (f.stem + ext)
                try:
                    if skip_existing and out_path.exists():
                        emit(
                            {
                                "type": "progress",
                                "index": i,
                                "total": job.total,
                                "file": f.name,
                                "skipped": True,
                            }
                        )
                        job.completed += 1
                        continue
                    with PROCESS_LOCK:
                        result = process_image(Image.open(f), params)
                    save_result(
                        result, str(out_path), fmt=output.format, scale=output.export_scale
                    )
                    job.completed += 1
                    emit(
                        {
                            "type": "progress",
                            "index": i,
                            "total": job.total,
                            "file": f.name,
                            "out": str(out_path),
                            "size": [result.out_w, result.out_h],
                            "colors": len(result.palette),
                        }
                    )
                except Exception as e:  # per-file failure shouldn't kill the batch
                    job.errors.append({"file": f.name, "error": str(e)})
                    emit(
                        {
                            "type": "file_error",
                            "index": i,
                            "total": job.total,
                            "file": f.name,
                            "error": str(e),
                        }
                    )
            job.status = "done"
            emit(
                {
                    "type": "done",
                    "completed": job.completed,
                    "total": job.total,
                    "errors": job.errors,
                }
            )
        except Exception as e:
            job.status = "error"
            traceback.print_exc()
            emit({"type": "error", "error": str(e)})

    threading.Thread(target=run, daemon=True).start()
    return job
