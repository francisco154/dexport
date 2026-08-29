/**
 * DexPort — Taskbar
 * ════════════════════════════════════════════════════════════
 * Port de la taskbar DeX del original: botones de navegación,
 * mini media player, botón de apps y bandeja del sistema
 * (batería, settings, reloj, fullscreen).
 */

import { useEffect, useState } from "react";
import {
  Home,
  ChevronLeft,
  ChevronUp,
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
} from "lucide-react";
import { displayEngine, useStore } from "../store/store";
import { webAdb } from "../services/adb";
import { QUICK_KEYS } from "../utils/androidKeys";

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
  const launchHome = useStore((s) => s.launchHome);
  const controlOnline = useStore((s) => s.controlOnline);
  const displayId = useStore((s) => s.displayId);
  const runningApps = useStore((s) => s.runningApps);

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
    <footer className="taskbar relative z-30 flex h-16 select-none items-center gap-2 px-3">
      {/* ── Navegación (izquierda) ── */}
      <div className="flex items-center gap-1">
        <button
          className="taskbar-btn"
          title="Inicio — abre el launcher del teléfono en el escritorio"
          onClick={() => void launchHome()}
        >
          <Home size={19} />
        </button>
        <button
          className="taskbar-btn"
          title="Atrás (Back)"
          onClick={() => sendKey(QUICK_KEYS.back)}
        >
          <ChevronLeft size={21} />
        </button>
        <button
          className="taskbar-btn"
          title="Recientes (App Switch)"
          onClick={() => sendKey(QUICK_KEYS.recents)}
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
        {/* v2: indicador de estado del canal de control */}
        <div
          className={`ml-1 h-2 w-2 rounded-full ${controlOnline ? "bg-[#3ddc84]" : "bg-[#f59e0b] pulse-glow"}`}
          title={
            controlOnline
              ? `Control activo (mouse/teclado) · ${runningApps.length} app(s) visible(s)${displayId != null ? ` · Display #${displayId}` : ""}`
              : "Canal de control no disponible — los botones usan comandos shell (más lentos)"
          }
        />
      </div>

      <div className="mx-1 h-8 w-px bg-white/10" />

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
      </div>
    </footer>
  );
}
