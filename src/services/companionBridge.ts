/**
 * DexPort v3 — CompanionBridge
 * ════════════════════════════════════════════════════════════
 * Conexión directa con el puente local del LAUNCHER ORIGINAL
 * (com.shrey.androiddex, ServerStartService) que corre en el
 * puerto 8457 del dispositivo — exactamente el mismo canal que
 * usaba el bootstrap JAR del original (forwardToApk).
 *
 * Ingeniería inversa del protocolo (ServerStartService.handleLocalClient):
 *   - 1 conexión TCP → 1 request JSON → 1 response JSON (por línea)
 *   - request:  {"type": "<cmd>", "id": "<n>"} + "\n"
 *   - response: {"status": "success"|"ok"|"error", ..., "id": "<n>"} + "\n"
 *
 * Comandos implementados por el APK (v1.2):
 *   get_all_apps      → { apps: [{app_name, package_name, version_name,
 *                          is_system, icon_base64}] }   ← drawer con íconos reales
 *   get_app_count     → { count: N }
 *   battery.get_full  → { battery: {percentage, charging, plugged, plug_type,
 *                          temperature, voltage, current_ma, health,
 *                          technology, battery_saver} }
 *   state.get_all, launcher.get_visibility, launcher.set_visibility…
 *
 * En el navegador el socket se abre vía WebADB:
 *   adb.createSocket("tcp:8457")  (mismo mecanismo que scrcpy tunnelForward)
 */

import { webAdb } from "./adb";
import { COMPANION_PKG } from "./companion";
import type { ReadableStream as YumeReadableStream } from "@yume-chan/stream-extra";

export interface CompanionApp {
  appName: string;
  packageName: string;
  versionName: string;
  isSystem: boolean;
  /** data:image/png;base64,… (vacío si el APK no envió ícono) */
  icon: string | null;
}

export interface CompanionBattery {
  percentage: number;
  charging: boolean;
  plugged: boolean;
  plugType: string;
  temperature: number | null;
  voltage: number | null;
  currentMa: number | null;
  health: string;
  technology: string;
  batterySaver: boolean;
}

let requestSeq = 1;

export class CompanionBridge {
  /** ¿El puente local (8457) responde? */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.request("get_app_count", 4_000);
      return res != null && (res.status === "success" || res.status === "ok" || typeof res.count === "number");
    } catch {
      return false;
    }
  }

  /**
   * Request/response del protocolo de líneas del companion.
   * Una conexión por comando (como el handleLocalClient del original).
   */
  async request(command: string, timeoutMs = 10_000): Promise<Record<string, unknown> | null> {
    const adb = webAdb.adb;
    if (!adb) throw new Error("Dispositivo no conectado");

    const socket = await adb.createSocket("tcp:8457");
    try {
      const id = `dp${requestSeq++}`;
      const payload = JSON.stringify({ type: command, command, id }) + "\n";

      const writer = socket.writable.getWriter();
      await writer.write(new TextEncoder().encode(payload));
      writer.releaseLock();

      // leer hasta \n o timeout
      const response = await Promise.race([
        readLine(socket.readable),
        new Promise<string | null>((_, reject) =>
          setTimeout(() => reject(new Error("companion bridge timeout")), timeoutMs),
        ),
      ]);
      if (!response) return null;
      try {
        return JSON.parse(response) as Record<string, unknown>;
      } catch {
        return null;
      }
    } finally {
      try {
        await socket.close();
      } catch {
        /* noop */
      }
    }
  }

  /** Lista completa de apps con nombre + ícono (el «análisis de apps» del original). */
  async getApps(): Promise<CompanionApp[]> {
    const res = await this.request("get_all_apps", 30_000);
    if (!res || !Array.isArray(res.apps)) return [];
    return (res.apps as Record<string, unknown>[]).map((a) => ({
      appName: String(a.app_name ?? a.package_name ?? ""),
      packageName: String(a.package_name ?? ""),
      versionName: String(a.version_name ?? ""),
      isSystem: a.is_system === true || a.is_system === 1,
      icon: typeof a.icon_base64 === "string" && a.icon_base64
        ? `data:image/png;base64,${a.icon_base64}`
        : null,
    }));
  }

  /** Batería completa (BatteryMonitor del companion). */
  async getBattery(): Promise<CompanionBattery | null> {
    const res = await this.request("battery.get_full", 8_000);
    if (!res || typeof res.battery !== "object" || !res.battery) return null;
    const b = res.battery as Record<string, unknown>;
    return {
      percentage: Number(b.percentage ?? 0),
      charging: b.charging === true,
      plugged: b.plugged === true,
      plugType: String(b.plug_type ?? ""),
      temperature: b.temperature != null ? Number(b.temperature) : null,
      voltage: b.voltage != null ? Number(b.voltage) : null,
      currentMa: b.current_ma != null ? Number(b.current_ma) : null,
      health: String(b.health ?? ""),
      technology: String(b.technology ?? ""),
      batterySaver: b.battery_saver === true,
    };
  }

  /** ¿El ícono del launcher companion es visible en el app drawer del teléfono? */
  async setLauncherIconVisible(visible: boolean): Promise<void> {
    await this.request(visible ? "launcher.set_visibility" : "launcher.set_visibility", 8_000).catch(
      () => null,
    );
  }
}

async function readLine(readable: YumeReadableStream<Uint8Array>): Promise<string | null> {
  const reader = readable.getReader();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value, { stream: true });
      const nl = text.indexOf("\n");
      if (nl >= 0) {
        return text.slice(0, nl);
      }
      if (text.length > 2_000_000) break; // íconos base64 grandes
    }
    return text.trim() ? text : null;
  } finally {
    reader.releaseLock();
  }
}

export const companionBridge = new CompanionBridge();
export { COMPANION_PKG };
