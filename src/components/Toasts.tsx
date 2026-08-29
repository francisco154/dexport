/**
 * DexPort — Toasts
 */

import { CheckCircle2, Info, AlertTriangle } from "lucide-react";
import { useStore } from "../store/store";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none absolute bottom-20 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="toast fade-in pointer-events-auto flex items-center gap-2.5"
          onClick={() => dismiss(t.id)}
        >
          {t.kind === "success" && <CheckCircle2 size={15} className="text-[#3ddc84]" />}
          {t.kind === "error" && <AlertTriangle size={15} className="text-red-400" />}
          {t.kind === "info" && <Info size={15} className="text-[#7dd3fc]" />}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
