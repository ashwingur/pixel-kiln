import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api";
import type { DryRunResult, OutputFormat } from "../api";
import { FolderPicker } from "../components/FolderPicker";
import { PaletteStrip } from "../components/PaletteStrip";
import { useParamsStore } from "../use-params-store";

const DIRS_KEY = "pixel-kiln:batch-dirs";

interface JobEvent {
  type: string;
  index?: number;
  total?: number;
  file?: string;
  out?: string;
  error?: string;
  skipped?: boolean;
  completed?: number;
  errors?: { file: string; error: string }[];
}

export function BatchPage() {
  const { params, output, setOutput, setParams } = useParamsStore();

  const [dirs, setDirs] = useState<{ input: string; output: string }>(() => {
    try {
      return JSON.parse(localStorage.getItem(DIRS_KEY) ?? "") ?? { input: "", output: "" };
    } catch {
      return { input: "", output: "" };
    }
  });
  useEffect(() => {
    localStorage.setItem(DIRS_KEY, JSON.stringify(dirs));
  }, [dirs]);

  const [skipExisting, setSkipExisting] = useState(true);
  const [sharedSize, setSharedSize] = useState(16);
  const [dryRunData, setDryRunData] = useState<DryRunResult | null>(null);

  const [job, setJob] = useState<{ id: string; total: number } | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [jobDone, setJobDone] = useState<JobEvent | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const sharedPalette = useMutation({
    mutationFn: () => api.sharedPalette(dirs.input, sharedSize),
    onSuccess: ({ colors }) =>
      setParams({
        palette: { source: "custom", size: sharedSize, preset_name: null, colors },
      }),
  });

  const dryRun = useMutation({
    mutationFn: () => api.dryRun(dirs.input, params, 8),
    onSuccess: setDryRunData,
  });

  const startJob = useMutation({
    mutationFn: () =>
      api.startJob({
        input_dir: dirs.input,
        output_dir: dirs.output,
        params,
        output,
        skip_existing: skipExisting,
      }),
    onSuccess: ({ job_id, total }) => {
      setJob({ id: job_id, total });
      setEvents([]);
      setJobDone(null);
      const es = new EventSource(`/api/jobs/${job_id}/events`);
      esRef.current = es;
      es.onmessage = (msg) => {
        const event: JobEvent = JSON.parse(msg.data);
        if (event.type === "snapshot") return;
        setEvents((prev) => [...prev, event]);
        if (["done", "error", "cancelled"].includes(event.type)) {
          setJobDone(event);
          es.close();
        }
      };
      es.onerror = () => es.close();
    },
  });

  useEffect(() => () => esRef.current?.close(), []);

  const progressCount = events.filter((e) =>
    ["progress", "file_error"].includes(e.type),
  ).length;
  const running = !!job && !jobDone;

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-4 overflow-y-auto p-4">
      <div className="grid grid-cols-2 gap-4">
        <FolderPicker
          label="Input folder"
          value={dirs.input}
          onChange={(input) => setDirs((d) => ({ ...d, input }))}
        />
        <FolderPicker
          label="Output folder"
          value={dirs.output}
          onChange={(output) => setDirs((d) => ({ ...d, output }))}
        />
      </div>

      {/* Settings summary + output options */}
      <div className="flex flex-wrap items-end gap-4 rounded-lg border border-edge bg-panel p-3">
        <div className="text-xs leading-5 text-zinc-400">
          <p className="mb-1 font-semibold tracking-wider text-accent-2 uppercase">
            Processing settings
          </p>
          <p>
            {params.target_size}px · detail {params.detail} · {params.mode} · outline{" "}
            {params.thickness} ·{" "}
            {params.palette.source === "auto"
              ? `auto ${params.palette.size} colors`
              : params.palette.source === "preset"
                ? params.palette.preset_name
                : params.palette.source === "custom"
                  ? `custom (${params.palette.colors?.length ?? 0} colors)`
                  : "full color"}{" "}
            · dither {params.dither}
          </p>
          <Link to="/" className="text-accent-2 underline">
            Tune on the Workbench →
          </Link>
        </div>
        <div className="ml-auto flex items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="lbl">Format</span>
            <select
              className="inp"
              value={output.format}
              onChange={(e) => setOutput({ format: e.target.value as OutputFormat })}
            >
              <option value="png">PNG (indexed)</option>
              <option value="webp">WebP (lossless)</option>
              <option value="bmp">BMP</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="lbl">Upscale</span>
            <select
              className="inp"
              value={output.export_scale}
              onChange={(e) => setOutput({ export_scale: Number(e.target.value) })}
            >
              {[1, 2, 4, 8, 16].map((s) => (
                <option key={s} value={s}>
                  {s === 1 ? "native" : `${s}×`}
                </option>
              ))}
            </select>
          </label>
          <label className="flex cursor-pointer items-center gap-2 pb-1.5 text-sm">
            <input
              type="checkbox"
              checked={skipExisting}
              onChange={(e) => setSkipExisting(e.target.checked)}
              className="accent-(--color-accent)"
            />
            Skip existing
          </label>
        </div>
      </div>

      {/* Shared palette */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-edge bg-panel p-3">
        <span className="text-xs font-semibold tracking-wider text-accent-2 uppercase">
          Shared palette
        </span>
        <span className="text-xs text-zinc-500">
          Extract one palette from every image in the input folder so the whole set matches.
        </span>
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          Colors
          <input
            type="number"
            min={2}
            max={64}
            value={sharedSize}
            onChange={(e) => setSharedSize(Number(e.target.value))}
            className="inp w-16"
          />
        </label>
        <button
          className="btn"
          disabled={!dirs.input || sharedPalette.isPending}
          onClick={() => sharedPalette.mutate()}
        >
          {sharedPalette.isPending ? "Extracting…" : "Extract & use"}
        </button>
        {sharedPalette.isError && (
          <span className="text-xs text-red-400">
            {(sharedPalette.error as Error).message}
          </span>
        )}
        {params.palette.source === "custom" && params.palette.colors && (
          <PaletteStrip colors={params.palette.colors} />
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          className="btn"
          disabled={!dirs.input || dryRun.isPending}
          onClick={() => dryRun.mutate()}
        >
          {dryRun.isPending ? "Processing…" : "Dry run (first 8)"}
        </button>
        <button
          className="btn-primary"
          disabled={!dirs.input || !dirs.output || running || startJob.isPending}
          onClick={() => startJob.mutate()}
        >
          {running ? "Running…" : "Run batch"}
        </button>
        {running && (
          <button className="btn" onClick={() => job && api.cancelJob(job.id)}>
            Cancel
          </button>
        )}
        {(dryRun.isError || startJob.isError) && (
          <span className="text-xs text-red-400">
            {((dryRun.error ?? startJob.error) as Error).message}
          </span>
        )}
      </div>

      {/* Progress */}
      {job && (
        <div className="flex flex-col gap-2 rounded-lg border border-edge bg-panel p-3">
          <div className="flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded bg-panel-2">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${(progressCount / job.total) * 100}%` }}
              />
            </div>
            <span className="font-mono text-xs text-zinc-400">
              {progressCount}/{job.total}
            </span>
          </div>
          {jobDone && (
            <p
              className={`text-sm ${jobDone.type === "done" ? "text-green-400" : "text-amber-400"}`}
            >
              {jobDone.type === "done"
                ? `Done — ${jobDone.completed}/${job.total} written to ${dirs.output}${
                    jobDone.errors?.length ? `, ${jobDone.errors.length} failed` : ""
                  }`
                : jobDone.type === "cancelled"
                  ? "Cancelled."
                  : `Job failed: ${jobDone.error}`}
            </p>
          )}
          <div className="max-h-40 overflow-y-auto font-mono text-xs leading-5 text-zinc-500">
            {[...events].reverse().map((e, i) =>
              e.type === "progress" ? (
                <p key={i}>
                  ✔ {e.file}
                  {e.skipped ? " (skipped, exists)" : ""}
                </p>
              ) : e.type === "file_error" ? (
                <p key={i} className="text-red-400">
                  ✘ {e.file}: {e.error}
                </p>
              ) : null,
            )}
          </div>
        </div>
      )}

      {/* Dry run grid */}
      {dryRunData && (
        <div className="rounded-lg border border-edge bg-panel p-3">
          <p className="mb-2 text-xs text-zinc-400">
            Dry run — first {dryRunData.results.length} of {dryRunData.total_in_folder} images
            (nothing written):
          </p>
          <div className="grid grid-cols-4 gap-3">
            {dryRunData.results.map((r) => (
              <div
                key={r.file}
                className="checker flex flex-col items-center gap-1 rounded border border-edge p-2"
              >
                {r.png_base64 ? (
                  <img
                    src={`data:image/png;base64,${r.png_base64}`}
                    alt={r.file}
                    className="pixelated max-h-40 w-full object-contain"
                    style={{ imageRendering: "pixelated" }}
                  />
                ) : (
                  <p className="text-xs text-red-400">{r.error}</p>
                )}
                <span className="max-w-full truncate bg-panel/80 px-1 text-xs text-zinc-300">
                  {r.file}
                  {r.width ? ` · ${r.width}×${r.height}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
