/**
 * DexPort — OpusAudioPlayer
 * ════════════════════════════════════════════════════════════
 * Port web del streaming de audio de Android DEX.
 *
 * El original usaba `scrcpy --no-audio...` con servidores WebSocket propios
 * para el audio por app (Feature Hub APK, cerrado). En el navegador usamos
 * el canal de audio nativo de scrcpy 3.x sobre el socket ADB:
 *
 *   scrcpy (audioCodec: "opus") → WebCodecs AudioDecoder → AudioWorklet
 *
 * scrcpy siempre produce opus estéreo 48 kHz, así que la configuración del
 * decoder es determinista.
 */

import type { ScrcpyMediaStreamPacket } from "@yume-chan/scrcpy";
import { ReadableStream, WritableStream } from "@yume-chan/stream-extra";

const WORKLET_SRC = `
class DexPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];       // { l: Float32Array, r: Float32Array }
    this.playing = false;
    this.underruns = 0;
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'chunk') {
        this.queue.push({ l: msg.l, r: msg.r });
        if (!this.playing && this.queuedDuration() > 0.12) {
          this.playing = true;
        }
      } else if (msg.type === 'flush') {
        this.queue = [];
        this.playing = false;
      }
    };
  }
  queuedDuration() {
    // cada frame de opus ≈ 960 samples @48kHz
    let samples = 0;
    for (const c of this.queue) samples += c.l.length;
    return samples / sampleRate;
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out.length > 1 ? out[1] : out[0];
    if (!this.playing) {
      left.fill(0);
      if (right !== left) right.fill(0);
      return true;
    }
    let written = 0;
    while (written < left.length) {
      const chunk = this.queue[0];
      if (!chunk) {
        // underrun — silencio y espera de rebuferización
        this.playing = false;
        this.underruns++;
        left.fill(written);
        if (right !== left) right.fill(written);
        return true;
      }
      const n = Math.min(chunk.l.length, left.length - written);
      left.set(chunk.l.subarray(0, n), written);
      if (right !== left) right.set(chunk.r.subarray(0, n), written);
      written += n;
      if (n >= chunk.l.length) {
        this.queue.shift();
      } else {
        this.queue[0] = {
          l: chunk.l.subarray(n),
          r: chunk.r.subarray(n),
        };
      }
    }
    // Protección: si nos retrasamos demasiado, soltamos frames
    if (this.queuedDuration() > 0.5) {
      while (this.queuedDuration() > 0.25 && this.queue.length > 1) {
        this.queue.shift();
      }
    }
    return true;
  }
}
registerProcessor('dex-player', DexPlayerProcessor);
`;

export class OpusAudioPlayer {
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private decoder: AudioDecoder | null = null;
  private gainNode: GainNode | null = null;
  private _running = false;
  private _muted = false;
  private _volume = 1;

  get running(): boolean {
    return this._running;
  }

  static get isSupported(): boolean {
    return typeof AudioDecoder !== "undefined" && typeof AudioWorkletNode !== "undefined";
  }

  async start(
    stream: ReadableStream<ScrcpyMediaStreamPacket>,
    onWarn?: (msg: string) => void,
  ): Promise<void> {
    if (!OpusAudioPlayer.isSupported) {
      onWarn?.("AudioDecoder no soportado — audio desactivado");
      // Consumir el stream para no bloquear la conexión
      await stream.pipeTo(new WritableStream());
      return;
    }

    await this.stop();

    this.audioContext = new AudioContext({
      sampleRate: 48000,
      latencyHint: "interactive",
    });
    await this.audioContext.resume();

    const blobURL = URL.createObjectURL(
      new Blob([WORKLET_SRC], { type: "application/javascript" }),
    );
    try {
      await this.audioContext.audioWorklet.addModule(blobURL);
    } finally {
      URL.revokeObjectURL(blobURL);
    }

    this.workletNode = new AudioWorkletNode(this.audioContext, "dex-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = this._muted ? 0 : this._volume;
    this.workletNode.connect(this.gainNode);
    this.gainNode.connect(this.audioContext.destination);

    this.decoder = new AudioDecoder({
      output: (frame: AudioData) => {
        if (!this.workletNode || frame.numberOfChannels < 1) {
          frame.close();
          return;
        }
        const frames = Math.min(frame.numberOfFrames, 48000);
        const l = new Float32Array(frames);
        const r = new Float32Array(frames);
        // copyTo puede requerir planar float32 — lo manejamos canal por canal
        try {
          frame.copyTo(l, { planeIndex: 0, frameOffset: 0, format: "f32" });
          if (frame.numberOfChannels > 1) {
            frame.copyTo(r, { planeIndex: 1, frameOffset: 0, format: "f32" });
          } else {
            l.forEach((v, i) => (r[i] = v));
          }
        } catch {
          // formatos alternativos — fallback a conversión manual
          try {
            const tmp = new Float32Array(frames * frame.numberOfChannels);
            frame.copyTo(tmp, { planeIndex: 0, frameOffset: 0, format: "f32-planar" });
            for (let i = 0; i < frames; i++) {
              l[i] = tmp[i];
              r[i] = frame.numberOfChannels > 1 ? tmp[frames + i] : tmp[i];
            }
          } catch {
            frame.close();
            return;
          }
        }
        frame.close();
        this.workletNode.port.postMessage({ type: "chunk", l, r }, [l.buffer, r.buffer]);
      },
      error: (e: DOMException) => {
        onWarn?.(`Error de decodificación de audio: ${e.message}`);
      },
    });

    this.decoder.configure({
      codec: "opus",
      sampleRate: 48000,
      numberOfChannels: 2,
    });

    this._running = true;

    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (value.type === "configuration") {
          // Para opus la configuración (magic + OpusHead) no es necesaria:
          // el decoder de WebCodecs se configura determinísticamente.
          continue;
        }
        if (this.decoder.state === "closed") break;
        const ts = value.pts !== undefined ? Number(value.pts) : 0;
        this.decoder.decode(
          new EncodedAudioChunk({
            type: "key",
            timestamp: ts,
            data: value.data,
          }),
        );
      }
    } finally {
      reader.releaseLock();
      this._running = false;
    }
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    if (this.gainNode) this.gainNode.gain.value = muted ? 0 : this._volume;
  }

  setVolume(v: number): void {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.gainNode && !this._muted) this.gainNode.gain.value = this._volume;
  }

  async stop(): Promise<void> {
    try {
      if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    } catch {
      /* noop */
    }
    this.decoder = null;
    try {
      this.workletNode?.disconnect();
      this.gainNode?.disconnect();
    } catch {
      /* noop */
    }
    this.workletNode = null;
    this.gainNode = null;
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {
        /* noop */
      }
    }
    this.audioContext = null;
    this._running = false;
  }
}
