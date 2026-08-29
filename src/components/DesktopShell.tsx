/**
 * DexPort — Desktop shell
 * ════════════════════════════════════════════════════════════
 * Entorno de escritorio DeX: wallpaper, display virtual (canvas),
 * taskbar y paneles. El shell se monta desde el arranque para que
 * el canvas exista cuando el motor scrcpy comience a decodificar.
 */

import { DisplayCanvas } from "./DisplayCanvas";
import { Taskbar } from "./Taskbar";
import { AppDrawer } from "./AppDrawer";
import { MediaPanel, DevicePanel, SettingsPanel, ShortcutsModal } from "./Panels";
import { ReconnectOverlay } from "./ReconnectOverlay";
import { Toasts } from "./Toasts";
import { CompanionPromptFloat } from "./CompanionInstall";
import { useStore } from "../store/store";

export function DesktopShell() {
  const phase = useStore((s) => s.phase);

  return (
    <div className="dex-wallpaper relative flex h-full w-full flex-col overflow-hidden">
      {/* Área del display virtual */}
      <main className="relative min-h-0 flex-1">
        <DisplayCanvas focused={phase === "desktop"} />
        {/* Reloj analógico decorativo (como el widget del original) */}
        {phase === "desktop" && <AnalogClock />}
        <AppDrawer />
        <MediaPanel />
        <DevicePanel />
        <SettingsPanel />
        <ShortcutsModal />
      </main>

      <Taskbar />
      <CompanionPromptFloat />
      <ReconnectOverlay />
      <Toasts />
    </div>
  );
}

function AnalogClock() {
  const now = new Date();
  const seconds = now.getSeconds();
  const minutes = now.getMinutes() + seconds / 60;
  const hours = (now.getHours() % 12) + minutes / 60;
  const hand = (angle: number, length: number, width: number, color: string) => {
    const rad = ((angle - 90) * Math.PI) / 180;
    const x = 50 + Math.cos(rad) * length;
    const y = 50 + Math.sin(rad) * length;
    return (
      <line x1="50" y1="50" x2={x} y2={y} stroke={color} strokeWidth={width} strokeLinecap="round" />
    );
  };
  const marks = Array.from({ length: 12 }, (_, i) => {
    const rad = ((i * 30 - 90) * Math.PI) / 180;
    const isHour = i % 3 === 0;
    const r1 = isHour ? 36 : 39;
    return (
      <line
        key={i}
        x1={50 + Math.cos(rad) * r1}
        y1={50 + Math.sin(rad) * r1}
        x2={50 + Math.cos(rad) * 43}
        y2={50 + Math.sin(rad) * 43}
        stroke="rgba(255,255,255,0.75)"
        strokeWidth={isHour ? 3 : 1.4}
        strokeLinecap="round"
      />
    );
  });
  return (
    <div className="pointer-events-none absolute right-8 top-8 opacity-90 drop-shadow-xl">
      <svg width="120" height="120" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="48" fill="rgba(0,0,0,0.55)" />
        {marks}
        {hand(hours * 30, 24, 4.5, "#ffffff")}
        {hand(minutes * 6, 34, 3, "#ffffff")}
        {hand(seconds * 6, 38, 1.4, "#38bdf8")}
        <circle cx="50" cy="50" r="2.6" fill="#38bdf8" />
      </svg>
    </div>
  );
}
