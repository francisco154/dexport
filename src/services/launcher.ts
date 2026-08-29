/**
 * DexPort v4 — LauncherService
 * ════════════════════════════════════════════════════════════
 * Servicio de LAUNCHERS: enumeración de los launchers instalados
 * en el dispositivo (vía ADB) + protocolo robusto de lanzamiento
 * en el display virtual con VERIFICACIÓN real y log de diagnóstico.
 *
 * Por qué existía el error v3 ("No se pudo abrir el launcher"):
 *   1. `am start --display N` NO mueve una tarea que ya existe en el
 *      display 0 — el launcher del teléfono SIEMPRE está corriendo,
 *      así que el intent se "resolvía" trayendo esa tarea al frente
 *      en el display físico y el display virtual quedaba vacío.
 *   2. El fallback HOME (`-a MAIN -c HOME`) abre el launcher POR
 *      DEFECTO del teléfono (One UI Home, MIUI Home…), que en la
 *      mayoría de fabricantes RECHAZA displays virtuales.
 *   3. El éxito se adivinaba con regex sobre la salida de `am start`
 *      (un "Starting:" podía aparecer junto a un "Error type 3")
 *      y nunca se verificaba que la tarea quedara VISIBLE en el
 *      display N — mismo chequeo que hacía el AppMonitor del
 *      original (`dumpsys activity activities`).
 *
 * Protocolo v4 (con verificación entre pasos y log completo):
 *   A) am force-stop pkg + am start --display N -n comp
 *      --activity-new-task --activity-clear-task   (tarea nueva → cae en N)
 *   B) controller.startApp(pkg) de scrcpy 3.3 (START_APP — el mismo
 *      mensaje que usaba el JAR original con setLaunchDisplayId)
 *   C) am start --display N -n comp (sin force-stop, reintento)
 *   D) am start --display N -a MAIN -c HOME (home stack del display N;
 *      acepta CUALQUIER launcher que el sistema ponga ahí)
 * Verificación: port del AppMonitor original — parsear
 * `dumpsys activity activities` buscando una Task visible del paquete
 * dentro del bloque `Display #N`.
 */

import { webAdb } from "./adb";
import { parseRunningApps } from "../utils/telemetry";
import type { ScrcpyControlMessageWriter } from "@yume-chan/scrcpy";
import { COMPANION_PKG, COMPANION_MAIN_ACTIVITY } from "./companion";

export interface LauncherInfo {
  /** componente achatado: "com.pkg/.Activity" */
  component: string;
  pkg: string;
  label: string;
  /** launcher por defecto del teléfono (cmd shortcut get-default-launcher) */
  isDefault: boolean;
  /** el launcher ORIGINAL del proyecto (companion APK) */
  isCompanion: boolean;
}

export interface LaunchResult {
  ok: boolean;
  /** la tarea quedó VERIFICADA visible en el display virtual */
  verified: boolean;
  /** estrategia que funcionó: A | B | C | D */
  strategy: string;
  /** salida cruda de cada comando — para diagnóstico */
  log: string[];
}

/** Etiquetas amigables para launchers conocidos (por paquete). */
const LAUNCHER_LABELS: Record<string, string> = {
  [COMPANION_PKG]: "AndroidDex · Launcher original",
  "com.android.launcher3": "Launcher3 (AOSP)",
  "com.sec.android.app.launcher": "One UI Home (Samsung)",
  "com.google.android.apps.nexuslauncher": "Pixel Launcher",
  "com.google.android.apps.launcher": "Google Now Launcher",
  "com.miui.home": "MIUI Home (Xiaomi)",
  "com.huawei.android.launcher": "HUAWEI Home",
  "com.hihonor.android.launcher": "HONOR Home",
  "com.oppo.launcher": "ColorOS Launcher",
  "com.coloros.launcher": "ColorOS Launcher",
  "com.android.launcher": "Launcher (AOSP)",
  "com.cyanogenmod.trebuchet": "Trebuchet",
  "org.lineageos.trebuchet": "Trebuchet (LineageOS)",
  "com.android.systemui": "System UI",
};

/** Etiqueta para paquetes desconocidos (incluye coincidencias parciales). */
export function launcherLabel(pkg: string): string {
  const exact = LAUNCHER_LABELS[pkg];
  if (exact) return exact;
  const lower = pkg.toLowerCase();
  if (lower.includes("hyperdroid")) return "HyperDroid";
  if (lower.includes("launch")) return `Launcher (${pkg})`;
  const last = pkg.split(".").pop() ?? pkg;
  return last
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || pkg;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Extrae componentes tipo "com.pkg/.Activity" de una salida shell. */
function extractComponents(out: string): string[] {
  const found = new Set<string>();
  const re = /\b([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)\/(\.[a-zA-Z0-9_$]+|[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_$]+)*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out))) {
    const pkg = m[1];
    const cls = m[2];
    if (pkg.length < 3 || cls.length < 2) continue;
    // descarta intents/android y basura del dumpsys
    if (/^android$|^com\.android\.server|intent|permission$/i.test(pkg)) continue;
    found.add(`${pkg}/${cls}`);
  }
  return [...found];
}

/**
 * Enumera TODOS los launchers (categoría HOME) instalados en el
 * dispositivo. Estrategia principal: `cmd package query-activities`
 * (Android 7+); fallback: grep sobre `dumpsys package`.
 */
export async function listHomeLaunchers(): Promise<LauncherInfo[]> {
  const components = new Set<string>();

  // ── 1. query-activities (fiable en Android 7+) ──
  const q = await webAdb.shellSafe(
    "cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.HOME 2>/dev/null",
    12_000,
  );
  extractComponents(q).forEach((c) => components.add(c));

  // ── 2. fallback: dumpsys package (filtros HOME) ──
  if (components.size === 0) {
    const d = await webAdb.shellSafe(
      "dumpsys package 2>/dev/null | grep -B4 'android.intent.category.HOME' | grep -oE '[a-zA-Z0-9_.]+/[.a-zA-Z0-9_$]+' | head -30",
      15_000,
    );
    extractComponents(d).forEach((c) => components.add(c));
  }

  // ── 3. launcher por defecto (siempre conocido) ──
  let defaultComponent: string | null = null;
  const def = await webAdb.shellSafe(
    "cmd shortcut get-default-launcher 2>/dev/null",
    8_000,
  );
  const defComp = extractComponents(def)[0];
  if (defComp) {
    defaultComponent = defComp;
    components.add(defComp);
  } else {
    const defPkg = def.match(/([a-z0-9_.]+)/i)?.[1];
    if (defPkg && defPkg.includes(".")) components.add(defPkg);
  }

  // ── 4. SIEMPRE incluir el launcher ORIGINAL (companion del proyecto) ──
  components.add(COMPANION_MAIN_ACTIVITY);

  const infos: LauncherInfo[] = [...components].map((component) => {
    const pkg = component.split("/")[0];
    return {
      component,
      pkg,
      label: launcherLabel(pkg),
      isDefault: defaultComponent != null && pkg === defaultComponent.split("/")[0],
      isCompanion: pkg === COMPANION_PKG,
    };
  });

  // el original primero (recomendado), luego el default, luego el resto alfabético
  infos.sort((a, b) => {
    if (a.isCompanion !== b.isCompanion) return a.isCompanion ? -1 : 1;
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  return infos;
}

/**
 * VERIFICACIÓN (port del AppMonitor del original): ¿hay una tarea
 * VISIBLE de `pkg` (o de cualquier launcher, si anyPackage) dentro
 * del bloque `Display #N` de `dumpsys activity activities`?
 */
export async function verifyOnDisplay(
  pkg: string | null,
  displayId: number,
  log: string[],
  anyPackage = false,
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(attempt === 0 ? 1_000 : 800);
    const out = await webAdb.shellSafe(
      `timeout 4 dumpsys activity activities 2>/dev/null | grep -E 'Display #[0-9]+|Task\\{' | head -160`,
      9_000,
    );
    if (!out) continue;
    const running = parseRunningApps(out, displayId);
    if (running.length > 0) {
      if (anyPackage) {
        const first = running[0];
        log.push(
          `✓ verificado: tarea visible de ${first.packageName} en display #${displayId}`,
        );
        return true;
      }
      const hit = running.find((a) => a.packageName === pkg);
      if (hit) {
        log.push(`✓ verificado: tarea visible de ${pkg} en display #${displayId}`);
        return true;
      }
    }
  }
  log.push(
    `✗ sin verificación: ${pkg ?? "(home)"} no apareció como tarea visible en el display #${displayId}`,
  );
  return false;
}

export interface LaunchOptions {
  /** canal de control scrcpy (si está disponible) para START_APP */
  controller?: ScrcpyControlMessageWriter | null;
  /** false → no forzar parada del proceso (p.ej. si el puente importa) */
  forceStop?: boolean;
}

/**
 * Protocolo robusto de lanzamiento de un launcher en el display
 * virtual. Devuelve éxito REAL (verificado) + log completo de
 * diagnóstico (cada comando con su salida cruda).
 */
export async function launchLauncherOnDisplay(
  info: LauncherInfo,
  displayId: number,
  opts: LaunchOptions = {},
): Promise<LaunchResult> {
  const log: string[] = [
    `DexPort v4 · lanzar "${info.label}" (${info.component}) en display #${displayId}`,
  ];
  const run = async (cmd: string, timeoutMs = 12_000): Promise<string> => {
    const out = await webAdb.shellSafe(cmd, timeoutMs);
    log.push(`$ ${cmd}\n${out.trim() || "(sin salida)"}`);
    return out;
  };
  const amSaidOk = (out: string) =>
    /Starting:/i.test(out) && !/Error|Exception|does not exist/i.test(out);

  // ── Estrategia A: force-stop + tarea nueva con clear-task en el display N ──
  if (opts.forceStop !== false) {
    await run(`am force-stop ${info.pkg}`, 8_000);
    const outA = await run(
      `am start --display ${displayId} -n ${info.component} --activity-new-task --activity-clear-task 2>&1`,
    );
    if (amSaidOk(outA)) {
      if (await verifyOnDisplay(info.pkg, displayId, log)) {
        return { ok: true, verified: true, strategy: "A", log };
      }
    } else {
      log.push("⚠ estrategia A: am start reportó error (ver arriba)");
    }
  }

  // ── Estrategia B: START_APP del canal de control scrcpy 3.3 ──
  // (idéntico al AppController.startAppOnDisplay del JAR original)
  if (opts.controller) {
    try {
      log.push(`$ [scrcpy] START_APP ${info.pkg} {forceStop:false}`);
      await opts.controller.startApp(info.pkg, {
        forceStop: false,
        searchByName: false,
      });
      if (await verifyOnDisplay(info.pkg, displayId, log)) {
        return { ok: true, verified: true, strategy: "B", log };
      }
    } catch (e) {
      log.push(`⚠ START_APP falló: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Estrategia C: reintento explícito sin force-stop ──
  const outC = await run(
    `am start --display ${displayId} -n ${info.component} 2>&1`,
  );
  if (amSaidOk(outC)) {
    if (await verifyOnDisplay(info.pkg, displayId, log)) {
      return { ok: true, verified: true, strategy: "C", log };
    }
  }

  // ── Estrategia D: HOME del display N (cualquier launcher del sistema) ──
  const outD = await run(
    `am start --display ${displayId} -a android.intent.action.MAIN -c android.intent.category.HOME 2>&1`,
  );
  if (/Starting:|Warning/i.test(outD)) {
    if (await verifyOnDisplay(null, displayId, log, true)) {
      return { ok: true, verified: true, strategy: "D", log };
    }
  }

  log.push("✗ todas las estrategias fallaron — revisa las salidas anteriores");
  return { ok: false, verified: false, strategy: "-", log };
}
