/**
 * DexPort — WebAdbService
 * ════════════════════════════════════════════════════════════
 * Port web del `AdbProvider` + `DeviceManager` originales de Android DEX.
 *
 * El original ejecutaba binarios `adb` locales (Process.run):
 *   - adb start-server / adb connect / adb reverse
 *   - adb push / adb shell ...
 *
 * Este port sustituye TODO el transporte local por WebADB:
 *   - @yume-chan/adb-daemon-webusb  (sucesor de @yume-chan/adb-backend-webusb)
 *   - @yume-chan/adb-credential-web (credenciales RSA en IndexedDB)
 *   - @yume-chan/adb                (protocolo ADB puro sobre WebUSB)
 *
 * La autenticación RSA y el handshake son idénticos a los del daemon ADB
 * de escritorio, por lo que los comandos shell se reenvían tal cual.
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
    } catch (e) {
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

  /** `AdbProvider.run("shell ...")` del original → spawnWaitText vía socket shell. */
  async shell(command: string): Promise<string> {
    if (!this._adb) throw new Error("Dispositivo no conectado");
    return this._adb.subprocess.noneProtocol.spawnWaitText([
      "sh",
      "-c",
      command,
    ]);
  }

  /**
   * Como `shell()` pero no lanza si el dispositivo está desconectado.
   * Devuelve "" silenciosamente (usado por el polling de telemetría).
   */
  async shellSafe(command: string): Promise<string> {
    try {
      return await this.shell(command);
    } catch {
      return "";
    }
  }

  /** Info del dispositivo (`getprop`), port del banner del original. */
  async getDeviceInfo(): Promise<DeviceInfo> {
    const [model, brand, version, sdk] = await Promise.all([
      this.shellSafe("getprop ro.product.model"),
      this.shellSafe("getprop ro.product.brand"),
      this.shellSafe("getprop ro.build.version.release"),
      this.shellSafe("getprop ro.build.version.sdk"),
    ]);
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
    await this.shell("settings put global enable_freeform_support 1");
    await this.shell(
      "settings put global force_desktop_mode_on_external_displays 1",
    );
  }

  async restoreDexSettings(): Promise<void> {
    await this.shell("settings put global enable_freeform_support 0");
    await this.shell(
      "settings put global force_desktop_mode_on_external_displays 0",
    );
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
