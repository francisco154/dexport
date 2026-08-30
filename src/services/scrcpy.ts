/**
 * DexPort v6 — DisplayEngine
 * ════════════════════════════════════════════════════════════
 * Port web de `ScrcpyVideoManager` + `ScrcpyAudioManager` + `WindowManager`
 * de Android DEX.
 *
 * v6 — hallazgos de la ingeniería inversa del build ORIGINAL (Build_copy):
 *   ⚠ El original NO usa el scrcpy estándar: usa un FORK 3.3.3
 *   (`com.shrey.re_size_scrcpy`, AndroidDex-vd-server.jar) que añade:
 *     · TYPE_RESIZE_DISPLAY = 18 → redimensionar el display virtual EN VIVO
 *       (`virtualDisplay.resize()`, las apps SOBREVIVEN, solo config-change)
 *     · `new_display=WxH/dpi:r` → marca el display como redimensionable
 *     · `display_ime_policy=hide` → ocultar el teclado virtual del display
 *   ⚠ El original arranca con: `--new-display` + `--no-vd-system-decorations`
 *   (SIN barra de navegación de Android — solo sus propios botones) y
 *   `--stay-awake` + un PARTIAL_WAKE_LOCK en el JAR (la pantalla nunca se
 *   apaga mientras está conectado).
 *
 * Implementación web:
 *   · El cliente @yume-chan lanza SIEMPRE `com.genymobile.scrcpy.Server` →
 *     se inyecta un SPAWNER propio que sustituye el nombre de clase por
 *     `com.shrey.re_size_scrcpy.Server`, añade `:r` a new_display y agrega
 *     los argumentos extra del fork (ime policy, screen_off_timeout…).
 *   · RESIZE en vivo: mensaje de control crudo [18, w>>8, w&255, h>>8, h&255]
 *     (mismo formato binario que parsea el Controller del fork).
 *   · Tamaño inicial adaptado a la ventana (fitToWindow) → pantalla completa
 *     real sin bandas negras: el aspect del display virtual = aspect del
 *     área de video del navegador.
 */

import type { Adb } from "@yume-chan/adb";
import { AdbNoneProtocolSpawner } from "@yume-chan/adb";
import {
  AdbScrcpyClient,
  AdbScrcpyOptionsLatest,
} from "@yume-chan/adb-scrcpy";
import {
  ScrcpyNewDisplay as NewDisplay,
  type ScrcpyControlMessageWriter,
} from "@yume-chan/scrcpy";
import {
  WebCodecsVideoDecoder,
  WebGLVideoFrameRenderer,
  BitmapVideoFrameRenderer,
} from "@yume-chan/scrcpy-decoder-webcodecs";
import { TinyH264Decoder } from "@yume-chan/scrcpy-decoder-tinyh264";
import { ReadableStream, WritableStream } from "@yume-chan/stream-extra";
import { OpusAudioPlayer } from "../audio/opusPlayer";
import {
  computeDisplaySizeForContainer,
  transformForkArgs,
  buildResizeDisplayMessage,
} from "../utils/displayMath";

export const SCRCPY_SERVER_PATH = "/data/local/tmp/scrcpy-server.jar";

export interface DisplaySettings {
  width: number;
  height: number;
  dpi: number;
  videoBitRate: number;
  maxFps: number;
  videoCodec: "h264" | "h265" | "av1";
  audio: boolean;
  /** 0 = espejo de la pantalla real (fallback), true = display virtual */
  virtualDisplay: boolean;
  // ── v6 ──
  /** el display virtual replica el ASPECT de la ventana (pantalla completa real) */
  fitToWindow: boolean;
  /** redimensionar en vivo cuando cambia el tamaño de la ventana (mensaje 18) */
  autoResize: boolean;
  /** mostrar las barras de sistema de Android (nav/status) dentro del display */
  androidBars: boolean;
  /** ocultar el teclado virtual del display DeX (se escribe con teclado físico) */
  hideIme: boolean;
  /** mantener el dispositivo despierto mientras DexPort está conectado */
  keepScreenOn: boolean;
  // ── v11 ──
  /**
   * Modo ecológico: si la pestaña pasa a segundo plano ~3 min, el
   * escritorio se suspende solo (display virtual destruido) → el
   * teléfono queda 100% libre y sin tráfico USB. Al volver, se reanuda.
   */
  ecoMode: boolean;
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  width: 1920,
  height: 1080,
  dpi: 160,
  videoBitRate: 12_000_000,
  maxFps: 60,
  videoCodec: "h264",
  audio: true,
  virtualDisplay: true,
  fitToWindow: true,
  autoResize: true,
  androidBars: false,
  hideIme: true,
  keepScreenOn: true,
  ecoMode: true,
};

export interface DisplayEngineEvents {
  onFirstFrame?: () => void;
  onSizeChanged?: (width: number, height: number) => void;
  onExited?: (output: string[]) => void;
  onClipboard?: (text: string) => void;
  onLog?: (line: string) => void;
  onAudioWarn?: (msg: string) => void;
  /** display virtual creado en el dispositivo (id>0) */
  onDisplayId?: (displayId: number) => void;
  /** canal de control listo (mouse/teclado operativos) */
  onControllerReady?: () => void;
  /** el servidor se cayó pero podemos relanzar (no fatal durante boot) */
  onRecoverableExit?: (output: string[]) => void;
}

export interface DisplayHandle {
  client: AdbScrcpyClient<AdbScrcpyOptionsLatest<boolean>>;
  width: number;
  height: number;
}

/** tamaño final aplicado en la última sesión (para el store) */
let lastAppliedSize: { width: number; height: number } = { width: 1920, height: 1080 };

// re-export para compatibilidad de imports
export { computeDisplaySizeForContainer };

export class DisplayEngine {
  private _client: AdbScrcpyClient<AdbScrcpyOptionsLatest<boolean>> | null = null;
  private _decoder:
    | WebCodecsVideoDecoder
    | TinyH264Decoder
    | null = null;
  private _audioPlayer = new OpusAudioPlayer();
  private _events: DisplayEngineEvents = {};
  private _closed = false;
  private _frameCount = 0;
  private _displayId: number | null = null;
  /** ya se intentó el fallback a espejo (evita bucles) */
  private _mirrorFallbackUsed = false;
  private _controllerReadyFired = false;
  /** último tamaño enviado al servidor (para saber si un resize cambia algo) */
  private _currentSize: { width: number; height: number } = { width: 1920, height: 1080 };
  /** true si la sesión actual es un display virtual redimensionable (:r) */
  private _resizable = false;

  get audioPlayer(): OpusAudioPlayer {
    return this._audioPlayer;
  }

  get controller(): ScrcpyControlMessageWriter | null | undefined {
    return this._client?.controller;
  }

  get displayId(): number | null {
    return this._displayId;
  }

  get isRunning(): boolean {
    return !!this._client && !this._closed;
  }

  /** display actual redimensionable en vivo (fork :r) */
  get resizable(): boolean {
    return this._resizable && !!this._client && !this._closed;
  }

  get currentSize(): { width: number; height: number } {
    return { ...this._currentSize };
  }

  setEvents(events: DisplayEngineEvents): void {
    this._events = events;
  }

  /**
   * Empuja el binario scrcpy-server al dispositivo.
   * v6: el binario es el FORK DEL ORIGINAL (AndroidDex-vd-server.jar,
   * com.shrey.re_size_scrcpy 3.3.3) con START_APP + RESIZE_DISPLAY.
   */
  static async pushServer(adb: Adb): Promise<void> {
    const response = await fetch("scrcpy-server");
    if (!response.ok && !response.body) {
      throw new Error("No se pudo descargar scrcpy-server");
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength < 1024) {
      throw new Error("scrcpy-server inválido o no encontrado");
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(buffer));
        controller.close();
      },
    });
    await AdbScrcpyClient.pushServer(adb, stream);
  }

  /**
   * v6: spawner propio — mismo comando que construiría la librería, pero:
   *  · sustituye la clase `com.genymobile.scrcpy.Server` por el fork
   *    `com.shrey.re_size_scrcpy.Server` (el server del proyecto original)
   *  · añade `:r` (redimensionable) al valor de `new_display`
   *  · agrega argumentos extra del fork que la librería no conoce
   */
  private makeForkSpawner(
    adb: Adb,
    extras: string[],
    resizable: boolean,
  ): AdbNoneProtocolSpawner {
    return new AdbNoneProtocolSpawner(async (command, signal) => {
      const args = transformForkArgs(command, extras, resizable);
      return adb.subprocess.noneProtocol.spawn(args, signal);
    });
  }

  /**
   * Levanta la pantalla virtual DeX y la decodifica en el canvas.
   * v6: replica el arranque del original — display virtual SIN barras de
   * Android (`--no-vd-system-decorations`), pantalla siempre despierta
   * (`--stay-awake` + screen_off_timeout) y tamaño adaptado a la ventana.
   */
  async start(
    adb: Adb,
    canvas: HTMLCanvasElement,
    settings: DisplaySettings,
  ): Promise<DisplayHandle> {
    if (this._client) {
      await this.stop();
    }
    this._closed = false;
    this._frameCount = 0;
    this._displayId = null;
    this._controllerReadyFired = false;

    // ── v6: tamaño adaptado al aspect de la ventana ──
    let width = settings.width;
    let height = settings.height;
    if (settings.virtualDisplay && settings.fitToWindow) {
      const container = canvas.parentElement;
      const size = computeDisplaySizeForContainer(
        container?.clientWidth ?? 0,
        container?.clientHeight ?? 0,
        Math.max(settings.width, settings.height),
      );
      width = size.width;
      height = size.height;
    }
    this._currentSize = { width, height };
    this._resizable = settings.virtualDisplay;

    // ── argumentos extra del fork (la librería no los conoce) ──
    const extras: string[] = [];
    if (settings.virtualDisplay && settings.keepScreenOn) {
      // 24h: la pantalla del dispositivo no se apaga mientras corre scrcpy
      extras.push("screen_off_timeout=86400");
    }
    if (settings.virtualDisplay && settings.hideIme) {
      // DISPLAY_IME_POLICY_HIDE — el teclado virtual no aparece en el display DeX
      extras.push("display_ime_policy=hide");
    }

    const options = new AdbScrcpyOptionsLatest(
      {
        // ── Display virtual DeX (comando --new-display del original) ──
        ...(settings.virtualDisplay
          ? { newDisplay: new NewDisplay(width, height, settings.dpi) }
          : { displayId: 0 }),
        // v6: como el original — SIN barra de tareas de Android dentro del
        // display (el botón HOME de esa barra deja el display gris y roba
        // espacio; DexPort aporta sus propios botones en la taskbar web)
        vdSystemDecorations: settings.virtualDisplay && settings.androidBars,

        // ── Video ──
        video: true,
        videoCodec: settings.videoCodec,
        videoBitRate: settings.videoBitRate,
        maxFps: settings.maxFps,
        maxSize: 0,

        // ── Audio (streaming por-app del original → audio del dispositivo) ──
        audio: settings.audio && OpusAudioPlayer.isSupported,
        audioCodec: "opus" as const,
        audioBitRate: 96_000,

        // ── Control ──
        control: true,
        clipboardAutosync: true,
        // v6: como el original — mantener el dispositivo despierto
        stayAwake: settings.keepScreenOn,
        powerOn: true,
        cleanup: true,

        // ── Red: en web SIEMPRE forward (el navegador no acepta conexiones entrantes) ──
        tunnelForward: true,

        sendDeviceMeta: true,
        sendDummyByte: true,
        sendCodecMeta: true,
        logLevel: "info" as const,
      },
      {
        version: "3.3.3",
        // v6: spawner del fork (clase + :r + extras)
        spawner: this.makeForkSpawner(adb, extras, settings.virtualDisplay),
      },
    );

    const client = await AdbScrcpyClient.start(adb, SCRCPY_SERVER_PATH, options);
    this._client = client;
    lastAppliedSize = { width, height };

    // ── canal de control listo → UI habilitada ──
    if (client.controller) {
      setTimeout(() => {
        if (!this._controllerReadyFired && !this._closed) {
          this._controllerReadyFired = true;
          this._events.onControllerReady?.();
        }
      }, 0);
    }

    // ── Monitor de salida prematura (ReconnectionManager) ──
    client.exited.then(
      () => {
        if (!this._closed) {
          this._events.onExited?.([]);
        }
      },
      () => {
        if (!this._closed) {
          this._events.onExited?.([]);
        }
      },
    );

    // ── Log del servidor scrcpy + parse del display ID virtual ──
    void client.output
      .pipeTo(
        new WritableStream<string>({
          write: (line) => {
            if (!line.trim()) return;
            this._events.onLog?.(line);
            const m = line.match(/New display:\s*\d+x\d+\/\d+\s*\(id=(\d+)\)/i);
            if (m) {
              const id = Number(m[1]);
              if (id > 0) {
                this._displayId = id;
                this._events.onDisplayId?.(id);
              }
            }
            // el fork informa de los resizes en vivo
            const r = line.match(/Resized display to:\s*(\d+)x(\d+)/i);
            if (r) {
              this._currentSize = { width: Number(r[1]), height: Number(r[2]) };
            }
          },
        }),
      )
      .catch(() => undefined);

    // ── Clipboard autosync ──
    if (client.clipboard) {
      void client.clipboard
        .pipeTo(
          new WritableStream<string>({
            write: (text) => this._events.onClipboard?.(text),
          }),
        )
        .catch(() => undefined);
    }

    // ── AUDIO — consumir SIEMPRE el stream ──
    const audioStreamPromise = client.audioStream;
    if (audioStreamPromise) {
      void audioStreamPromise
        .then(async (meta) => {
          if (!meta || meta.type !== "success") {
            return;
          }
          await this._audioPlayer.start(meta.stream, (msg) =>
            this._events.onAudioWarn?.(msg),
          );
        })
        .catch(() => undefined);
    }

    // ── Video: WebCodecs con fallback TinyH264 ──
    const videoStream = await client.videoStream;
    if (videoStream) {
      const codec = videoStream.metadata.codec;
      let decoder: WebCodecsVideoDecoder | TinyH264Decoder;

      const webCodecsUsable =
        WebCodecsVideoDecoder.isSupported &&
        (codec === 1748121140 /* H264 */ ||
          codec === 1748121141 /* H265 */ ||
          codec === 6387249 /* AV1 */);

      if (webCodecsUsable) {
        const renderer = WebGLVideoFrameRenderer.isSupported
          ? new WebGLVideoFrameRenderer(canvas, false)
          : new BitmapVideoFrameRenderer(canvas);
        decoder = new WebCodecsVideoDecoder({ codec, renderer });
      } else {
        decoder = new TinyH264Decoder({ canvas });
      }
      this._decoder = decoder;

      videoStream.sizeChanged((size) => {
        this._currentSize = { width: size.width, height: size.height };
        this._events.onSizeChanged?.(size.width, size.height);
      });

      // Primer frame → señal "handshake de video"
      let firstFrameFired = false;
      const checkFirst = () => {
        if (!firstFrameFired) {
          if (
            (decoder instanceof WebCodecsVideoDecoder && decoder.framesRendered > 0) ||
            this._frameCount > 0
          ) {
            firstFrameFired = true;
            this._events.onFirstFrame?.();
          }
        }
      };
      const interval = setInterval(() => {
        checkFirst();
        if (firstFrameFired || this._closed) clearInterval(interval);
      }, 120);

      void videoStream.stream.pipeTo(decoder.writable).catch(() => undefined);

      return {
        client,
        width: videoStream.width ?? width,
        height: videoStream.height ?? height,
      };
    }

    throw new Error("scrcpy no devolvió flujo de video");
  }

  /**
   * v6: REDIMENSIONA el display virtual EN VIVO (fork mensaje 18).
   * Las apps abiertas SOBREVIVEN (solo config-change, como una rotación).
   * Devuelve true si se envió el mensaje.
   */
  async resizeDisplay(width: number, height: number): Promise<boolean> {
    const controller = this._client?.controller;
    if (!controller || !this._resizable || this._closed) return false;
    let w = Math.max(320, Math.min(3840, Math.round(width)));
    let h = Math.max(320, Math.min(3840, Math.round(height)));
    // múltiplos de 8 (igual que el fork: Size.round8())
    w = Math.round(w / 8) * 8;
    h = Math.round(h / 8) * 8;
    const cur = this._currentSize;
    // cambio irrelevante → no molestar al encoder
    if (Math.abs(cur.width - w) < 24 && Math.abs(cur.height - h) < 24) return false;
    try {
      const msg = buildResizeDisplayMessage(w, h);
      await controller.write(msg);
      this._currentSize = { width: w, height: h };
      return true;
    } catch {
      return false;
    }
  }

  /** v6: tamaño aplicado en la última sesión (fitToWindow). */
  static get lastApplied(): { width: number; height: number } {
    return { ...lastAppliedSize };
  }

  /**
   * reintenta en modo espejo (displayId 0) cuando el display virtual
   * falla en el dispositivo. Devuelve true si relanzó.
   */
  async retryWithMirror(adb: Adb, canvas: HTMLCanvasElement, settings: DisplaySettings): Promise<boolean> {
    if (this._mirrorFallbackUsed) return false;
    this._mirrorFallbackUsed = true;
    await this.stop();
    await this.start(adb, canvas, { ...settings, virtualDisplay: false });
    return true;
  }

  /** Barra JAR del original: pasos del despliegue del motor. */
  async stop(): Promise<void> {
    this._closed = true;
    this._resizable = false;
    const client = this._client;
    this._client = null;
    if (client) {
      try {
        await client.close();
      } catch {
        /* noop */
      }
    }
    try {
      if (
        this._decoder &&
        "dispose" in this._decoder &&
        typeof (this._decoder as WebCodecsVideoDecoder).dispose === "function"
      ) {
        (this._decoder as WebCodecsVideoDecoder).dispose();
      }
    } catch {
      /* noop */
    }
    this._decoder = null;
    await this._audioPlayer.stop();
  }
}
