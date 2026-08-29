/**
 * DexPort v8 — WindowControls
 * ════════════════════════════════════════════════════════════
 * Botones tipo Windows (minimizar · ventana · pantalla completa ·
 * cerrar) en una esquina del escritorio, aplicados a la app que
 * está enfocada EN EL DISPLAY VIRTUAL.
 *
 * Aparece solo cuando hay una app real al frente (no el launcher):
 * la detección exacta la da el DexPort Agent (título de ventana,
 * actividad y foco por display) con fallback al dump multi-fuente.
 */

import { useMemo } from "react";
import { AppWindow, Expand, Minus, X, MonitorSmartphone } from "lucide-react";
import { useStore } from "../store/store";
import { appColor, appInitial, type AppEntry } from "../utils/appNames";
import type { TaskInfo } from "../utils/telemetry";

export function WindowControls() {
  const phase = useStore((s) => s.phase);
  const displayId = useStore((s) => s.displayId);
  const runningApps = useStore((s) => s.runningApps);
  const userApps = useStore((s) => s.userApps);
  const systemApps = useStore((s) => s.systemApps);
  const taskAction = useStore((s) => s.taskAction);
  const launcherComponent = useStore((s) => s.selectedLauncherComponent);
  const showWindowControls = useStore((s) => s.uiPrefs.showWindowControls);
  const panels = useStore((s) => s.panels);
  const mirrorMode = useStore((s) => s.mirrorMode);

  const vd = displayId ?? -1;

  const byPkg = useMemo(() => {
    const m = new Map<string, AppEntry>();
    for (const a of userApps) m.set(a.packageName, a);
    for (const a of systemApps) m.set(a.packageName, a);
    return m;
  }, [userApps, systemApps]);

  const launcherPkg = launcherComponent?.split("/")[0] ?? null;

  /** la app enfocada del escritorio virtual (no el launcher) */
  const activeTask: TaskInfo | null = useMemo(() => {
    const onDesktop = runningApps.filter(
      (t) => t.displayId !== 0 && t.displayId === vd,
    );
    const focused =
      onDesktop.find((t) => t.focused) ??
      onDesktop.find((t) => t.visible) ??
      onDesktop[0] ??
      null;
    if (!focused) return null;
    if (launcherPkg && focused.packageName === launcherPkg) return null;
    if (focused.type === "home") return null;
    return focused;
  }, [runningApps, vd, launcherPkg]);

  if (
    phase !== "desktop" ||
    !showWindowControls ||
    mirrorMode ||
    displayId == null ||
    displayId <= 0 ||
    !activeTask ||
    panels.taskViewOpen
  ) {
    return null;
  }

  const entry = byPkg.get(activeTask.packageName);
  const label = activeTask.title || entry?.label || activeTask.packageName;

  return (
    <div className="win-controls fade-in">
      {/* app activa */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="win-controls-chip" title={`${label} · Display #${vd}`}>
          <MonitorSmartphone size={11} />
        </span>
        {entry?.icon ? (
          <img src={entry.icon} alt={label} draggable={false} />
        ) : (
          <span
            className="app-icon !h-6 !w-6 !rounded-lg !text-[10px]"
            style={{ background: appColor(activeTask.packageName) }}
          >
            {appInitial(label)}
          </span>
        )}
        <span className="max-w-[150px] truncate text-[12px] font-medium text-white">
          {label}
        </span>
      </div>

      {/* botones estilo Windows */}
      <div className="flex items-center gap-0.5">
        <button
          className="win-btn"
          title="Minimizar (al teléfono — sigue abierta)"
          onClick={() => void taskAction(activeTask, "minimize")}
        >
          <Minus size={13} />
        </button>
        <button
          className="win-btn"
          title="Abrir en ventana (freeform estilo DeX)"
          onClick={() => void taskAction(activeTask, "freeform")}
        >
          <AppWindow size={13} />
        </button>
        <button
          className="win-btn"
          title="Pantalla completa"
          onClick={() => void taskAction(activeTask, "fullscreen")}
        >
          <Expand size={12} />
        </button>
        <button
          className="win-btn win-btn-close"
          title="Cerrar aplicación"
          onClick={() => void taskAction(activeTask, "kill")}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
