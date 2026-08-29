/**
 * DexPort v2 — TelemetryService (AndroidCore port)
 * ════════════════════════════════════════════════════════════
 * El original recibía telemetría en vivo (batería, volúmenes, wifi…)
 * por WebSocket desde el Feature Hub APK (cerrado, requiere APK).
 *
 * En el navegador no existe ese canal, así que replicamos el mismo
 * estado (`AndroidCore`) mediante polling de comandos shell estándar
 * (dumpsys battery, dumpsys media_session, settings) — el mismo
 * mecanismo que usaba el Logic Engine JAR del original.
 *
 * v2:
 *   - Todo en UN solo comando batch (un stream ADB por tick, no cuatro).
 *   - `timeout` del lado del dispositivo + `head` para acotar outputs
 *     gigantes de Samsung (dumpsys media_session puede escupir 100KB+).
 *   - parseRunningApps: port del AppMonitor del servidor original
 *     (dumpsys activity activities + regex `Display #(\d+)` +
 *     `Task{...A=id:pkg ... visible=true}`).
 */

import { webAdb } from "../services/adb";

export interface BatteryState {
  percentage: number;
  charging: boolean;
  temperature: number | null;
  voltage: number | null;
  currentMa: number | null;
  health: string | null;
  technology: string | null;
}

export interface MediaSession {
  packageName: string;
  title: string;
  artist: string;
  active: boolean;
  paused: boolean;
}

export interface DeviceFlags {
  wifi: boolean | null;
  bluetooth: boolean | null;
  airplane: boolean | null;
  dnd: boolean | null;
}

export interface VolumeState {
  music: number;
  musicMax: number;
  ring: number;
  ringMax: number;
}

/** App visible en un display (port del TaskStackMonitor/AppMonitor). */
export interface RunningApp {
  packageName: string;
  displayId: number;
}

/**
 * v7: tarea Android completa — la unidad de la gestión de ventanas
 * estilo Windows (taskbar con apps abiertas + TaskView).
 * v8: `title` (del agente/ventanas), `fromAgent` (fuente exacta) y
 * `taskId=-1` para tareas que solo existen como ventana (agente).
 */
export interface TaskInfo {
  taskId: number;
  packageName: string;
  /** componente "pkg/.Activity" de la actividad superior de la tarea */
  activity: string | null;
  displayId: number;
  /** tipo de tarea: standard | home | … */
  type: string | null;
  visible: boolean;
  /** tarea superior (foco) de su display */
  focused: boolean;
  /** título de la ventana (agente o dumpsys window) — para TaskView */
  title?: string;
  /** la información proviene del DexPort Agent (exacta) */
  fromAgent?: boolean;
}

/**
 * v8: volcado multi-fuente de tareas en UN stream (marcadores):
 *
 *   __ACT__   dumpsys activity activities — tareas con taskId/type por display
 *             (Android 10/11 «Display #N»+TaskRecord · 12+ «Task{…}»)
 *   __WIN__   dumpsys window windows — cada ventana con su pkg/actividad
 *             y mDisplayId real (vitaminas para freeform/DeX y para ROMs
 *             con secciones de activity confusas — Samsung One UI, HyperOS)
 *   __STACK__ am stack list — tareas con displayId (fuente extra)
 *   __FOCUS__ dumpsys window | mCurrentFocus — foco global
 *
 * La sección __ACT__ ya no arrastra ActivityRecord{…} (con muchas apps
 * recientes, 170 líneas se agotaban ANTES de llegar al display virtual:
 * esa era la causa del «No hay apps abiertas» con apps abiertas).
 */
export const TASK_DUMP_COMMAND =
  "echo __ACT__;" +
  " timeout 5 dumpsys activity activities 2>/dev/null" +
  " | grep -E 'Display #[0-9]+|displayId=[0-9]+ rootTaskId|Task\\{|TaskRecord\\{|type=[a-z]+'" +
  " | head -260;" +
  " echo __WIN__;" +
  " timeout 4 dumpsys window windows 2>/dev/null" +
  " | grep -E 'Window #[0-9]+ Window\\{|mDisplayId=|displayId=' | head -200;" +
  " echo __STACK__;" +
  " timeout 3 am stack list 2>/dev/null | head -70;" +
  " echo __FOCUS__;" +
  " timeout 3 dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -2";

/** Normaliza "pkg" + activity (.Main | Main | com.x.Main) → componente am start. */
function buildComponent(pkg: string, act: string): string {
  if (act.startsWith(".")) return `${pkg}/${act}`;
  if (act.includes(".")) return `${pkg}/${act}`; // clase completa
  return `${pkg}/.${act}`;
}

/** Extrae el paquete de la línea de foco de dumpsys window. */
export function parseCurrentFocus(out: string): string | null {
  const m = out.match(/m(?:CurrentFocus|FocusedApp)[^=]*=\s*(?:Window\{[^}]*?\s)?([a-zA-Z][a-zA-Z0-9_.]*)\//);
  return m ? m[1] : null;
}

/**
 * v7: port del AppMonitor + TaskStackMonitor del servidor original.
 * `dumpsys activity activities` → tareas por display con taskId + activity.
 *
 * Formatos tolerados:
 *   Android 10/11:  Display #2 ... / TaskRecord{... #123 A=10285:com.x u0 ...}
 *                   / Hist #0: ActivityRecord{... u0 com.x/.Main t123}
 *   Android 12+:    displayId=2 rootTaskId=44 / * Task{... #123 type=standard
 *                   A=10285:com.x visible=true} / * ActivityRecord{... u0 com.x/.Main t123}
 *   Samsung One UI: variantes con espacios y orden distinto.
 *
 * `focusInfo` = salida de `dumpsys window | grep mCurrentFocus` (foco GLOBAL:
 * si el paquete enfocado tiene tarea en el display virtual, esa tarea queda
 * marcada como focused — el resto se deduce por orden top-down del dump).
 */
export function parseTasks(dump: string, focusInfo?: string): TaskInfo[] {
  if (!dump) return [];
  const focusPkg = focusInfo ? parseCurrentFocus(focusInfo) : null;
  const tasks = new Map<number, TaskInfo>();
  let displayId = 0;
  const topByDisplay = new Map<number, number>(); // primer taskId visto por display

  for (const rawLine of dump.split("\n")) {
    const line = rawLine.trim();
    // ── cambio de display (formato antiguo "Display #N" o nuevo "displayId=N") ──
    const dOld = line.match(/^Display #(\d+)/);
    const dNew = line.match(/^displayId=(\d+)\s+rootTaskId/);
    if (dOld || dNew) {
      displayId = Number((dOld ?? dNew)![1]);
      continue;
    }
    // ── Task{... #123 type=standard A=10285:com.x ... visible=true} ──
    //    TaskRecord{... #123 A=10285:com.x ...}   (Android ≤11) ──
    const t = line.match(/^(?:\* )?(?:Task|TaskRecord)\{[^}]*? #(\d+)([^}]*)\}/);
    if (t) {
      const taskId = Number(t[1]);
      const rest = t[2];
      const pkg = rest.match(/\bA=(-?\d+):([a-zA-Z][a-zA-Z0-9_.]*)/)?.[2] ?? null;
      const type = rest.match(/\btype=([a-z]+)/)?.[1] ?? null;
      const visible = /\bvisible=true\b/.test(rest) || !/\bvisible=false\b/.test(rest);
      if (pkg && pkg !== "com.android.systemui" && !tasks.has(taskId)) {
        tasks.set(taskId, {
          taskId,
          packageName: pkg,
          activity: null,
          displayId,
          type,
          visible,
          focused: false,
        });
        if (!topByDisplay.has(displayId)) topByDisplay.set(displayId, taskId);
      }
      continue;
    }
    // ── ActivityRecord{... u0 com.x/.Main t123} / Hist #0: ActivityRecord{...} ──
    //    la parte de la activity puede ser relativa (.Main) o completa (com.x.Main)
    const a = line.match(
      /ActivityRecord\{[^}]*?\b(?:u\d+ )?([a-zA-Z][a-zA-Z0-9_.]*)\/([\w$.]+)\s+t(\d+)/,
    );
    if (a) {
      const pkg = a[1];
      const act = a[2];
      const taskId = Number(a[3]);
      const task = tasks.get(taskId);
      if (task && task.packageName === pkg) {
        task.activity = buildComponent(pkg, act);
      } else if (!task && pkg !== "com.android.systemui") {
        // ActivityRecord sin Task{} previo (algunos Samsung) — se asume el
        // display en curso
        tasks.set(taskId, {
          taskId,
          packageName: pkg,
          activity: buildComponent(pkg, act),
          displayId,
          type: null,
          visible: true,
          focused: false,
        });
        if (!topByDisplay.has(displayId)) topByDisplay.set(displayId, taskId);
      }
    }
  }

  const list = [...tasks.values()];
  for (const [disp, taskId] of topByDisplay) {
    const task = list.find((t) => t.taskId === taskId);
    if (task) task.focused = true; // top del display
  }
  // el foco GLOBAL (dumpsys window) refina: solo una tarea marcada
  if (focusPkg) {
    const withPkg = list.filter((t) => t.packageName === focusPkg);
    if (withPkg.length > 0) {
      for (const t of list) t.focused = false;
      // preferir la tarea del display virtual (la que ve el usuario)
      const vdTask =
        withPkg.find((t) => t.displayId !== 0) ?? withPkg[withPkg.length - 1];
      vdTask.focused = true;
    }
  }
  return list;
}

/** Entrada del volcado de ventanas (__WIN__): pkg/actividad + display real. */
export interface WindowDumpEntry {
  packageName: string;
  activity: string | null;
  displayId: number;
}

/**
 * v8: parser de `dumpsys window windows`.
 * Cada bloque:
 *   Window #3 Window{abc u0 com.whatsapp/com.whatsapp.HomeActivity}:
 *     mDisplayId=2 stackId=44
 * → pkg + actividad de la ventana y el display REAL donde vive
 *   (incluidas las ventanas freeform del escritorio DeX).
 */
export function parseWindowDump(out: string): WindowDumpEntry[] {
  if (!out) return [];
  const entries: WindowDumpEntry[] = [];
  let current: WindowDumpEntry | null = null;
  let sawDisplayForCurrent = false;
  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim();
    // ── cabecera de ventana con componente pkg/activity ──
    const h = line.match(
      /Window #\d+ Window\{[0-9a-f]+ (?:\S+ )?([a-zA-Z][a-zA-Z0-9_.]*)\/(\S+?)[\s}]/,
    );
    if (h) {
      const pkg = h[1];
      const act = h[2].replace(/[:}]$/, "");
      if (pkg === "android" || pkg === "com.android.systemui") {
        current = null;
        continue;
      }
      current = { packageName: pkg, activity: buildComponent(pkg, act), displayId: -1 };
      sawDisplayForCurrent = false;
      entries.push(current);
      continue;
    }
    // ── display de la ventana en curso ──
    const d = line.match(/^(?:m)?[dD]isplayId=(\d+)/);
    if (d && current && !sawDisplayForCurrent) {
      current.displayId = Number(d[1]);
      sawDisplayForCurrent = true;
    }
  }
  return entries;
}

/**
 * v8: parser de `am stack list` (fuente extra de displayId por tarea):
 *   Stack id=44 type=standard activityType=1 bounds=[0,0][...] displayId=2 userId=0
 *     taskId=45: com.whatsapp/com.whatsapp.HomeActivity type=standard V=[...]
 */
export function parseStackList(out: string): TaskInfo[] {
  if (!out) return [];
  const tasks = new Map<number, TaskInfo>();
  let displayId = -1;
  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim();
    const s = line.match(/^Stack id=\d+.*?displayId=(\d+)/);
    if (s) {
      displayId = Number(s[1]);
      continue;
    }
    const t = line.match(/^taskId=(\d+):\s*([a-zA-Z][a-zA-Z0-9_.]*)\/(\S+)/);
    if (t) {
      const taskId = Number(t[1]);
      const pkg = t[2];
      if (pkg === "com.android.systemui" || tasks.has(taskId)) continue;
      tasks.set(taskId, {
        taskId,
        packageName: pkg,
        activity: buildComponent(pkg, t[3]),
        displayId,
        type: line.match(/\btype=([a-z]+)/)?.[1] ?? null,
        visible: true,
        focused: false,
      });
    }
  }
  return [...tasks.values()];
}

/** Divide la salida multi-marcador del TASK_DUMP_COMMAND v8. */
export function splitTaskDump(out: string): {
  act: string;
  win: string;
  stack: string;
  focus: string;
} {
  const [act = "", rest1 = ""] = out.split("__WIN__");
  const [win = "", rest2 = ""] = rest1.split("__STACK__");
  const [stack = "", focus = ""] = rest2.split("__FOCUS__");
  const actBody = act.includes("__ACT__") ? act.split("__ACT__")[1] ?? "" : act;
  return { act: actBody, win, stack, focus };
}

/**
 * v8: fusión de todas las fuentes de tareas (agente + dumpsys activity +
 * dumpsys window + am stack list) en una lista coherente de TaskInfo.
 *
 * Prioridad: agente (exacto) > activity (taskId/type) > window (display
 * real de cada ventana) > stack (display alternativo).
 * El foco final lo decide: agente (isActive/isFocused) > mCurrentFocus >
 * top del display del dump de activity.
 */
export function mergeTaskSources(input: {
  act: TaskInfo[];
  windows: WindowDumpEntry[];
  stacks: TaskInfo[];
  focusPkg: string | null;
  virtualDisplayId: number | null;
  /** tareas del DexPort Agent (si está conectado) */
  agent?: {
    packageName: string;
    activity: string;
    title: string;
    displayId: number;
    isActive: boolean;
    isFocused: boolean;
  }[];
}): TaskInfo[] {
  const { act, windows, stacks, focusPkg, virtualDisplayId, agent } = input;
  const vd = virtualDisplayId ?? null;
  const merged = new Map<string, TaskInfo>();

  const upsert = (t: TaskInfo) => {
    const key = t.packageName;
    const cur = merged.get(key);
    if (!cur) {
      merged.set(key, t);
      return;
    }
    // quedarse con la mejor información de cada campo
    if (t.activity && !cur.activity) cur.activity = t.activity;
    if (t.title && !cur.title) cur.title = t.title;
    if (t.type && !cur.type) cur.type = t.type;
    if (t.taskId > 0 && cur.taskId <= 0) cur.taskId = t.taskId;
    // display: gana la fuente más fiable (agente > ventana > ya puesto)
    if (t.fromAgent) cur.displayId = t.displayId;
    else if (t.displayId >= 0 && !t.fromAgent) {
      const curFromAgent = cur.fromAgent === true;
      if (!curFromAgent) cur.displayId = t.displayId;
    }
    if (t.focused) {
      for (const o of merged.values()) o.focused = false;
      cur.focused = true;
    }
  };

  // 1) dumpsys activity (taskId, type, display por secciones)
  for (const t of act) upsert({ ...t });

  // 2) ventanas (display REAL de cada ventana — p.ej. freeform en el VD)
  for (const w of windows) {
    const cur = merged.get(w.packageName);
    if (cur) {
      if (w.displayId >= 0) cur.displayId = w.displayId;
      if (w.activity && !cur.activity) cur.activity = w.activity;
    } else {
      upsert({
        taskId: -1,
        packageName: w.packageName,
        activity: w.activity,
        displayId: w.displayId,
        type: null,
        visible: true,
        focused: false,
      });
    }
  }

  // 3) am stack list (taskId + display alternativos)
  for (const s of stacks) {
    const cur = merged.get(s.packageName);
    if (cur) {
      if (s.taskId > 0 && cur.taskId <= 0) cur.taskId = s.taskId;
      if (cur.displayId < 0 && s.displayId >= 0) cur.displayId = s.displayId;
      if (s.activity && !cur.activity) cur.activity = s.activity;
    } else {
      upsert({ ...s });
    }
  }

  // 4) agente (la fuente exacta: ventanas reales con título y foco)
  if (agent && agent.length > 0) {
    for (const a of agent) {
      const cur = merged.get(a.packageName);
      if (cur) {
        if (a.activity) cur.activity = a.activity;
        if (a.title) cur.title = a.title;
        if (a.displayId >= 0) cur.displayId = a.displayId;
        cur.fromAgent = true;
        cur.visible = true;
        if (a.isActive || a.isFocused) {
          for (const o of merged.values()) o.focused = false;
          cur.focused = true;
        }
      } else {
        upsert({
          taskId: -1,
          packageName: a.packageName,
          activity: a.activity || null,
          displayId: a.displayId,
          type: null,
          visible: true,
          focused: a.isActive || a.isFocused,
          title: a.title,
          fromAgent: true,
        });
      }
    }
  }

  // 5) foco global (último refinamiento si nadie marcó foco)
  const list = [...merged.values()];
  const anyFocused = list.some((t) => t.focused);
  if (!anyFocused && focusPkg) {
    const withPkg = list.filter((t) => t.packageName === focusPkg);
    if (withPkg.length > 0) {
      const pick =
        withPkg.find((t) => vd != null && t.displayId === vd) ??
        withPkg.find((t) => t.displayId !== 0) ??
        withPkg[withPkg.length - 1];
      pick.focused = true;
    }
  }
  return list;
}

/**
 * Compatibilidad v2-v6: apps visibles por display (el watchdog del launcher
 * y el tooltip de la taskbar siguen usando esta forma).
 */
export function parseRunningApps(out: string, onlyDisplayId?: number | null): RunningApp[] {
  const tasks = parseTasks(out);
  const apps = tasks.map((t) => ({ packageName: t.packageName, displayId: t.displayId }));
  return onlyDisplayId != null && onlyDisplayId > 0
    ? apps.filter((a) => a.displayId === onlyDisplayId)
    : apps;
}

/** dumpsys battery → BatteryState (port del parser del original) */
export function parseBattery(out: string): BatteryState | null {
  if (!out || !out.includes("level:")) return null;
  const get = (re: RegExp): string | null => out.match(re)?.[1]?.trim() ?? null;
  const level = Number(get(/level:\s*(\d+)/) ?? -1);
  const status = get(/status:\s*(\d+)/);
  // 2 = charging, 5 = full
  const charging = status === "2" || status === "5";
  const tempRaw = get(/temperature:\s*(\d+)/);
  const voltRaw = get(/voltage:\s*(\d+)/);
  const curRaw = get(/current now:\s*(-?\d+)/i) ?? get(/Charge counter:\s*(-?\d+)/i);
  return {
    percentage: level >= 0 ? level : 0,
    charging,
    temperature: tempRaw ? Number(tempRaw) / 10 : null,
    voltage: voltRaw ? Number(voltRaw) / 1000 : null,
    currentMa: curRaw ? Number(curRaw) : null,
    health: get(/health:\s*(\d+)/)
      ? ({
          "1": "Unknown",
          "2": "Good",
          "3": "Overheat",
          "4": "Dead",
          "5": "Over voltage",
          "6": "Unspecified failure",
          "7": "Too cold",
        } as Record<string, string>)[get(/health:\s*(\d+)/)!] ?? null
      : null,
    technology: get(/technology:\s*(\S+)/),
  };
}

/** Batería vía sysfs (fallback cuando dumpsys falla — algunos Samsung). */
export function parseBatterySysfs(cap: string, status: string): BatteryState | null {
  const level = Number(cap.trim());
  if (!Number.isFinite(level) || cap.trim() === "") return null;
  return {
    percentage: Math.max(0, Math.min(100, level)),
    charging: /Charging|Full/i.test(status),
    temperature: null,
    voltage: null,
    currentMa: null,
    health: null,
    technology: null,
  };
}

/**
 * dumpsys media_session → sesiones activas.
 * Devuelve la sesión con metadata (título/artista) para el media center,
 * replicando el MediaDataManager del original.
 */
export function parseMediaSessions(out: string): MediaSession[] {
  if (!out) return [];
  const sessions: MediaSession[] = [];
  const blocks = out.split(/(?=Session\s+\{)/g);
  for (const block of blocks) {
    if (!block.includes("Session {")) continue;
    const pkg = block.match(/pkg=([^\s\}]+)/)?.[1] ?? "";
    if (!pkg) continue;
    const active = /state=PlaybackState.*?active=true/.test(block) ||
      /\bactive=true\b/.test(block);
    // Los metadatos aparecen como lines tipo:
    //   description=Title — Artist  |  metadataaje...
    // dumpsys imprime: "description:" o "metadata:" con título/artista
    const meta = block.match(
      /description=(.+?)(?:\s*\||\n|$)/,
    )?.[1];
    let title = "";
    let artist = "";
    const m = block.match(/metadata:.*?title=([^,\n]+)/)?.[1];
    const a = block.match(/metadata:.*?artist=([^,\n]+)/)?.[1];
    if (m) title = m.trim();
    if (a) artist = a.trim();
    if (!title && meta) {
      const parts = meta.split(/\s+[—–-]\s+/);
      title = (parts[0] ?? "").trim();
      artist = (parts[1] ?? "").trim();
    }
    const paused = /state=Paused|PlaybackState.*?state=3\b/.test(block);
    if (title || active) {
      sessions.push({ packageName: pkg, title, artist, active, paused });
    }
  }
  return sessions;
}

/**
 * v2: UN solo comando batch con toda la telemetría del tick.
 * `timeout` (toybox, Android 8+) corta los dumpsys colgados del lado
 * del dispositivo; `head` limita el tamaño de los outputs enormes.
 */
export async function pollTelemetryBatch(): Promise<{
  battery: BatteryState | null;
  mediaSessions: MediaSession[];
  volumes: VolumeState | null;
}> {
  const [batteryOut, mediaOut, capOut, chgOut, volOut] = await webAdb.shellBatch(
    [
      "dumpsys battery 2>/dev/null | head -40",
      "timeout 3 dumpsys media_session 2>/dev/null | head -80",
      "cat /sys/class/power_supply/battery/capacity 2>/dev/null",
      "cat /sys/class/power_supply/battery/status 2>/dev/null",
      "dumpsys audio 2>/dev/null | grep -E 'STREAM_(2|3):' | head -4",
    ],
    18_000,
  );
  const battery =
    parseBattery(batteryOut) ??
    parseBatterySysfs(capOut, chgOut);
  const mediaSessions = parseMediaSessions(mediaOut).slice(0, 4);
  const volumes = volOut ? parseVolumes(volOut) : null;
  return { battery, mediaSessions, volumes };
}

/** Estado rápido de flags del dispositivo (port de `states` del APK). */
export async function readDeviceFlags(): Promise<DeviceFlags> {
  const [wifiOut, btOut, airplaneOut, dndOut] = await webAdb.shellBatch(
    [
      "settings get global wifi_on",
      "settings get global bluetooth_on",
      "settings get global airplane_mode_on",
      "settings get global zen_mode",
    ],
    8_000,
  );
  const toBool = (s: string): boolean | null =>
    s.trim() === "1" ? true : s.trim() === "0" ? false : null;
  return {
    wifi: toBool(wifiOut),
    bluetooth: toBool(btOut),
    airplane: toBool(airplaneOut),
    dnd: (() => {
      const v = dndOut.trim();
      return v === "0" ? false : v === "" ? null : true;
    })(),
  };
}

/** dumpsys audio → volúmenes (port de volume_update). */
export function parseVolumes(out: string): VolumeState {
  const stream = (id: number): { cur: number; max: number } => {
    const re = new RegExp(
      `STREAM_${id}:.*?\\(\\s*(\\d+)\\s*/\\s*(\\d+)\\s*\\)`,
    );
    const m = out.match(re);
    return { cur: m ? Number(m[1]) : 0, max: m ? Number(m[2]) : 15 };
  };
  const music = stream(3);
  const ring = stream(2);
  return { music: music.cur, musicMax: music.max, ring: ring.cur, ringMax: ring.max };
}
