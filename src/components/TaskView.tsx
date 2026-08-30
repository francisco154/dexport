/**
 * DexPort v7 — TaskView («Apps abiertas», estilo Windows)
 * ════════════════════════════════════════════════════════════
 * El botón «Recientes» ya no envía APP_SWITCH al teléfono: abre esta
 * vista con las tareas reales del dispositivo (dumpsys activity).
 *
 * Acciones por tarjeta (port del WindowManager del original):
 *   · Traer al frente  — am start --display N (restaura tareas minimizadas)
 *   · Abrir en ventana — am start --windowingMode 5 (freeform estilo DeX)
 *   · Pantalla completa— am start --windowingMode 1
 *   · Minimizar        — am move-task → al teléfono (sigue viva)
 *   · Cerrar           — am force-stop
 */

import { useEffect, useMemo } from "react";
import {
  X,
  Maximize2,
  AppWindow,
  Expand,
  Minus,
  Square,
  MonitorSmartphone,
  Smartphone,
  LayoutGrid,
  RefreshCw,
  ShieldCheck,
  Download,
  Loader2,
  Radar,
} from "lucide-react";
import { useStore } from "../store/store";
import { appColor, appInitial, type AppEntry } from "../utils/appNames";
import type { TaskInfo } from "../utils/telemetry";

function AppIcon({ entry, pkg, size = 46 }: { entry?: AppEntry; pkg: string; size?: number }) {
  if (entry?.icon) {
    return (
      <img
        src={entry.icon}
        alt={entry.label}
        className="rounded-xl object-contain"
        style={{ width: size, height: size }}
        draggable={false}
      />
    );
  }
  return (
    <span
      className="app-icon"
      style={{ background: appColor(pkg), width: size, height: size }}
    >
      {appInitial(entry?.label ?? pkg)}
    </span>
  );
}

function TaskCard({
  task,
  entry,
  onAction,
}: {
  task: TaskInfo;
  entry?: AppEntry;
  onAction: (a: "front" | "minimize" | "kill" | "freeform" | "fullscreen") => void;
}) {
  const vd = useStore((s) => s.displayId);
  const onDesktop = task.displayId !== 0 && task.displayId === vd;
  const onPhone = !onDesktop;
  return (
    <div className="glass-dark group flex min-w-[270px] max-w-[300px] flex-1 flex-col gap-3 rounded-2xl p-4 transition hover:border-white/20">
      <div className="flex items-center gap-3">
        <AppIcon entry={entry} pkg={task.packageName} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-white">
              {entry?.label ?? task.packageName}
            </span>
            {task.focused && onDesktop && (
              <span className="rounded-full bg-[#3ddc84]/20 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[#3ddc84]">
                activa
              </span>
            )}
            {task.fromAgent && (
              <span
                className="text-[9px] text-sky-300/80"
                title="Detectada por el DexPort Agent (exacta)"
              >
                ●
              </span>
            )}
          </div>
          {/* v8: título real de la ventana cuando el agente está activo */}
          {task.title ? (
            <span className="block truncate text-[10px] text-[#7dd3fc]/80">{task.title}</span>
          ) : null}
          <span className="block truncate text-[10px] text-[#9499a3]">
            {task.packageName}
          </span>
          <span
            className={`mt-0.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold ${
              onDesktop
                ? "bg-[#38bdf8]/15 text-[#7dd3fc]"
                : "bg-white/8 text-[#9499a3]"
            }`}
          >
            {onDesktop ? <MonitorSmartphone size={10} /> : <Smartphone size={10} />}
            {onDesktop ? `Escritorio · #${task.displayId}` : "Teléfono (minimizada)"}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          className="act-btn"
          title="Traer al frente"
          onClick={() => onAction("front")}
        >
          <Maximize2 size={14} />
          <span>Frente</span>
        </button>
        <button
          className="act-btn"
          title="Abrir en ventana (freeform)"
          onClick={() => onAction("freeform")}
        >
          <AppWindow size={14} />
          <span>Ventana</span>
        </button>
        <button
          className="act-btn"
          title="Pantalla completa"
          onClick={() => onAction("fullscreen")}
        >
          <Expand size={14} />
          <span>Completa</span>
        </button>
        <button
          className="act-btn"
          title="Minimizar (al teléfono, sigue abierta)"
          onClick={() => onAction("minimize")}
        >
          <Minus size={14} />
          <span>Min</span>
        </button>
        <button
          className="act-btn act-danger"
          title="Cerrar (force-stop)"
          onClick={() => onAction("kill")}
        >
          <Square size={13} />
          <span>Cerrar</span>
        </button>
      </div>
    </div>
  );
}

/**
 * v8: tarjeta del DexPort Agent — la app con permiso de accesibilidad
 * que mapea TODO lo que ADB no ve (apps abiertas, ventanas, foco…).
 * Aparece en el TaskView cuando no hay tareas detectadas o cuando el
 * agente aún no está activo: es el fix real del «No hay apps abiertas».
 */
function AgentCard({ prominent = false }: { prominent?: boolean }) {
  const agentStatus = useStore((s) => s.agentStatus);
  const agentPing = useStore((s) => s.agentPing);
  const agentInstall = useStore((s) => s.agentInstall);
  const installAgent = useStore((s) => s.installAgent);
  const checkAgent = useStore((s) => s.checkAgent);

  if (agentStatus === "connected") {
    return (
      <div className="flex items-center gap-2 rounded-full border border-sky-400/25 bg-sky-400/10 px-3 py-1.5 text-[11.5px] text-sky-200">
        <ShieldCheck size={13} className="text-sky-300" />
        DexPort Agent activo{agentPing ? ` · Android ${agentPing.android}` : ""} —
        detección exacta de ventanas
      </div>
    );
  }

  // v11: agente desactivado por el usuario → no promocionarlo
  if (agentStatus === "disabled") return null;

  const busy = agentInstall.phase === "downloading" ||
    agentInstall.phase === "pushing" || agentInstall.phase === "installing" ||
    agentInstall.phase === "enabling" || agentInstall.phase === "verifying";

  if (busy) {
    return (
      <div className="flex items-center gap-2.5 rounded-2xl border border-sky-400/25 bg-sky-400/8 px-4 py-3 text-[12.5px] text-sky-100">
        <Loader2 size={15} className="animate-spin text-sky-300" />
        <span className="flex-1">DexPort Agent — {agentInstall.message}</span>
        <span className="font-mono text-[11px] text-sky-300">
          {Math.round(agentInstall.progress * 100)}%
        </span>
      </div>
    );
  }

  return (
    <div
      className={`${prominent ? "" : "mt-4"} flex flex-wrap items-center gap-3 rounded-2xl border border-sky-400/25 bg-sky-400/8 px-4 py-3`}
    >
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#0d3a42] to-[#051c2b] ring-1 ring-sky-300/20">
        <Radar size={16} className="text-sky-300" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-semibold text-white">
          {agentStatus === "no-permission"
            ? "Activa el DexPort Agent para ver las apps abiertas"
            : "Instala el DexPort Agent (45 KB) para ver las apps abiertas"}
        </p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-[#aab3bf]">
          App con permiso de accesibilidad que mapea ventanas, apps y foco de
          ambas pantallas — se instala y se le dan permisos por ADB, sin tocar
          el teléfono.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button className="btn-solid !py-2 !text-[12px]" onClick={() => void installAgent()}>
          <Download size={12} />
          {agentStatus === "no-permission" ? "Reintentar permisos" : "Instalar Agent"}
        </button>
        {agentStatus !== "missing" && (
          <button
            className="btn-ghost !py-2 !text-[12px]"
            title="Comprobar de nuevo"
            onClick={() => void checkAgent()}
          >
            <RefreshCw size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

export function TaskView() {
  const open = useStore((s) => s.panels.taskViewOpen);
  const togglePanel = useStore((s) => s.togglePanel);
  const runningApps = useStore((s) => s.runningApps);
  const displayId = useStore((s) => s.displayId);
  const userApps = useStore((s) => s.userApps);
  const systemApps = useStore((s) => s.systemApps);
  const taskAction = useStore((s) => s.taskAction);
  const refreshRunningApps = useStore((s) => s.refreshRunningApps);
  const agentStatus = useStore((s) => s.agentStatus);
  const launcherComponent = useStore((s) => s.selectedLauncherComponent);

  // refresco continuo mientras la vista está abierta (cada 2.5s)
  useEffect(() => {
    if (!open) return;
    void refreshRunningApps();
    const t = setInterval(() => void refreshRunningApps(), 2_500);
    return () => clearInterval(t);
  }, [open, refreshRunningApps]);

  const byPkg = useMemo(() => {
    const m = new Map<string, AppEntry>();
    for (const a of userApps) m.set(a.packageName, a);
    for (const a of systemApps) m.set(a.packageName, a);
    return m;
  }, [userApps, systemApps]);

  const vd = displayId ?? -1;
  const launcherPkg = launcherComponent?.split("/")[0] ?? null;
  // apps del escritorio — el launcher no cuenta (es el propio escritorio)
  const desktopTasks = runningApps.filter(
    (t) =>
      t.displayId !== 0 &&
      t.displayId === vd &&
      t.type !== "home" &&
      t.packageName !== launcherPkg,
  );
  const phoneTasks = runningApps.filter((t) => !(t.displayId !== 0 && t.displayId === vd));

  if (!open) return null;

  const doAction = (
    task: TaskInfo,
    a: "front" | "minimize" | "kill" | "freeform" | "fullscreen",
  ) => void taskAction(task, a);

  return (
    <div
      className="absolute inset-0 bottom-[92px] z-20 flex flex-col"
      onClick={(e) => {
        if (e.target === e.currentTarget) togglePanel("taskViewOpen", false);
      }}
    >
      <div className="glass-dark scrollable fade-in m-4 mb-2 flex-1 rounded-3xl p-6">
        {/* Header */}
          <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="font-serif text-2xl italic text-white">Apps abiertas</h2>
            <span className="text-[12px] text-[#9499a3]">
              {desktopTasks.length} en el escritorio
              {phoneTasks.length > 0 ? ` · ${phoneTasks.length} en el teléfono` : ""}
            </span>
            {agentStatus === "connected" && <AgentCard />}
          </div>
          <div className="flex items-center gap-2">
            {desktopTasks.length > 1 && (
              <button
                className="btn-ghost !px-3 !py-1.5 !text-[11px]"
                title="Force-stop de todas las apps del escritorio (excepto el launcher)"
                onClick={() => {
                  const launcherPkg =
                    useStore
                      .getState()
                      .selectedLauncherComponent?.split("/")[0] ?? "__none__";
                  for (const t of desktopTasks) {
                    if (t.packageName !== launcherPkg) void taskAction(t, "kill");
                  }
                }}
              >
                <X size={12} />
                Cerrar todo
              </button>
            )}
            <button
              className="taskbar-btn"
              title="Refrescar"
              onClick={() => void refreshRunningApps()}
            >
              <RefreshCw size={16} />
            </button>
            <button
              className="taskbar-btn"
              title="Cerrar"
              onClick={() => togglePanel("taskViewOpen", false)}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* v8: estado del agente (chip compacto arriba) */}
        {agentStatus !== "connected" && runningApps.length > 0 && <AgentCard />}

        {runningApps.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 py-10 text-[#9499a3]">
            <LayoutGrid size={34} className="opacity-40" />
            <p className="text-sm">
              No hay apps abiertas todavía — ábrelas desde el botón de apps
            </p>
            {/* v8: con apps abiertas que no aparecen → el agente lo arregla */}
            {agentStatus !== "connected" && <AgentCard prominent />}
          </div>
        ) : (
          <>
            {/* ── En el escritorio ── */}
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-[#5a606c]">
              En el escritorio {displayId != null ? `(#${displayId})` : ""}
            </h3>
            {desktopTasks.length === 0 ? (
              <p className="mb-6 text-sm text-[#9499a3]">
                El escritorio está vacío (solo el launcher). Abre una app desde el botón de apps.
              </p>
            ) : (
              <div className="mb-8 flex flex-wrap gap-3">
                {desktopTasks.map((t) => (
                  <TaskCard
                    key={`${t.taskId}-${t.packageName}`}
                    task={t}
                    entry={byPkg.get(t.packageName)}
                    onAction={(a) => doAction(t, a)}
                  />
                ))}
              </div>
            )}

            {/* ── En el teléfono (minimizadas / abiertas en el móvil) ── */}
            {phoneTasks.length > 0 && (
              <>
                <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-[#5a606c]">
                  En el teléfono · minimizadas
                </h3>
                <div className="flex flex-wrap gap-3">
                  {phoneTasks.map((t) => (
                    <TaskCard
                      key={`${t.taskId}-${t.packageName}`}
                      task={t}
                      entry={byPkg.get(t.packageName)}
                      onAction={(a) => doAction(t, a)}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
