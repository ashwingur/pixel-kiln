"""Processing parameter model, shared by the preview endpoint, batch jobs,
presets and the CLI."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class PaletteParams(BaseModel):
    # auto: k-means per image | preset: built-in retro palette
    # custom: explicit color list (imported file or shared batch palette)
    # none: keep PixelOE's full-color output
    source: Literal["auto", "preset", "custom", "none"] = "auto"
    size: int = Field(default=16, ge=2, le=64)  # auto mode only
    preset_name: str | None = None
    colors: list[str] | None = None  # '#rrggbb' list for custom mode


class AlphaParams(BaseModel):
    threshold: float = Field(default=0.5, ge=0.05, le=0.95)
    # 2 = hard 1-bit edges (classic sprites); higher allows semi-transparency steps
    levels: int = Field(default=2, ge=2, le=8)


class ProcessParams(BaseModel):
    # Long side of the output in pixels
    target_size: int = Field(default=64, ge=8, le=512)
    # PixelOE patch size: how much source context feeds one output pixel
    detail: int = Field(default=6, ge=3, le=10)
    # Outline expansion thickness (0 = off)
    thickness: int = Field(default=2, ge=0, le=6)
    mode: Literal["contrast", "k_centroid", "lanczos", "nearest", "bilinear", "bicubic"] = (
        "contrast"
    )
    color_match: bool = True

    # Pre-adjustments (1.0 = unchanged)
    contrast: float = Field(default=1.0, ge=0.5, le=2.0)
    saturation: float = Field(default=1.0, ge=0.0, le=2.0)

    palette: PaletteParams = PaletteParams()
    dither: Literal["none", "ordered", "error_diffusion"] = "none"
    dither_strength: float = Field(default=0.35, ge=0.0, le=1.0)

    alpha: AlphaParams = AlphaParams()
    trim_transparent: bool = True
    despeckle: bool = True
    # Try several sub-pixel grid offsets and keep the sharpest result
    offset_search: bool = False


class OutputParams(BaseModel):
    format: Literal["png", "webp", "bmp"] = "png"
    # Extra nearest-neighbor upscaled copy (1 = only the native-size file)
    export_scale: int = Field(default=1, ge=1, le=16)
