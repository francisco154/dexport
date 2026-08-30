/**
 * DexPort v8 — AgentBridge
 * ════════════════════════════════════════════════════════════
 * Conexión con el DEXPORT AGENT (com.dexport.agent) — la app
 * auxiliar con permiso de ACCESIBILIDAD que mapea todo lo que
 * ADB no puede ver:
 *
 *   · apps y ventanas abiertas en TODAS las pantallas (teléfono +
 *     display virtual scrcpy + ventanas freeform DeX)
 *   · qué app está enfocada en cada display (API 33+)
 *   · actividad real de cada tarea (sin parsear dumpsys)
 *   · acciones globales fiables: ATRÁS / HOME / RECIENTES /
 *     notificaciones / ajustes rápidos / bloqueo / all-apps
 *
 * El agente abre un servidor de líneas JSON en 127.0.0.1:8458
 * (mismo protocolo que el companion original de 8457) que aquí
 * alcanzamos por el túnel de WebADB: adb.createSocket("tcp:8458").
 *
 * También instala el agente por ADB:
 *   fetch(public/dexport-agent.apk) → adb.sync().write() →
 *   pm install -r → settings put secure
 *   enabled_accessibility_services (permiso de accesibilidad
 *   concedido por ADB, sin tocar el teléfono).
 */

import { webAdb } from "./adb";
import { ReadableStream } from "@yume-chan/stream-extra";

/** Puerto del puente local del DexPort Agent en el dispositivo. */
export const AGENT_PORT = 8458;
export const AGENT_PKG = "com.dexport.agent";
export const AGENT_SERVICE = "com.dexport.agent/com.dexport.agent.AgentAccessibilityService";
export const AGENT_NOTIF_LISTENER = "com.dexport.agent/com.dexport.agent.AgentNotificationListener";
export const AGENT_APK_URL = "dexport-agent.apk";
export const AGENT_APK_DEVICE_PATH = "/data/local/tmp/dexport-agent.apk";
export const AGENT_APK_SIZE = 49_801;

/** Tarea/app abierta según el agente (ventana TYPE_APPLICATION). */
export interface AgentTask {
  windowId: number;
  packageName: string;
  /** componente "pkg/com.pkg.Activity" deducido del último evento */
  activity: string;
  title: string;
  /** -1 en API < 33 (el agente no puede saberlo → se cruza con dumpsys) */
  displayId: number;
  isActive: boolean;
  isFocused: boolean;
  layer: number;
}

export type AgentActionName =
  | "back"
  | "home"
  | "recents"
  | "notifications"
  | "quick_settings"
  | "lock_screen"
  | "all_apps";

export interface AgentPing {
  version: number;
  sdk: number;
  android: string;
  device: string;
  /** true si el agente distingue ventanas por display (API 33+) */
  multiDisplay: boolean;
  /** v2: true si el espejo de notificaciones tiene permiso */
  notifications: boolean;
}

/** v2: app lanzable con etiqueta real (del PackageManager del teléfono). */
export interface AgentAppInfo {
  packageName: string;
  label: string;
  /** "pkg/pkg.Activity" exacto para `am start -n` */
  component: string;
  system: boolean;
}

/** v2: launcher HOME instalado. */
export interface AgentLauncher {
  component: string;
  packageName: string;
  label: string;
  isDefault: boolean;
}

/** v2: notificación activa espejada desde el teléfono. */
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
  /** PNG base64 de la app emisora (si el agente ya lo tenía cacheado) */
  icon?: string;
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
    try {
      const id = `ag${requestSeq++}`;
      const body = JSON.stringify({ type: command, command, id, ...payload }) + "\n";
      const writer = socket.writable.getWriter();
      await writer.write(new TextEncoder().encode(body));
      writer.releaseLock();
      const response = await Promise.race([
        readLine(socket.readable),
        new Promise<string | null>((_, reject) =>
          setTimeout(() => reject(new Error("agent timeout")), timeoutMs),
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

  /** ¿El agente está instalado, con permiso y respondiendo? */
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

  /** Apps abiertas (ventanas TYPE_APPLICATION de todos los displays). */
  async getTasks(timeoutMs = 6_000): Promise<AgentTask[]> {
    const res = await this.request("tasks.get_all", timeoutMs);
    if (!res || !Array.isArray(res.tasks)) return [];
    const out: AgentTask[] = [];
    for (const raw of res.tasks as Record<string, unknown>[]) {
      const pkg = String(raw.package_name ?? "");
      if (!pkg) continue;
      out.push({
        windowId: Number(raw.window_id ?? 0),
        packageName: pkg,
        activity: String(raw.activity ?? ""),
        title: String(raw.title ?? ""),
        displayId: Number(raw.display_id ?? -1),
        isActive: raw.is_active === true,
        isFocused: raw.is_focused === true,
        layer: Number(raw.layer ?? 0),
      });
    }
    // ventanas de la misma app → quedarse con la de mayor capa
    const byPkg = new Map<string, AgentTask>();
    for (const t of out) {
      const cur = byPkg.get(t.packageName);
      if (!cur || t.layer > cur.layer) byPkg.set(t.packageName, t);
    }
    return [...byPkg.values()];
  }

  /** App en primer plano (ventana activa global). */
  async getForeground(timeoutMs = 5_000): Promise<{ packageName: string; activity: string } | null> {
    const res = await this.request("foreground.get", timeoutMs);
    if (!res || typeof res.foreground !== "object" || !res.foreground) return null;
    const fg = res.foreground as Record<string, unknown>;
    const pkg = String(fg.package_name ?? "");
    return pkg ? { packageName: pkg, activity: String(fg.activity ?? "") } : null;
  }

  /** Acción global del agente (más fiable que keyevent plano). */
  async performAction(action: AgentActionName): Promise<boolean> {
    try {
      const res = await this.request(`action.${action}`, 5_000);
      return !!res && res.status === "success" && res.performed === true;
    } catch {
      return false;
    }
  }

  // ═════════════════════════════════════════════════════════
  // v2: apps reales (labels + componentes + íconos)
  // ═════════════════════════════════════════════════════════

  /** apps.get — apps lanzables con ETIQUETAS reales y componente exacto. */
  async getApps(timeoutMs = 15_000): Promise<AgentAppInfo[]> {
    const res = await this.request("apps.get", timeoutMs);
    if (!res || !Array.isArray(res.apps)) return [];
    const out: AgentAppInfo[] = [];
    for (const raw of res.apps as Record<string, unknown>[]) {
      const pkg = String(raw.package_name ?? "");
      if (!pkg) continue;
      out.push({
        packageName: pkg,
        label: String(raw.label ?? pkg),
        component: String(raw.component ?? ""),
        system: raw.system === true,
      });
    }
    return out;
  }

  /**
   * icons.get — lote de íconos PNG base64 (el agente renderiza el drawable
   * del launcher a 64px). Máx. 12 paquetes por request para no saturar el
   * túnel; devuelve pkg → dataURL.
   */
  async getIcons(packages: string[], timeoutMs = 20_000): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (packages.length === 0) return out;
    const res = await this.request("icons.get", timeoutMs, {
      packages: packages.slice(0, 12),
    });
    if (!res || !Array.isArray(res.icons)) return out;
    for (const raw of res.icons as Record<string, unknown>[]) {
      const pkg = String(raw.package_name ?? "");
      const b64 = String(raw.icon ?? "");
      if (pkg && b64.startsWith("iVBOR")) {
        out.set(pkg, `data:image/png;base64,${b64}`);
      }
    }
    return out;
  }

  /** launcher.get — el launcher PREDETERMINADO del teléfono + todos los HOME. */
  async getLauncher(
    timeoutMs = 8_000,
  ): Promise<{ defaultComponent: string | null; launchers: AgentLauncher[] } | null> {
    const res = await this.request("launcher.get", timeoutMs);
    if (!res || typeof res.launcher !== "object" || !res.launcher) return null;
    const l = res.launcher as Record<string, unknown>;
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
    return {
      defaultComponent: String(def.component ?? "") || null,
      launchers,
    };
  }

  // ═════════════════════════════════════════════════════════
  // v2: espejo de notificaciones
  // ═════════════════════════════════════════════════════════

  /** notifications.get — lista viva (enabled=false si falta el permiso). */
  async getNotifications(
    timeoutMs = 8_000,
  ): Promise<{ enabled: boolean; notifications: AgentNotification[] } | null> {
    try {
      const res = await this.request("notifications.get", timeoutMs);
      if (!res || typeof res.notifications !== "object" || !res.notifications) return null;
      const n = res.notifications as Record<string, unknown>;
      const out: AgentNotification[] = [];
      if (Array.isArray(n.notifications)) {
        for (const raw of n.notifications as Record<string, unknown>[]) {
          const key = String(raw.key ?? "");
          const pkg = String(raw.package_name ?? "");
          if (!key || !pkg) continue;
          const b64 = String(raw.icon ?? "");
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
            ...(b64.startsWith("iVBOR") ? { icon: `data:image/png;base64,${b64}` } : {}),
          });
        }
      }
      return { enabled: n.enabled === true, notifications: out };
    } catch {
      return null;
    }
  }

  /** Descarta una notificación por key (desde la web). */
  async dismissNotification(key: string): Promise<boolean> {
    try {
      const res = await this.request("notification.dismiss", 5_000, { key });
      return !!res && res.performed === true;
    } catch {
      return false;
    }
  }

  /** Limpia todas las notificaciones descartables. */
  async clearNotifications(): Promise<boolean> {
    try {
      const res = await this.request("notifications.clear_all", 5_000);
      return !!res && res.performed === true;
    } catch {
      return false;
    }
  }

  // ═════════════════════════════════════════════════════════
  // Instalación por ADB (APK + permiso de accesibilidad)
  // ═════════════════════════════════════════════════════════

  /**
   * Flujo completo: descargar APK → push → pm install → conceder
   * permiso de accesibilidad por settings put → verificar ping.
   */
  async install(onProgress: ProgressCb = () => undefined): Promise<boolean> {
    const adb = webAdb.adb;
    if (!adb) throw new Error("Dispositivo no conectado");

    // ── 1. Descargar el APK embebido en la web (50 KB, instantáneo) ──
    onProgress({
      phase: "downloading",
      progress: 0.05,
      message: "Descargando DexPort Agent v2 (50 KB)…",
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

    // ── 3. pm install (igual que `adb install -r`) ──
    onProgress({
      phase: "installing",
      progress: 0.55,
      message: "Instalando agente (pm install)…",
    });
    const installOut = await webAdb.shellTimeout(
      `pm install -r -g ${AGENT_APK_DEVICE_PATH} 2>&1`,
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

    // ── 4. Conceder el permiso de ACCESIBILIDAD por ADB ──
    onProgress({
      phase: "enabling",
      progress: 0.75,
      message: "Activando permiso de accesibilidad…",
    });
    await webAdb.shellSafe(enableAccessibilityScript(), 10_000);

    // ── 4b. v2: activar el ESPEJO DE NOTIFICACIONES por ADB ──
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

    // abrir la app del agente: «des-detiene» el paquete (una app recién
    // instalada está en estado stopped y algunas ROMs no ligan el servicio
    // de accesibilidad hasta despierta)
    await webAdb.shellSafe(
      `am start -n ${AGENT_PKG}/.MainActivity 2>/dev/null`,
      6_000,
    );

    // ── 5. Verificar que el puente responde (reintentos: el servicio
    //       tarda ~1-2 s en arrancar tras recibir el permiso) ──
    onProgress({
      phase: "verifying",
      progress: 0.9,
      message: "Verificando el puente del agente…",
    });
    for (let i = 0; i < 6; i++) {
      await sleep(900);
      const pong = await this.ping(2_500);
      if (pong) {
        onProgress({ phase: "done", progress: 1, message: "DexPort Agent activo ✓" });
        return true;
      }
    }
    // el puente no respondió: puede requerir activación manual
    // (algunas ROMs ignoran el settings put por USB)
    onProgress({
      phase: "done",
      progress: 1,
      message:
        "Agente instalado — activa «DexPort Agent» en Ajustes → Accesibilidad si no se activó solo",
    });
    return false;
  }
}

/**
 * Script robusto de activación del servicio de accesibilidad:
 * respeta los servicios ya habilitados (append con «:») y fuerza
 * accessibility_enabled=1. El sistema liga el servicio al cambiar el
 * setting (y `am start` de la MainActivity lo despierta si estaba en
 * estado stopped tras la instalación).
 */
function enableAccessibilityScript(): string {
  const svc = AGENT_SERVICE;
  return (
    `svc="${svc}"; ` +
    `cur=$(settings get secure enabled_accessibility_services); ` +
    `case "$cur" in *"$svc"*) ;; ` +
    `*) if [ -z "$cur" ] || [ "$cur" = "null" ]; then n="$svc"; ` +
    `else n="$cur:$svc"; fi; ` +
    `settings put secure enabled_accessibility_services "$n"; ;; esac; ` +
    `settings put secure accessibility_enabled 1; true`
  );
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
      // v2: los lotes de iconos pueden pesar unos cientos de KB por línea
      if (text.length > 8_000_000) break;
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
