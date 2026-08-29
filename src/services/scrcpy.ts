/**
 * DexPort v2 — DisplayEngine
 * ════════════════════════════════════════════════════════════
 * Port web de `ScrcpyVideoManager` + `ScrcpyAudioManager` + `WindowManager`
 * de Android DEX.
 *
 * Original (escritorio):
 *   scrcpy.exe --new-display=1920x1080 ...  → ventana Win32 embebida (SetParent)
 *   flujo H.264 → decodificador nativo del sistema
 *
 * Port (navegador):
 *   AdbScrcpyClient.start(adb, server, { newDisplay, tunnelForward }) vía
 *   socket ADB de WebADB → WebCodecsVideoDecoder → <canvas>
 *   audio opus → WebCodecs AudioDecoder → AudioWorklet
 *   control (mouse/teclado) → ScrcpyControlMessageWriter (mismo protocolo binario)
 *
 * v2 (fixes de ingeniería inversa):
 *   - El audioStream SIEMPRE se consume (en v1 no se consumía y la doc de
 *     ya-webadb advierte que eso bloquea la conexión ADB entera).
 *   - El display ID del display virtual se parsea del log del servidor
 *     ("New display: 1920x1080/160 (id=2)") — mismo dato que el servidor
 *     fork del original notificaba con onNewVirtualDisplay().
 *   - Fallback automático a espejo (displayId 0) si el dispositivo no
 *     soporta displays virtuales.
 *   - onControllerReady para habilitar la UI de input con feedback visible.
 */

import type { Adb } from "@yume-chan/adb";
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
};

export interface DisplayEngineEvents {
  onFirstFrame?: () => void;
  onSizeChanged?: (width: number, height: number) => void;
  onExited?: (output: string[]) => void;
  onClipboard?: (text: string) => void;
  onLog?: (line: string) => void;
  onAudioWarn?: (msg: string) => void;
  /** v2: display virtual creado en el dispositivo (id>0) */
  onDisplayId?: (displayId: number) => void;
  /** v2: canal de control listo (mouse/teclado operativos) */
  onControllerReady?: () => void;
  /** v2: el servidor se cayó pero podemos relanzar (no fatal durante boot) */
  onRecoverableExit?: (output: string[]) => void;
}

export interface DisplayHandle {
  client: AdbScrcpyClient<AdbScrcpyOptionsLatest<boolean>>;
  width: number;
  height: number;
}

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
  /** v2: ya se intentó el fallback a espejo (evita bucles) */
  private _mirrorFallbackUsed = false;
  private _controllerReadyFired = false;

  get audioPlayer(): OpusAudioPlayer {
    return this._audioPlayer;
  }

  get controller(): ScrcpyControlMessageWriter | null | undefined {
    return this._client?.controller;
  }

  /** v2: display virtual actual (null si espejo o desconocido). */
  get displayId(): number | null {
    return this._displayId;
  }

  get isRunning(): boolean {
    return !!this._client && !this._closed;
  }

  setEvents(events: DisplayEngineEvents): void {
    this._events = events;
  }

  /**
   * Empuja el binario scrcpy-server al dispositivo.
   * Equivale a `JarManager.startJar()`: locate → push (barra de progreso del JAR).
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
   * Levanta la pantalla virtual DeX y la decodifica en el canvas.
   * Equivale a `scrcpy --new-display=WxH --vd-system-decorations`
   * reenviado por el socket shell de WebADB.
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

    const options = new AdbScrcpyOptionsLatest(
      {
        // ── Display virtual DeX (comando --new-display del original) ──
        ...(settings.virtualDisplay
          ? { newDisplay: new NewDisplay(settings.width, settings.height, settings.dpi) }
          : { displayId: 0 }),
        vdSystemDecorations: settings.virtualDisplay,

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
        stayAwake: true,
        powerOn: true,
        cleanup: true,

        // ── Red: en web SIEMPRE forward (el navegador no acepta conexiones entrantes) ──
        tunnelForward: true,

        sendDeviceMeta: true,
        sendDummyByte: true,
        sendCodecMeta: true,
        logLevel: "info" as const,
      },
      { version: "3.3.3" },
    );

    const client = await AdbScrcpyClient.start(adb, SCRCPY_SERVER_PATH, options);
    this._client = client;

    // ── v2: canal de control listo → UI habilitada ──
    if (client.controller) {
      // dejar que el store registre sus eventos primero
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

    // ── Log del servidor scrcpy + v2: parse del display ID virtual ──
    // El servidor scrcpy 3.x imprime:
    //   [server] INFO: New display: 1920x1080/160 (id=2)
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
          },
        }),
      )
      .catch(() => undefined);

    // ── Clipboard autosync (port del clipboardAutosync del original) ──
    if (client.clipboard) {
      void client.clipboard
        .pipeTo(
          new WritableStream<string>({
            write: (text) => this._events.onClipboard?.(text),
          }),
        )
        .catch(() => undefined);
    }

    // ── v2: AUDIO — consumir SIEMPRE el stream (aunque no se pueda reproducir)
    // Sin esto, la ventana de recepción del socket audio se llena y puede
    // bloquear la conexión ADB completa (bug del 93% en v1). ──
    const audioStreamPromise = client.audioStream;
    if (audioStreamPromise) {
      void audioStreamPromise
        .then(async (meta) => {
          if (!meta || meta.type !== "success") {
            // disabled / errored — no hay stream que drenar
            return;
          }
          await this._audioPlayer.start(meta.stream, (msg) =>
            this._events.onAudioWarn?.(msg),
          );
        })
        .catch(() => undefined);
    }

    // ── Video: WebCodecs con fallback TinyH264 (H264 puro) ──
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
        this._events.onSizeChanged?.(size.width, size.height);
      });

      // Primer frame → señal "handshake de video" (equivale jar.hello → 1.0)
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
        width: videoStream.width ?? settings.width,
        height: videoStream.height ?? settings.height,
      };
    }

    throw new Error("scrcpy no devolvió flujo de video");
  }

  /**
   * v2: reintenta en modo espejo (displayId 0) cuando el display virtual
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
