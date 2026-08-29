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
          label="Launcher"
          value={launcherPkg ?? "—"}
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

      <div className="mt-4">
        <button
          className="btn-primary w-full"
          onClick={() => void launchHome()}
        >
          Relanzar launcher en el escritorio
        </button>
      </div>

      {/* v3: launcher ORIGINAL de Android DEX (companion APK) */}
      <div className="glass mt-3 rounded-2xl p-3.5">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[#5a606c]">
          Launcher original (com.shrey.androiddex)
        </p>
        <CompanionStatusChip />
        <CompanionInstallCard compact />
      </div>

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

/** ── Ajustes del display virtual ── */
export function SettingsPanel() {
  const open = useStore((s) => s.panels.settingsOpen);
  const togglePanel = useStore((s) => s.togglePanel);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const toast = useStore((s) => s.toast);
  const reconnectDesktop = useStore((s) => s.reconnectDesktop);

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

  return (
    <PanelShell
      title="Ajustes"
      subtitle="Configuración del display virtual scrcpy (persistente en este navegador)"
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

      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-[#5a606c]">
        Resolución del display virtual
      </h3>
      <div className="mb-5 grid grid-cols-2 gap-2">
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
