import { useCallback, useEffect, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { PreviewResult, UploadedImage } from "../api";
import { ParamPanel } from "../components/ParamPanel";
import { PaletteStrip } from "../components/PaletteStrip";
import { useParamsStore } from "../use-params-store";

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

const ZOOMS = [1, 2, 3, 4, 6, 8, 12, 16];

interface Pinned {
  dataUrl: string;
  width: number;
  height: number;
  palette: string[];
}

export function WorkbenchPage() {
  const { params, output, replaceAll } = useParamsStore();
  const queryClient = useQueryClient();

  const [source, setSource] = useState<{
    meta: UploadedImage;
    objectUrl: string;
    name: string;
    file: File;
  } | null>(null);
  const [zoom, setZoom] = useState(6);
  const [showGrid, setShowGrid] = useState(false);
  const [pinned, setPinned] = useState<Pinned | null>(null);
  const [showPinned, setShowPinned] = useState(false);
  const [presetName, setPresetName] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const leftPane = useRef<HTMLDivElement>(null);
  const rightPane = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  const upload = useMutation({
    mutationFn: api.uploadImage,
    onSuccess: (meta, file) => {
      setSource((prev) => {
        if (prev) URL.revokeObjectURL(prev.objectUrl);
        return { meta, objectUrl: URL.createObjectURL(file), name: file.name, file };
      });
      setPinned(null);
      setShowPinned(false);
    },
  });

  const loadFile = useCallback(
    (file: File | undefined | null) => {
      if (file && file.type.startsWith("image/")) upload.mutate(file);
    },
    [upload],
  );

  // Re-upload on backend restart (image cache is in-memory).
  const debouncedParams = useDebounced(params, 350);
  const preview = useQuery<PreviewResult, Error>({
    queryKey: ["preview", source?.meta.id, debouncedParams],
    queryFn: ({ signal }) => api.preview(source!.meta.id, debouncedParams, signal),
    enabled: !!source,
    placeholderData: keepPreviousData,
    retry: false,
  });
  useEffect(() => {
    if (preview.error?.message.includes("re-upload") && source) {
      upload.mutate(source.file);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.error]);

  const presets = useQuery({ queryKey: ["presets"], queryFn: api.listPresets });
  const savePreset = useMutation({
    mutationFn: ({ name }: { name: string }) => api.savePreset(name, { params, output }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["presets"] }),
  });
  const deletePreset = useMutation({
    mutationFn: api.deletePreset,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["presets"] }),
  });

  const result = preview.data;
  const displayedResult =
    showPinned && pinned
      ? pinned
      : result
        ? {
            dataUrl: `data:image/png;base64,${result.png_base64}`,
            width: result.width,
            height: result.height,
            palette: result.palette,
          }
        : null;

  const syncScroll = (from: "left" | "right") => {
    if (syncing.current) return;
    syncing.current = true;
    const a = from === "left" ? leftPane.current : rightPane.current;
    const b = from === "left" ? rightPane.current : leftPane.current;
    if (a && b) {
      b.scrollLeft = a.scrollLeft;
      b.scrollTop = a.scrollTop;
    }
    requestAnimationFrame(() => (syncing.current = false));
  };

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="w-80 shrink-0 overflow-y-auto border-r border-edge p-3">
        {/* Presets */}
        <div className="mb-3 flex flex-col gap-2 rounded-lg border border-edge bg-panel p-3">
          <span className="text-xs font-semibold tracking-wider text-accent-2 uppercase">
            Presets
          </span>
          <div className="flex gap-2">
            <select
              className="inp flex-1"
              value=""
              onChange={(e) => {
                const p = presets.data?.[e.target.value];
                if (p) {
                  replaceAll(p.params, p.output);
                  setPresetName(e.target.value);
                }
              }}
            >
              <option value="">Load preset…</option>
              {Object.keys(presets.data ?? {}).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <input
              className="inp min-w-0 flex-1"
              placeholder="Preset name"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
            />
            <button
              className="btn"
              disabled={!presetName.trim() || savePreset.isPending}
              onClick={() => savePreset.mutate({ name: presetName.trim() })}
            >
              Save
            </button>
            <button
              className="btn"
              disabled={!presetName.trim() || !presets.data?.[presetName.trim()]}
              title="Delete this preset"
              onClick={() => deletePreset.mutate(presetName.trim())}
            >
              ✕
            </button>
          </div>
          {savePreset.isSuccess && <span className="text-xs text-green-400">Saved.</span>}
        </div>

        <ParamPanel hasAlpha={source?.meta.has_alpha ?? true} />
      </aside>

      {/* Main area */}
      <section
        className="flex min-w-0 flex-1 flex-col"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          loadFile(e.dataTransfer.files?.[0]);
        }}
      >
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-edge bg-panel px-3 py-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              loadFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button className="btn-primary" onClick={() => fileInputRef.current?.click()}>
            Open image…
          </button>
          {source && (
            <span className="max-w-48 truncate text-xs text-zinc-400" title={source.name}>
              {source.name} ({source.meta.width}×{source.meta.height})
            </span>
          )}
          <div className="mx-2 h-5 w-px bg-edge" />
          <span className="text-xs text-zinc-400">Zoom</span>
          <button
            className="btn"
            onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)])}
          >
            −
          </button>
          <span className="w-8 text-center font-mono text-sm">{zoom}×</span>
          <button
            className="btn"
            onClick={() =>
              setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)])
            }
          >
            +
          </button>
          <label className="ml-2 flex cursor-pointer items-center gap-1 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={showGrid}
              onChange={(e) => setShowGrid(e.target.checked)}
              className="accent-(--color-accent)"
            />
            Pixel grid
          </label>
          <div className="mx-2 h-5 w-px bg-edge" />
          <button
            className="btn"
            disabled={!result}
            title="Snapshot the current result for A/B comparison"
            onClick={() => {
              if (result)
                setPinned({
                  dataUrl: `data:image/png;base64,${result.png_base64}`,
                  width: result.width,
                  height: result.height,
                  palette: result.palette,
                });
            }}
          >
            📌 Pin
          </button>
          <button
            className={`btn ${showPinned ? "border-accent text-accent" : ""}`}
            disabled={!pinned}
            title="Toggle between the pinned snapshot (B) and the live result (A)"
            onClick={() => setShowPinned((s) => !s)}
          >
            {showPinned ? "Showing B (pinned)" : "Showing A (live)"}
          </button>
          <div className="ml-auto text-xs text-zinc-500">
            {preview.isFetching
              ? "processing…"
              : result
                ? `${result.width}×${result.height} · ${result.palette.length} colors · ${result.elapsed_ms}ms`
                : ""}
          </div>
        </div>

        {/* Panes */}
        {!source ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="rounded-xl border-2 border-dashed border-edge p-16 text-center text-zinc-500">
              <p className="mb-2 text-4xl">🖼️ → 👾</p>
              <p>
                Drop an image here or click <b>Open image…</b>
              </p>
            </div>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-px bg-edge">
            <div
              ref={leftPane}
              onScroll={() => syncScroll("left")}
              className="checker overflow-auto"
            >
              <div className="flex min-h-full min-w-full items-center justify-center p-8">
                {displayedResult && (
                  <img
                    src={source.objectUrl}
                    alt="original"
                    style={{ width: displayedResult.width * zoom }}
                    className="max-w-none"
                  />
                )}
              </div>
            </div>
            <div className="relative min-h-0">
              <div
                ref={rightPane}
                onScroll={() => syncScroll("right")}
                className="checker h-full overflow-auto"
              >
                <div className="flex min-h-full min-w-full items-center justify-center p-8">
                  {displayedResult && (
                    <div className="relative">
                      <img
                        src={displayedResult.dataUrl}
                        alt="pixel art result"
                        width={displayedResult.width * zoom}
                        height={displayedResult.height * zoom}
                        className="pixelated max-w-none"
                      />
                      {showGrid && zoom >= 4 && (
                        <div
                          className="pointer-events-none absolute inset-0"
                          style={{
                            backgroundImage:
                              "linear-gradient(to right, rgba(255,255,255,0.12) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.12) 1px, transparent 1px)",
                            backgroundSize: `${zoom}px ${zoom}px`,
                          }}
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>
              {(preview.isFetching || upload.isPending) && (
                <div className="pointer-events-none absolute top-3 right-3 z-10 flex items-center gap-2 rounded-full border border-edge bg-panel/90 px-3 py-1.5 text-xs text-zinc-300 shadow-lg backdrop-blur-sm">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                  {upload.isPending ? "uploading…" : "processing…"}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer: palette + errors */}
        <div className="flex min-h-10 items-center gap-4 border-t border-edge bg-panel px-3 py-2">
          {preview.isError && !preview.error.message.includes("re-upload") && (
            <span className="text-xs text-red-400">{preview.error.message}</span>
          )}
          {displayedResult && <PaletteStrip colors={displayedResult.palette} />}
          {displayedResult && (
            <a
              href={displayedResult.dataUrl}
              download={source ? source.name.replace(/\.[^.]+$/, "") + "_pixel.png" : "pixel.png"}
              className="btn ml-auto"
            >
              ⬇ Download PNG
            </a>
          )}
        </div>
      </section>
    </div>
  );
}
