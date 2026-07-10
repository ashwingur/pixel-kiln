"""Color math: Oklab conversion, k-means palette extraction, palette mapping
with optional dithering, and palette file parsing (.hex / .gpl).

Everything operates on numpy arrays. Images at this stage are tiny (the
downscaled pixel-art result), so plain numpy is plenty fast.
"""

from __future__ import annotations

import re

import numpy as np

# ---------------------------------------------------------------------------
# sRGB <-> Oklab (Björn Ottosson's constants)
# ---------------------------------------------------------------------------


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def srgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    """rgb: [..., 3] floats in [0, 1] -> oklab [..., 3]."""
    lin = srgb_to_linear(rgb)
    r, g, b = lin[..., 0], lin[..., 1], lin[..., 2]
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_, m_, s_ = np.cbrt(l), np.cbrt(m), np.cbrt(s)
    return np.stack(
        [
            0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
            1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
            0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
        ],
        axis=-1,
    )


# ---------------------------------------------------------------------------
# K-means palette extraction (in Oklab, deterministic)
# ---------------------------------------------------------------------------


def extract_palette(
    pixels_rgb: np.ndarray, num_colors: int, iters: int = 24, seed: int = 1337
) -> np.ndarray:
    """K-means over opaque pixels. pixels_rgb: [N, 3] uint8. Returns [K, 3] uint8,
    sorted dark->light for stable palette display."""
    if len(pixels_rgb) == 0:
        return np.zeros((1, 3), dtype=np.uint8)
    uniq = np.unique(pixels_rgb.reshape(-1, 3), axis=0)
    if len(uniq) <= num_colors:
        lab_l = srgb_to_oklab(uniq.astype(np.float64) / 255.0)[:, 0]
        return uniq[np.argsort(lab_l)].astype(np.uint8)

    rng = np.random.default_rng(seed)
    # Sample for speed; k-means++ init.
    n_sample = min(len(pixels_rgb), 50_000)
    sample = pixels_rgb[rng.choice(len(pixels_rgb), n_sample, replace=False)]
    data = srgb_to_oklab(sample.astype(np.float64) / 255.0)

    centroids = np.empty((num_colors, 3))
    centroids[0] = data[rng.integers(len(data))]
    d2 = np.full(len(data), np.inf)
    for k in range(1, num_colors):
        d2 = np.minimum(d2, ((data - centroids[k - 1]) ** 2).sum(axis=1))
        probs = d2 / d2.sum()
        centroids[k] = data[rng.choice(len(data), p=probs)]

    for _ in range(iters):
        dists = ((data[:, None, :] - centroids[None, :, :]) ** 2).sum(axis=2)
        labels = dists.argmin(axis=1)
        new_centroids = centroids.copy()
        for k in range(num_colors):
            mask = labels == k
            if mask.any():
                new_centroids[k] = data[mask].mean(axis=0)
        if np.abs(new_centroids - centroids).max() < 1e-5:
            centroids = new_centroids
            break
        centroids = new_centroids

    # Snap each centroid to the nearest actually-occurring color to avoid muddy averages.
    uniq_lab = srgb_to_oklab(uniq.astype(np.float64) / 255.0)
    snapped = []
    for c in centroids:
        idx = ((uniq_lab - c) ** 2).sum(axis=1).argmin()
        snapped.append(uniq[idx])
    palette = np.unique(np.array(snapped, dtype=np.uint8), axis=0)
    lab_l = srgb_to_oklab(palette.astype(np.float64) / 255.0)[:, 0]
    return palette[np.argsort(lab_l)]


# ---------------------------------------------------------------------------
# Palette mapping + dithering
# ---------------------------------------------------------------------------

_BAYER_8 = None


def _bayer8() -> np.ndarray:
    global _BAYER_8
    if _BAYER_8 is None:
        m = np.array([[0, 2], [3, 1]], dtype=np.float64)
        for _ in range(2):  # 2x2 -> 4x4 -> 8x8
            n = m.shape[0]
            m = np.block([[4 * m + 0, 4 * m + 2], [4 * m + 3, 4 * m + 1]])
            assert m.shape[0] == n * 2
        _BAYER_8 = m / 64.0 - 0.5  # [-0.5, 0.5)
    return _BAYER_8


def _nearest_indices(rgb: np.ndarray, palette_lab: np.ndarray) -> np.ndarray:
    """rgb: [H, W, 3] float in [0,1] -> index map [H, W] into palette."""
    lab = srgb_to_oklab(rgb)
    dists = ((lab[:, :, None, :] - palette_lab[None, None, :, :]) ** 2).sum(axis=3)
    return dists.argmin(axis=2)


def map_to_palette(
    img_rgb: np.ndarray,
    palette: np.ndarray,
    dither: str = "none",
    dither_strength: float = 0.35,
) -> np.ndarray:
    """img_rgb: [H, W, 3] uint8; palette: [K, 3] uint8. Returns mapped [H, W, 3] uint8."""
    pal_f = palette.astype(np.float64) / 255.0
    pal_lab = srgb_to_oklab(pal_f)
    img = img_rgb.astype(np.float64) / 255.0
    h, w = img.shape[:2]

    if dither == "ordered":
        b = _bayer8()
        tiled = np.tile(b, (h // 8 + 1, w // 8 + 1))[:h, :w]
        perturbed = np.clip(img + tiled[:, :, None] * dither_strength * 0.5, 0, 1)
        idx = _nearest_indices(perturbed, pal_lab)
    elif dither == "error_diffusion":
        idx = _floyd_steinberg(img, pal_f, pal_lab)
    else:
        idx = _nearest_indices(img, pal_lab)
    return palette[idx]


def _floyd_steinberg(img: np.ndarray, pal_f: np.ndarray, pal_lab: np.ndarray) -> np.ndarray:
    """Serial FS error diffusion. Images here are pixel-art sized, so the loop is fine."""
    h, w = img.shape[:2]
    buf = img.copy()
    idx = np.zeros((h, w), dtype=np.int64)
    for y in range(h):
        for x in range(w):
            px = np.clip(buf[y, x], 0, 1)
            lab = srgb_to_oklab(px[None, :])[0]
            k = int(((pal_lab - lab) ** 2).sum(axis=1).argmin())
            idx[y, x] = k
            err = px - pal_f[k]
            if x + 1 < w:
                buf[y, x + 1] += err * (7 / 16)
            if y + 1 < h:
                if x > 0:
                    buf[y + 1, x - 1] += err * (3 / 16)
                buf[y + 1, x] += err * (5 / 16)
                if x + 1 < w:
                    buf[y + 1, x + 1] += err * (1 / 16)
    return idx


# ---------------------------------------------------------------------------
# Palette file parsing
# ---------------------------------------------------------------------------

_HEX_RE = re.compile(r"^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$")


def parse_palette_text(text: str, filename: str = "") -> list[str]:
    """Parse .hex (one RRGGBB per line) or .gpl (GIMP palette) content into
    a list of '#rrggbb' strings. Raises ValueError if nothing parseable."""
    colors: list[str] = []
    if filename.lower().endswith(".gpl") or text.lstrip().startswith("GIMP Palette"):
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or ":" in line or line == "GIMP Palette":
                continue
            parts = line.split()
            if len(parts) >= 3:
                try:
                    r, g, b = (max(0, min(255, int(p))) for p in parts[:3])
                    colors.append(f"#{r:02x}{g:02x}{b:02x}")
                except ValueError:
                    continue
    else:
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith(";") or line.startswith("//"):
                continue
            m = _HEX_RE.match(line)
            if m:
                colors.append(f"#{m.group(1).lower()}")
    # Dedupe preserving order
    seen: set[str] = set()
    out = [c for c in colors if not (c in seen or seen.add(c))]
    if not out:
        raise ValueError("No colors found in palette file")
    return out


def hex_to_rgb_array(hex_colors: list[str]) -> np.ndarray:
    out = []
    for c in hex_colors:
        c = c.lstrip("#")
        out.append([int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)])
    return np.array(out, dtype=np.uint8)


def rgb_array_to_hex(palette: np.ndarray) -> list[str]:
    return [f"#{r:02x}{g:02x}{b:02x}" for r, g, b in palette.astype(int)]
