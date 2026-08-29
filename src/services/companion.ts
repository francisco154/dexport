/**
 * DexPort v3 — CompanionService
 * ════════════════════════════════════════════════════════════
 * Instalador del LAUNCHER ORIGINAL de Android DEX (companion APK),
 * extraído por ingeniería inversa del release oficial v1.2 del
 * repositorio original (Android_Dex_Windows.zip → Build_copy/AndroidDex.apk).
 *
 * Hallazgos de la ingeniería inversa (AndroidManifest.xml del APK):
 *   - package: `com.shrey.androiddex` (versionName 1.2, versionCode 2)
 *   - `com.shrey.androiddex.MainActivity` es una actividad HOME
 *     (intent-filter MAIN + HOME + DEFAULT) → ES el launcher DeX:
 *     taskbar, app drawer y widgets se renderizan EN el display virtual.
 *   - `ServerStartService` — puente WebSocket dispositivo↔escritorio.
 *   - `AdbStartReceiver` — acción `com.shrey.androiddex.START_SERVER`
 *     para arrancar el puente por ADB.
 *
 * El original (Dart/Flutter en Windows) instala el APK con
 * `adb install AndroidDex.apk` y lanza `com.shrey.androiddex/.MainActivity`
 * en el display virtual. Aquí el equivalente Web es:
 *   fetch(APK) → adb.sync().write() (push ADB con progreso)
 *   → `pm install -r -g /data/local/tmp/...apk`
 *   → `am start --display N -n com.shrey.androiddex/.MainActivity`
 */

import type { Adb } from "@yume-chan/adb";
import { ReadableStream } from "@yume-chan/stream-extra";
import { webAdb } from "./adb";

export const COMPANION_PKG = "com.shrey.androiddex";
export const COMPANION_MAIN_ACTIVITY = `${COMPANION_PKG}/.MainActivity`;
export const COMPANION_SERVER_SERVICE = `${COMPANION_PKG}/.init_start_server.ServerStartService`;
export const COMPANION_START_ACTION = `${COMPANION_PKG}.START_SERVER`;
export const COMPANION_APK_URL = "androiddex-launcher.apk";
export const COMPANION_APK_DEVICE_PATH = "/data/local/tmp/dexport-companion.apk";
export const COMPANION_APK_SIZE = 44_114_427;
export const COMPANION_APK_SHA256 = "76f09aac3c2d55cb";

export type InstallPhase =
  | "idle"
  | "downloading"
  | "pushing"
  | "installing"
  | "launching"
  | "done"
  | "error";

export interface InstallProgress {
  phase: InstallPhase;
  /** 0..1 dentro de la fase actual */
  progress: number;
  message: string;
  /** mensaje de error si phase === "error" */
  error?: string;
}

type ProgressCb = (p: InstallProgress) => void;

export class CompanionService {
  private static _instance: CompanionService | null = null;
  static get instance(): CompanionService {
    if (!CompanionService._instance) {
      CompanionService._instance = new CompanionService();
    }
    return CompanionService._instance;
  }

  private constructor() {}

  /** ¿Está instalado el launcher original? (`pm list packages`) */
  async isInstalled(): Promise<boolean> {
    const out = await webAdb.shellSafe(
      `pm list packages ${COMPANION_PKG} 2>/dev/null`,
      10_000,
    );
    return out.includes(`package:${COMPANION_PKG}`);
  }

  /** versionName del companion instalado (o null). */
  async getVersion(): Promise<string | null> {
    const out = await webAdb.shellSafe(
      `dumpsys package ${COMPANION_PKG} 2>/dev/null | grep -m1 versionName`,
      10_000,
    );
    const m = out.match(/versionName=(\S+)/);
    return m ? m[1] : null;
  }

  /**
   * Flujo completo: descargar → push → pm install → (lanzamiento aparte).
   * Equivale al `installApk()` del original (`adb install AndroidDex.apk`).
   */
  async install(onProgress: ProgressCb = () => undefined): Promise<boolean> {
    const adb = webAdb.adb;
    if (!adb) throw new Error("Dispositivo no conectado");

    // ── 1. Descargar el APK embebido en la web (mismo binario del release) ──
    onProgress({ phase: "downloading", progress: 0.05, message: "Descargando launcher AndroidDex (44 MB)…" });
    const response = await fetch(COMPANION_APK_URL);
    if (!response.ok || !response.body) {
      throw new Error("No se pudo descargar el APK del launcher");
    }
    const total = Number(response.headers.get("content-length")) || COMPANION_APK_SIZE;

    // Stream con conteo de bytes → progreso real de descarga
    const downloadCounter = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        received += chunk.byteLength;
        onProgress({
          phase: "downloading",
          progress: Math.min(0.99, received / total),
          message: `Descargando launcher AndroidDex… ${(received / 1_048_576).toFixed(1)} MB`,
        });
        controller.enqueue(chunk);
      },
    });
    let received = 0;
    const downloadedStream = response.body.pipeThrough(downloadCounter);
    // Materializar el buffer (necesario para el push por sync)
    const chunks: Uint8Array[] = [];
    const reader = downloadedStream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const apk = concatChunks(chunks);
    if (apk.byteLength < 1_000_000) {
      throw new Error("APK descargado inválido (demasiado pequeño)");
    }

    // ── 2. Push al dispositivo (AdbSync, mismo canal que scrcpy-server) ──
    onProgress({ phase: "pushing", progress: 0.02, message: "Subiendo APK al dispositivo…" });

    // Push por bloques de 256 KB con progreso
    const BLOCK = 256 * 1024;
    let offset = 0;
    let blockIndex = 0;
    const blockCount = Math.ceil(apk.byteLength / BLOCK);
    const pushStream = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (offset >= apk.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + BLOCK, apk.byteLength);
        controller.enqueue(apk.subarray(offset, end));
        offset = end;
        blockIndex++;
        onProgress({
          phase: "pushing",
          progress: Math.min(0.99, blockIndex / blockCount),
          message: `Subiendo APK al dispositivo… ${((blockIndex * BLOCK) / 1_048_576).toFixed(1)} / ${(apk.byteLength / 1_048_576).toFixed(1)} MB`,
        });
      },
    });

    const sync = await adb.sync();
    try {
      await sync.write({
        filename: COMPANION_APK_DEVICE_PATH,
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
    onProgress({ phase: "installing", progress: 0.2, message: "Instalando en el dispositivo (confirma en el teléfono si lo pide)…" });
    const installOut = await webAdb.shellTimeout(
      `pm install -r -g ${COMPANION_APK_DEVICE_PATH} 2>&1`,
      120_000,
    );
    if (!/Success/i.test(installOut)) {
      const reason =
        installOut
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("pkg:"))
          .join(" · ") || "razón desconocida";
      throw new Error(`pm install falló: ${reason.slice(0, 200)}${installHint(reason)}`);
    }

    // limpiar el temporal del dispositivo
    void webAdb.shellSafe(`rm -f ${COMPANION_APK_DEVICE_PATH}`, 5_000);

    onProgress({ phase: "done", progress: 1, message: "Launcher AndroidDex instalado ✓" });
    return true;
  }

  /**
   * Arranca el puente del companion (ServerStartService + broadcast
   * START_SERVER) — el mismo arranque que hace el escritorio original
   * al conectar el dispositivo.
   */
  async startBridge(): Promise<void> {
    await webAdb.shellSafe(
      `am start-foreground-service -n ${COMPANION_SERVER_SERVICE} 2>/dev/null; am broadcast -a ${COMPANION_START_ACTION} 2>/dev/null`,
      10_000,
    );
  }

  /**
   * Lanza el launcher ORIGINAL en el display virtual.
   * `am start --display N -n com.shrey.androiddex/.MainActivity`
   */
  async launchOnDisplay(displayId: number): Promise<boolean> {
    // MainActivity es HOME: intent explícito al display virtual
    const out = await webAdb.shellSafe(
      `am start --display ${displayId} -n ${COMPANION_MAIN_ACTIVITY} 2>&1`,
      15_000,
    );
    if (/Starting:/i.test(out) && !/Error|Exception/i.test(out)) {
      return true;
    }
    // fallback: HOME genérico en el display (Android resuelve al companion
    // porque también tiene categoría HOME)
    const out2 = await webAdb.shellSafe(
      `am start --display ${displayId} -a android.intent.action.MAIN -c android.intent.category.HOME 2>&1`,
      15_000,
    );
    return /Starting:|Warning/i.test(out2) && !/Error type/i.test(out2);
  }

  /** Desinstala el companion (para "volver al estado original"). */
  async uninstall(): Promise<boolean> {
    const out = await webAdb.shellSafe(`pm uninstall ${COMPANION_PKG} 2>&1`, 20_000);
    return /Success/i.test(out);
  }
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * v5: consejo amable para los motivos de fallo más comunes de
 * `pm install` en Samsung/One UI y otros fabricantes.
 */
export function installHint(rawError: string): string {
  const e = rawError.toLowerCase();
  if (e.includes("user_restricted") || e.includes("user_restriction")) {
    return " — activa «Instalar vía USB» en Opciones de desarrollador del teléfono y reintenta";
  }
  if (e.includes("verification_timeout") || e.includes("verifier")) {
    return " — el verificador de apps tardó demasiado: acepta el diálogo del teléfono o desactiva «Verificar apps vía USB»";
  }
  if (e.includes("update_incompatible") || e.includes("signatures")) {
    return " — desinstala primero la versión anterior del launcher (panel Dispositivo → desinstalar) e reintenta";
  }
  if (e.includes("insufficient_storage")) {
    return " — libera espacio en el teléfono (~100 MB) e reintenta";
  }
  if (e.includes("cancelled") || e.includes("canceled")) {
    return " — la instalación se canceló: acepta el diálogo de confirmación del teléfono";
  }
  return "";
}

export const companion = CompanionService.instance;
