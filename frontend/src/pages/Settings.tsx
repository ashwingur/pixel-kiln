import { LuCheck } from "react-icons/lu";
import { setTheme, THEMES, useTheme } from "../theme";

export function SettingsPage() {
  const theme = useTheme();
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h2 className="mb-1 text-lg font-semibold text-zinc-100">Theme</h2>
      <p className="mb-4 text-sm text-zinc-500">
        Applies instantly and is remembered on this device.
      </p>
      <div className="grid grid-cols-2 gap-4">
        {THEMES.map((t) => {
          const selected = t.id === theme;
          return (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              className={`flex cursor-pointer flex-col gap-3 rounded-lg border p-4 text-left transition-colors ${
                selected
                  ? "border-accent bg-panel-2"
                  : "border-edge bg-panel hover:border-accent/50"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-zinc-100">{t.name}</span>
                {selected && <LuCheck className="text-accent" />}
              </div>
              <div
                className="flex items-center gap-2 rounded-md p-3"
                style={{ backgroundColor: t.preview[0] }}
              >
                {t.preview.slice(1).map((c, i) => (
                  <span
                    key={i}
                    className="h-6 w-6 rounded-full border border-black/40"
                    style={{ backgroundColor: c }}
                  />
                ))}
                <span
                  className="ml-auto rounded px-2 py-0.5 font-mono text-xs"
                  style={{ backgroundColor: t.preview[1], color: t.preview[2] }}
                >
                  Aa
                </span>
              </div>
              <span className="text-xs text-zinc-500">{t.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
