# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pixel Kiln is a local, single-user tool that converts high-res AI-generated art into real pixel art. Two halves:

- `backend/` — Python 3.12 / FastAPI on `:8100`, managed with [uv](https://docs.astral.sh/uv/). The image work is PixelOE (contrast-aware outline expansion + smart downscale, torch CPU-only) plus custom Oklab palette reduction, dithering, and RGBA-correct sprite handling.
- `frontend/` — React 19 + Vite + Tailwind 4 on `:3100`, TanStack Router/Query, plain npm (not pnpm).

It is deliberately localhost-only: no auth, CORS pinned to `localhost:3100`, and the backend exposes filesystem browsing under the user's home directory (`/api/fs/list`, path-checked with `is_relative_to(HOME)` — keep that check intact if touching it). Never add features that assume multiple users or network exposure.

This repo was extracted from the soul-warden-online monorepo (it's the asset tool for that game), but has no code dependency on it.

## Commands

```sh
./dev.sh                                            # both services (installs uv itself if missing; uv run syncs the venv)
cd backend && uv run uvicorn app.main:app --port 8100   # backend only
cd frontend && npm run dev                              # frontend only
cd frontend && npm run build                            # typecheck (tsc -b) + production build

# CLI (same pipeline, no server)
cd backend && uv run python -m app.cli input.png -o out.png --target-size 48 --colors 12 --scale 8
```

There are no tests and no formatter config; match the existing style by hand. `uv sync` in `backend/` and `npm install` in `frontend/` for first-time setup. Dependency changes go through `pyproject.toml` + `uv lock` — note the `[tool.uv.sources]` pin of torch/torchvision to the CPU wheel index; don't remove it (the default wheels drag in ~3GB of CUDA).

## Architecture

### Backend (`backend/app/`)

- **`params.py`** — the shared parameter model (`ProcessParams`, `OutputParams`, pydantic). This is the single contract used by the preview endpoint, batch jobs, saved presets, and the CLI; the frontend mirrors it in `src/api.ts` and `use-params-store.ts`. **Adding a parameter means touching: `params.py`, `pipeline.py` (consume it), `api.ts` (type + default), and `ParamPanel.tsx` (control).** Presets are stored as raw JSON of this model, so keep new fields optional/defaulted — old preset files must still parse.
- **`pipeline.py`** — `process_image(img, params)`, the whole conversion: pre-adjust → PixelOE outline expansion + downscale → palette reduction → dither → alpha snap → trim/despeckle. The interesting file; everything else is plumbing around it.
- **`color_utils.py`** — Oklab conversion, k-means palette extraction, ordered/error-diffusion dithering, `.hex`/`.gpl` palette parsing.
- **`palettes.py`** — built-in retro palettes (`PRESET_PALETTES`).
- **`main.py`** — FastAPI endpoints: image upload into a small in-memory LRU (`_images`, 20 entries — previews reference images by id, a 404 means "re-upload"), `/api/preview`, palette endpoints, preset CRUD (JSON files in `backend/presets/`, gitignored), `/api/fs/list`, and batch jobs.
- **`jobs.py`** — batch job runner: background thread per job, cancel via `Event`, progress streamed over SSE (`/api/jobs/{id}/events`, snapshot-first so late connects catch up). `PROCESS_LOCK` serializes all pipeline runs (PixelOE/torch is not run concurrently) — hold it around any new `process_image` call site.
- **`cli.py`** — thin argparse wrapper over the same pipeline.

### Frontend (`frontend/src/`)

- **`api.ts`** — typed fetch wrappers for every backend endpoint + the TS mirror of `ProcessParams` (including defaults). Keep in sync with `params.py` by hand — there is no codegen.
- **`use-params-store.ts`** — the parameter state store shared by Workbench and Batch, persisted to localStorage (loads by spreading over `DEFAULT_PARAMS`, so old stored shapes self-heal).
- **`pages/Workbench.tsx`** — upload + live preview (synced pan/zoom, pixel grid, pin-for-A/B), preset save/load.
- **`pages/Batch.tsx`** — folder pickers (via `/api/fs/list`), shared-palette extraction, dry-run preview, SSE progress.
- **`pages/Settings.tsx`**, **`theme.ts`** — UI theme system.
- **`components/`** — `ParamPanel` (the parameter controls), `PaletteStrip`, `FolderPicker`.
