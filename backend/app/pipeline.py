"""The pixel-art conversion pipeline.

PixelOE does the heavy lifting (outline expansion + smart downscale) but is
RGB-only. This wrapper makes it RGBA-correct and adds the palette stage:

  1. pre-adjust (contrast/saturation), trim transparent border
  2. premultiplied-alpha resize to (out * detail)  <- no background halos
  3. edge-extend RGB into transparent areas        <- fill colors = real colors
  4. PixelOE pixelize on RGB (no quantization, no post upscale)
  5. box-downscale alpha separately, snap to N levels (default hard 1-bit)
  6. palette stage in Oklab (auto k-means over opaque pixels only / preset /
     custom) with optional ordered or Floyd-Steinberg dithering
  7. despeckle (majority-neighbor orphan pixel cleanup, alpha-aware)
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageEnhance

# We use PixelOE's building blocks rather than its pixelize() wrapper: the
# wrapper's padding logic emits an extra row/col when dims are exact multiples
# of pixel_size (which ours always are, so no padding is ever needed).
from pixeloe.torch.color import match_color
from pixeloe.torch.downscale.contrast_based import contrast_downscale
from pixeloe.torch.downscale.k_centroid import k_centroid_downscale_torch
from pixeloe.torch.downscale.lanczos import lanczos_resize
from pixeloe.torch.outline import outline_expansion

from .color_utils import (
    extract_palette,
    hex_to_rgb_array,
    map_to_palette,
    rgb_array_to_hex,
)
from .palettes import PRESET_PALETTES
from .params import ProcessParams


@dataclass
class PipelineResult:
    image: Image.Image  # RGBA, native pixel-art size
    palette: list[str]  # hex colors actually used (post-quantization)
    out_w: int
    out_h: int


# ---------------------------------------------------------------------------
# Alpha helpers
# ---------------------------------------------------------------------------


def _trim_transparent(img: np.ndarray) -> np.ndarray:
    """Crop away fully transparent borders (keeps a 1px margin)."""
    a = img[:, :, 3]
    ys, xs = np.nonzero(a)
    if len(ys) == 0:
        return img
    y0, y1 = max(0, ys.min() - 1), min(img.shape[0], ys.max() + 2)
    x0, x1 = max(0, xs.min() - 1), min(img.shape[1], xs.max() + 2)
    return img[y0:y1, x0:x1]


def _premultiplied_resize(rgba: np.ndarray, out_w: int, out_h: int) -> np.ndarray:
    """Resize RGBA float [H,W,4] via premultiplied alpha (bicubic, antialiased)."""
    t = torch.from_numpy(rgba).permute(2, 0, 1)[None]  # [1,4,H,W]
    rgb, a = t[:, :3], t[:, 3:4]
    pre = torch.cat([rgb * a, a], dim=1)
    resized = F.interpolate(pre, size=(out_h, out_w), mode="bicubic", antialias=True)
    resized = resized.clamp(0, 1)
    rgb_r = resized[:, :3] / resized[:, 3:4].clamp(min=1e-4)
    out = torch.cat([rgb_r.clamp(0, 1), resized[:, 3:4]], dim=1)
    return out[0].permute(1, 2, 0).numpy()


def _edge_extend(rgba: np.ndarray, iterations: int) -> np.ndarray:
    """Bleed edge colors into (near-)transparent regions so the downscaler and
    outline expansion never see undefined colors. Pure numpy, 4-neighbor flood."""
    rgb = rgba[:, :, :3].copy()
    known = rgba[:, :, 3] > 0.01
    if known.all() or not known.any():
        return rgba
    mean_color = rgb[known].mean(axis=0)
    for _ in range(iterations):
        if known.all():
            break
        acc = np.zeros_like(rgb)
        cnt = np.zeros(rgb.shape[:2])
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            sk = np.zeros_like(known)
            sc = np.zeros_like(rgb)
            src_y = slice(max(0, -dy), rgb.shape[0] - max(0, dy))
            dst_y = slice(max(0, dy), rgb.shape[0] - max(0, -dy))
            src_x = slice(max(0, -dx), rgb.shape[1] - max(0, dx))
            dst_x = slice(max(0, dx), rgb.shape[1] - max(0, -dx))
            sk[dst_y, dst_x] = known[src_y, src_x]
            sc[dst_y, dst_x] = rgb[src_y, src_x]
            acc += sc * sk[:, :, None]
            cnt += sk
        newly = (~known) & (cnt > 0)
        rgb[newly] = acc[newly] / cnt[newly][:, None]
        known |= newly
    rgb[~known] = mean_color
    out = rgba.copy()
    out[:, :, :3] = rgb
    return out


def _downscale_alpha(alpha: np.ndarray, detail: int, threshold: float, levels: int) -> np.ndarray:
    """Box-average alpha per output pixel, then snap to discrete levels."""
    t = torch.from_numpy(alpha)[None, None]
    small = F.avg_pool2d(t, kernel_size=detail)[0, 0].numpy()
    if levels <= 2:
        return (small >= threshold).astype(np.float64)
    # Shift the level grid so `threshold` is the opaque/transparent watershed.
    snapped = np.round(small * (levels - 1)) / (levels - 1)
    snapped[small < threshold / 2] = 0.0
    return snapped


# ---------------------------------------------------------------------------
# Scoring for offset search
# ---------------------------------------------------------------------------


def _sharpness(rgb_small: np.ndarray) -> float:
    """Mean absolute Laplacian of luma — higher = crisper pixel clusters."""
    luma = rgb_small.astype(np.float64) @ np.array([0.299, 0.587, 0.114])
    lap = (
        -4 * luma[1:-1, 1:-1]
        + luma[:-2, 1:-1]
        + luma[2:, 1:-1]
        + luma[1:-1, :-2]
        + luma[1:-1, 2:]
    )
    return float(np.abs(lap).mean())


# ---------------------------------------------------------------------------
# Main entry
# ---------------------------------------------------------------------------


def process_image(pil_img: Image.Image, params: ProcessParams) -> PipelineResult:
    img = pil_img.convert("RGBA")

    if params.contrast != 1.0:
        img = ImageEnhance.Contrast(img).enhance(params.contrast)
    if params.saturation != 1.0:
        img = ImageEnhance.Color(img).enhance(params.saturation)

    rgba = np.asarray(img).astype(np.float64) / 255.0
    has_alpha = bool((rgba[:, :, 3] < 0.99).any())
    if params.trim_transparent and has_alpha:
        rgba = _trim_transparent(rgba)

    h, w = rgba.shape[:2]
    if w >= h:
        out_w = params.target_size
        out_h = max(1, round(params.target_size * h / w))
    else:
        out_h = params.target_size
        out_w = max(1, round(params.target_size * w / h))

    detail = params.detail
    work = _premultiplied_resize(rgba, out_w * detail, out_h * detail)
    if has_alpha:
        work = _edge_extend(work, iterations=detail * (params.thickness + 2) + 8)

    def run_pixeloe(t: torch.Tensor) -> np.ndarray:
        with torch.no_grad():
            if params.thickness > 0:
                expanded, _ = outline_expansion(
                    t, params.thickness, params.thickness, detail
                )
            else:
                expanded = t
            if params.color_match:
                expanded = match_color(expanded, t)
            oh, ow = t.shape[2] // detail, t.shape[3] // detail
            match params.mode:
                case "contrast":
                    out = contrast_downscale(expanded, detail)
                case "k_centroid":
                    out = k_centroid_downscale_torch(expanded, detail, 2)
                case "lanczos":
                    out = lanczos_resize(expanded, size=(oh, ow))
                case "nearest":
                    out = F.interpolate(expanded, size=(oh, ow), mode="nearest-exact")
                case other:
                    out = F.interpolate(expanded, size=(oh, ow), mode=other)
        return (
            (out[0].permute(1, 2, 0).cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
        )

    def candidate(rgba_crop: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        rgb_t = torch.from_numpy(rgba_crop[:, :, :3]).float().permute(2, 0, 1)[None]
        small = run_pixeloe(rgb_t)
        a = (
            _downscale_alpha(
                np.ascontiguousarray(rgba_crop[:, :, 3]),
                detail,
                params.alpha.threshold,
                params.alpha.levels,
            )
            if has_alpha
            else np.ones((out_h, out_w))
        )
        return small, a

    if params.offset_search:
        # Shift the sampling grid by sub-pixel offsets (RGB and alpha together —
        # they must stay aligned) and keep the sharpest result.
        pad = detail
        padded = np.pad(work, ((pad, pad), (pad, pad), (0, 0)), mode="edge")
        best, best_score = None, -1.0
        for dy in (0, detail // 3, 2 * detail // 3):
            for dx in (0, detail // 3, 2 * detail // 3):
                crop = padded[dy : dy + out_h * detail, dx : dx + out_w * detail]
                small, a = candidate(crop)
                score = _sharpness(small)
                if score > best_score:
                    best, best_score = (small, a), score
        small_rgb, alpha_small = best
    else:
        small_rgb, alpha_small = candidate(work)

    # ---- palette stage -------------------------------------------------
    palette_hex: list[str]
    p = params.palette
    if p.source == "none":
        quantized = small_rgb
        opaque = quantized[alpha_small > 0]
        palette_hex = rgb_array_to_hex(np.unique(opaque.reshape(-1, 3), axis=0))[:256]
    else:
        if p.source == "auto":
            opaque_px = small_rgb[alpha_small > 0].reshape(-1, 3)
            palette = extract_palette(opaque_px, p.size)
        elif p.source == "preset":
            if not p.preset_name or p.preset_name not in PRESET_PALETTES:
                raise ValueError(f"Unknown preset palette: {p.preset_name!r}")
            palette = hex_to_rgb_array(PRESET_PALETTES[p.preset_name])
        else:  # custom
            if not p.colors:
                raise ValueError("Custom palette selected but no colors provided")
            palette = hex_to_rgb_array(p.colors)
        quantized = map_to_palette(small_rgb, palette, params.dither, params.dither_strength)
        palette_hex = rgb_array_to_hex(palette)

    if params.despeckle:
        quantized = _despeckle(quantized, alpha_small)

    out = np.dstack([quantized, (alpha_small * 255).round().astype(np.uint8)])
    out[out[:, :, 3] == 0, :3] = 0
    return PipelineResult(
        image=Image.fromarray(out, "RGBA"),
        palette=palette_hex,
        out_w=out_w,
        out_h=out_h,
    )


def _despeckle(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Replace orphan pixels (no same-colored neighbor) with the majority
    neighbor color. Single pass; transparent pixels are left alone."""
    h, w = rgb.shape[:2]
    if h < 3 or w < 3:
        return rgb
    out = rgb.copy()
    opaque = alpha > 0
    packed = (
        rgb[:, :, 0].astype(np.int64) << 16
        | rgb[:, :, 1].astype(np.int64) << 8
        | rgb[:, :, 2].astype(np.int64)
    )
    packed[~opaque] = -1
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            if not opaque[y, x]:
                continue
            c = packed[y, x]
            neigh = packed[y - 1 : y + 2, x - 1 : x + 2].ravel()
            neigh = np.delete(neigh, 4)
            neigh = neigh[neigh >= 0]
            if len(neigh) == 0 or (neigh == c).any():
                continue
            vals, counts = np.unique(neigh, return_counts=True)
            if counts.max() >= 5:
                m = int(vals[counts.argmax()])
                out[y, x] = [(m >> 16) & 255, (m >> 8) & 255, m & 255]
    return out


# ---------------------------------------------------------------------------
# Saving
# ---------------------------------------------------------------------------


def save_result(result: PipelineResult, path: str, fmt: str = "png", scale: int = 1) -> None:
    img = result.image
    if scale > 1:
        img = img.resize((img.width * scale, img.height * scale), Image.Resampling.NEAREST)
    if fmt == "png":
        # Indexed PNG when the palette fits (canonical pixel-art format).
        # FASTOCTREE is the only PIL quantizer that keeps RGBA; with <=256
        # actual colors it is exact, not lossy.
        flat = np.asarray(img.convert("RGBA"))
        n_colors = len(np.unique(flat.reshape(-1, 4), axis=0))
        if n_colors <= 256:
            indexed = img.quantize(colors=n_colors, method=Image.Quantize.FASTOCTREE)
            indexed.save(path, format="PNG", optimize=True)
        else:
            img.save(path, format="PNG")
    elif fmt == "webp":
        img.save(path, format="WEBP", lossless=True)
    else:
        img.convert("RGB").save(path, format="BMP")
