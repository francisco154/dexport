/**
 * DexPort v2 — WebAdbService
 * ════════════════════════════════════════════════════════════
 * Port web del `AdbProvider` + `DeviceManager` originales de Android DEX.
 *
 * v2 (ingeniería inversa del build original):
 *   - Todos los comandos con TIMEOUT (v1 se colgaba en el 93% esperando
 *     `dumpsys media_session` / `pm list packages` que en Samsung pueden
 *     tardar minutos o bloquearse indefinidamente).
 *   - Batch de comandos en UN solo stream (menos sockets ADB concurrentes
 *     compitiendo con el video por el ancho de banda de WebUSB).
 *   - `am start --display N` (mismo mecanismo que el AppController del JAR
 *     original: ActivityOptions.setLaunchDisplayId).
 *   - Detección del launcher por defecto (`cmd shortcut get-default-launcher`).
 *   - Detección del display virtual creado por scrcpy (nombre "scrcpy").
 */

import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import {
  AdbDaemonWebUsbDevice,
  AdbDaemonWebUsbDeviceManager,
} from "@yume-chan/adb-daemon-webusb";

export interface DeviceInfo {
  serial: string;
  name: string;
  model: string;
  brand: string;
  androidVersion: string;
  sdk: string;
}

export interface AdbConnectionState {
  connected: boolean;
  serial: string | null;
  deviceName: string | null;
}

/** Timeout por defecto para comandos shell (ms). */
const DEFAULT_SHELL_TIMEOUT = 12_000;

/**
 * AdbProvider (port) — única fuente de verdad para la ejecución de comandos.
 * Equivale a `AdbProvider.runOnDevice()` del original.
 */
export class WebAdbService {
  private static _instance: WebAdbService | null = null;
  static get instance(): WebAdbService {
    if (!WebAdbService._instance) {
      WebAdbService._instance = new WebAdbService();
    }
    return WebAdbService._instance;
  }

  readonly deviceManager: AdbDaemonWebUsbDeviceManager | undefined;
  private credentialStore: AdbWebCredentialStore | null = null;
  private _adb: Adb | null = null;
  private _device: AdbDaemonWebUsbDevice | null = null;
  private _onDisconnect: (() => void) | null = null;

  /** Dispositivos ya autorizados (el usuario ya les dio permiso al navegador) */
  private authorizedDevices: AdbDaemonWebUsbDevice[] = [];

  private constructor() {
    // `BROWSER` es undefined si el navegador no soporta WebUSB (p.ej. Safari/Firefox)
    this.deviceManager = AdbDaemonWebUsbDeviceManager.BROWSER;
  }

  get adb(): Adb | null {
    return this._adb;
  }

  get device(): AdbDaemonWebUsbDevice | null {
    return this._device;
  }

  get isSupported(): boolean {
    return (
      !!this.deviceManager &&
      typeof navigator !== "undefined" &&
      !!navigator.usb &&
      window.isSecureContext
    );
  }

  private async ensureCredentials(): Promise<AdbWebCredentialStore> {
    if (!this.credentialStore) {
      this.credentialStore = new AdbWebCredentialStore("DexPort");
    }
    return this.credentialStore;
  }

  /**
   * DeviceManager.getDevices() del original → dispositivos autorizados.
   * El "ADB Manager Dialog" del original aparece cuando hay 0 o 2+;
   * aquí además existe `requestDevice()` que abre el picker nativo del navegador.
   */
  async getAuthorizedDevices(): Promise<AdbDaemonWebUsbDevice[]> {
    if (!this.deviceManager) return [];
    try {
      this.authorizedDevices = await this.deviceManager.getDevices();
      return this.authorizedDevices;
    } catch {
      return [];
    }
  }

  /** Abre el selector nativo de WebUSB del navegador (Chrome/Edge). */
  async requestDevice(): Promise<AdbDaemonWebUsbDevice | null> {
    if (!this.deviceManager) throw new Error("WebUSB no soportado en este navegador");
    try {
      const device = await this.deviceManager.requestDevice();
      if (device) {
        this.authorizedDevices = await this.deviceManager.getDevices();
      }
      return device ?? null;
    } catch {
      // El usuario canceló el diálogo del navegador
      return null;
    }
  }

  /**
   * Conecta y autentica un dispositivo — reemplaza
   * `adb start-server` + `adb connect` + `adb reverse` del original.
   * La autenticación RSA con el credential store web equivale al
   * diálogo "Permitir depuración USB" del original.
   */
  async connect(device: AdbDaemonWebUsbDevice): Promise<Adb> {
    if (this._adb) {
      await this.disconnect();
    }

    const connection = await device.connect();
    const credentialStore = await this.ensureCredentials();

    const transport = await AdbDaemonTransport.authenticate({
      serial: device.serial,
      connection,
      credentialStore,
    });

    const adb = new Adb(transport);
    this._adb = adb;
    this._device = device;

    // ReconnectionManager (port): vigilamos la pérdida del transporte
    this.watchDisconnection();

    return adb;
  }

  private watchDisconnection() {
    if (!this._adb) return;
    const adb = this._adb;
    adb.disconnected.then(
      () => {
        if (this._adb === adb) {
          this._adb = null;
          this._onDisconnect?.();
        }
      },
      () => {
        if (this._adb === adb) {
          this._adb = null;
          this._onDisconnect?.();
        }
      },
    );
  }

  onDisconnected(callback: () => void): void {
    this._onDisconnect = callback;
  }

  /**
   * `AdbProvider.run("shell ...")` del original → spawnWaitText vía socket shell.
   *
   * ⚠️ v5 — CORRECCIÓN CRÍTICA del protocolo `exec:`:
   *   adbd ejecuta `exec:<cadena>` con `sh -c` EN EL DISPOSITIVO, y la
   *   librería une los argumentos con espacios SIN escaparlos
   *   (`command.join(" ")`). El código antiguo enviaba
   *   `["sh", "-c", comando]` → `exec:sh -c cmd package query-activities …`
   *   → el dispositivo ejecutaba `sh -c "cmd"` (¡solo `cmd`, sin args!)
   *   → TODOS los comandos con espacios devolvían vacío.
   *   Por eso no se detectaban launchers ni se abría nada (v1-v4).
   *
   *   Ahora se envía el comando COMPLETO como único elemento del array
   *   (join es identidad) → `exec:<comando>` → `sh -c "<comando>"` ✓.
   *   Pipes, comillas, `;` y redirecciones los interpreta el sh del dispositivo.
   */
  async shell(command: string): Promise<string> {
    if (!this._adb) throw new Error("Dispositivo no conectado");
    return this._adb.subprocess.noneProtocol.spawnWaitText([command]);
  }

  /**
   * v5: `shell()` con timeout REAL — además de la carrera, este método
   * CIERRA el proceso/Socket ADB al vencer el plazo (AbortSignal de la
   * librería) y conserva la salida parcial recibida hasta entonces.
   * v1-v4 dejaban el stream abierto para siempre (fugas de sockets que
   * acababan ahogando la conexión bajo el video de scrcpy).
   */
  async shellTimeout(command: string, timeoutMs = DEFAULT_SHELL_TIMEOUT): Promise<string> {
    const adb = this._adb;
    if (!adb) throw new Error("Dispositivo no conectado");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // El AbortSignal viaja dentro de spawn: si createSocket tarda, al
      // resolverse con la señal ya abortada la librería cierra el socket sola.
      const proc = await Promise.race([
        adb.subprocess.noneProtocol.spawn([command], controller.signal),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`timeout (${timeoutMs}ms): ${command.slice(0, 60)}`)),
            timeoutMs,
          ),
        ),
      ]);

      // Lectura manual del stream: si el abort corta el socket a mitad,
      // conservamos los chunks que ya llegaron (lectura parcial).
      const reader = proc.output.getReader();
      const chunks: Uint8Array[] = [];
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
      } catch {
        /* socket cerrado por timeout — nos quedamos con la salida parcial */
      }

      try {
        await proc.exited;
      } catch {
        /* abortado — ignorar */
      }

      let text = "";
      for (const c of chunks) text += decoder.decode(c, { stream: true });
      text += decoder.decode();
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Como `shell()` pero nunca lanza. Devuelve "" silenciosamente
   * (usado por el polling de telemetría).
   */
  async shellSafe(command: string, timeoutMs = DEFAULT_SHELL_TIMEOUT): Promise<string> {
    try {
      return await this.shellTimeout(command, timeoutMs);
    } catch {
      return "";
    }
  }

  /**
   * v5: ejecuta varios comandos en UN stream shell, separados por
   * marcadores. Misma idea que v2 pero SIN el doble wrapper `sh -c`
   * (que era la causa del bug raíz: ver `shell()`).
   * El stderr de cada comando se descarta en el dispositivo para que
   * la salida de marcadores nunca se contamine (noneProtocol mezcla
   * stdout+stderr en un solo stream).
   */
  async shellBatch(commands: string[], timeoutMs = 15_000): Promise<string[]> {
    const MARK = "__DEXPORT_MARK__";
    const script = commands
      .map((c, i) => `echo ${MARK}${i}; ( ${c} ) 2>/dev/null`)
      .join("\n");
    const out = await this.shellSafe(script, timeoutMs);
    const parts: string[] = commands.map(() => "");
    let current = -1;
    let buf = "";
    for (const line of out.split("\n")) {
      const m = line.match(new RegExp(`^${MARK}(\\d+)$`));
      if (m) {
        if (current >= 0) parts[current] = buf.replace(/^\n/, "");
        current = Number(m[1]);
        buf = "";
      } else if (current >= 0) {
        buf += line + "\n";
      }
    }
    if (current >= 0) parts[current] = buf.replace(/^\n/, "");
    return parts;
  }

  /** Info del dispositivo (`getprop`) — batch en un stream. */
  async getDeviceInfo(): Promise<DeviceInfo> {
    const [model, brand, version, sdk] = await this.shellBatch(
      [
        "getprop ro.product.model",
        "getprop ro.product.brand",
        "getprop ro.build.version.release",
        "getprop ro.build.version.sdk",
      ],
      8_000,
    );
    const clean = (s: string) => s.trim();
    return {
      serial: this._device?.serial ?? "",
      name:
        this._device?.name ||
        `${clean(brand)} ${clean(model)}`.trim() ||
        this._device?.serial ||
        "Dispositivo Android",
      model: clean(model),
      brand: clean(brand),
      androidVersion: clean(version),
      sdk: clean(sdk),
    };
  }

  /**
   * Comandos DeX del entorno original — se reenvían tal cual a través
   * del socket shell de WebADB:
   *   settings put global enable_freeform_support 1
   *   settings put global force_desktop_mode_on_external_displays 1
   */
  async applyDexSettings(): Promise<void> {
    await this.shellBatch(
      [
        "settings put global enable_freeform_support 1",
        "settings put global force_desktop_mode_on_external_displays 1",
      ],
      8_000,
    );
  }

  async restoreDexSettings(): Promise<void> {
    await this.shellBatch(
      [
        "settings put global enable_freeform_support 0",
        "settings put global force_desktop_mode_on_external_displays 0",
      ],
      8_000,
    );
  }

  // ═════════════════════════════════════════════════════════
  // v2: utilidades de apps/display (port del AppController del JAR)
  // ═════════════════════════════════════════════════════════

  /**
   * Launcher por defecto del dispositivo.
   * `cmd shortcut get-default-launcher` (Android 7.1+) devuelve:
   *   com.sec.android.app.launcher/com.sec.android.app.launcher.activities.Launcher
   * En versiones antiguas: "Launcher: pkg/activity" o el componente.
   */
  async getDefaultLauncher(): Promise<string | null> {
    const out = await this.shellSafe(
      "cmd shortcut get-default-launcher 2>/dev/null || cmd package resolve-activity -c android.intent.category.HOME 2>/dev/null | grep name=",
      8_000,
    );
    const comp = out.match(/([a-z0-9_.]+)\/[a-zA-Z0-9_.$]+/);
    if (comp) return comp[1];
    const any = out.match(/name=([a-z0-9_.]+)\.([a-zA-Z0-9_.$]+)/);
    return any ? `${any[1]}.${any[2]}` : null;
  }

  /**
   * Display virtual creado por scrcpy (se llama "scrcpy").
   * Parse de `dumpsys display` — misma técnica que el original
   * (`mDisplayId=(\d+)` + "Virtual display ID from ADB query").
   */
  async findScrcpyDisplayId(): Promise<number | null> {
    const out = await this.shellSafe(
      "dumpsys display 2>/dev/null | grep -iE 'scrcpy|mDisplayId' | head -40",
      8_000,
    );
    if (!out) return null;
    // Líneas tipo: "mDisplayId=2" dentro del bloque del display "scrcpy"
    const lines = out.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (/scrcpy/i.test(lines[i])) {
        // busca mDisplayId en esta línea o las siguientes (±3)
        for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) {
          const m = lines[j].match(/(?:mDisplayId=|displayId[= :])(\d+)/);
          if (m) return Number(m[1]);
        }
      }
    }
    // fallback: el display "scrcpy" con su id entre paréntesis
    const par = out.match(/scrcpy[^\n]*?#(\d+)/i) || out.match(/scrcpy[^\n]*?\((\d+)\)/i);
    return par ? Number(par[1]) : null;
  }

  /**
   * v2: lanza una app en un display concreto — equivalente shell del
   * `AppController.startAppOnDisplay` del JAR original
   * (ActivityOptions.setLaunchDisplayId + FLAG_ACTIVITY_NEW_TASK).
   *
   * `am start --display N` requiere Android 10+; en versiones menores
   * la app arranca en el display principal.
   */
  async launchOnDisplay(
    pkg: string,
    displayId: number,
    opts: { forceStop?: boolean } = {},
  ): Promise<boolean> {
    // 1. resolver la launch activity del paquete
    const resolveOut = await this.shellSafe(
      `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg} 2>/dev/null | tail -n 1`,
      8_000,
    );
    let target = resolveOut.trim();
    if (!target || !target.includes("/")) {
      target = pkg; // resolve falló → intent genérico
    }
    if (opts.forceStop) {
      await this.shellSafe(`am force-stop ${pkg}`, 6_000);
    }
    const out = await this.shellSafe(
      `am start --display ${displayId} -n ${target} 2>&1`,
      10_000,
    );
    return !/Error|Exception|Error type/i.test(out) || /Starting:/i.test(out);
  }

  /**
   * v2: lanza el HOME (launcher) en un display.
   * Esto convierte el display virtual vacío en un escritorio real:
   * el launcher del teléfono (One UI Home, Pixel Launcher…)
   * se renderiza en el display virtual con su wallpaper y app grid.
   */
  async launchHomeOnDisplay(displayId: number): Promise<boolean> {
    const out = await this.shellSafe(
      `am start --display ${displayId} -a android.intent.action.MAIN -c android.intent.category.HOME 2>&1`,
      10_000,
    );
    return /Starting:|Warning|display/i.test(out);
  }

  /** Fallback de input para cuando el canal de control no está disponible. */
  async inputKeyevent(keycode: number): Promise<void> {
    await this.shellSafe(`input keyevent ${keycode}`, 6_000);
  }

  /**
   * v7: keyevent DIRIGIDO a un display concreto — el fix de «ATRÁS funciona
   * a medias». El `input` de Android 10+ acepta `-d <displayId>`: el evento
   * lleva setDisplayId(vd) y llega a la ventana enfocada DEL DISPLAY VIRTUAL
   * (no a la del teléfono). Si el dispositivo no soporta `-d` (salida con
   * "Error"/"usage"), devuelve false para que el llamante use el canal de
   * control de scrcpy.
   */
  async inputKeyeventOnDisplay(keycode: number, displayId: number): Promise<boolean> {
    if (displayId <= 0) {
      await this.inputKeyevent(keycode);
      return true;
    }
    const out = await this.shellSafe(`input -d ${displayId} keyevent ${keycode}`, 6_000);
    const bad = /error|usage|invalid|not found|unknown/i.test(out) && !/^\s*$/.test(out);
    return !bad;
  }

  /**
   * v7: mueve una tarea a otro display — el corazón del «minimizar» estilo
   * Windows. `am move-task <taskId> <displayId>` (Android 10+); si el
   * dispositivo no lo tiene, prueba `am stack move` (Android 9-11).
   * Devuelve true si algún comando se aceptó.
   */
  async moveTask(taskId: number, displayId: number): Promise<boolean> {
    const out1 = await this.shellSafe(
      `am move-task ${taskId} ${displayId} 2>&1`,
      8_000,
    );
    if (!/error|exception|unknown command|not found/i.test(out1)) return true;
    const out2 = await this.shellSafe(
      `am stack move ${taskId} ${displayId} 2>&1`,
      8_000,
    );
    return !/error|exception|unknown command|not found/i.test(out2);
  }

  /**
   * v7: trae una tarea al frente / la abre en ventana freeform (5) o
   * pantalla completa (1) sobre un display. `am start` con la tarea
   * existente la mueve al frente de SU display; `--windowingMode` cambia
   * el modo de ventana (freeform = ventanas estilo DeX/Windows).
   */
  async startActivityOnDisplay(
    component: string,
    displayId: number,
    opts: { windowingMode?: number; newTask?: boolean } = {},
  ): Promise<boolean> {
    const flags = opts.newTask === false ? "" : " -f 0x10000000"; // FLAG_ACTIVITY_NEW_TASK
    const wm =
      opts.windowingMode != null ? ` --windowingMode ${opts.windowingMode}` : "";
    const out = await this.shellSafe(
      `am start --display ${displayId}${flags}${wm} -n ${component} 2>&1`,
      10_000,
    );
    return /Starting:|Warning/i.test(out) && !/Error|Exception/i.test(out);
  }

  /** Resolución con caché de la activity LAUNCHER de un paquete (fallback). */
  private launcherActivityCache = new Map<string, string | null>();

  async resolveLauncherActivity(pkg: string): Promise<string | null> {
    if (this.launcherActivityCache.has(pkg)) {
      return this.launcherActivityCache.get(pkg) ?? null;
    }
    const out = await this.shellSafe(
      `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg} 2>/dev/null | tail -n 1`,
      8_000,
    );
    let target = out.trim();
    if (!target || !target.includes("/")) {
      // a veces devuelve "priority=0 preferredOrder=0 match=…" — buscar pkg/
      const m = out.match(new RegExp(`(${pkg.replace(/[.]/g, "\\.")}/\\S+)`));
      target = m ? m[1] : "";
    }
    const result = target.includes("/") ? target : null;
    this.launcherActivityCache.set(pkg, result);
    return result;
  }

  /** `pm list packages` con timeout — el listado de apps nunca bloquea el boot. */
  async listPackages(kind: "user" | "system"): Promise<string> {
    const flag = kind === "user" ? "-3" : "-s";
    return this.shellSafe(
      `pm list packages ${flag} 2>/dev/null | head -400`,
      25_000,
    );
  }

  async forceStop(pkg: string): Promise<void> {
    await this.shellSafe(`am force-stop ${pkg}`, 6_000);
  }

  async disconnect(): Promise<void> {
    const adb = this._adb;
    this._adb = null;
    this._device = null;
    if (adb) {
      try {
        await adb.close();
      } catch {
        /* noop */
      }
    }
  }
}

export const webAdb = WebAdbService.instance;
