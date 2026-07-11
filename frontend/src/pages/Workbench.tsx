import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LuArrowRight,
  LuDownload,
  LuGamepad2,
  LuImagePlus,
  LuPin,
  LuTrash2,
} from "react-icons/lu";
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
  const [downloadScale, setDownloadScale] = useState(1);

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

  // Pasted/dropped images ask before replacing a loaded one; the explicit
  // file picker never asks (opening it is already a deliberate choice).
  const [pendingReplace, setPendingReplace] = useState<File | null>(null);
  const requestLoad = useCallback(
    (file: File | undefined | null) => {
      if (!file || !file.type.startsWith("image/")) return;
      if (source) setPendingReplace(file);
      else loadFile(file);
    },
    [source, loadFile],
  );

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // Don't hijack pastes into text fields (preset name, folder paths).
      if (
        e.target instanceof HTMLElement &&
        e.target.closest("input, textarea, [contenteditable]")
      )
        return;
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith("image/"),
      );
      const file = item?.getAsFile();
      if (file) {
        e.preventDefault();
        requestLoad(file);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [requestLoad]);

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

  // Scroll-wheel zoom, anchored on the cursor. React's onWheel is passive, so
  // attach natively to be able to preventDefault the pane scroll.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const pendingScroll = useRef<{ factor: number; cx: number; cy: number } | null>(null);
  useEffect(() => {
    const panes = [leftPane.current, rightPane.current].filter(
      (p): p is HTMLDivElement => !!p,
    );
    if (!panes.length) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const i = ZOOMS.indexOf(zoomRef.current);
      const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, i + dir))];
      if (next === zoomRef.current) return;
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      pendingScroll.current = {
        factor: next / zoomRef.current,
        cx: e.clientX - rect.left,
        cy: e.clientY - rect.top,
      };
      setZoom(next);
    };
    panes.forEach((p) => p.addEventListener("wheel", onWheel, { passive: false }));
    return () => panes.forEach((p) => p.removeEventListener("wheel", onWheel));
  }, [source]);

  // Apply the scroll correction after the images have re-rendered at the new
  // zoom (setting scroll before the resize would clamp against the old size).
  useLayoutEffect(() => {
    const p = pendingScroll.current;
    if (!p) return;
    pendingScroll.current = null;
    syncing.current = true;
    for (const pane of [leftPane.current, rightPane.current]) {
      if (!pane) continue;
      pane.scrollLeft = (pane.scrollLeft + p.cx) * p.factor - p.cx;
      pane.scrollTop = (pane.scrollTop + p.cy) * p.factor - p.cy;
    }
    requestAnimationFrame(() => (syncing.current = false));
  }, [zoom]);

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
              <LuTrash2 />
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
          requestLoad(e.dataTransfer.files?.[0]);
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
          {source && (
            <button
              className="btn flex max-w-64 items-center gap-2"
              title="Open a different image"
              onClick={() => fileInputRef.current?.click()}
            >
              <LuImagePlus className="shrink-0" />
              <span className="truncate text-xs">
                {source.name} ({source.meta.width}×{source.meta.height})
              </span>
            </button>
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
              className="accent-accent"
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
            <span className="flex items-center gap-1.5">
              <LuPin /> Pin
            </span>
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
            <button
              onClick={() => fileInputRef.current?.click()}
              className="group cursor-pointer rounded-xl border-2 border-dashed border-edge p-16 text-center text-zinc-500 transition-colors hover:border-accent hover:text-zinc-300"
            >
              <span className="mb-3 flex items-center justify-center gap-3 text-4xl text-zinc-600 transition-colors group-hover:text-accent">
                <LuImagePlus />
                <LuArrowRight className="text-2xl" />
                <LuGamepad2 />
              </span>
              <span>
                Drop an image here, <b>click to open</b>, or paste (Ctrl+V)
              </span>
            </button>
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
            <div className="ml-auto flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-zinc-400">
                Scale
                <select
                  className="inp"
                  value={downloadScale}
                  onChange={(e) => setDownloadScale(Number(e.target.value))}
                >
                  {[1, 2, 4, 8, 16].map((s) => (
                    <option key={s} value={s}>
                      {s * 100}%
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn flex items-center gap-1.5"
                onClick={() =>
                  downloadResult(
                    displayedResult,
                    downloadScale,
                    source ? source.name.replace(/\.[^.]+$/, "") + "_pixel.png" : "pixel.png",
                  )
                }
              >
                <LuDownload /> Download PNG
              </button>
            </div>
          )}
        </div>
      </section>

      {/* Replace confirmation for pasted / dropped images */}
      {pendingReplace && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setPendingReplace(null)}
        >
          <div
            className="flex w-96 flex-col gap-3 rounded-lg border border-edge bg-panel p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-sm font-semibold text-zinc-100">
              Replace the current image?
            </span>
            <p className="text-xs text-zinc-400">
              <span className="text-zinc-200">{pendingReplace.name || "Pasted image"}</span>{" "}
              will replace <span className="text-zinc-200">{source?.name}</span> on the
              workbench. The pinned snapshot will be cleared.
            </p>
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={() => setPendingReplace(null)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  loadFile(pendingReplace);
                  setPendingReplace(null);
                }}
              >
                Replace
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function downloadResult(
  result: { dataUrl: string; width: number; height: number },
  scale: number,
  filename: string,
) {
  const trigger = (href: string) => {
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    a.click();
  };
  if (scale <= 1) {
    trigger(result.dataUrl);
    return;
  }
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = result.width * scale;
    canvas.height = result.height * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false; // nearest-neighbor: keep pixels crisp
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    trigger(canvas.toDataURL("image/png"));
  };
  img.src = result.dataUrl;
}
