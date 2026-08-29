/**
 * DexPort — TelemetryService (AndroidCore port)
 * ════════════════════════════════════════════════════════════
 * El original recibía telemetría en vivo (batería, volúmenes, wifi…)
 * por WebSocket desde el Feature Hub APK (cerrado, requiere APK).
 *
 * En el navegador no existe ese canal, así que replicamos el mismo
 * estado (`AndroidCore`) mediante polling de comandos shell estándar
 * (dumpsys battery, dumpsys media_session, settings) — el mismo
 * mecanismo que usaba el Logic Engine JAR del original.
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

/** dumpsys battery → BatteryState (port del parser del original) */
export function parseBattery(out: string): BatteryState {
  const get = (re: RegExp): string | null => out.match(re)?.[1]?.trim() ?? null;
  const level = Number(get(/level:\s*(\d+)/) ?? -1);
  const status = get(/status:\s*(\d+)/);
  // 2 = charging, 5 = full
  const charging = status === "2" || status === "5";
  const tempRaw = get(/temperature:\s*(\d+)/);
  const voltRaw = get(/voltage:\s*(\d+)/);
  const curRaw = get(/current now:\s*(-?\d+)/i);
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

/**
 * dumpsys media_session → sesiones activas.
 * Devuelve la sesión con metadata (título/artista) para el media center,
 * replicando el MediaDataManager del original.
 */
export function parseMediaSessions(out: string): MediaSession[] {
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
    const m = block.match(/metadata:.*?title=([^,]+)/)?.[1];
    const a = block.match(/metadata:.*?artist=([^,]+)/)?.[1];
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

/** Estado rápido de flags del dispositivo (port de `states` del APK). */
export async function readDeviceFlags(): Promise<DeviceFlags> {
  const [wifiOut, btOut, airplaneOut, dndOut] = await Promise.all([
    webAdb.shellSafe("settings get global wifi_on"),
    webAdb.shellSafe("settings get global bluetooth_on"),
    webAdb.shellSafe("settings get global airplane_mode_on"),
    webAdb.shellSafe("settings get global zen_mode"),
  ]);
  const toBool = (s: string): boolean | null =>
    s === "1" ? true : s === "0" ? false : null;
  return {
    wifi: toBool(wifiOut.trim()),
    bluetooth: toBool(btOut.trim()),
    airplane: toBool(airplaneOut.trim()),
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
