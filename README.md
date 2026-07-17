# Pixel Kiln

Local tool that converts high-res AI-generated art into real pixel art:
proper downscaling ([PixelOE](https://github.com/KohakuBlueleaf/PixelOE)
contrast-aware outline expansion + smart downscale), palette reduction in
Oklab space, optional dithering, and RGBA-correct sprite handling
(premultiplied resize, hard 1-bit alpha edges, no halo bleed).

Runs entirely on your machine: a FastAPI backend on `:8100` and a
React/Vite frontend on `:3100`. Single-user, localhost-only — there is no
auth and the backend can browse folders under your home directory, so don't
expose it to a network.

## Run

```sh
./dev.sh          # backend :8100 + frontend :3100
# then open http://localhost:3100
```

Or individually:

```sh
cd backend && uv run uvicorn app.main:app --port 8100
cd frontend && npm run dev
```

First-time setup: `uv sync` in `backend/`, `npm install` in `frontend/`
(needs [uv](https://docs.astral.sh/uv/); `dev.sh` installs uv itself if
missing. Torch is the CPU build, ~200MB — no CUDA download).

## Pages

- **Workbench** — drop an image, tune parameters with a live side-by-side
  preview (synced pan/zoom, pixel grid overlay, 📌 pin for A/B comparison),
  save parameter presets.
- **Batch** — pick input/output folders, optionally extract a shared palette
  from the whole folder (consistent set of game assets), dry-run the first 8
  in-browser, then run with live progress. PNG output is indexed
  (palette-mode) when possible.
- **Settings** — UI theme.

## Parameters cheat-sheet

- **Detail** — source pixels per output pixel (PixelOE patch size). Higher =
  more context per pixel, chunkier reads.
- **Outline expansion** — pre-downscale dilate/erode that keeps thin details
  alive; the main "AI art → pixel art" trick. 0 disables.
- **Downscale mode** — `contrast` is the best default; `k_centroid` for flat
  cartoon shading; `lanczos/bicubic` soft baselines.
- **Palette** — auto k-means (per image), retro presets (PICO-8, Game Boy,
  Sweetie 16, Endesga 32), custom `.hex`/`.gpl` import, or shared-from-folder
  (Batch page). Mapping is nearest-in-Oklab.
- **Dither** — none (sprites), ordered/Bayer with strength (gradients, stable
  in animation), Floyd–Steinberg (organic stills).
- **Alpha threshold / levels** — where soft alpha snaps to hard edges; levels
  2 = classic 1-bit sprite edges.
- **Grid offset search** — tries 9 sub-pixel grid alignments and keeps the
  sharpest; helps when the AI image has an implied misaligned pixel grid.

## CLI

```sh
cd backend
uv run python -m app.cli input.png -o out.png --target-size 48 --colors 12 --scale 8
```

## Layout

- `backend/app/pipeline.py` — the conversion pipeline (the interesting file)
- `backend/app/color_utils.py` — Oklab, k-means, dithering, palette parsing
- `backend/app/main.py` — FastAPI endpoints (preview, presets, fs browse, batch + SSE)
- `backend/presets/` — saved parameter presets (JSON, gitignored)
- `frontend/src/pages/{Workbench,Batch}.tsx` — the two main pages
