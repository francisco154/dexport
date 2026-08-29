/**
 * DexPort v6 — Desktop shell
 * ════════════════════════════════════════════════════════════
 * Entorno de escritorio DeX: wallpaper, display virtual (canvas),
 * taskbar y paneles. El shell se monta desde el arranque para que
 * el canvas exista cuando el motor scrcpy comience a decodificar.
 *
 * v6:
 *   · widget del reloj OCULTABLE (preferencias del panel Ajustes)
 *   · ajuste AUTOMÁTICO del display virtual al tamaño de la ventana:
 *     ResizeObserver + evento fullscreenchange → mensaje RESIZE_DISPLAY
 *     del fork (las apps sobreviven, solo config-change)
 *   · taskbar auto-ocultable (aparece al acercar el mouse al borde)
 */

import { useEffect, useRef, useState } from "react";
import { DisplayCanvas } from "./DisplayCanvas";
import { Taskbar, TaskbarPill } from "./Taskbar";
import { WindowControls } from "./WindowControls";
import { AppDrawer } from "./AppDrawer";
import { TaskView } from "./TaskView";
import { MediaPanel, DevicePanel, SettingsPanel, ShortcutsModal } from "./Panels";
import { ReconnectOverlay } from "./ReconnectOverlay";
import { Toasts } from "./Toasts";
import { CompanionPromptFloat } from "./CompanionInstall";
import { LauncherPicker } from "./LauncherPicker";
import { useStore } from "../store/store";

export function DesktopShell() {
  const phase = useStore((s) => s.phase);
  const showClock = useStore((s) => s.uiPrefs.showClock);
  const autoHideTaskbar = useStore((s) => s.uiPrefs.autoHideTaskbar);
  const taskbarCollapsed = useStore((s) => s.uiPrefs.taskbarCollapsed);
  const mainRef = useRef<HTMLElement>(null);
  const [taskbarVisible, setTaskbarVisible] = useState(true);

  // ── v6: ajuste del display virtual al tamaño de la ventana ──
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fit = () => {
      const s = useStore.getState();
      if (
        s.phase !== "desktop" &&
        s.phase !== "boot"
      ) {
        return;
      }
      if (
        !s.settings.autoResize ||
        !s.settings.fitToWindow ||
        !s.settings.virtualDisplay ||
        s.displayId == null ||
        s.mirrorMode ||
        s.reconnecting
      ) {
        return;
      }
      void s.resizeDisplayToWindow(true);
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fit, 700); // debounce
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(main);
    window.addEventListener("resize", schedule);
    document.addEventListener("fullscreenchange", schedule);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("fullscreenchange", schedule);
      if (timer) clearTimeout(timer);
    };
  }, []);

  // ── v6: auto-ocultar la taskbar (hover en el borde inferior) ──
  useEffect(() => {
    if (!autoHideTaskbar) {
      setTaskbarVisible(true);
      return;
    }
    setTaskbarVisible(false);
    const onMove = (e: MouseEvent) => {
      const h = window.innerHeight;
      setTaskbarVisible(e.clientY >= h - 12);
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [autoHideTaskbar]);

  return (
    <div className="dex-wallpaper relative flex h-full w-full flex-col overflow-hidden">
      {/* Área del display virtual — ocupa TODO el alto: la taskbar flota encima */}
      <main ref={mainRef} className="relative min-h-0 flex-1">
        <DisplayCanvas focused={phase === "desktop"} />
        {/* Reloj analógico decorativo (ocultable desde Ajustes) */}
        {phase === "desktop" && showClock && <AnalogClock />}
        {/* v8: controles estilo Windows de la app activa (esquina sup. derecha) */}
        <WindowControls />
        <AppDrawer />
        {/* v7: vista «Apps abiertas» estilo Windows (botón Recientes) */}
        <TaskView />
        <MediaPanel />
        <DevicePanel />
        <SettingsPanel />
        <ShortcutsModal />
      </main>

      {/* v8: barra de tareas FLOTANTE — desplegada o en pastilla pequeña;
          el auto-ocultar (hover inferior) sigue disponible */}
      {phase === "desktop" && taskbarCollapsed ? (
        <TaskbarPill />
      ) : (
        taskbarVisible && <Taskbar />
      )}
      <CompanionPromptFloat />
      {/* v4: pantalla de selección de launcher (modal del escritorio) */}
      <LauncherPicker />
      <ReconnectOverlay />
      <Toasts />
    </div>
  );
}

function AnalogClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
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
