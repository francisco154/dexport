/**
 * DexPort v12 — AgentBridge (Agent v5: paquete único + hibernación)
 * ════════════════════════════════════════════════════════════
 * Conexión con el DEXPORT AGENT (com.dexport.agent) — la app
 * auxiliar que le da a la web lo que ADB shell no puede ver:
 *
 *   · apps lanzables con ETIQUETAS reales + COMPONENTE exacto
 *   · TODOS los íconos PNG reales (64 px)
 *   · el launcher predefinido del teléfono (informativo)
 *   · espejo de notificaciones (cuando abres el panel)
 *
 * v5 — FILOSOFÍA «UNA FRECUENCIA, LEÍDA UNA VEZ»:
 *   · La web pide `package.get` UNA sola vez → el agente responde
 *     con TODO (apps + íconos + launcher + notificaciones) y la
 *     web le ordena `agent.hibernate` → el puente TCP se APAGA
 *     (cero consumo en el teléfono). Sin polling, sin lotes,
 *     sin reintentos: una frecuencia, leída una vez.
 *   · El agente NO tiene servicio de accesibilidad (eliminado):
 *     la multitarea (apps abiertas, foco por display, Atrás/
 *     Inicio/Recientes) vive 100 % en ADB shell — el agente ya
 *     no puede interferir con el teléfono.
 *   · Despertar: `am start-foreground-service -n …/.AgentServerService`
 *     por ADB (lo hace esta clase al conectar o al abrir el panel
 *     de notificaciones). Hiberna solo tras 90 s ocioso.
 *
 * El agente abre un servidor de líneas JSON en 127.0.0.1:8458 que
 * aquí alcanzamos por el túnel de WebADB: adb.createSocket("tcp:8458").
 */

import { webAdb } from "./adb";
import { ReadableStream } from "@yume-chan/stream-extra";

/** Puerto del puente local del DexPort Agent en el dispositivo. */
export const AGENT_PORT = 8458;
export const AGENT_PKG = "com.dexport.agent";
/** v5: servicio en primer plano que aloja el puente (encendible/apagable por ADB). */
export const AGENT_SERVER_SERVICE =
  "com.dexport.agent/com.dexport.agent.AgentServerService";
/** v≤4: el viejo servicio de accesibilidad — solo para LIMPIAR su rastro. */
export const AGENT_LEGACY_A11Y =
  "com.dexport.agent/com.dexport.agent.AgentAccessibilityService";
export const AGENT_NOTIF_LISTENER = "com.dexport.agent/com.dexport.agent.AgentNotificationListener";
export const AGENT_APK_URL = "dexport-agent.apk";
export const AGENT_APK_DEVICE_PATH = "/data/local/tmp/dexport-agent.apk";
export const AGENT_APK_SIZE = 53_813;
/** Protocolo que esta web sabe hablar (agentes menores → upgrade). */
export const AGENT_REQUIRED_VERSION = 5;

export interface AgentPing {
  version: number;
  sdk: number;
  android: string;
  device: string;
  /** true si el agente distingue ventanas por display (API 33+) */
  multiDisplay: boolean;
  /** true si el espejo de notificaciones tiene permiso */
  notifications: boolean;
  /** perfil en el que corre el agente (0 = principal; >0 = trabajo/Island) */
  userId: number;
}

/** v5: app lanzable con etiqueta real + ícono PNG incluido en el paquete. */
export interface AgentAppInfo {
  packageName: string;
  label: string;
  /** "pkg/pkg.Activity" exacto para `am start -n` */
  component: string;
  system: boolean;
  /** PNG base64 (data URL) — llega DENTRO del paquete único */
  icon?: string;
}

/** v5: launcher HOME instalado. */
export interface AgentLauncher {
  component: string;
  packageName: string;
  label: string;
  isDefault: boolean;
}

/** v5: notificación activa espejada desde el teléfono. */
export interface AgentNotification {
  key: string;
  packageName: string;
  label: string;
  title: string;
  text: string;
  when: number;
  postedAt: number;
  ongoing: boolean;
  clearable: boolean;
}

/** v5: EL PAQUETE — todo lo que la web necesita, en UNA respuesta. */
export interface AgentPackage {
  apps: AgentAppInfo[];
  launcher: { defaultComponent: string | null; launchers: AgentLauncher[] } | null;
  notifications: { enabled: boolean; notifications: AgentNotification[] };
  /** true si el agente devolvió lo que tenía antes de terminar */
  partial?: boolean;
  builtAt?: number;
}

export type AgentInstallPhase =
  | "idle"
  | "downloading"
  | "pushing"
  | "installing"
  | "enabling"
  | "verifying"
  | "done"
  | "error";

export interface AgentInstallProgress {
  phase: AgentInstallPhase;
  progress: number; // 0..1
  message: string;
  error?: string;
}

export type ProgressCb = (p: AgentInstallProgress) => void;

let requestSeq = 1;

export class AgentBridge {
  // ═════════════════════════════════════════════════════════
  // Protocolo (líneas JSON por conexión, como el companion 8457)
  // ═════════════════════════════════════════════════════════

  /** Request/response de una línea (payload extra opcional). null si el agente no responde. */
  async request(
    command: string,
    timeoutMs = 6_000,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown> | null> {
    const adb = webAdb.adb;
    if (!adb) throw new Error("Dispositivo no conectado");
    const socket = await adb.createSocket(`tcp:${AGENT_PORT}`);
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const id = `ag${requestSeq++}`;
      const body = JSON.stringify({ type: command, command, id, ...payload }) + "\n";
      const writer = socket.writable.getWriter();
      await writer.write(new TextEncoder().encode(body));
      writer.releaseLock();
      // v11: el timer del race se limpia SIEMPRE (antes quedaban
      // timers huérfanos que Chrome acumulaba por cientos).
      const timeoutP = new Promise<string | null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      const response = await Promise.race([readLine(socket.readable), timeoutP]);
      if (!response) return null;
      try {
        return JSON.parse(response) as Record<string, unknown>;
      } catch {
        return null;
      }
    } finally {
      if (timer) clearTimeout(timer);
      try {
        await socket.close();
      } catch {
        /* noop */
      }
    }
  }

  /**
   * v5: request de un comando INTERACTIVO (notificaciones) — si el
   * puente está hibernando, lo despierta por ADB y reintenta una vez.
   */
  async requestLive(
    command: string,
    timeoutMs = 8_000,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown> | null> {
    let res = await this.request(command, timeoutMs, payload).catch(() => null);
    if (!res) {
      await this.wake();
      res = await this.request(command, timeoutMs, payload).catch(() => null);
    }
    return res;
  }

  // ═════════════════════════════════════════════════════════
  // v5: DESPERTAR / HIBERNAR — el puente se enciende y apaga por ADB
  // ═════════════════════════════════════════════════════════

  /**
   * Enciende el puente (servicio en primer plano) por ADB. Barato:
   * un comando shell. Si ya estaba despierto, no hace nada raro.
   */
  async wake(): Promise<void> {
    await webAdb.shellSafe(
      `am start-foreground-service -n ${AGENT_SERVER_SERVICE} 2>/dev/null` +
        ` || am startservice -n ${AGENT_SERVER_SERVICE} 2>/dev/null; true`,
      8_000,
    );
    // el socket abre casi al instante, pero damos aire al binder
    await sleep(700);
  }

  /**
   * Ordena al agente HIBERNAR ya (tras recibir el paquete): el
   * servidor TCP se apaga y la notificación del puente desaparece.
   */
  async hibernate(): Promise<void> {
    await this.request("agent.hibernate", 3_000).catch(() => null);
  }

  /** ¿El agente está instalado, despierto y respondiendo? */
  async ping(timeoutMs = 4_000): Promise<AgentPing | null> {
    try {
      const res = await this.request("ping", timeoutMs);
      if (!res || res.status !== "success" || typeof res.version !== "number") return null;
      return {
        version: Number(res.version ?? 1),
        sdk: Number(res.sdk ?? 0),
        android: String(res.android ?? ""),
        device: String(res.device ?? ""),
        multiDisplay: res.multi_display === true,
        notifications: res.notifications === true,
        userId: Number(res.user_id ?? 0),
      };
    } catch {
      return null;
    }
  }

  /** ¿El APK está instalado en el dispositivo? (pm path) */
  async isInstalled(): Promise<boolean> {
    const out = await webAdb.shellSafe(`pm path ${AGENT_PKG} 2>/dev/null | head -1`, 6_000);
    // salida: package:/data/app/…/com.dexport.agent-…/base.apk
    return out.includes(AGENT_PKG) && out.includes(".apk");
  }

  // ═════════════════════════════════════════════════════════
  // v5: EL PAQUETE ÚNICO
  // ═════════════════════════════════════════════════════════

  /**
   * package.get — UNA solicitud con TODO: apps lanzables con TODOS
   * los íconos + launcher + notificaciones. El agente la retiene
   * (long-poll) hasta que su hilo de fondo terminó de renderizar
   * cada ícono → aquí llega COMPLETA. Timeout holgado (200 s).
   */
  async getPackage(timeoutMs = 200_000): Promise<AgentPackage | null> {
    const res = await this.request("package.get", timeoutMs).catch(() => null);
    if (!res || res.status !== "success" || typeof res.package !== "object" || !res.package) {
      return null;
    }
    const p = res.package as Record<string, unknown>;
    const apps: AgentAppInfo[] = [];
    if (Array.isArray(p.apps)) {
      for (const raw of p.apps as Record<string, unknown>[]) {
        const pkg = String(raw.package_name ?? "");
        if (!pkg || !String(raw.component ?? "")) continue;
        const b64 = String(raw.icon ?? "");
        apps.push({
          packageName: pkg,
          label: String(raw.label ?? pkg),
          component: String(raw.component ?? ""),
          system: raw.system === true,
          ...(b64.startsWith("iVBOR") ? { icon: `data:image/png;base64,${b64}` } : {}),
        });
      }
    }
    // launcher
    let launcher: AgentPackage["launcher"] = null;
    if (p.launcher && typeof p.launcher === "object") {
      const l = p.launcher as Record<string, unknown>;
      const def = (l.default ?? {}) as Record<string, unknown>;
      const launchers: AgentLauncher[] = [];
      if (Array.isArray(l.launchers)) {
        for (const raw of l.launchers as Record<string, unknown>[]) {
          const component = String(raw.component ?? "");
          if (!component) continue;
          launchers.push({
            component,
            packageName: String(raw.package_name ?? component.split("/")[0]),
            label: String(raw.label ?? ""),
            isDefault: raw.is_default === true,
          });
        }
      }
      launcher = {
        defaultComponent: String(def.component ?? "") || null,
        launchers,
      };
    }
    // notificaciones (incluidas en el paquete)
    let notifications: AgentPackage["notifications"] = { enabled: false, notifications: [] };
    const n = res.notifications;
    if (n && typeof n === "object") {
      notifications = parseNotifications(n as Record<string, unknown>);
    }
    return {
      apps,
      launcher,
      notifications,
      ...(p.partial === true ? { partial: true } : {}),
      ...(typeof p.built_at === "number" ? { builtAt: p.built_at as number } : {}),
    };
  }

  // ═════════════════════════════════════════════════════════
  // v5: notificaciones BAJO DEMANDA (panel abierto) — despiertan
  // el puente un instante si estaba hibernando
  // ═════════════════════════════════════════════════════════

  /** notifications.get — lista viva (enabled=false si falta el permiso). */
  async getNotifications(
    timeoutMs = 8_000,
  ): Promise<{ enabled: boolean; notifications: AgentNotification[] } | null> {
    try {
      const res = await this.requestLive("notifications.get", timeoutMs);
      if (!res || typeof res.notifications !== "object" || !res.notifications) return null;
      const parsed = parseNotifications(res.notifications as Record<string, unknown>);
      return { enabled: parsed.enabled, notifications: parsed.notifications };
    } catch {
      return null;
    }
  }

  /** Descarta una notificación por key (desde la web). */
  async dismissNotification(key: string): Promise<boolean> {
    try {
      const res = await this.requestLive("notification.dismiss", 5_000, { key });
      return !!res && res.performed === true;
    } catch {
      return false;
    }
  }

  /** Limpia todas las notificaciones descartables. */
  async clearNotifications(): Promise<boolean> {
    try {
      const res = await this.requestLive("notifications.clear_all", 5_000);
      return !!res && res.performed === true;
    } catch {
      return false;
    }
  }

  // ═════════════════════════════════════════════════════════
  // Instalación por ADB (APK + despertar el puente)
  // v5: SIN permiso de accesibilidad — el puente vive en un
  // servicio en primer plano. SOLO perfil principal (user 0).
  // ═════════════════════════════════════════════════════════

  /**
   * v3: desinstala el agente de TODOS los perfiles que no sean el
   * principal (0). `pm install` sin --user lo mete también en
   * perfiles de trabajo (Island/Secure Folder en Samsung) → dos
   * copias compitiendo por el puerto 8458 = conflictos y colas.
   * Devuelve los ids de usuarios limpiados.
   */
  async cleanOtherProfiles(): Promise<number[]> {
    try {
      const users = await webAdb.shellSafe("pm list users 2>/dev/null", 6_000);
      // "UserInfo{0:Owner:c13} running" / "UserInfo{10:Island:30}"
      const ids: number[] = [];
      for (const m of users.matchAll(/UserInfo\{(\d+):/g)) {
        const id = Number(m[1]);
        if (Number.isFinite(id) && id !== 0) ids.push(id);
      }
      if (ids.length === 0) return [];
      const cleaned: number[] = [];
      for (const id of ids) {
        const out = await webAdb.shellSafe(
          `pm uninstall --user ${id} ${AGENT_PKG} 2>/dev/null; true`,
          8_000,
        );
        if (/Success/i.test(out)) cleaned.push(id);
      }
      return cleaned;
    } catch {
      return [];
    }
  }

  /**
   * Flujo completo v5: descargar APK → push → pm install --user 0 →
   * limpiar duplicados de Island → limpiar el rastro de la vieja
   * accesibilidad (v≤4) → permitir el listener de notificaciones →
   * ENCENDER el puente (servicio en primer plano) → verificar ping.
   */
  async install(onProgress: ProgressCb = () => undefined): Promise<boolean> {
    const adb = webAdb.adb;
    if (!adb) throw new Error("Dispositivo no conectado");

    // ── 1. Descargar el APK embebido en la web (54 KB, instantáneo) ──
    onProgress({
      phase: "downloading",
      progress: 0.05,
      message: "Descargando DexPort Agent v5 (54 KB)…",
    });
    const response = await fetch(AGENT_APK_URL);
    if (!response.ok && !response.body) {
      throw new Error("No se pudo descargar el APK del agente");
    }
    const apk = new Uint8Array(await response.arrayBuffer());
    if (apk.byteLength < 20_000) {
      throw new Error("APK del agente inválido (demasiado pequeño)");
    }

    // ── 2. Push al dispositivo (mismo canal que scrcpy-server) ──
    onProgress({
      phase: "pushing",
      progress: 0.2,
      message: "Subiendo el agente al dispositivo…",
    });
    const BLOCK = 32 * 1024;
    let offset = 0;
    const pushStream = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (offset >= apk.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + BLOCK, apk.byteLength);
        controller.enqueue(apk.subarray(offset, end));
        offset = end;
      },
    });
    const sync = await adb.sync();
    try {
      await sync.write({
        filename: AGENT_APK_DEVICE_PATH,
        file: pushStream,
        permission: 0o644,
        mtime: Math.floor(Date.now() / 1000),
      });
    } finally {
      try {
        await sync.dispose();
      } catch {
        /* noop */
      }
    }

    // ── 3. pm install SOLO en el perfil principal (user 0) ──
    // sin --user, pm lo instala en TODOS los perfiles (incluido el
    // perfil de trabajo Island) → copias duplicadas en conflicto.
    onProgress({
      phase: "installing",
      progress: 0.55,
      message: "Instalando agente v5 (perfil principal)…",
    });
    const installOut = await webAdb.shellTimeout(
      `pm install --user 0 -r -g ${AGENT_APK_DEVICE_PATH} 2>&1 || pm install -r -g ${AGENT_APK_DEVICE_PATH} 2>&1`,
      60_000,
    );
    if (!/Success/i.test(installOut)) {
      const reason =
        installOut
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .join(" · ") || "razón desconocida";
      throw new Error(`pm install falló: ${reason.slice(0, 160)}`);
    }
    void webAdb.shellSafe(`rm -f ${AGENT_APK_DEVICE_PATH}`, 4_000);

    // ── 3b. v3: limpiar duplicados en perfiles de trabajo (Island) ──
    onProgress({
      phase: "installing",
      progress: 0.65,
      message: "Limpiando duplicados en perfiles de trabajo…",
    });
    const cleaned = await this.cleanOtherProfiles();
    if (cleaned.length > 0) {
      onProgress({
        phase: "installing",
        progress: 0.7,
        message: `Agente duplicado eliminado de ${cleaned.length} perfil(es) de trabajo`,
      });
    }

    // ── 4. v5: limpiar el RASTRO del viejo servicio de accesibilidad
    //       (v≤4 lo dejó habilitado en settings; v5 ya no existe) ──
    onProgress({
      phase: "enabling",
      progress: 0.75,
      message: "Liberando accesibilidad (v5 no la usa)…",
    });
    await webAdb.shellSafe(cleanLegacyAccessibilityScript(), 8_000);

    // ── 4b. activar el ESPEJO DE NOTIFICACIONES por ADB ──
    // (NotificationListenerService: `cmd notification allow_listener`)
    onProgress({
      phase: "enabling",
      progress: 0.82,
      message: "Activando el espejo de notificaciones…",
    });
    await webAdb.shellSafe(
      `cmd notification allow_listener ${AGENT_NOTIF_LISTENER} 2>/dev/null; true`,
      8_000,
    );

    // ── 5. v5: ENCENDER el puente (servicio en primer plano) ──
    // (despierta el paquete del estado stopped y abre el 8458)
    onProgress({
      phase: "verifying",
      progress: 0.88,
      message: "Encendiendo el puente del agente…",
    });
    await this.wake();

    // ── 6. Verificar que el puente responde (reintentos) ──
    for (let i = 0; i < 6; i++) {
      const pong = await this.ping(2_500);
      if (pong) {
        onProgress({ phase: "done", progress: 1, message: "DexPort Agent v5 activo ✓" });
        return true;
      }
      await sleep(900);
    }
    onProgress({
      phase: "done",
      progress: 1,
      message:
        "Agente instalado — abre la app «DexPort Agent» en el teléfono y pulsa «Abrir puente ahora» si no conectó solo",
    });
    return false;
  }
}

/**
 * v5: quita SOLO nuestro componente del setting de accesibilidad
 * (los demás servicios del usuario quedan intactos). Las versiones
 * ≤4 del agente dejaban este rastro habilitado; la v5 no usa
 * accesibilidad — liberar el teléfono por completo.
 */
function cleanLegacyAccessibilityScript(): string {
  const svc = AGENT_LEGACY_A11Y;
  return (
    `svc="${svc}"; ` +
    `cur=$(settings get secure enabled_accessibility_services); ` +
    `case "$cur" in *"$svc"*) ` +
    `n=$(echo "$cur" | tr ':' '\\n' | grep -v "^$svc$" | paste -sd: -); ` +
    `if [ -z "$n" ]; then settings delete secure enabled_accessibility_services 2>/dev/null; ` +
    `else settings put secure enabled_accessibility_services "$n"; fi; ;; esac; ` +
    `true`
  );
}

/** Parser común del snapshot de notificaciones del agente. */
function parseNotifications(
  n: Record<string, unknown>,
): { enabled: boolean; notifications: AgentNotification[] } {
  const out: AgentNotification[] = [];
  if (Array.isArray(n.notifications)) {
    for (const raw of n.notifications as Record<string, unknown>[]) {
      const key = String(raw.key ?? "");
      const pkg = String(raw.package_name ?? "");
      if (!key || !pkg) continue;
      out.push({
        key,
        packageName: pkg,
        label: String(raw.label ?? pkg),
        title: String(raw.title ?? ""),
        text: String(raw.text ?? ""),
        when: Number(raw.when ?? 0),
        postedAt: Number(raw.posted_at ?? raw.when ?? 0),
        ongoing: raw.ongoing === true,
        clearable: raw.clearable !== false,
      });
    }
  }
  return { enabled: n.enabled === true, notifications: out };
}

async function readLine(readable: ReadableStream<Uint8Array>): Promise<string | null> {
  const reader = readable.getReader();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value, { stream: true });
      const nl = text.indexOf("\n");
      if (nl >= 0) return text.slice(0, nl);
      // v5: EL PAQUETE trae TODOS los íconos en una línea (~0.5-1.5 MB
      // en teléfonos cargados de apps) → límite generoso
      if (text.length > 24_000_000) break;
    }
    return text.trim() ? text : null;
  } finally {
    reader.releaseLock();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const agentBridge = new AgentBridge();
