import { useState } from "react";

export function PaletteStrip({ colors }: { colors: string[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  if (!colors.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {colors.map((c, i) => (
        <button
          key={`${c}-${i}`}
          title={`${c} (click to copy)`}
          onClick={() => {
            navigator.clipboard.writeText(c);
            setCopied(c);
            setTimeout(() => setCopied(null), 800);
          }}
          className="h-6 w-6 cursor-pointer rounded-sm border border-black/40 transition-transform hover:scale-125"
          style={{ backgroundColor: c }}
        />
      ))}
      <span className="ml-2 text-xs text-zinc-500">
        {copied ? `copied ${copied}` : `${colors.length} colors`}
      </span>
    </div>
  );
}
