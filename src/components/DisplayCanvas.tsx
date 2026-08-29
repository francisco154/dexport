/**
 * DexPort — DisplayCanvas
 * ════════════════════════════════════════════════════════════
 * Reemplaza la ventana Win32 embebida (SetParent) del original:
 * el flujo H.264 del display virtual se decodifica con WebCodecs
 * sobre este <canvas>, y todo el input del navegador se traduce al
 * protocolo de control de scrcpy (mismo binario que usaba el
 * cliente de escritorio).
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { displayEngine, useStore } from "../store/store";
import {
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  ScrcpyPointerId,
  QUICK_KEYS,
  sendKeycode,
  keyEventToAndroidCode,
  buildMetaState,
  isPrintableKey,
} from "../utils/androidKeys";

interface Props {
  focused: boolean;
}

export function DisplayCanvas({ focused }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoSizeRef = useRef({ width: 1920, height: 1080 });
  const mouseDownRef = useRef(false);
  const lastHoverRef = useRef<{ x: number; y: number } | null>(null);
  const [showHint, setShowHint] = useState(true);

  const displaySize = useStore((s) => s.displaySize);
  const togglePanel = useStore((s) => s.togglePanel);

  useEffect(() => {
    videoSizeRef.current = displaySize;
  }, [displaySize]);

  /** Mapea coords del navegador → coords del video (object-fit: contain) */
  const mapToVideo = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const vw = videoSizeRef.current.width;
      const vh = videoSizeRef.current.height;
      if (!vw || !vh || !rect.width || !rect.height) return null;
      const scale = Math.min(rect.width / vw, rect.height / vh);
      const dispW = vw * scale;
      const dispH = vh * scale;
      const offX = (rect.width - dispW) / 2;
      const offY = (rect.height - dispH) / 2;
      const x = (clientX - rect.left - offX) / scale;
      const y = (clientY - rect.top - offY) / scale;
      return {
        x: Math.max(0, Math.min(vw - 1, Math.round(x))),
        y: Math.max(0, Math.min(vh - 1, Math.round(y))),
      };
    },
    [],
  );

  // ── Mouse ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !focused) return;

    const controller = () => displayEngine.controller;

    const onMouseMove = (e: MouseEvent) => {
      const pos = mapToVideo(e.clientX, e.clientY);
      if (!pos) return;
      lastHoverRef.current = pos;
      const c = controller();
      if (!c) return;
      void c
        .injectTouch({
          action: mouseDownRef.current
            ? AndroidMotionEventAction.Move
            : AndroidMotionEventAction.HoverMove,
          pointerId: ScrcpyPointerId.Mouse,
          pointerX: pos.x,
          pointerY: pos.y,
          videoWidth: videoSizeRef.current.width,
          videoHeight: videoSizeRef.current.height,
          pressure: mouseDownRef.current ? 1 : 0,
          actionButton: 0,
          buttons: mouseDownRef.current ? AndroidMotionEventButton.Primary : 0,
        })
        .catch(() => undefined);
    };

    const onMouseDown = (e: MouseEvent) => {
      setShowHint(false);
      const pos = mapToVideo(e.clientX, e.clientY);
      if (!pos) return;
      const c = controller();
      if (!c) return;
      e.preventDefault();
      canvas.focus();

      if (e.button === 1) {
        // clic central → HOME (como scrcpy escritorio)
        void sendKeycode(c, QUICK_KEYS.home).catch(() => undefined);
        return;
      }
      if (e.button === 2) {
        // clic derecho → BACK
        void sendKeycode(c, QUICK_KEYS.back).catch(() => undefined);
        return;
      }
      if (e.button !== 0) return;

      mouseDownRef.current = true;
      void c
        .injectTouch({
          action: AndroidMotionEventAction.Down,
          pointerId: ScrcpyPointerId.Mouse,
          pointerX: pos.x,
          pointerY: pos.y,
          videoWidth: videoSizeRef.current.width,
          videoHeight: videoSizeRef.current.height,
          pressure: 1,
          actionButton: AndroidMotionEventButton.Primary,
          buttons: AndroidMotionEventButton.Primary,
        })
        .catch(() => undefined);
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0 || !mouseDownRef.current) return;
      mouseDownRef.current = false;
      const pos = mapToVideo(e.clientX, e.clientY);
      const c = controller();
      if (!c || !pos) return;
      void c
        .injectTouch({
          action: AndroidMotionEventAction.Up,
          pointerId: ScrcpyPointerId.Mouse,
          pointerX: pos.x,
          pointerY: pos.y,
          videoWidth: videoSizeRef.current.width,
          videoHeight: videoSizeRef.current.height,
          pressure: 0,
          actionButton: 0,
          buttons: 0,
        })
        .catch(() => undefined);
    };

    const onWheel = (e: WheelEvent) => {
      const pos = mapToVideo(e.clientX, e.clientY);
      const c = controller();
      if (!c || !pos) return;
      e.preventDefault();
      const ticks = e.deltaMode === 1 ? e.deltaY / 53 : e.deltaY / 100;
      void c
        .injectScroll({
          pointerX: pos.x,
          pointerY: pos.y,
          videoWidth: videoSizeRef.current.width,
          videoHeight: videoSizeRef.current.height,
          scrollX: 0,
          scrollY: Math.max(-1, Math.min(1, ticks)),
          buttons: 0,
        })
        .catch(() => undefined);
    };

    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);
    return () => {
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
    };
  }, [focused, mapToVideo]);

  // ── Teclado (scancode-like, como el cliente de escritorio) ──
  useEffect(() => {
    if (!focused) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onKeyDown = (e: KeyboardEvent) => {
      // Atajos locales de DexPort (port de los shortcuts del original)
      if (e.ctrlKey && e.code === "KeyF") {
        e.preventDefault();
        toggleFullscreen();
        return;
      }
      if (e.ctrlKey && e.code === "KeyG") {
        e.preventDefault();
        useStore.getState().toast(
          "Modo juego: usa el display para jugar con mouse y teclado",
          "info",
        );
        return;
      }
      if (e.code === "F1") {
        e.preventDefault();
        togglePanel("shortcutsOpen");
        return;
      }

      const c = displayEngine.controller;
      if (!c) return;
      e.preventDefault();
      canvas.focus();

      // Texto imprimible → injectText (más fiable que keycodes para IMEs)
      if (isPrintableKey(e)) {
        void c.injectText(e.key).catch(() => undefined);
        return;
      }

      const keyCode = keyEventToAndroidCode(e);
      if (keyCode === null) return;
      const metaState = buildMetaState(e);
      void c
        .injectKeyCode({
          action: 0,
          keyCode: keyCode as never,
          repeat: 0,
          metaState: metaState as never,
        })
        .catch(() => undefined);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const c = displayEngine.controller;
      if (!c) return;
      const keyCode = keyEventToAndroidCode(e);
      if (keyCode === null || isPrintableKey(e)) return;
      e.preventDefault();
      const metaState = buildMetaState(e);
      void c
        .injectKeyCode({
          action: 1,
          keyCode: keyCode as never,
          repeat: 0,
          metaState: metaState as never,
        })
        .catch(() => undefined);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [focused, togglePanel]);

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden bg-black"
      onClick={() => canvasRef.current?.focus()}
    >
      <canvas
        id="dex-display-canvas"
        ref={canvasRef}
        tabIndex={0}
        className="display-canvas outline-none"
      />
      {showHint && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <div className="toast pulse-glow">
            Haz clic en el escritorio para tomar el control — mouse y teclado se
            reenvían al dispositivo
          </div>
        </div>
      )}
    </div>
  );
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
  } else {
    void document.documentElement.requestFullscreen();
  }
}
