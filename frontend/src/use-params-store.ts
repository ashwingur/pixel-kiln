// Current processing params, shared between Workbench and Batch and persisted
// to localStorage so a tuned setup survives reloads.

import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_OUTPUT, DEFAULT_PARAMS } from "./api";
import type { OutputParams, ProcessParams } from "./api";

const KEY = "pixel-kiln:params";

interface Stored {
  params: ProcessParams;
  output: OutputParams;
}

let state: Stored = load();
const listeners = new Set<() => void>();

function load(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        params: {
          ...DEFAULT_PARAMS,
          ...parsed.params,
          palette: { ...DEFAULT_PARAMS.palette, ...parsed.params?.palette },
          alpha: { ...DEFAULT_PARAMS.alpha, ...parsed.params?.alpha },
        },
        output: { ...DEFAULT_OUTPUT, ...parsed.output },
      };
    }
  } catch {
    // fall through to defaults
  }
  return { params: DEFAULT_PARAMS, output: DEFAULT_OUTPUT };
}

function set(next: Stored) {
  state = next;
  localStorage.setItem(KEY, JSON.stringify(state));
  listeners.forEach((l) => l());
}

export function useParamsStore() {
  const snapshot = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );

  const setParams = useCallback(
    (update: Partial<ProcessParams>) =>
      set({ ...state, params: { ...state.params, ...update } }),
    [],
  );
  const setOutput = useCallback(
    (update: Partial<OutputParams>) =>
      set({ ...state, output: { ...state.output, ...update } }),
    [],
  );
  const replaceAll = useCallback(
    (params: ProcessParams, output: OutputParams) => set({ params, output }),
    [],
  );
  const reset = useCallback(
    () => set({ params: DEFAULT_PARAMS, output: DEFAULT_OUTPUT }),
    [],
  );

  return { ...snapshot, setParams, setOutput, replaceAll, reset };
}
