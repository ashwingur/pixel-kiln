import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

export function FolderPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState<string | undefined>(undefined);

  const listing = useQuery({
    queryKey: ["fs", browsePath ?? "~"],
    queryFn: () => api.fsList(browsePath),
    enabled: open,
  });

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-zinc-400">{label}</span>
      <div className="flex gap-2">
        <input
          className="inp flex-1 font-mono text-xs"
          value={value}
          placeholder="/home/you/images"
          onChange={(e) => onChange(e.target.value)}
        />
        <button className="btn" onClick={() => setOpen(true)}>
          Browse
        </button>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex max-h-[70vh] w-[480px] flex-col gap-2 rounded-lg border border-edge bg-panel p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs break-all text-zinc-300">
                {listing.data?.path ?? "…"}
              </span>
              <button
                className="btn"
                disabled={!listing.data?.parent}
                onClick={() =>
                  listing.data?.parent && setBrowsePath(listing.data.parent)
                }
              >
                ↑ Up
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto rounded border border-edge bg-panel-2">
              {listing.isError && (
                <p className="p-3 text-xs text-red-400">
                  {(listing.error as Error).message}
                </p>
              )}
              {listing.data?.dirs.map((d) => (
                <button
                  key={d}
                  className="block w-full cursor-pointer px-3 py-1.5 text-left text-sm text-zinc-300 hover:bg-panel"
                  onDoubleClick={() => setBrowsePath(`${listing.data.path}/${d}`)}
                  onClick={() => setBrowsePath(`${listing.data.path}/${d}`)}
                >
                  📁 {d}
                </button>
              ))}
              {listing.data && listing.data.dirs.length === 0 && (
                <p className="p-3 text-xs text-zinc-500">No subfolders</p>
              )}
            </div>
            {listing.data && (
              <p className="text-xs text-zinc-500">
                {listing.data.images.length} image
                {listing.data.images.length === 1 ? "" : "s"} in this folder
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={!listing.data}
                onClick={() => {
                  if (listing.data) onChange(listing.data.path);
                  setOpen(false);
                }}
              >
                Use this folder
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
