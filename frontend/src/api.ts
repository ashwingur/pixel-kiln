// Typed client for the Pixel Kiln backend. Types mirror backend/app/params.py.

export type DownscaleMode =
  | "contrast"
  | "k_centroid"
  | "lanczos"
  | "nearest"
  | "bilinear"
  | "bicubic";
export type PaletteSource = "auto" | "preset" | "custom" | "none";
export type DitherMode = "none" | "ordered" | "error_diffusion";
export type OutputFormat = "png" | "webp" | "bmp";

export interface PaletteParams {
  source: PaletteSource;
  size: number;
  preset_name: string | null;
  colors: string[] | null;
}

export interface AlphaParams {
  threshold: number;
  levels: number;
}

export interface ProcessParams {
  target_size: number;
  detail: number;
  thickness: number;
  mode: DownscaleMode;
  color_match: boolean;
  contrast: number;
  saturation: number;
  palette: PaletteParams;
  dither: DitherMode;
  dither_strength: number;
  alpha: AlphaParams;
  trim_transparent: boolean;
  despeckle: boolean;
  offset_search: boolean;
}

export interface OutputParams {
  format: OutputFormat;
  export_scale: number;
}

export const DEFAULT_PARAMS: ProcessParams = {
  target_size: 64,
  detail: 6,
  thickness: 2,
  mode: "contrast",
  color_match: true,
  contrast: 1,
  saturation: 1,
  palette: { source: "auto", size: 16, preset_name: null, colors: null },
  dither: "none",
  dither_strength: 0.35,
  alpha: { threshold: 0.5, levels: 2 },
  trim_transparent: true,
  despeckle: true,
  offset_search: false,
};

export const DEFAULT_OUTPUT: OutputParams = { format: "png", export_scale: 1 };

export interface UploadedImage {
  id: string;
  width: number;
  height: number;
  has_alpha: boolean;
}

export interface PreviewResult {
  png_base64: string;
  width: number;
  height: number;
  palette: string[];
  elapsed_ms: number;
}

export interface Preset {
  params: ProcessParams;
  output: OutputParams;
}

export interface FsListing {
  path: string;
  parent: string | null;
  dirs: string[];
  images: string[];
}

export interface DryRunResult {
  total_in_folder: number;
  results: {
    file: string;
    png_base64?: string;
    width?: number;
    height?: number;
    colors?: number;
    error?: string;
  }[];
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      // keep statusText
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export const api = {
  uploadImage(file: File): Promise<UploadedImage> {
    const form = new FormData();
    form.append("file", file);
    return request("/api/images", { method: "POST", body: form });
  },
  preview(
    imageId: string,
    params: ProcessParams,
    signal?: AbortSignal,
  ): Promise<PreviewResult> {
    return postJson("/api/preview", { image_id: imageId, params }, signal);
  },
  palettePresets(): Promise<Record<string, string[]>> {
    return request("/api/palettes/presets");
  },
  parsePaletteFile(file: File): Promise<{ colors: string[] }> {
    const form = new FormData();
    form.append("file", file);
    return request("/api/palettes/parse", { method: "POST", body: form });
  },
  sharedPalette(inputDir: string, size: number): Promise<{ colors: string[]; files: number }> {
    return postJson("/api/palettes/shared", { input_dir: inputDir, size });
  },
  listPresets(): Promise<Record<string, Preset>> {
    return request("/api/presets");
  },
  savePreset(name: string, preset: Preset): Promise<void> {
    return request(`/api/presets/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(preset),
    });
  },
  deletePreset(name: string): Promise<void> {
    return request(`/api/presets/${encodeURIComponent(name)}`, { method: "DELETE" });
  },
  fsList(path?: string): Promise<FsListing> {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    return request(`/api/fs/list${q}`);
  },
  dryRun(inputDir: string, params: ProcessParams, limit: number): Promise<DryRunResult> {
    return postJson("/api/jobs/dry-run", { input_dir: inputDir, params, limit });
  },
  startJob(req: {
    input_dir: string;
    output_dir: string;
    params: ProcessParams;
    output: OutputParams;
    skip_existing: boolean;
  }): Promise<{ job_id: string; total: number }> {
    return postJson("/api/jobs", req);
  },
  cancelJob(jobId: string): Promise<void> {
    return request(`/api/jobs/${jobId}/cancel`, { method: "POST" });
  },
};
