import { useEffect, useRef, useState } from "react";
import { LuMinus, LuPlus } from "react-icons/lu";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { DitherMode, DownscaleMode, PaletteSource } from "../api";
import { useParamsStore } from "../use-params-store";
import { PaletteStrip } from "./PaletteStrip";

function NumberField({
  value,
  min,
  max,
  step,
  onChange,
  suffix,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  // Follow external changes (slider drags, preset loads) while not typing.
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const parsed = Number(draft.replace(",", "."));
    if (Number.isNaN(parsed)) {
      setDraft(String(value));
      return;
    }
    // Snap to the step grid so the slider and backend stay consistent.
    const snapped = Math.round(parsed / step) * step;
    const clamped = Math.min(max, Math.max(min, Number(snapped.toFixed(4))));
    setDraft(String(clamped));
    onChange(clamped);
  };

  return (
    <span className="flex items-center gap-1 font-mono text-zinc-300">
      <input
        className="inp w-16 py-0 text-right font-mono text-xs"
        value={draft}
        inputMode="decimal"
        onFocus={(e) => {
          setEditing(true);
          e.target.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(String(value));
            setEditing(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {suffix && <span className="text-xs text-zinc-500">{suffix}</span>}
    </span>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
  annotation,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  suffix?: string;
  annotation?: (v: number) => string | null;
}) {
  const note = annotation?.(value);
  const nudge = (dir: 1 | -1) => {
    const next = Number((value + dir * step).toFixed(4));
    onChange(Math.min(max, Math.max(min, next)));
  };
  return (
    <label className="flex flex-col gap-1">
      <span className="lbl">
        <span>
          {label}
          {note && <span className="ml-1 text-zinc-500">({note})</span>}
        </span>
        <NumberField
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={onChange}
          suffix={suffix}
        />
      </span>
      <span className="flex items-center gap-1.5">
        <button
          type="button"
          className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border border-edge bg-panel-2 text-xs text-zinc-400 hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          disabled={value <= min}
          onClick={() => nudge(-1)}
        >
          <LuMinus />
        </button>
        <input
          type="range"
          className="min-w-0 flex-1"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <button
          type="button"
          className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border border-edge bg-panel-2 text-xs text-zinc-400 hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          disabled={value >= max}
          onClick={() => nudge(1)}
        >
          <LuPlus />
        </button>
      </span>
    </label>
  );
}

function Check({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm" title={hint}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-accent"
      />
      {label}
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-edge bg-panel p-3">
      <legend className="px-1 text-xs font-semibold tracking-wider text-accent-2 uppercase">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

export function ParamPanel({ hasAlpha }: { hasAlpha: boolean }) {
  const { params, setParams, reset } = useParamsStore();
  const paletteFileRef = useRef<HTMLInputElement>(null);

  const presets = useQuery({
    queryKey: ["palette-presets"],
    queryFn: api.palettePresets,
  });

  const setPalette = (update: Partial<typeof params.palette>) =>
    setParams({ palette: { ...params.palette, ...update } });

  return (
    <div className="flex flex-col gap-3">
      <Section title="Size & downscale">
        <Slider
          label="Output size (long side)"
          value={params.target_size}
          min={8}
          max={512}
          onChange={(v) => setParams({ target_size: v })}
          suffix="px"
        />
        <Slider
          label="Detail (source px per output px)"
          value={params.detail}
          min={3}
          max={10}
          onChange={(v) => setParams({ detail: v })}
        />
        <label className="flex flex-col gap-1">
          <span className="lbl">Downscale mode</span>
          <select
            className="inp"
            value={params.mode}
            onChange={(e) => setParams({ mode: e.target.value as DownscaleMode })}
          >
            <option value="contrast">Contrast (best for most art)</option>
            <option value="k_centroid">K-centroid (flat colors)</option>
            <option value="lanczos">Lanczos (soft)</option>
            <option value="nearest">Nearest</option>
            <option value="bilinear">Bilinear</option>
            <option value="bicubic">Bicubic</option>
          </select>
        </label>
        <Slider
          label="Outline expansion"
          value={params.thickness}
          min={0}
          max={6}
          onChange={(v) => setParams({ thickness: v })}
          annotation={(v) => (v === 0 ? "off" : null)}
        />
        <Check
          label="Color match"
          hint="Re-match colors to the original after outline expansion"
          checked={params.color_match}
          onChange={(v) => setParams({ color_match: v })}
        />
        <Check
          label="Grid offset search (slower, sharper)"
          hint="Try 9 sub-pixel grid alignments and keep the crispest"
          checked={params.offset_search}
          onChange={(v) => setParams({ offset_search: v })}
        />
      </Section>

      <Section title="Palette">
        <label className="flex flex-col gap-1">
          <span className="lbl">Source</span>
          <select
            className="inp"
            value={params.palette.source}
            onChange={(e) => setPalette({ source: e.target.value as PaletteSource })}
          >
            <option value="auto">Auto (k-means from image)</option>
            <option value="preset">Retro preset</option>
            <option value="custom">Custom (.hex / .gpl)</option>
            <option value="none">No reduction</option>
          </select>
        </label>
        {params.palette.source === "auto" && (
          <Slider
            label="Colors"
            value={params.palette.size}
            min={2}
            max={64}
            onChange={(v) => setPalette({ size: v })}
          />
        )}
        {params.palette.source === "preset" && (
          <label className="flex flex-col gap-1">
            <span className="lbl">Preset</span>
            <select
              className="inp"
              value={params.palette.preset_name ?? ""}
              onChange={(e) => setPalette({ preset_name: e.target.value })}
            >
              <option value="" disabled>
                Pick a palette…
              </option>
              {Object.keys(presets.data ?? {}).map((name) => (
                <option key={name} value={name}>
                  {name} ({presets.data![name].length})
                </option>
              ))}
            </select>
            {params.palette.preset_name && presets.data?.[params.palette.preset_name] && (
              <PaletteStrip colors={presets.data[params.palette.preset_name]} />
            )}
          </label>
        )}
        {params.palette.source === "custom" && (
          <div className="flex flex-col gap-2">
            <input
              ref={paletteFileRef}
              type="file"
              accept=".hex,.gpl,.txt"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  const { colors } = await api.parsePaletteFile(file);
                  setPalette({ colors });
                } catch (err) {
                  alert((err as Error).message);
                }
                e.target.value = "";
              }}
            />
            <button className="btn" onClick={() => paletteFileRef.current?.click()}>
              Import .hex / .gpl file
            </button>
            {params.palette.colors ? (
              <PaletteStrip colors={params.palette.colors} />
            ) : (
              <p className="text-xs text-zinc-500">
                No palette loaded yet (or extract a shared one on the Batch page).
              </p>
            )}
          </div>
        )}
        {params.palette.source !== "none" && (
          <>
            <label className="flex flex-col gap-1">
              <span className="lbl">Dither</span>
              <select
                className="inp"
                value={params.dither}
                onChange={(e) => setParams({ dither: e.target.value as DitherMode })}
              >
                <option value="none">None (cleanest for sprites)</option>
                <option value="ordered">Ordered / Bayer (stable pattern)</option>
                <option value="error_diffusion">Floyd–Steinberg (organic)</option>
              </select>
            </label>
            {params.dither === "ordered" && (
              <Slider
                label="Dither strength"
                value={params.dither_strength}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => setParams({ dither_strength: v })}
              />
            )}
          </>
        )}
      </Section>

      <Section title="Adjustments">
        <Slider
          label="Contrast"
          value={params.contrast}
          min={0.5}
          max={2}
          step={0.05}
          onChange={(v) => setParams({ contrast: v })}
          suffix="×"
        />
        <Slider
          label="Saturation"
          value={params.saturation}
          min={0}
          max={2}
          step={0.05}
          onChange={(v) => setParams({ saturation: v })}
          suffix="×"
        />
        <Check
          label="Despeckle"
          hint="Merge orphan single pixels into their neighborhood"
          checked={params.despeckle}
          onChange={(v) => setParams({ despeckle: v })}
        />
      </Section>

      {hasAlpha && (
        <Section title="Transparency">
          <Slider
            label="Alpha threshold"
            value={params.alpha.threshold}
            min={0.05}
            max={0.95}
            step={0.05}
            onChange={(v) => setParams({ alpha: { ...params.alpha, threshold: v } })}
          />
          <Slider
            label="Alpha levels"
            value={params.alpha.levels}
            min={2}
            max={8}
            onChange={(v) => setParams({ alpha: { ...params.alpha, levels: v } })}
            annotation={(v) => (v === 2 ? "hard 1-bit" : null)}
          />
          <Check
            label="Trim transparent border"
            checked={params.trim_transparent}
            onChange={(v) => setParams({ trim_transparent: v })}
          />
        </Section>
      )}

      <button className="btn self-start" onClick={reset}>
        Reset to defaults
      </button>
    </div>
  );
}
