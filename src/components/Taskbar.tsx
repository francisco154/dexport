/**
 * DexPort — Taskbar
 * ════════════════════════════════════════════════════════════
 * Port de la taskbar DeX del original: botones de navegación,
 * mini media player, botón de apps y bandeja del sistema
 * (batería, settings, reloj, fullscreen).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Home,
  ChevronLeft,
  ChevronUp,
  ChevronDown,
  Grid2x2,
  Search,
  Settings,
  Maximize2,
  BatteryCharging,
  BatteryFull,
  Battery,
  Volume2,
  VolumeX,
  SkipBack,
  SkipForward,
  Play,
  Pause,
  MonitorSmartphone,
  Music2,
  Info,
  AppWindow,
  Expand,
  Minus,
  Square,
  X,
  LayoutGrid,
} from "lucide-react";
import { displayEngine, useStore } from "../store/store";
import { webAdb } from "../services/adb";
import { QUICK_KEYS } from "../utils/androidKeys";
import { appColor, appInitial, type AppEntry } from "../utils/appNames";
import type { TaskInfo } from "../utils/telemetry";

type TaskActionName = "front" | "minimize" | "kill" | "freeform" | "fullscreen";

/**
 * v7: menú contextual estilo Windows para una tarea de la franja.
 */
function TaskContextMenu({
  task,
  entry,
  x,
  y,
  onAction,
  onClose,
}: {
  task: TaskInfo;
  entry?: AppEntry;
  x: number;
  y: number;
  onAction: (a: TaskActionName) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as globalThis.Node)) onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const top = Math.min(y, window.innerHeight - 300);
  const left = Math.min(x, window.innerWidth - 230);
  const item = (label: string, icon: React.ReactNode, action: TaskActionName, danger = false) => (
    <button
      className={`task-ctx-item ${danger ? "danger" : ""}`}
      onClick={() => {
        onAction(action);
        onClose();
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div ref={ref} className="task-ctx fade-in" style={{ top, left }}>
      <div className="px-2.5 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-[#5a606c]">
        {entry?.label ?? task.packageName}
      </div>
      {item("Traer al frente", <Maximize2 size={14} />, "front")}
      {item("Abrir en ventana", <AppWindow size={14} />, "freeform")}
      {item("Pantalla completa", <Expand size={14} />, "fullscreen")}
      {item("Minimizar", <Minus size={14} />, "minimize")}
      <div className="mx-2 my-1 h-px bg-white/10" />
      {item("Cerrar (forzar)", <Square size={12} />, "kill", true)}
    </div>
  );
}

/**
 * v7: franja de tareas estilo Windows — apps abiertas en el escritorio.
 * · clic → traer al frente (o minimizar si ya está enfocada)
 * · clic derecho → menú contextual completo
 */
function RunningTasksStrip() {
  const runningApps = useStore((s) => s.runningApps);
  const displayId = useStore((s) => s.displayId);
  const userApps = useStore((s) => s.userApps);
  const systemApps = useStore((s) => s.systemApps);
  const taskAction = useStore((s) => s.taskAction);
  const launcherComponent = useStore((s) => s.selectedLauncherComponent);
  const [menu, setMenu] = useState<{
    task: TaskInfo;
    entry?: AppEntry;
    x: number;
    y: number;
  } | null>(null);

  const byPkg = useMemo(() => {
    const m = new Map<string, AppEntry>();
    for (const a of userApps) m.set(a.packageName, a);
    for (const a of systemApps) m.set(a.packageName, a);
    return m;
  }, [userApps, systemApps]);

  const vd = displayId ?? -1;
  const launcherPkg = launcherComponent?.split("/")[0] ?? null;
  // una entrada por app (la tarea superior); solo apps del display virtual
  // (el launcher NO cuenta: es el propio escritorio)
  const tasks = useMemo(() => {
    const seen = new Set<string>();
    const out: TaskInfo[] = [];
    for (const t of runningApps) {
      if (t.displayId !== vd) continue;
      if (launcherPkg && t.packageName === launcherPkg) continue;
      if (t.type === "home") continue;
      if (seen.has(t.packageName)) continue;
      seen.add(t.packageName);
      out.push(t);
    }
    return out.slice(0, 12);
  }, [runningApps, vd, launcherPkg]);

  if (tasks.length === 0) return null;

  return (
    <div
      className="scrollable-x flex items-center gap-1"
      onContextMenu={(e) => e.preventDefault()}
    >
      {tasks.map((t) => {
        const entry = byPkg.get(t.packageName);
        return (
          <button
            key={`${t.taskId}-${t.packageName}`}
            className={`task-app ${t.focused ? "is-focused" : "is-open"}`}
            title={
              `${entry?.label ?? t.packageName}\n` +
              `clic: traer al frente · clic derecho: más acciones`
            }
            onClick={() => void taskAction(t, t.focused ? "minimize" : "front")}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ task: t, entry, x: e.clientX, y: e.clientY - 8 });
            }}
          >
            {entry?.icon ? (
              <img src={entry.icon} alt={entry.label} draggable={false} />
            ) : (
              <span className="app-icon" style={{ background: appColor(t.packageName) }}>
                {appInitial(entry?.label ?? t.packageName)}
              </span>
            )}
          </button>
        );
      })}
      {menu && (
        <TaskContextMenu
          task={menu.task}
          entry={menu.entry}
          x={menu.x}
          y={menu.y}
          onAction={(a) => void taskAction(menu.task, a)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const time = now.toLocaleTimeString("es", {
    hour: "numeric",
    minute: "2-digit",
  });
  const date = now.toLocaleDateString("es", {
    weekday: "short",
    day: "numeric",
    month: "numeric",
  });
  return (
    <div className="flex flex-col items-end leading-tight">
      <span className="text-[13px] font-medium text-white">{time}</span>
      <span className="text-[10px] text-[#9499a3] capitalize">{date}</span>
    </div>
  );
}

function BatteryIndicator() {
  const battery = useStore((s) => s.battery);
  // v2: sin datos → no mostrar (v1 mostraba "0%" engañoso)
  if (!battery) {
    return (
      <div className="flex items-center gap-1 text-[#9499a3]" title="Telemetría no disponible aún">
        <Battery size={16} />
        <span className="text-[12px] font-medium">—</span>
      </div>
    );
  }
  const Icon = battery.charging
    ? BatteryCharging
    : battery.percentage >= 95
      ? BatteryFull
      : Battery;
  return (
    <div className="flex items-center gap-1.5 text-[#cfd4dc]" title={battery.charging ? "Cargando" : "Con batería"}>
      <Icon size={16} className={battery.charging ? "text-[#3ddc84]" : ""} />
      <span className="text-[12px] font-medium">{battery.percentage}%</span>
    </div>
  );
}

function MiniMediaPlayer() {
  const mediaSessions = useStore((s) => s.mediaSessions);
  const togglePanel = useStore((s) => s.togglePanel);
  const sendKeyAction = useStore((s) => s.sendKeyAction);
  const session = mediaSessions.find((s) => s.active) ?? mediaSessions[0];

  const sendKey = (key: number) => {
    sendKeyAction(key);
  };

  return (
    <div className="glass-dark flex items-center gap-2.5 rounded-full px-3 py-1.5">
      {session ? (
        <>
          <button
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#1d3a4a] to-[#0d2430] text-[#7dd3fc]"
            title={session.packageName}
            onClick={() => togglePanel("mediaOpen")}
          >
            <Music2 size={18} />
          </button>
          <button
            className="flex min-w-0 flex-col items-start"
            onClick={() => togglePanel("mediaOpen")}
            title="Abrir centro multimedia"
          >
            <span className="max-w-[130px] truncate text-[12px] font-medium text-white">
              {session.title || "Reproduciendo"}
            </span>
            <span className="max-w-[130px] truncate text-[10px] text-[#9499a3]">
              {session.artist || session.packageName}
            </span>
          </button>
          <div className="flex items-center gap-0.5">
            <button className="taskbar-btn !h-9 !w-9" title="Anterior" onClick={() => sendKey(QUICK_KEYS.mediaPrevious)}>
              <SkipBack size={15} />
            </button>
            <button
              className="taskbar-btn !h-9 !w-9"
              title={session.paused ? "Reproducir" : "Pausar"}
              onClick={() => sendKey(QUICK_KEYS.mediaPlayPause)}
            >
              {session.paused ? <Play size={16} /> : <Pause size={16} />}
            </button>
            <button className="taskbar-btn !h-9 !w-9" title="Siguiente" onClick={() => sendKey(QUICK_KEYS.mediaNext)}>
              <SkipForward size={15} />
            </button>
          </div>
        </>
      ) : (
        <button
          className="flex items-center gap-2 px-1 text-[11px] text-[#9499a3]"
          onClick={() => togglePanel("mediaOpen")}
        >
          <Music2 size={15} />
          <span>Sin sesión multimedia</span>
        </button>
      )}
    </div>
  );
}

export function Taskbar() {
  const togglePanel = useStore((s) => s.togglePanel);
  const panels = useStore((s) => s.panels);
  const deviceInfo = useStore((s) => s.deviceInfo);
  const audioMuted = useStore((s) => s.audioMuted);
  const setAudioMuted = useStore((s) => s.setAudioMuted);
  const settings = useStore((s) => s.settings);
  const sendKeyAction = useStore((s) => s.sendKeyAction);
  const sendNavKey = useStore((s) => s.sendNavKey);
  const goHomeSmart = useStore((s) => s.goHomeSmart);
  const controlOnline = useStore((s) => s.controlOnline);
  const displayId = useStore((s) => s.displayId);
  const runningApps = useStore((s) => s.runningApps);
  const showTaskbarNav = useStore((s) => s.uiPrefs.showTaskbarNav);
  const agentStatus = useStore((s) => s.agentStatus);
  const setUiPrefs = useStore((s) => s.setUiPrefs);

  const sendKey = (key: number) => {
    sendKeyAction(key);
  };

  const openNotifications = () => {
    const c = displayEngine.controller;
    if (c) {
      c.expandNotificationPanel().catch(() => undefined);
    } else {
      void webAdb.inputKeyevent(QUICK_KEYS.notification);
    }
  };

  return (
    <footer className="taskbar taskbar-float z-30 flex h-16 select-none items-center gap-2 px-4">
      {/* ── Navegación (izquierda) — ocultable desde Ajustes ── */}
      {showTaskbarNav && (
      <div className="flex items-center gap-1">
        <button
          className="taskbar-btn"
          title="Inicio — launcher del escritorio (instantáneo)"
          onClick={() => void goHomeSmart()}
        >
          <Home size={19} />
        </button>
        <button
          className="taskbar-btn"
          title="Atrás — dirigido al escritorio (display virtual)"
          onClick={() => void sendNavKey(QUICK_KEYS.back)}
        >
          <ChevronLeft size={21} />
        </button>
        <button
          className={`taskbar-btn ${panels.taskViewOpen ? "bg-white/12 text-white" : ""}`}
          title="Apps abiertas — vista de tareas estilo Windows"
          onClick={() => togglePanel("taskViewOpen")}
        >
          <ChevronUp size={19} />
        </button>
        <button
          className="taskbar-btn"
          title="Panel de notificaciones"
          onClick={openNotifications}
        >
          <Info size={18} />
        </button>
        {/* indicador de estado del canal de control + agente */}
        <div
          className={`ml-1 h-2 w-2 rounded-full ${controlOnline ? "bg-[#3ddc84]" : "bg-[#f59e0b] pulse-glow"}`}
          title={
            controlOnline
              ? `Control activo (mouse/teclado) · ${runningApps.length} tarea(s)${displayId != null ? ` · Display #${displayId}` : ""}`
              : "Canal de control no disponible — los botones usan comandos shell (más lentos)"
          }
        />
        {agentStatus === "connected" && (
          <div
                       className="h-2 w-2 rounded-full bg-[#38bdf8]"
            title="DexPort Agent activo — detección de apps y acciones exactas"
          />
        )}
      </div>
      )}

      <div className="mx-1 h-8 w-px bg-white/10" />

      {/* ── v7: franja de apps abiertas (estilo Windows) ── */}
      <RunningTasksStrip />

      {/* ── Mini media player (como el original) ── */}
      <MiniMediaPlayer />

      <div className="flex-1" />

      {/* ── Centro-izquierda: botón apps ── */}
      <button
        className={`taskbar-btn ${panels.drawerOpen ? "bg-white/12 text-white" : ""}`}
        title="Todas las apps"
        onClick={() => togglePanel("drawerOpen")}
      >
        <Grid2x2 size={19} />
      </button>

      <div className="mx-1 h-8 w-px bg-white/10" />

      {/* ── Bandeja del sistema (derecha) ── */}
      <div className="flex items-center gap-2.5">
        <button
          className="taskbar-btn !h-9 !w-9"
          title={audioMuted ? "Activar audio" : "Silenciar audio"}
          onClick={() => setAudioMuted(!audioMuted)}
        >
          {audioMuted ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </button>
        <button
          className="taskbar-btn !h-9 !w-9"
          title="Subir volumen"
          onClick={() => sendKey(QUICK_KEYS.volumeUp)}
        >
          <span className="text-[13px] font-bold">+</span>
        </button>
        <button
          className="taskbar-btn !h-9 !w-9"
          title="Bajar volumen"
          onClick={() => sendKey(QUICK_KEYS.volumeDown)}
        >
          <span className="text-[15px] font-bold">−</span>
        </button>

        <div className="mx-1 h-8 w-px bg-white/10" />

        <button
          className="flex items-center gap-1.5 rounded-xl px-2 py-1.5 text-[11px] text-[#9499a3] transition hover:bg-white/10 hover:text-white"
          title={`${deviceInfo?.name ?? ""} · Android ${deviceInfo?.androidVersion ?? ""} · ${settings.virtualDisplay ? `Display virtual ${settings.width}×${settings.height}${displayId != null ? ` (#${displayId})` : ""}` : "Espejo de pantalla"}`}
          onClick={() => togglePanel("deviceOpen")}
        >
          <MonitorSmartphone size={15} />
          <span className="max-w-[120px] truncate">{deviceInfo?.name ?? "Dispositivo"}</span>
        </button>

        <BatteryIndicator />

        <button
          className="taskbar-btn"
          title="Buscar en el dispositivo"
          onClick={() => togglePanel("drawerOpen")}
        >
          <Search size={17} />
        </button>
        <button
          className={`taskbar-btn ${panels.settingsOpen ? "bg-white/12 text-white" : ""}`}
          title="Ajustes de DexPort"
          onClick={() => togglePanel("settingsOpen")}
        >
          <Settings size={18} />
        </button>

        <button
          className="taskbar-btn"
          title="Pantalla completa (Ctrl+F)"
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void document.documentElement.requestFullscreen();
          }}
        >
          <Maximize2 size={17} />
        </button>

        <Clock />

        {/* ── v8: minimizar la barra flotante (la devuelve a su pastilla) ── */}
        <button
          className="taskbar-btn taskbar-collapse !h-9 !w-9"
          title="Minimizar barra — queda un botón pequeño en la esquina"
          onClick={() => setUiPrefs({ taskbarCollapsed: true })}
        >
          <ChevronDown size={17} />
        </button>
      </div>
    </footer>
  );
}

/**
 * v8: pastilla flotante de la barra minimizada — un botón pequeño que
 * no moleste; un clic (o hover en el borde inferior) la despliega de nuevo.
 */
export function TaskbarPill() {
  const setUiPrefs = useStore((s) => s.setUiPrefs);
  const runningApps = useStore((s) => s.runningApps);
  const displayId = useStore((s) => s.displayId);
  const vd = displayId ?? -1;
  const desktopCount = runningApps.filter(
    (t) => t.displayId !== 0 && t.displayId === vd,
  ).length;
  return (
    <button
      className="taskbar-pill fade-in"
      title="Mostrar barra de tareas"
      onClick={() => setUiPrefs({ taskbarCollapsed: false })}
    >
      <LayoutGrid size={15} className="text-[#7dd3fc]" />
      {desktopCount > 0 && (
        <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-[#38bdf8] px-1 text-[9px] font-bold text-[#04121f]">
          {desktopCount}
        </span>
      )}
    </button>
  );
}
