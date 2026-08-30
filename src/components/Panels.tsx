/**
 * DexPort — MediaPanel / DevicePanel / SettingsPanel / ShortcutsModal
 * ════════════════════════════════════════════════════════════
 * MediaPanel: port del Media Center (sesiones multimedia, controles).
 * DevicePanel: port del panel de telemetría (batería, flags, info).
 * SettingsPanel: ajustes del display virtual (resolución, bitrate…).
 * ShortcutsModal: atajos de teclado del original.
 */

import {
  X,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Music2,
  Repeat,
  MoreHorizontal,
  BatteryCharging,
  Battery,
  Thermometer,
  Zap,
  Activity,
  Wifi,
  Bluetooth,
  Plane,
  Smartphone,
  Monitor,
  Keyboard,
  Link2,
  RotateCcw,
  Power,
  Trash2,
  Grid2x2,
  LayoutGrid,
  ChevronDown,
  ShieldCheck,
  Radar,
  Download,
  Loader2,
} from "lucide-react";
import { useStore } from "../store/store";
import { QUICK_KEYS } from "../utils/androidKeys";
import { readDeviceFlags, type DeviceFlags } from "../utils/telemetry";
import { CompanionStatusChip, CompanionInstallCard } from "./CompanionInstall";
import { useEffect, useState } from "react";

function PanelShell({
  title,
  subtitle,
  onClose,
  children,
  wide,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center p-6">
      <div
        className="absolute inset-0 bg-black/45"
        onClick={onClose}
      />
      <div
        className={`glass-dark scrollable fade-in relative max-h-full ${wide ? "w-full max-w-3xl" : "w-full max-w-md"} rounded-3xl p-6`}
      >
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 className="font-serif text-2xl italic text-white">{title}</h2>
            {subtitle && <p className="mt-1 text-[12px] text-[#9499a3]">{subtitle}</p>}
          </div>
          <button className="taskbar-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** ── Media Center (port del media_control del original) ── */
export function MediaPanel() {
  const open = useStore((s) => s.panels.mediaOpen);
  const togglePanel = useStore((s) => s.togglePanel);
  const sessions = useStore((s) => s.mediaSessions);
  const refreshTelemetry = useStore((s) => s.refreshTelemetry);
  const toast = useStore((s) => s.toast);
  const sendKeyAction = useStore((s) => s.sendKeyAction);

  if (!open) return null;

  const sendKey = (key: number) => {
    sendKeyAction(key);
    void refreshTelemetry();
  };

  return (
    <PanelShell
      title="Media Center"
      subtitle="Sesiones multimedia activas en el dispositivo (dumpsys media_session)"
      onClose={() => togglePanel("mediaOpen", false)}
      wide
    >
      {sessions.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-10 text-[#9499a3]">
          <Music2 size={28} />
          <p className="text-sm">
            No hay sesiones multimedia activas. Reproduce algo en el dispositivo.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {sessions.map((s, i) => (
            <div key={`${s.packageName}-${i}`} className="glass rounded-2xl p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2 text-[12px] text-[#9499a3]">
                  <Music2 size={14} className="text-[#3ddc84]" />
                  <span className="max-w-[220px] truncate">{s.packageName}</span>
                  {s.active && (
                    <span className="rounded-full bg-[#3ddc84]/15 px-2 py-0.5 text-[10px] font-semibold text-[#3ddc84]">
                      ACTIVA
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-[#5a606c]">
                  <Repeat size={14} />
                  <MoreHorizontal size={14} />
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="grid h-16 w-16 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#1d3a4a] to-[#0d2430] text-[#7dd3fc]">
                  <Music2 size={22} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-white">
                    {s.title || "Sin metadatos"}
                  </p>
                  <p className="truncate text-[12px] text-[#9499a3]">
                    {s.artist || "Artista desconocido"}
                  </p>
                  {/* Barra decorativa de progreso (el original mostraba posición real vía APK) */}
                  <div className="dex-progress-track mt-3">
                    <div className="dex-progress-fill" style={{ width: s.paused ? "0%" : "38%" }} />
                  </div>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-center gap-8">
                <button className="taskbar-btn" title="Anterior" onClick={() => sendKey(QUICK_KEYS.mediaPrevious)}>
                  <SkipBack size={20} />
                </button>
                <button
                  className="grid h-14 w-14 place-items-center rounded-full bg-white text-black transition hover:scale-105"
                  title={s.paused ? "Reproducir" : "Pausar"}
                  onClick={() => {
                    sendKey(QUICK_KEYS.mediaPlayPause);
                    toast("Comando enviado al dispositivo", "info");
                  }}
                >
                  {s.paused ? <Play size={22} /> : <Pause size={22} />}
                </button>
                <button className="taskbar-btn" title="Siguiente" onClick={() => sendKey(QUICK_KEYS.mediaNext)}>
                  <SkipForward size={20} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </PanelShell>
  );
}

/** ── Panel del dispositivo (telemetría AndroidCore port) ── */
export function DevicePanel() {
  const open = useStore((s) => s.panels.deviceOpen);
  const togglePanel = useStore((s) => s.togglePanel);
  const deviceInfo = useStore((s) => s.deviceInfo);
  const battery = useStore((s) => s.battery);
  const displayId = useStore((s) => s.displayId);
  const controlOnline = useStore((s) => s.controlOnline);
  const mirrorMode = useStore((s) => s.mirrorMode);
  const launcherPkg = useStore((s) => s.launcherPkg);
  const runningApps = useStore((s) => s.runningApps);
  const launchHome = useStore((s) => s.launchHome);
  const openLauncherPicker = useStore((s) => s.openLauncherPicker);
  const launchers = useStore((s) => s.launchers);
  const selectedLauncherComponent = useStore((s) => s.selectedLauncherComponent);
  const launcherActive = useStore((s) => s.launcherActive);
  const lastLauncherLog = useStore((s) => s.lastLauncherLog);
  const [flags, setFlags] = useState<DeviceFlags | null>(null);

  useEffect(() => {
    if (open) void readDeviceFlags().then(setFlags);
  }, [open, battery?.percentage]);

  if (!open) return null;

  const Stat = ({
    icon,
    label,
    value,
  }: {
    icon: React.ReactNode;
    label: string;
    value: string;
  }) => (
    <div className="glass flex items-center gap-3 rounded-2xl p-3">
      <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/5 text-[#3ddc84]">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wider text-[#5a606c]">{label}</p>
        <p className="truncate text-[13px] font-medium text-white">{value}</p>
      </div>
    </div>
  );

  return (
    <PanelShell
      title="Dispositivo"
      subtitle={deviceInfo ? `${deviceInfo.brand} ${deviceInfo.model} · Android ${deviceInfo.androidVersion} (SDK ${deviceInfo.sdk})` : undefined}
      onClose={() => togglePanel("deviceOpen", false)}
      wide
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat
          icon={<Monitor size={18} />}
          label="Display virtual"
          value={mirrorMode ? "Espejo (fallback)" : displayId != null ? `#${displayId} activo` : "Creando…"}
        />
        <Stat
          icon={<Activity size={18} />}
          label="Canal de control"
          value={controlOnline ? "Activo (scrcpy)" : "Vía shell (lento)"}
        />
        <Stat
          icon={<Smartphone size={18} />}
          label="Launcher del escritorio"
          value={
            selectedLauncherComponent
              ? launchers.find((l) => l.component === selectedLauncherComponent)?.label ??
                selectedLauncherComponent.split("/")[0]
              : launcherPkg ?? "—"
          }
        />
        <Stat
          icon={<Grid2x2 size={18} />}
          label="Apps visibles"
          value={`${runningApps.length} en el escritorio`}
        />
        <Stat
          icon={battery?.charging ? <BatteryCharging size={18} /> : <Battery size={18} />}
          label="Batería"
          value={battery ? `${battery.percentage}%${battery.charging ? " · cargando" : ""}` : "—"}
        />
        <Stat
          icon={<Thermometer size={18} />}
          label="Temperatura"
          value={battery?.temperature != null ? `${battery.temperature.toFixed(1)} °C` : "—"}
        />
        <Stat
          icon={<Zap size={18} />}
          label="Corriente"
          value={battery?.currentMa != null ? `${battery.currentMa > 0 ? "+" : ""}${battery.currentMa} mA` : "—"}
        />
        <Stat
          icon={<Activity size={18} />}
          label="Salud de batería"
          value={battery?.health ?? "—"}
        />
        <Stat
          icon={<Smartphone size={18} />}
          label="Serial"
          value={deviceInfo?.serial ?? "—"}
        />
        <Stat
          icon={<Monitor size={18} />}
          label="Tecnología"
          value={battery?.technology ?? "—"}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button
          className="btn-primary w-full"
          onClick={() => void launchHome()}
        >
          Relanzar launcher en el escritorio
        </button>
        <button
          className="btn-outline w-full"
          onClick={openLauncherPicker}
        >
          <LayoutGrid size={14} /> Elegir launcher…
        </button>
      </div>
      {selectedLauncherComponent && (
        <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-[#5a606c]">
          <ChevronDown size={11} />
          {launcherActive
            ? "Estado: abierto y verificado en el display virtual"
            : "Estado: sin verificar — pulsa «Relanzar» o elige otro en el selector"}
        </p>
      )}

      {/* v3: launcher ORIGINAL de Android DEX (companion APK) */}
      <div className="glass mt-3 rounded-2xl p-3.5">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[#5a606c]">
          Launcher original (com.shrey.androiddex)
        </p>
        <CompanionStatusChip />
        <CompanionInstallCard compact />
      </div>

      {/* v4: diagnóstico del launcher — salida cruda del último intento */}
      {lastLauncherLog && (
        <div className="glass mt-3 rounded-2xl p-3.5">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[#5a606c]">
            Diagnóstico del launcher (último intento)
          </p>
          <details>
            <summary className="cursor-pointer select-none text-[12px] text-[#8a93a3]">
              Ver detalles técnicos (salida real de ADB)
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded-xl bg-black/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-[#c9d1d9]">
              {lastLauncherLog}
            </pre>
          </details>
        </div>
      )}

      <h3 className="mb-3 mt-6 text-[11px] font-semibold uppercase tracking-widest text-[#5a606c]">
        Conectividad (polling vía settings)
      </h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          icon={<Wifi size={18} />}
          label="Wi-Fi"
          value={flags?.wifi == null ? "—" : flags.wifi ? "Encendido" : "Apagado"}
        />
        <Stat
          icon={<Bluetooth size={18} />}
          label="Bluetooth"
          value={flags?.bluetooth == null ? "—" : flags.bluetooth ? "Encendido" : "Apagado"}
        />
        <Stat
          icon={<Plane size={18} />}
          label="Modo avión"
          value={flags?.airplane == null ? "—" : flags.airplane ? "Activo" : "Inactivo"}
        />
        <Stat
          icon={<Link2 size={18} />}
          label="Transporte"
          value="WebUSB (WebADB)"
        />
      </div>
    </PanelShell>
  );
}

/** ── Ajustes del display virtual (v6: pantalla, personalización, calidad) ── */

/**
 * v8→v9: sección del DexPort Agent — estado + instalación + explicación.
 * v2: detección EXACTA de apps/ventanas + íconos y nombres reales +
 * espejo de notificaciones + launcher predefinido (HOME determinista).
 */
function AgentSettingsSection() {
  const agentStatus = useStore((s) => s.agentStatus);
  const agentPing = useStore((s) => s.agentPing);
  const agentInstall = useStore((s) => s.agentInstall);
  const installAgent = useStore((s) => s.installAgent);
  const checkAgent = useStore((s) => s.checkAgent);
  const notifListenerEnabled = useStore((s) => s.notifListenerEnabled);
  const notifications = useStore((s) => s.notifications);

  const busy =
    agentInstall.phase === "downloading" || agentInstall.phase === "pushing" ||
    agentInstall.phase === "installing" || agentInstall.phase === "enabling" ||
    agentInstall.phase === "verifying";

  const statusLabel: Record<string, string> = {
    checking: "Comprobando…",
    missing: "No instalado",
    "no-permission": "Instalado — falta permiso de accesibilidad",
    connected: "Activo",
    unknown: "Desconocido",
  };
  const statusColor: Record<string, string> = {
    checking: "text-[#9499a3]",
    missing: "text-[#f59e0b]",
    "no-permission": "text-[#f59e0b]",
    connected: "text-[#3ddc84]",
    unknown: "text-[#9499a3]",
  };

  return (
    <>
      <h3 className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-[#5a606c]">
        <Radar size={13} className="text-sky-300/70" />
        DexPort Agent v3 · detección + íconos + notificaciones
      </h3>
      <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-sky-400/15 bg-sky-400/5 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-white">
              App auxiliar con permiso de accesibilidad
            </p>
            <p className={`text-[11.5px] ${statusColor[agentStatus] ?? "text-[#9499a3]"}`}>
              {agentStatus === "connected" && agentPing
                ? `Activo v${agentPing.version} · Android ${agentPing.android} (${agentPing.device})`
                : statusLabel[agentStatus] ?? agentStatus}
            </p>
          </div>
          {agentStatus === "connected" ? (
            <span className="flex items-center gap-1.5 rounded-full bg-[#3ddc84]/15 px-3 py-1.5 text-[11.5px] font-semibold text-[#3ddc84]">
              <ShieldCheck size={13} /> OK
            </span>
          ) : busy ? (
            <span className="flex items-center gap-2 rounded-full bg-sky-400/10 px-3 py-1.5 text-[11.5px] text-sky-200">
              <Loader2 size={13} className="animate-spin" />
              {Math.round(agentInstall.progress * 100)}%
            </span>
          ) : (
            <button className="btn-solid !py-2 !text-[12px]" onClick={() => void installAgent()}>
              <Download size={12} />
              {agentStatus === "missing" ? "Instalar (54 KB)" : "Activar"}
            </button>
          )}
        </div>

        {/* v9: capacidades activas */}
        {agentStatus === "connected" && (
          <div className="flex flex-wrap gap-1.5 text-[10.5px]">
            <span className="rounded-full bg-[#3ddc84]/12 px-2.5 py-1 text-[#3ddc84]">
              ✓ apps y ventanas en vivo
            </span>
            <span className="rounded-full bg-[#38bdf8]/12 px-2.5 py-1 text-[#7dd3fc]">
              ✓ íconos y nombres reales
            </span>
            <span
              className={`rounded-full px-2.5 py-1 ${
                notifListenerEnabled
                  ? "bg-[#38bdf8]/12 text-[#7dd3fc]"
                  : "bg-[#f59e0b]/12 text-[#fbbf24]"
              }`}
            >
              {notifListenerEnabled
                ? `✓ notificaciones espejadas (${notifications.length})`
                : "⚠ notificaciones sin permiso"}
            </span>
            <span className="rounded-full bg-white/6 px-2.5 py-1 text-[#c3c9d4]">
              ✓ HOME al launcher predefinido
            </span>
            <span
              className={`rounded-full px-2.5 py-1 ${
                agentPing && agentPing.userId === 0
                  ? "bg-white/6 text-[#c3c9d4]"
                  : "bg-[#f59e0b]/12 text-[#fbbf24]"
              }`
            }
            >
              {agentPing && agentPing.userId === 0
                ? "✓ perfil principal"
                : "⚠ corre en perfil de trabajo"}
            </span>
          </div>
        )}

        <p className="text-[11.5px] leading-relaxed text-[#aab3bf]">
          El agente mapea lo que ADB no puede ver: apps y ventanas abiertas en
          ambas pantallas (título, actividad y foco por display), los íconos y
          nombres reales de TODAS las apps instaladas, las notificaciones activas
          del teléfono (centro de notificaciones del escritorio) y el launcher
          predefinido para que HOME lleve siempre al mismo sitio. v3
          reconstruido para no frenar NUNCA el teléfono: servicio de
          accesibilidad ultraligero, todo el trabajo pesado en un hilo de fondo
          y solo en el perfil principal (sin duplicados en Island). Se instala
          y recibe todos sus permisos por ADB — sin tocar el teléfono. Todo
          queda en tu dispositivo (USB).
        </p>
        {agentStatus === "no-permission" && (
          <p className="rounded-xl bg-amber-400/10 px-3 py-2 text-[11.5px] leading-relaxed text-amber-200">
            Si «Activar» no lo conecta, abre en el teléfono: Ajustes →
            Accesibilidad → DexPort Agent → activar. (Algunas ROMs lo piden
            manualmente la primera vez.)
          </p>
        )}
        {agentStatus === "connected" && !notifListenerEnabled && (
          <p className="rounded-xl bg-amber-400/10 px-3 py-2 text-[11.5px] leading-relaxed text-amber-200">
            El espejo de notificaciones no quedó activo en esta ROM. Pulsa
            «Activar» (reinstala y re-pide los permisos por ADB) o actívalo en
            Ajustes → Acceso a notificaciones → DexPort Agent · Notificaciones.
          </p>
        )}
        {agentStatus !== "connected" && !busy && (
          <button
            className="btn-ghost w-fit !py-1.5 !text-[11.5px]"
            onClick={() => void checkAgent()}
          >
            <RotateCcw size={11} /> Comprobar de nuevo
          </button>
        )}
      </div>
    </>
  );
}

export function SettingsPanel() {
  const open = useStore((s) => s.panels.settingsOpen);
  const togglePanel = useStore((s) => s.togglePanel);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const uiPrefs = useStore((s) => s.uiPrefs);
  const setUiPrefs = useStore((s) => s.setUiPrefs);
  const toast = useStore((s) => s.toast);
  const reconnectDesktop = useStore((s) => s.reconnectDesktop);
  const resizeDisplayToWindow = useStore((s) => s.resizeDisplayToWindow);

  if (!open) return null;

  const PRESETS = [
    { w: 1280, h: 720, dpi: 160 },
    { w: 1920, h: 1080, dpi: 160 },
    { w: 2560, h: 1440, dpi: 180 },
    { w: 1920, h: 1200, dpi: 160 },
  ];

  const apply = async (partial: Parameters<typeof setSettings>[0]) => {
    setSettings(partial);
    toast("Aplicando cambios… el display se reiniciará", "info");
    await reconnectDesktop();
    togglePanel("settingsOpen", false);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  };

  return (
    <PanelShell
      wide
      title="Ajustes"
      subtitle="Display virtual, pantalla completa y personalización (persistente en este navegador)"
      onClose={() => togglePanel("settingsOpen", false)}
    >
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-[#5a606c]">
        Modo de pantalla
      </h3>
      <div className="mb-5 grid grid-cols-2 gap-2">
        <button
          className={`glass rounded-2xl p-4 text-left transition ${settings.virtualDisplay ? "ring-1 ring-[#3ddc84]/60" : "hover:bg-white/5"}`}
          onClick={() => void apply({ virtualDisplay: true })}
        >
          <Monitor size={18} className="mb-2 text-[#3ddc84]" />
          <p className="text-sm font-semibold text-white">Display virtual DeX</p>
          <p className="mt-1 text-[11px] text-[#9499a3]">
            Escritorio independiente con ventanas libres (freeform)
          </p>
        </button>
        <button
          className={`glass rounded-2xl p-4 text-left transition ${!settings.virtualDisplay ? "ring-1 ring-[#3ddc84]/60" : "hover:bg-white/5"}`}
          onClick={() => void apply({ virtualDisplay: false })}
        >
          <Smartphone size={18} className="mb-2 text-[#7dd3fc]" />
          <p className="text-sm font-semibold text-white">Espejo de pantalla</p>
          <p className="mt-1 text-[11px] text-[#9499a3]">Duplica el display real del dispositivo</p>
        </button>
      </div>

      {/* ═══════════ v6: PANTALLA COMPLETA Y AJUSTE ═══════════ */}
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-[#5a606c]">
        Pantalla completa y ajuste
      </h3>
      <div className="mb-5 flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2">
          <button className="glass rounded-xl px-4 py-3 text-[13px] font-medium text-[#cfd4dc] transition hover:bg-white/5" onClick={toggleFullscreen}>
            ⤢ Pantalla completa ahora
          </button>
          <button
            className="glass rounded-xl px-4 py-3 text-[13px] font-medium text-[#cfd4dc] transition hover:bg-white/5"
            onClick={() => void resizeDisplayToWindow()}
            title="Redimensiona el display virtual EN VIVO al tamaño actual de la ventana — las apps abiertas no se cierran"
          >
            Ajustar display a la ventana
          </button>
        </div>
        <Toggle
          label="Ajustar a la ventana (sin bandas negras)"
          hint="El display virtual replica el aspecto de la ventana del navegador — pantalla completa real. Se aplica al reconectar."
          checked={settings.fitToWindow}
          onChange={() => void apply({ fitToWindow: !settings.fitToWindow })}
        />
        <Toggle
          label="Auto-ajustar al redimensionar"
          hint="Al mover la ventana o entrar en pantalla completa, el display se redimensiona en vivo (las apps siguen abiertas)."
          checked={settings.autoResize}
          onChange={(v) => setSettings({ autoResize: v })}
        />
        <Toggle
          label="Barra de tareas de Android dentro del escritorio"
          hint="Desactivada (recomendado): el botón HOME de Android deja el display gris y roba espacio. Usa los botones de DexPort en la barra inferior. Se aplica al reconectar."
          checked={settings.androidBars}
          onChange={() => void apply({ androidBars: !settings.androidBars })}
        />
        <Toggle
          label="Mantener el dispositivo despierto"
          hint="Como el original (wake-lock): la pantalla no se apaga mientras DexPort esté conectado por USB."
          checked={settings.keepScreenOn}
          onChange={() => void apply({ keepScreenOn: !settings.keepScreenOn })}
        />
        <Toggle
          label="Ocultar teclado virtual en el escritorio"
          hint="El teclado en pantalla no aparece en el display DeX — se escribe con el teclado físico del PC. Se aplica al reconectar."
          checked={settings.hideIme}
          onChange={() => void apply({ hideIme: !settings.hideIme })}
        />
      </div>

      {/* ═══════════ v6: PERSONALIZACIÓN ═══════════ */}
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-[#5a606c]">
        Personalización
      </h3>
      <div className="mb-5 flex flex-col gap-2">
        <Toggle
          label="Widget del reloj en el escritorio"
          hint="El reloj analógico de la esquina superior derecha."
          checked={uiPrefs.showClock}
          onChange={(v) => setUiPrefs({ showClock: v })}
        />
        <Toggle
          label="Botones de navegación en la barra"
          hint="Inicio, atrás, recientes y notificaciones — los botones propios de DexPort."
          checked={uiPrefs.showTaskbarNav}
          onChange={(v) => setUiPrefs({ showTaskbarNav: v })}
        />
        <Toggle
          label="Auto-ocultar la barra de tareas"
          hint="La barra se esconde y aparece al acercar el mouse al borde inferior."
          checked={uiPrefs.autoHideTaskbar}
          onChange={(v) => setUiPrefs({ autoHideTaskbar: v })}
        />
        <Toggle
          label="Botones de ventana estilo Windows"
          hint="Controles (minimizar · ventana · pantalla completa · cerrar) de la app activa, en la esquina superior derecha del escritorio."
          checked={uiPrefs.showWindowControls}
          onChange={(v) => setUiPrefs({ showWindowControls: v })}
        />
      </div>

      {/* ═══════════ v8: DEXPORT AGENT (accesibilidad) ═══════════ */}
      <AgentSettingsSection />

      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-[#5a606c]">
        Resolución del display virtual
      </h3>
      <div className="mb-2 grid grid-cols-2 gap-2">
        {PRESETS.map((p) => (
          <button
            key={`${p.w}x${p.h}`}
            className={`glass rounded-xl px-4 py-3 text-[13px] font-medium transition ${
              settings.width === p.w && settings.height === p.h
                ? "ring-1 ring-[#3ddc84]/60 text-white"
                : "text-[#cfd4dc] hover:bg-white/5"
            }`}
            onClick={() => void apply({ width: p.w, height: p.h, dpi: p.dpi, virtualDisplay: true })}
          >
            {p.w} × {p.h}
          </button>
        ))}
      </div>
      <p className="mb-5 text-[11px] leading-relaxed text-[#5a606c]">
        Con «Ajustar a la ventana» activo, la resolución elegida se usa como lado
        mayor y el aspecto se adapta a tu ventana (sin bandas negras).
      </p>

      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-[#5a606c]">
        Calidad de video
      </h3>
      <div className="mb-5 flex flex-col gap-3">
        <div>
          <div className="mb-1.5 flex justify-between text-[12px]">
            <span className="text-[#cfd4dc]">Bitrate</span>
            <span className="font-mono text-[#9499a3]">{(settings.videoBitRate / 1_000_000).toFixed(0)} Mbps</span>
          </div>
          <input
            type="range"
            min={2}
            max={30}
            step={2}
            value={settings.videoBitRate / 1_000_000}
            onChange={(e) => setSettings({ videoBitRate: Number(e.target.value) * 1_000_000 })}
            className="w-full accent-[#3ddc84]"
          />
        </div>
        <div>
          <div className="mb-1.5 flex justify-between text-[12px]">
            <span className="text-[#cfd4dc]">FPS máximos</span>
            <span className="font-mono text-[#9499a3]">{settings.maxFps || "sin límite"}</span>
          </div>
          <input
            type="range"
            min={0}
            max={120}
            step={15}
            value={settings.maxFps}
            onChange={(e) => setSettings({ maxFps: Number(e.target.value) })}
            className="w-full accent-[#3ddc84]"
          />
        </div>
        <div className="flex gap-2">
          {(["h264", "h265", "av1"] as const).map((c) => (
            <button
              key={c}
              className={`glass flex-1 rounded-xl px-3 py-2 text-[12px] font-semibold uppercase transition ${
                settings.videoCodec === c ? "ring-1 ring-[#3ddc84]/60 text-white" : "text-[#9499a3] hover:bg-white/5"
              }`}
              onClick={() => void apply({ videoCodec: c })}
            >
              {c}
            </button>
          ))}
        </div>
        <label className="glass flex cursor-pointer items-center justify-between rounded-xl px-4 py-3">
          <span className="text-[13px] text-[#cfd4dc]">Audio (opus · WebCodecs)</span>
          <input
            type="checkbox"
            checked={settings.audio}
            onChange={(e) => void apply({ audio: e.target.checked })}
            className="h-4 w-4 accent-[#3ddc84]"
          />
        </label>
        <p className="text-[11px] leading-relaxed text-[#5a606c]">
          El bitrate y los FPS se aplican al reiniciar el display (botón abajo).
        </p>
      </div>

      <div className="mt-6 flex justify-between gap-2 border-t border-white/8 pt-4">
        <button
          className="btn-outline !py-2.5 !text-[13px]"
          onClick={() => void apply({})}
          title="Reaplicar configuración reiniciando el display"
        >
          <RotateCcw size={14} /> Reiniciar display
        </button>
        <button
          className="btn-outline !border-red-500/30 !py-2.5 !text-[13px] !text-red-300 hover:!bg-red-500/10"
          onClick={async () => {
            togglePanel("settingsOpen", false);
            await useStore.getState().shutdown();
          }}
        >
          <Power size={14} /> Desconectar
        </button>
      </div>
    </PanelShell>
  );
}

/** interruptor glass reutilizable (v6) */
function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="glass flex cursor-pointer items-start justify-between gap-3 rounded-xl px-4 py-3">
      <span className="min-w-0">
        <span className="block text-[13px] text-[#cfd4dc]">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-relaxed text-[#5a606c]">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 accent-[#3ddc84]"
      />
    </label>
  );
}

/** ── Modal de atajos (port de la tabla de shortcuts del README) ── */
export function ShortcutsModal() {
  const open = useStore((s) => s.panels.shortcutsOpen);
  const togglePanel = useStore((s) => s.togglePanel);

  if (!open) return null;

  const SHORTCUTS: [string, string][] = [
    ["Ctrl + F", "Pantalla completa / salir"],
    ["Esc", "Salir de pantalla completa"],
    ["Ctrl + G", "Modo juego (aviso)"],
    ["F1", "Esta ayuda"],
    ["Clic derecho", "Botón Atrás (BACK)"],
    ["Clic central", "Botón Inicio (HOME)"],
    ["Rueda", "Scroll en el display"],
    ["Escribir", "Texto inyectado al dispositivo"],
    ["Modificadores", "Ctrl/Alt/Shift → metaState Android"],
  ];

  return (
    <PanelShell
      title="Atajos de teclado"
      subtitle="Port de los shortcuts del Android DEX original (los globales de SO no aplican en web)"
      onClose={() => togglePanel("shortcutsOpen", false)}
    >
      <div className="flex flex-col gap-2">
        {SHORTCUTS.map(([keys, desc]) => (
          <div key={keys} className="glass flex items-center justify-between rounded-xl px-4 py-3">
            <kbd className="rounded-md bg-white/10 px-2.5 py-1 font-mono text-[12px] text-white">
              {keys}
            </kbd>
            <span className="text-[13px] text-[#cfd4dc]">{desc}</span>
          </div>
        ))}
      </div>
      <div className="mt-5 flex items-start gap-2 text-[11px] leading-relaxed text-[#5a606c]">
        <Keyboard size={14} className="mt-0.5 shrink-0" />
        <p>
          Los atajos de nivel de sistema del original (Ctrl+Alt+flechas) no pueden
          capturarse desde el navegador; usa la taskbar para esas acciones.
        </p>
      </div>
    </PanelShell>
  );
}
