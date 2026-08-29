/**
 * DexPort v6 — utilidades puras del display virtual
 * ════════════════════════════════════════════════════════════
 * Funciones puras (testables sin navegador) compartidas entre el
 * motor de display y los tests.
 */

/**
 * Mensaje de control del fork del original: TYPE_RESIZE_DISPLAY = 18.
 * Formato (parseResizeDisplay del ControlMessageReader del fork):
 *   [18, width>>8 & 0xff, width & 0xff, height>>8 & 0xff, height & 0xff]
 * (uint16 big-endian, como todo el protocolo scrcpy).
 */
export const MSG_RESIZE_DISPLAY = 18;

export function buildResizeDisplayMessage(width: number, height: number): Uint8Array {
  return new Uint8Array([
    MSG_RESIZE_DISPLAY,
    (width >> 8) & 0xff,
    width & 0xff,
    (height >> 8) & 0xff,
    height & 0xff,
  ]);
}

/**
 * Calcula el tamaño del display virtual para que su ASPECT coincida
 * con el área visible del navegador (pantalla completa sin bandas).
 * El lado mayor respeta la resolución elegida por el usuario.
 * Los múltiplos de 8 evitan workarounds del encoder (Size.round8 del fork).
 */
export function computeDisplaySizeForContainer(
  containerW: number,
  containerH: number,
  targetLong: number,
): { width: number; height: number } {
  const w = Math.max(120, Math.round(containerW || 16));
  const h = Math.max(120, Math.round(containerH || 9));
  const aspect = w / h;
  const long = Math.max(640, Math.min(3840, targetLong));
  let dw: number;
  let dh: number;
  if (aspect >= 1) {
    dw = long;
    dh = Math.round(long / aspect);
  } else {
    dh = long;
    dw = Math.round(long * aspect);
  }
  dw = Math.max(320, Math.round(dw / 8) * 8);
  dh = Math.max(320, Math.round(dh / 8) * 8);
  return { width: dw, height: dh };
}

/**
 * v6: transforma el comando scrcpy para lanzar el FORK del original
 * (com.shrey.re_size_scrcpy.Server) en lugar del server estándar:
 *   · sustituye la clase principal
 *   · añade `:r` (redimensionable) a new_display=WxH/dpi
 *   · agrega argumentos extra que la librería no conoce (sin duplicar)
 * Exportada para tests — el spawner real la envuelve.
 */
export function transformForkArgs(
  command: readonly string[],
  extras: readonly string[] = [],
  resizable = true,
): string[] {
  const args = [...command];
  const idx = args.indexOf("com.genymobile.scrcpy.Server");
  if (idx !== -1) args[idx] = "com.shrey.re_size_scrcpy.Server";
  const present = new Set(args.map((a) => a.split("=")[0]));
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("new_display=")) {
      if (resizable && !args[i].endsWith(":r")) args[i] += ":r";
      present.add("new_display");
    }
  }
  for (const extra of extras) {
    const key = extra.split("=")[0];
    if (!present.has(key)) args.push(extra);
  }
  return args;
}
