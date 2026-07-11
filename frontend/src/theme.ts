// Theme store: localStorage-persisted, applied as a data-theme attribute on
// <html>. The CSS variable overrides live in index.css.

import { useSyncExternalStore } from "react";

export interface Theme {
  id: string;
  name: string;
  description: string;
  // Swatches for the settings-page preview cards: bg, surface, accent, accent-2
  preview: [string, string, string, string];
}

export const THEMES: Theme[] = [
  {
    id: "moss",
    name: "Dark Green",
    description: "Mossy surfaces with a soft green accent",
    preview: ["#111813", "#1e2b22", "#7fd08f", "#e3c56e"],
  },
  {
    id: "ember",
    name: "Ember",
    description: "The original kiln look — warm amber on slate",
    preview: ["#16161d", "#262633", "#e8a33d", "#7dc4ff"],
  },
  {
    id: "crimson",
    name: "Dark Red",
    description: "Deep wine surfaces with a crimson accent",
    preview: ["#191114", "#2c1c1f", "#f07178", "#ffb86b"],
  },
  {
    id: "abyss",
    name: "Abyss",
    description: "Cold deep blue with an icy accent",
    preview: ["#101420", "#1c2438", "#7dc4ff", "#e8a33d"],
  },
];

const KEY = "pixel-kiln:theme";
const DEFAULT_THEME = "moss";

let current: string = (() => {
  const stored = localStorage.getItem(KEY);
  return stored && THEMES.some((t) => t.id === stored) ? stored : DEFAULT_THEME;
})();

const listeners = new Set<() => void>();

function apply() {
  document.documentElement.dataset.theme = current;
}

export function setTheme(id: string) {
  if (!THEMES.some((t) => t.id === id)) return;
  current = id;
  localStorage.setItem(KEY, id);
  apply();
  listeners.forEach((l) => l());
}

export function useTheme(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

// Apply on module load so there's no flash of the wrong theme.
apply();
