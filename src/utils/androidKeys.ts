/**
 * DexPort — Utilidades de entrada Android
 * ════════════════════════════════════════════════════════════
 * El original inyectaba input vía los servicios nativos (JAR Logic Engine).
 * Este port usa el protocolo de control de scrcpy (idéntico binario),
 * con los mismos keycodes de Android (AKEYCODE_*).
 */

import {
  AndroidKeyCode,
  AndroidKeyEventMeta,
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  ScrcpyPointerId,
  type ScrcpyControlMessageWriter,
} from "@yume-chan/scrcpy";

export {
  AndroidKeyCode,
  AndroidKeyEventMeta,
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  ScrcpyPointerId,
};

export const KEY_ACTION_DOWN = 0;
export const KEY_ACTION_UP = 1;

/** Envía un keyevent Android completo (down + up) vía scrcpy. */
export async function sendKeycode(
  writer: ScrcpyControlMessageWriter,
  keyCode: number,
  metaState = 0,
): Promise<void> {
  await writer.injectKeyCode({
    action: KEY_ACTION_DOWN,
    keyCode: keyCode as AndroidKeyCode,
    repeat: 0,
    metaState: metaState as AndroidKeyEventMeta,
  });
  await writer.injectKeyCode({
    action: KEY_ACTION_UP,
    keyCode: keyCode as AndroidKeyCode,
    repeat: 0,
    metaState: metaState as AndroidKeyEventMeta,
  });
}

/** Teclas de acción rápidas usadas por la taskbar / media center */
export const QUICK_KEYS = {
  home: AndroidKeyCode.AndroidHome,
  back: AndroidKeyCode.AndroidBack,
  recents: AndroidKeyCode.AndroidAppSwitch,
  volumeUp: AndroidKeyCode.VolumeUp,
  volumeDown: AndroidKeyCode.VolumeDown,
  power: AndroidKeyCode.Power,
  notification: AndroidKeyCode.AndroidNotification,
  menu: AndroidKeyCode.ContextMenu,
  mediaPlayPause: 85, // KEYCODE_MEDIA_PLAY_PAUSE
  mediaPlay: 126, // KEYCODE_MEDIA_PLAY
  mediaPause: 127, // KEYCODE_MEDIA_PAUSE
  mediaNext: 87, // KEYCODE_MEDIA_NEXT
  mediaPrevious: 88, // KEYCODE_MEDIA_PREVIOUS
} as const;

/**
 * Mapa KeyboardEvent.code → AndroidKeyCode (layout físico, como hace
 * el cliente de escritorio de scrcpy usando los keylayout files).
 */
const CODE_MAP: Record<string, number> = {
  // Letras (KEYCODE_A=29 ... KEYCODE_Z=54)
  KeyA: 29, KeyB: 30, KeyC: 31, KeyD: 32, KeyE: 33, KeyF: 34, KeyG: 35,
  KeyH: 36, KeyI: 37, KeyJ: 38, KeyK: 39, KeyL: 40, KeyM: 41, KeyN: 42,
  KeyO: 43, KeyP: 44, KeyQ: 45, KeyR: 46, KeyS: 47, KeyT: 48, KeyU: 49,
  KeyV: 50, KeyW: 51, KeyX: 52, KeyY: 53, KeyZ: 54,
  // Dígitos (KEYCODE_0=7 ... KEYCODE_9=16)
  Digit0: 7, Digit1: 8, Digit2: 9, Digit3: 10, Digit4: 11,
  Digit5: 12, Digit6: 13, Digit7: 14, Digit8: 15, Digit9: 16,
  Numpad0: 144, Numpad1: 145, Numpad2: 146, Numpad3: 147, Numpad4: 148,
  Numpad5: 149, Numpad6: 150, Numpad7: 151, Numpad8: 152, Numpad9: 153,
  // Control
  Enter: 66, NumpadEnter: 66, Backspace: 67, Space: 62, Tab: 61,
  Escape: 111, Delete: 112, Insert: 124, ForwardDelete: 112,
  // Navegación
  ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
  PageUp: 92, PageDown: 93, Home: 122, End: 123,
  // Símbolos
  Comma: 55, Period: 56, Minus: 69, Equal: 70, Backquote: 68,
  BracketLeft: 71, BracketRight: 72, Backslash: 73, Semicolon: 74,
  Quote: 75, Slash: 76,
  // Funcionales
  F1: 131, F2: 132, F3: 133, F4: 134, F5: 135, F6: 136, F7: 137,
  F8: 138, F9: 139, F10: 140, F11: 141, F12: 142,
  // Extras
  CapsLock: 115, NumLock: 143, ScrollLock: 116,
  NumpadAdd: 157, NumpadSubtract: 156, NumpadMultiply: 155, NumpadDivide: 154,
  NumpadDecimal: 158,
  VolumeUp: 24, VolumeDown: 25, Mute: 164,
  MediaPlayPause: 85, MediaTrackNext: 87, MediaTrackPrevious: 88,
};

/** Conversión de teclas modificadoras → metaState de Android */
export function buildMetaState(e: KeyboardEvent): number {
  let meta = 0;
  if (e.shiftKey) meta |= AndroidKeyEventMeta.Shift | AndroidKeyEventMeta.ShiftLeft;
  if (e.ctrlKey) meta |= AndroidKeyEventMeta.Ctrl | AndroidKeyEventMeta.CtrlLeft;
  if (e.altKey) meta |= AndroidKeyEventMeta.Alt | AndroidKeyEventMeta.AltLeft;
  return meta;
}

/** Resuelve el keycode Android para un evento de teclado del navegador. */
export function keyEventToAndroidCode(e: KeyboardEvent): number | null {
  const code = CODE_MAP[e.code];
  if (code !== undefined) return code;
  // Fallback por key para navegadores que no reportan `code` (p.ej. IMEs)
  if (e.key.length === 1) {
    const upper = e.key.toUpperCase();
    if (upper >= "A" && upper <= "Z") return 29 + (upper.charCodeAt(0) - 65);
    if (e.key >= "0" && e.key <= "9") return 7 + Number(e.key);
  }
  return null;
}

/** ¿El evento produce texto imprimible? (se envía con injectText, más fiable) */
export function isPrintableKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  return e.key.length === 1 && !e.repeat;
}
