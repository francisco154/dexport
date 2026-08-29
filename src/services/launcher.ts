/**
 * DexPort v5 — LauncherService
 * ════════════════════════════════════════════════════════════
 * Servicio de LAUNCHERS con DOS frentes arreglados en v5:
 *
 * (1) BÚSQUEDA ROBUSTA DE LAUNCHERS (lo que pedía el usuario:
 *     "encontrar maneras alternativas de que el sistema haga una
 *     mejor búsqueda de launchers"). Se ejecutan SIETE estrategias
 *     complementarias y TODAS dejan su salida cruda en un informe
 *     de diagnóstico visible en el selector:
 *       S0  ping del shell (sanity check del protocolo exec:)
 *       S1  cmd package query-activities --brief  (Android 11+)
 *       S2  cmd package query-activities (salida completa)
 *       S3  cmd package resolve-activity --brief  (launcher por defecto)
 *       S4  cmd shortcut get-default-launcher     (defecto, vía alternativa)
 *       S5  dumpsys package | grep HOME           (compatible con todo)
 *       S6  ESCANEO DIFUSO: pm list packages + palabras clave
 *           (launch/home/hyperdroid/niagara/lawnchair/…) + verificación
 *           individual por paquete (dumpsys package <pkg>) — encuentra
 *           launchers que los otros métodos no listan
 *       S7  el launcher ORIGINAL del proyecto (siempre presente)
 *
 * (2) LANZAMIENTO VERIFICADO en el display virtual:
 *       A  force-stop + am start --display N -n comp
 *          --activity-new-task --activity-clear-task
 *       C  am start -W --display N -n comp   (Status: ok del propio am)
 *       D  am start --display N -a MAIN -c HOME (cualquier launcher)
 *       B  START_APP del canal de control scrcpy (como el JAR original)
 *     Cada paso se VERIFICA con el port del AppMonitor (tarea visible en
 *     el bloque Display #N de dumpsys activity activities) y todo queda
 *     en el log. Si nada se verifica pero `am` dijo "Starting:" sin
 *     error y el display ni siquiera aparece en dumpsys, se acepta un
 *     ÉXITO SUAVE (algunos Samsung no listan displays virtuales vacíos).
 *     Al fallar, se añade el buffer de crashes de logcat al diagnóstico.
 *
 * ⚠️ Nota histórica: en v1-v4 TODOS los comandos shell de la app se
 * ejecutaban mal (bug del wrapper `sh -c` en el protocolo exec: de
 * WebADB — ver services/adb.ts), así que la enumeración devolvía vacío
 * y `am start` nunca llegaba a lanzar nada. v5 arregla la capa shell
 * Y endurece todo lo que hay encima por si acaso.
 */

import { webAdb } from "./adb";
import { parseRunningApps } from "../utils/telemetry";
import type { ScrcpyControlMessageWriter } from "@yume-chan/scrcpy";
import { COMPANION_PKG, COMPANION_MAIN_ACTIVITY } from "./companion";

export interface LauncherInfo {
  /** componente achatado "com.pkg/.Activity" (o solo el pkg si se desconoce la activity) */
  component: string;
  pkg: string;
  label: string;
  /** launcher por defecto del teléfono (resolve-activity / shortcut) */
  isDefault: boolean;
  /** el launcher ORIGINAL del proyecto (companion APK) */
  isCompanion: boolean;
  /** estrategias que lo encontraron — se muestra en el selector ("vía …") */
  sources: string[];
}

/** Informe de una estrategia de búsqueda (salida cruda para diagnóstico). */
export interface LauncherScanReport {
  strategy: string;
  command: string;
  /** salida cruda truncada (primeros ~700 caracteres) */
  raw: string;
  /** componentes encontrados por esta estrategia */
  found: string[];
  /** true si la estrategia aportó ≥1 launcher */
  ok: boolean;
  /** ms que tardó (0 si no se ejecutó) */
  ms: number;
}

export interface LauncherScanResult {
  launchers: LauncherInfo[];
  report: LauncherScanReport[];
}

export interface LaunchResult {
  ok: boolean;
  /** la tarea quedó VERIFICADA visible en el display virtual */
  verified: boolean;
  /** estrategia que funcionó: A | C | D | B | soft */
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
  "com.miui.home": "MIUI / HyperOS Home (Xiaomi)",
  "com.huawei.android.launcher": "HUAWEI Home",
  "com.hihonor.android.launcher": "HONOR Home",
  "com.oppo.launcher": "ColorOS Launcher",
  "com.coloros.launcher": "ColorOS Launcher",
  "com.oplus.launcher": "OPlus Launcher",
  "com.android.launcher": "Launcher (AOSP)",
  "com.cyanogenmod.trebuchet": "Trebuchet",
  "org.lineageos.trebuchet": "Trebuchet (LineageOS)",
  "com.microsoft.launcher": "Microsoft Launcher",
  "com.teslacoilsw.launcher": "Nova Launcher",
  "bitpit.launcher": "Niagara Launcher",
  "ch.deletescape.lawnchair.plah": "Lawnchair",
  "app.olauncher": "Olauncher",
  "com.binary.hyperdroid": "HyperDroid · PC Launcher",
  "com.asus.launcher": "ASUS ZenUI Launcher",
  "com.vivo.launcher": "Funtouch / OriginOS Launcher",
  "com.bbk.launcher2": "i Launcher (vivo)",
  "com.hihonor.cloudmotion": "Magic Launcher (HONOR)",
};

/** Etiqueta para paquetes desconocidos (incluye coincidencias parciales). */
export function launcherLabel(pkg: string): string {
  const exact = LAUNCHER_LABELS[pkg];
  if (exact) return exact;
  const lower = pkg.toLowerCase();
  if (lower.includes("hyperdroid")) return "HyperDroid";
  if (lower.includes("hyper")) return "Hyper Launcher";
  if (lower.includes("niagara")) return "Niagara Launcher";
  if (lower.includes("lawnchair")) return "Lawnchair";
  if (lower.includes("nova")) return "Nova Launcher";
  if (lower.includes("launch")) return `Launcher (${pkg})`;
  if (lower.includes("home")) return `Home (${pkg})`;
  const last = pkg.split(".").pop() ?? pkg;
  return (
    last
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || pkg
  );
}

/** Paquetes que NUNCA son launchers (ruido del parseo). */
const BLOCKED_PKGS = new Set([
  "android",
  "com.android.internal",
  "com.android.server",
  "com.android.shell",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Extrae componentes tipo "com.pkg/.Activity" o "com.pkg/com.pkg.Activity"
 * de una salida shell cualquiera (query-activities, dumpsys, shortcut…).
 * Tolera prefijos hash (-6a2c1f8), "filter NNNN", "Activity #N:", $Inner…
 */
export function extractComponents(out: string): string[] {
  const found = new Set<string>();
  const re =
    /\b([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)\/(\.?[a-zA-Z][a-zA-Z0-9_]*(?:[.$][a-zA-Z0-9_$]+)*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out))) {
    const pkg = m[1];
    const cls = m[2];
    if (pkg.length < 3 || cls.length < 2) continue;
    if (BLOCKED_PKGS.has(pkg)) continue;
    // descartar intents/acciones android y basura del dumpsys
    if (/^android\.intent|^com\.android\.server|^intent$|^permission$/i.test(pkg)) continue;
    found.add(`${pkg}/${cls}`);
  }
  return [...found];
}

/**
 * Normaliza una clase de activity vista en `dumpsys package <pkg>` hacia
 * un componente completo "pkg/clase". Los nombres relativos (".Home",
 * "ui.Home") se completan con el paquete.
 */
export function normalizeComponent(pkg: string, cls: string): string | null {
  const c = cls.trim().replace(/^["']|["']$/g, "");
  if (!c || !/^[a-zA-Z0-9_.$]+$/.test(c)) return null;
  if (c.includes("/")) {
    const p = c.split("/", 1)[0];
    return p === pkg ? c : null; // componente de otro paquete → ignorar
  }
  if (c.startsWith(pkg + ".")) return `${pkg}/${c}`;
  if (c.startsWith(".")) return `${pkg}/${c}`;
  if (c.includes(".")) return `${pkg}/${pkg}.${c}`;
  return `${pkg}/.${c}`;
}

/**
 * Parsea la salida de `dumpsys package <pkg>` alrededor de las líneas
 * "Category: android.intent.category.HOME" y devuelve el componente
 * HOME del paquete (o null). Formatos tolerados:
 *   Moderno (A 10+):  2be8345 com.pkg/.HomeActivity filter 2be8346
 *   Antiguo (A 8-9):  activity com.pkg.ui.HomeActivity 2be8345
 *   Mixto:            2be8345 .HomeActivity
 */
export function parsePerPackageHome(out: string, pkg: string): string | null {
  if (!out || !out.includes("android.intent.category.HOME")) return null;
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("android.intent.category.HOME")) continue;
    // buscar hacia atrás la línea del componente (hasta 8 líneas),
    // saltando las líneas de metadatos del intent-filter
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      const line = lines[j];
      if (
        /Action:|Category:|Intent|AutoVerify|priority|preferredOrder|specificIndex|isDefault|match=|Ordering/.test(
          line,
        )
      ) {
        continue; // metadato del filtro, no la activity
      }
      // moderno: "  2be8345 com.pkg/.HomeActivity filter 2be8346"
      let m = line.match(/[0-9a-f]{6,}\s+(\S+)\s+filter\s+[0-9a-f]+/);
      if (m) {
        const comp = normalizeComponent(pkg, m[1]);
        if (comp) return comp;
      }
      // antiguo "Activities:": "activity com.pkg.ui.HomeActivity 2be8345"
      m = line.match(/(?:^|\s)activity\s+([a-zA-Z0-9_.$]+)\s+[0-9a-f]+/);
      if (m) {
        const comp = normalizeComponent(pkg, m[1]);
        if (comp) return comp;
      }
      // mixto: "  2be8345 .HomeActivity" (hash delante, sin filter)
      m = line.match(/(?:^|\s)[0-9a-f]{6,}\s+(\.?[a-zA-Z][a-zA-Z0-9_.$]*\.[a-zA-Z0-9_$]+)/);
      if (m) {
        const comp = normalizeComponent(pkg, m[1]);
        if (comp) return comp;
      }
      // componente completo con barra en la línea
      const full = extractComponents(line).find((c) => c.startsWith(pkg + "/"));
      if (full) return full;
    }
  }
  return null;
}

/** Extrae un paquete suelto "com.x.y" de una salida (para get-default-launcher). */
function extractPackage(out: string): string | null {
  const m = out.match(/\b([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+){2,})\b/);
  if (!m) return null;
  const pkg = m[1];
  if (BLOCKED_PKGS.has(pkg)) return null;
  if (/^android\.intent|^com\.android\.server/i.test(pkg)) return null;
  return pkg;
}

// ═════════════════════════════════════════════════════════════
// v5: ESCANEO MULTIESTRATEGIA DE LAUNCHERS
// ═════════════════════════════════════════════════════════════

const ACTION_MAIN = "android.intent.action.MAIN";
const CAT_HOME = "android.intent.category.HOME";

/** Palabras clave del escaneo difuso (S6) — cubre launchers famosos. */
const FUZZY_KEYWORDS =
  "launcher|launch|home|hyper|hyperdroid|niagara|lawnchair|trebuchet|teslacoilsw|bitpit|nova|poco|evie|olauncher|actionlauncher|smartlauncher|microsoft|asus|zenlauncher|lucid|heytab|oplus|funtouch|originos|coloros";

/**
 * Enumera TODOS los launchers (categoría HOME) instalados en el
 * dispositivo combinando SIETE estrategias complementarias.
 * Devuelve la lista + el informe de diagnóstico crudo por estrategia.
 */
export async function scanHomeLaunchers(): Promise<LauncherScanResult> {
  const report: LauncherScanReport[] = [];
  const byPkg = new Map<string, LauncherInfo>();
  let defaultPkg: string | null = null;

  const runStrategy = async (
    strategy: string,
    command: string,
    timeoutMs: number,
    parse: (raw: string) => string[],
  ): Promise<string[]> => {
    const t0 = Date.now();
    const raw = await webAdb.shellSafe(command, timeoutMs);
    let found: string[] = [];
    try {
      found = parse(raw);
    } catch {
      found = [];
    }
    report.push({
      strategy,
      command,
      raw: raw.trim().slice(0, 700),
      found,
      ok: found.length > 0,
      ms: Date.now() - t0,
    });
    return found;
  };

  /** registra un componente (o un paquete suelto) en el mapa de resultados */
  const add = (componentOrPkg: string, source: string): void => {
    const hasComp = componentOrPkg.includes("/");
    const pkg = componentOrPkg.split("/")[0];
    if (!pkg.includes(".") || BLOCKED_PKGS.has(pkg)) return;
    const existing = byPkg.get(pkg);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      // el componente con actividad manda sobre el paquete suelto
      if (hasComp && !existing.component.includes("/")) {
        existing.component = componentOrPkg;
      }
    } else {
      byPkg.set(pkg, {
        component: componentOrPkg,
        pkg,
        label: launcherLabel(pkg),
        isDefault: false,
        isCompanion: pkg === COMPANION_PKG,
        sources: [source],
      });
    }
  };

  // ── S0: ping del shell (¿funciona la capa shell? sanity check) ──
  await runStrategy("S0 · ping del shell", "echo dexport_shell_ok", 6_000, (raw) =>
    raw.includes("dexport_shell_ok") ? ["__shell_ok__"] : [],
  );

  // ── S1: query-activities --brief (fiable en Android 11+) ──
  const s1 = await runStrategy(
    "S1 · query-activities",
    `timeout 10 cmd package query-activities --brief -a ${ACTION_MAIN} -c ${CAT_HOME} 2>/dev/null`,
    12_000,
    extractComponents,
  );
  s1.forEach((c) => add(c, "query-activities"));

  // ── S2: query-activities completo (formato verboso, Android 10+) ──
  if (s1.length === 0) {
    const s2 = await runStrategy(
      "S2 · query-activities (completo)",
      `timeout 10 cmd package query-activities -a ${ACTION_MAIN} -c ${CAT_HOME} 2>/dev/null | head -80`,
      12_000,
      extractComponents,
    );
    s2.forEach((c) => add(c, "query-activities"));
  }

  // ── S3: resolve-activity (el launcher POR DEFECTO — siempre conocido) ──
  const s3 = await runStrategy(
    "S3 · resolve-activity (defecto)",
    `timeout 10 cmd package resolve-activity --brief -a ${ACTION_MAIN} -c ${CAT_HOME} 2>/dev/null`,
    12_000,
    (raw) => {
      const comps = extractComponents(raw);
      if (comps.length > 0) return comps;
      const pkg = extractPackage(raw);
      return pkg ? [pkg] : [];
    },
  );
  if (s3.length > 0) {
    defaultPkg = s3[0].split("/")[0];
    s3.forEach((c) => add(c, "resolve-activity"));
  }

  // ── S4: cmd shortcut get-default-launcher (vía alternativa al defecto) ──
  const s4 = await runStrategy(
    "S4 · shortcut get-default-launcher",
    "timeout 8 cmd shortcut get-default-launcher 2>/dev/null",
    10_000,
    (raw) => {
      const comps = extractComponents(raw);
      if (comps.length > 0) return comps;
      const pkg = extractPackage(raw);
      return pkg ? [pkg] : [];
    },
  );
  if (s4.length > 0) {
    const pkg = s4[0].split("/")[0];
    if (!defaultPkg) defaultPkg = pkg;
    s4.forEach((c) => add(c, "shortcut"));
  }

  // ── S5: dumpsys package (grep en el dispositivo — compatible con todo) ──
  // Solo si los métodos rápidos aún no aportaron ≥2 launchers (dumpsys
  // completo puede tardar varios segundos en Samsung).
  if (byPkg.size < 2) {
    const s5 = await runStrategy(
      "S5 · dumpsys package (HOME)",
      "timeout 12 dumpsys package 2>/dev/null | grep -B6 'android.intent.category.HOME' | grep -oE '[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z0-9_$]+)+/[.a-zA-Z0-9_$]+' | sort -u | head -40",
      15_000,
      (raw) => raw.split("\n").map((l) => l.trim()).filter((l) => l.includes("/")),
    );
    s5.forEach((c) => add(c, "dumpsys"));
  }

  // ── S6: ESCANEO DIFUSO por nombre de paquete + verificación individual ──
  const s6Raw = await webAdb.shellSafe(
    `pm list packages 2>/dev/null | grep -iE '${FUZZY_KEYWORDS}' | head -24`,
    20_000,
  );
  const candidates = s6Raw
    .split("\n")
    .map((l) => l.replace(/^package:/, "").trim())
    .filter((p) => p.includes(".") && !BLOCKED_PKGS.has(p))
    .slice(0, 16);
  const s6Found: string[] = [];
  for (const cand of candidates) {
    // solo los que aún no conocemos
    if (byPkg.has(cand) && byPkg.get(cand)!.component.includes("/")) continue;
    const out = await webAdb.shellSafe(
      `dumpsys package ${cand} 2>/dev/null | grep -B6 -A1 'android.intent.category.HOME' | head -20`,
      8_000,
    );
    const comp = parsePerPackageHome(out, cand);
    if (comp) {
      s6Found.push(comp);
      add(comp, "escaneo difuso");
    }
  }
  report.push({
    strategy: "S6 · escaneo difuso (pm + verificación)",
    command: `pm list packages | grep -iE '…' → ${candidates.length} candidatos`,
    raw:
      `candidatos: ${candidates.join(", ").slice(0, 500) || "(ninguno)"}\n` +
      `verificados como launcher: ${s6Found.length}`,
    found: s6Found,
    ok: s6Found.length > 0,
    ms: 0,
  });

  // ── S7: el launcher ORIGINAL siempre está disponible ──
  add(COMPANION_MAIN_ACTIVITY, "proyecto original");

  // ── resolver los paquetes sueltos (sin activity conocida) ──
  let resolved = 0;
  for (const info of byPkg.values()) {
    if (resolved >= 4) break;
    if (info.component.includes("/") || info.isCompanion) continue;
    const out = await webAdb.shellSafe(
      `dumpsys package ${info.pkg} 2>/dev/null | grep -B6 -A1 'android.intent.category.HOME' | head -20`,
      8_000,
    );
    const comp = parsePerPackageHome(out, info.pkg);
    if (comp) {
      info.component = comp;
      resolved++;
    }
  }

  // marcar el defecto + ordenar: original → defecto → resto alfabético
  const launchers = [...byPkg.values()].map((l) => ({
    ...l,
    isDefault: l.pkg === defaultPkg,
  }));
  launchers.sort((a, b) => {
    if (a.isCompanion !== b.isCompanion) return a.isCompanion ? -1 : 1;
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  return { launchers, report };
}

// ═════════════════════════════════════════════════════════════
// v5: VERIFICACIÓN (port del AppMonitor del original)
// ═════════════════════════════════════════════════════════════

/**
 * ¿Hay una tarea VISIBLE de `pkg` (o de cualquier paquete si anyPackage)
 * dentro del bloque `Display #N` de `dumpsys activity activities`?
 */
export async function verifyOnDisplay(
  pkg: string | null,
  displayId: number,
  log: string[],
  anyPackage = false,
): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(attempt === 0 ? 1_200 : 900);
    const out = await webAdb.shellSafe(
      `timeout 5 dumpsys activity activities 2>/dev/null | grep -E 'Display #[0-9]+|Task(Record)?\\{' | head -400`,
      10_000,
    );
    if (!out) continue;
    const running = parseRunningApps(out, displayId);
    if (running.length > 0) {
      if (anyPackage) {
        log.push(
          `✓ verificado: tarea visible de ${running[0].packageName} en display #${displayId}`,
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
 * virtual. Devuelve éxito REAL (verificado) + log de diagnóstico
 * completo (cada comando con su salida cruda + crash log si falla).
 */
export async function launchLauncherOnDisplay(
  info: LauncherInfo,
  displayId: number,
  opts: LaunchOptions = {},
): Promise<LaunchResult> {
  const log: string[] = [
    `DexPort v5 · lanzar "${info.label}" (${info.component}) en display #${displayId}`,
  ];
  const run = async (cmd: string, timeoutMs = 12_000): Promise<string> => {
    const out = await webAdb.shellSafe(cmd, timeoutMs);
    log.push(`$ ${cmd}\n${out.trim() || "(sin salida)"}`);
    return out;
  };
  const amSaidOk = (out: string) =>
    (/Starting:/i.test(out) || /Status:\s*ok/i.test(out)) &&
    !/Error|Exception|Permission Denial|does not exist|not able to find/i.test(out);

  let anyAmOk = false;

  // ── 0. si solo tenemos el paquete, resolver su activity HOME ──
  if (!info.component.includes("/")) {
    const resolveOut = await run(
      `dumpsys package ${info.pkg} 2>/dev/null | grep -B6 -A1 'android.intent.category.HOME' | head -20`,
      8_000,
    );
    const comp = parsePerPackageHome(resolveOut, info.pkg);
    if (comp) {
      info = { ...info, component: comp };
      log.push(`✓ activity HOME resuelta: ${comp}`);
    } else {
      log.push(
        `⚠ no se pudo resolver la activity HOME de ${info.pkg} — se intentará con el intent HOME genérico`,
      );
    }
  }

  // ── Estrategia A: force-stop + tarea nueva con clear-task en el display N ──
  if (opts.forceStop !== false) {
    await run(`am force-stop ${info.pkg}`, 8_000);
    const outA = await run(
      `am start --display ${displayId} -n ${info.component} --activity-new-task --activity-clear-task 2>&1`,
    );
    if (amSaidOk(outA)) anyAmOk = true;
    if (amSaidOk(outA)) {
      if (await verifyOnDisplay(info.pkg, displayId, log)) {
        return { ok: true, verified: true, strategy: "A", log };
      }
    } else {
      log.push("⚠ estrategia A: am start reportó error (ver arriba)");
    }
  }

  // ── Estrategia C: am start -W (el propio am reporta Status: ok) ──
  const outC = await run(
    `am start -W --display ${displayId} -n ${info.component} 2>&1`,
    15_000,
  );
  if (amSaidOk(outC)) anyAmOk = true;
  if (amSaidOk(outC)) {
    if (await verifyOnDisplay(info.pkg, displayId, log)) {
      return { ok: true, verified: true, strategy: "C", log };
    }
  }

  // ── Estrategia D: HOME del display N (cualquier launcher del sistema) ──
  const outD = await run(
    `am start --display ${displayId} -a ${ACTION_MAIN} -c ${CAT_HOME} 2>&1`,
  );
  if (/Starting:|Warning|Status:\s*ok/i.test(outD) && !/Error type|Exception/i.test(outD)) {
    if (await verifyOnDisplay(null, displayId, log, true)) {
      return { ok: true, verified: true, strategy: "D", log };
    }
  }

  // ── Estrategia B: START_APP del canal de control scrcpy ──
  // (el mismo mensaje que usaba el JAR original — útil para apps;
  //  para launchers HOME suele ser el último recurso)
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

  // ── diagnóstico del fallo: crash log + presencia del display ──
  const crashOut = await run(
    "logcat -d -b crash 2>/dev/null | tail -25",
    8_000,
  );
  if (crashOut.trim() && crashOut.includes(info.pkg)) {
    log.push(`⚠ el launcher PARECE HABER CRASHEADO (ver crash log arriba)`);
  }
  const dispCount = await run(
    `timeout 5 dumpsys activity activities 2>/dev/null | grep -c 'Display #${displayId}'`,
    10_000,
  );

  // ── éxito suave: am dijo que sí, y este Samsung ni lista el display N ──
  if (anyAmOk && dispCount.trim() === "0") {
    log.push(
      `⚠ el display #${displayId} no aparece en dumpsys (Samsung no lista VDs sin tareas) — se acepta éxito SIN verificar`,
    );
    return { ok: true, verified: false, strategy: "soft", log };
  }

  log.push("✗ todas las estrategias fallaron — revisa las salidas anteriores");
  return { ok: false, verified: false, strategy: "-", log };
}
