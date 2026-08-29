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
 * v2/v5: port del AppMonitor del servidor original.
 * `dumpsys activity activities` → apps visibles por display.
 *
 * Formatos tolerados (Android 10 → 15 / Samsung One UI):
 *   Display #2 (from top to bottom):
 *     Task{8f2f #4 type=standard A=10285:com.whatsapp U=0 ... visible=true}
 *     TaskRecord{1a2b #7 A=14:com.shrey.androiddex u0 ...}
 *   (v4 exigía `visible=true` literal en la misma línea y el formato
 *    exacto `A=x:pkg U=y` → fallaba en muchos Samsung; v5 captura el
 *    paquete siempre y trata la visibilidad como secundaria)
 */
export function parseRunningApps(out: string, onlyDisplayId?: number | null): RunningApp[] {
  if (!out) return [];
  const apps: RunningApp[] = [];
  let displayId = 0;
  const seen = new Set<string>();
  for (const line of out.split("\n")) {
    const d = line.match(/Display #(\d+)/);
    if (d) {
      displayId = Number(d[1]);
      continue;
    }
    // Task{... A=123:com.pkg ...} o TaskRecord{... A=123:com.pkg ...}
    const t = line.match(/(?:Task|TaskRecord)\{[^}]*?\bA=(-?\d+):([a-zA-Z][a-zA-Z0-9_.]*)/);
    if (t) {
      const pkg = t[2];
      // descartar systemui del conteo de "apps"
      if (pkg === "com.android.systemui") continue;
      // visibilidad secundaria: si la línea declara visible=false explícito → no contar
      if (/\bvisible=false\b/.test(line)) continue;
      const key = `${displayId}:${pkg}`;
      if (!seen.has(key)) {
        seen.add(key);
        apps.push({ packageName: pkg, displayId });
      }
    }
  }
  return onlyDisplayId != null && onlyDisplayId > 0
    ? apps.filter((a) => a.displayId === onlyDisplayId)
    : apps;
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
