"""Tiny CLI for smoke-testing the pipeline without the web app.

    uv run python -m app.cli input.png -o out.png --target-size 64 --colors 16
"""

from __future__ import annotations

import argparse
import time

from PIL import Image

from .params import AlphaParams, PaletteParams, ProcessParams
from .pipeline import process_image, save_result


def main() -> None:
    ap = argparse.ArgumentParser(description="Pixel Kiln pipeline CLI")
    ap.add_argument("input")
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--target-size", type=int, default=64)
    ap.add_argument("--detail", type=int, default=6)
    ap.add_argument("--thickness", type=int, default=2)
    ap.add_argument("--mode", default="contrast")
    ap.add_argument("--palette", default="auto", help="auto | none | preset:<name> | custom")
    ap.add_argument("--colors", type=int, default=16)
    ap.add_argument("--dither", default="none")
    ap.add_argument("--dither-strength", type=float, default=0.35)
    ap.add_argument("--alpha-threshold", type=float, default=0.5)
    ap.add_argument("--no-despeckle", action="store_true")
    ap.add_argument("--offset-search", action="store_true")
    ap.add_argument("--scale", type=int, default=1, help="extra nearest-neighbor upscale")
    args = ap.parse_args()

    if args.palette.startswith("preset:"):
        pal = PaletteParams(source="preset", preset_name=args.palette.split(":", 1)[1])
    else:
        pal = PaletteParams(source=args.palette, size=args.colors)

    params = ProcessParams(
        target_size=args.target_size,
        detail=args.detail,
        thickness=args.thickness,
        mode=args.mode,
        palette=pal,
        dither=args.dither,
        dither_strength=args.dither_strength,
        alpha=AlphaParams(threshold=args.alpha_threshold),
        despeckle=not args.no_despeckle,
        offset_search=args.offset_search,
    )

    img = Image.open(args.input)
    t0 = time.perf_counter()
    result = process_image(img, params)
    dt = time.perf_counter() - t0
    save_result(result, args.output, fmt="png", scale=args.scale)
    print(
        f"{args.input} -> {args.output}  {result.out_w}x{result.out_h}  "
        f"{len(result.palette)} colors  {dt:.2f}s"
    )


if __name__ == "__main__":
    main()
