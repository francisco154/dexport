/**
 * DexPort — Store central
 * ════════════════════════════════════════════════════════════
 * Port del AppManager (orquestador del boot) + AndroidCore (estado
 * reactivo del dispositivo) del original, adaptados a zustand/React.
 */

import { create } from "zustand";
import { webAdb, type DeviceInfo } from "../services/adb";
import {
  DisplayEngine,
  DEFAULT_DISPLAY_SETTINGS,
  type DisplaySettings,
} from "../services/scrcpy";
import {
  type BatteryState,
  type MediaSession,
  parseBattery,
  parseMediaSessions,
} from "../utils/telemetry";
import { parsePackageList, type AppEntry } from "../utils/appNames";

export type Phase = "landing" | "boot" | "desktop";

export interface BootEvent {
  message: string;
  progress: number; // 0..1
  isError?: boolean;
}

export interface PanelState {
  drawerOpen: boolean;
  mediaOpen: boolean;
  deviceOpen: boolean;
  settingsOpen: boolean;
  shortcutsOpen: boolean;
}

interface DexPortState {
  // ── Fase global ──
  phase: Phase;

  // ── Boot (barras duales del original: APP + ENGINE/JAR) ──
  appBoot: BootEvent;
  engineBoot: BootEvent;
  bootError: string | null;
  bootFatal: boolean;

  // ── Conexión / dispositivo ──
  deviceInfo: DeviceInfo | null;
  reconnecting: boolean;
  reconnectMessage: string;

  // ── Display ──
  displaySize: { width: number; height: number };
  fps: number;
  audioMuted: boolean;
  volume: number;

  // ── Telemetría (AndroidCore port) ──
  battery: BatteryState | null;
  mediaSessions: MediaSession[];
  clipboard: string;

  // ── Apps ──
  userApps: AppEntry[];
  systemApps: AppEntry[];
  appsLoading: boolean;

  // ── Panels ──
  panels: PanelState;
  toasts: { id: number; message: string; kind: "info" | "error" | "success" }[];

  // ── Settings ──
  settings: DisplaySettings;

  // ── Acciones ──
  setPhase: (p: Phase) => void;
  setAppBoot: (e: Partial<BootEvent>) => void;
  setEngineBoot: (e: Partial<BootEvent>) => void;
  setBootError: (err: string | null, fatal?: boolean) => void;
  setSettings: (s: Partial<DisplaySettings>) => void;
  togglePanel: (k: keyof PanelState, value?: boolean) => void;
  toast: (message: string, kind?: "info" | "error" | "success") => void;
  dismissToast: (id: number) => void;

  // ── Flujos principales ──
  startBoot: () => Promise<void>;
  retryBoot: () => Promise<void>;
  launchApp: (pkg: string) => Promise<void>;
  refreshApps: () => Promise<void>;
  refreshTelemetry: () => Promise<void>;
  setAudioMuted: (m: boolean) => void;
  setVolume: (v: number) => void;
  goHome: () => void;
  reconnectDesktop: () => Promise<void>;
  shutdown: () => Promise<void>;
}

const SETTINGS_KEY = "dexport.settings.v1";

function loadSettings(): DisplaySettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      return { ...DEFAULT_DISPLAY_SETTINGS, ...JSON.parse(raw) };
    }
  } catch {
    /* noop */
  }
  return { ...DEFAULT_DISPLAY_SETTINGS };
}

function saveSettings(s: DisplaySettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* noop */
  }
}

// Instancia única del motor de display (ScrcpyVideoManager port)
export const displayEngine = new DisplayEngine();

let telemetryTimer: ReturnType<typeof setInterval> | null = null;
let toastSeq = 1;

export const useStore = create<DexPortState>((set, get) => ({
  phase: "landing",

  appBoot: { message: "", progress: 0 },
  engineBoot: { message: "", progress: 0 },
  bootError: null,
  bootFatal: false,

  deviceInfo: null,
  reconnecting: false,
  reconnectMessage: "",

  displaySize: { width: 1920, height: 1080 },
  fps: 0,
  audioMuted: false,
  volume: 1,

  battery: null,
  mediaSessions: [],
  clipboard: "",

  userApps: [],
  systemApps: [],
  appsLoading: false,

  panels: {
    drawerOpen: false,
    mediaOpen: false,
    deviceOpen: false,
    settingsOpen: false,
    shortcutsOpen: false,
  },
  toasts: [],

  settings: loadSettings(),

  setPhase: (p) => set({ phase: p }),
  setAppBoot: (e) =>
    set((s) => ({ appBoot: { ...s.appBoot, ...e }, bootError: e.isError ? s.bootError : null })),
  setEngineBoot: (e) => set((s) => ({ engineBoot: { ...s.engineBoot, ...e } })),
  setBootError: (err, fatal = false) => set({ bootError: err, bootFatal: fatal }),

  setSettings: (partial) => {
    const next = { ...get().settings, ...partial };
    saveSettings(next);
    set({ settings: next });
  },

  togglePanel: (k, value) =>
    set((s) => ({
      panels: { ...s.panels, [k]: value ?? !s.panels[k] },
    })),

  toast: (message, kind = "info") => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, kind }] }));
    setTimeout(() => get().dismissToast(id), 4200);
  },
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  // ═════════════════════════════════════════════════════════
  // BOOT FLOW — port del AppManager.initializeSystem()
  // (secuencia fiel: APP bar 0.02 → 1.00 + ENGINE bar paralela)
  // ═════════════════════════════════════════════════════════
  startBoot: async () => {
    const store = get();
    store.setPhase("boot");
    store.setBootError(null, false);
    store.setAppBoot({ message: "Inicializando DexPort…", progress: 0.02 });
    store.setEngineBoot({ message: "En espera…", progress: 0 });

    try {
      // ── 0.02: soporte WebUSB ──
      if (!webAdb.isSupported) {
        throw new Error(
          "Este navegador no soporta WebUSB. Usa Chrome, Edge u otro navegador basado en Chromium (no Safari/Firefox), sobre HTTPS.",
        );
      }
      await sleep(150);

      // ── 0.10: selección de dispositivo (Device Manager del original) ──
      store.setAppBoot({
        message: "Selecciona tu dispositivo Android en el diálogo del navegador…",
        progress: 0.1,
      });
      let device = await webAdb.requestDevice();
      if (!device) {
        // Reintento con dispositivos ya autorizados
        const authorized = await webAdb.getAuthorizedDevices();
        device = authorized[0] ?? null;
      }
      if (!device) {
        throw new Error(
          "Ningún dispositivo seleccionado. Conecta el teléfono por USB con la depuración USB activada y vuelve a intentarlo.",
        );
      }

      // ── 0.20: autenticación (equivale adb connect + adb reverse) ──
      store.setAppBoot({
        message: "Autenticando… acepta el diálogo «Depuración USB» en el teléfono (marca «Siempre»).",
        progress: 0.2,
      });
      const adb = await webAdb.connect(device);

      // ── 0.28: info del dispositivo ──
      store.setAppBoot({
        message: "Leyendo información del dispositivo…",
        progress: 0.28,
      });
      const info = await webAdb.getDeviceInfo();
      set({ deviceInfo: info });
      await sleep(120);

      // ── 0.38: settings DeX (comandos del entorno original) ──
      store.setAppBoot({
        message: "Configurando entorno DeX (freeform + desktop mode)…",
        progress: 0.38,
      });
      try {
        await webAdb.applyDexSettings();
      } catch {
        store.toast(
          "No se pudieron aplicar los settings DeX — el display virtual funcionará igual",
          "info",
        );
      }

      // ── Barra ENGINE (JAR del original): despliegue del motor scrcpy ──
      store.setEngineBoot({ message: "Localizando motor de pantalla (scrcpy-server)…", progress: 0.15 });

      store.setAppBoot({
        message: "Desplegando motor de pantalla virtual…",
        progress: 0.55,
      });
      await DisplayEngine.pushServer(adb);
      store.setEngineBoot({ message: "Motor subido al dispositivo", progress: 0.7 });

      // ── 0.72: lanzar display virtual ──
      store.setEngineBoot({ message: "Lanzando runtime en el dispositivo…", progress: 0.82 });
      store.setAppBoot({
        message: "Iniciando pantalla virtual…",
        progress: 0.72,
      });

      const canvas = document.getElementById(
        "dex-display-canvas",
      ) as HTMLCanvasElement | null;
      if (!canvas) {
        throw new Error("Canvas de display no encontrado");
      }

      displayEngine.setEvents({
        onFirstFrame: () => {
          const s = get();
          if (s.engineBoot.progress < 1) {
            s.setEngineBoot({ message: "Motor conectado — video en vivo ✓", progress: 1 });
          }
        },
        onSizeChanged: (width, height) => set({ displaySize: { width, height } }),
        onExited: async () => {
          const s = get();
          if (s.phase === "desktop") {
            await s.reconnectDesktop();
          }
        },
        onClipboard: (text) => {
          if (text) {
            set({ clipboard: text });
            get().toast("Portapapeles del dispositivo actualizado", "info");
          }
        },
        onLog: () => undefined,
      });

      await displayEngine.start(adb, canvas, get().settings);
      set({ displaySize: get().settings.virtualDisplay
        ? { width: get().settings.width, height: get().settings.height }
        : get().displaySize });

      // ── 0.84: esperar primer frame (equivale handshake jar.hello) ──
      store.setAppBoot({
        message: "Esperando flujo de video…",
        progress: 0.84,
      });
      await waitFor(
        () => get().engineBoot.progress >= 1,
        15_000,
        "El motor de video no respondió a tiempo. El dispositivo puede estar ocupado o no soportar displays virtuales.",
      );

      // ── 0.93: telemetría + apps ──
      store.setAppBoot({
        message: "Sincronizando telemetría y aplicaciones…",
        progress: 0.93,
      });
      await Promise.all([get().refreshTelemetry(), get().refreshApps()]);

      startTelemetryLoop();

      // ── 1.00: sistema listo ──
      store.setAppBoot({ message: "Sistema listo ✓", progress: 1 });
      await sleep(350);
      set({ phase: "desktop" });
      get().toast("Escritorio DexPort conectado", "success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      get().setAppBoot({ message: "Error durante el arranque", isError: true });
      get().setBootError(msg, true);
    }
  },

  retryBoot: async () => {
    await get().shutdown();
    await get().startBoot();
  },

  // ═════════════════════════════════════════════════════════
  // ACCIONES DEL ESCRITORIO
  // ═════════════════════════════════════════════════════════

  launchApp: async (pkg) => {
    const controller = displayEngine.controller;
    try {
      if (controller) {
        // scrcpy 3.x: startApp arranca la app EN el display virtual
        await controller.startApp(pkg, { forceStop: false, searchByName: false });
        get().toast(`Lanzando ${pkg}…`, "info");
      } else {
        await webAdb.shellSafe(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
      }
      get().togglePanel("drawerOpen", false);
    } catch {
      // Fallback: launch por monkey en el display activo
      await webAdb.shellSafe(
        `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`,
      );
      get().togglePanel("drawerOpen", false);
    }
  },

  refreshApps: async () => {
    set({ appsLoading: true });
    try {
      const [userOut, sysOut] = await Promise.all([
        webAdb.shellSafe("pm list packages -3"),
        webAdb.shellSafe("pm list packages -s"),
      ]);
      const { userApps, systemApps } = parsePackageList(userOut, sysOut);
      set({ userApps, systemApps, appsLoading: false });
    } catch {
      set({ appsLoading: false });
    }
  },

  refreshTelemetry: async () => {
    try {
      const [batteryOut, mediaOut] = await Promise.all([
        webAdb.shellSafe("dumpsys battery"),
        webAdb.shellSafe("dumpsys media_session"),
      ]);
      set({
        battery: parseBattery(batteryOut),
        mediaSessions: parseMediaSessions(mediaOut).slice(0, 3),
      });
    } catch {
      /* noop */
    }
  },

  setAudioMuted: (m) => {
    displayEngine.audioPlayer.setMuted(m);
    set({ audioMuted: m });
  },

  setVolume: (v) => {
    displayEngine.audioPlayer.setVolume(v);
    set({ volume: v });
  },

  goHome: () => {
    const controller = displayEngine.controller;
    controller
      ?.injectKeyCode({ action: 0, keyCode: 3, repeat: 0, metaState: 0 })
      .then(() => controller.injectKeyCode({ action: 1, keyCode: 3, repeat: 0, metaState: 0 }))
      .catch(() => undefined);
  },

  // ═════════════════════════════════════════════════════════
  // RECONEXIÓN — port del ReconnectionManager (2 fases)
  // ═════════════════════════════════════════════════════════
  reconnectDesktop: async () => {
    if (get().reconnecting) return;
    set({ reconnecting: true, reconnectMessage: "Intentando reconectar con el dispositivo…" });

    // Fase 1: reconexión rápida (sin redesplegar)
    try {
      await displayEngine.stop();
      const authorized = await webAdb.getAuthorizedDevices();
      const device = authorized.find((d) => d.serial === get().deviceInfo?.serial) ?? authorized[0];
      if (!device || !webAdb.adb) throw new Error("sin dispositivo");

      // Si la conexión ADB sigue viva, reutilizamos
      let adb = webAdb.adb;
      if (!adb) {
        set({ reconnectMessage: "Re-autenticando dispositivo…" });
        adb = await webAdb.connect(device);
      }

      set({ reconnectMessage: "Relanzando pantalla virtual…" });
      const canvas = document.getElementById("dex-display-canvas") as HTMLCanvasElement | null;
      if (!canvas) throw new Error("canvas perdido");

      await DisplayEngine.pushServer(adb);
      await displayEngine.start(adb, canvas, get().settings);
      await get().refreshTelemetry();
      set({ reconnecting: false, reconnectMessage: "" });
      get().toast("Reconectado ✓", "success");
      return;
    } catch {
      // Fase 2: reinicio completo (reintento único)
      set({ reconnectMessage: "Reconexión rápida fallida — reinicio completo…" });
      try {
        await displayEngine.stop();
        await webAdb.disconnect();
        const authorized = await webAdb.getAuthorizedDevices();
        const device = authorized[0];
        if (!device) throw new Error("Sin dispositivos");
        const adb = await webAdb.connect(device);
        set({ deviceInfo: await webAdb.getDeviceInfo() });
        await webAdb.applyDexSettings();
        const canvas = document.getElementById("dex-display-canvas") as HTMLCanvasElement;
        await DisplayEngine.pushServer(adb);
        await displayEngine.start(adb, canvas, get().settings);
        await get().refreshTelemetry();
        set({ reconnecting: false, reconnectMessage: "" });
        get().toast("Reconectado tras reinicio completo ✓", "success");
      } catch (e2) {
        set({
          reconnecting: false,
          reconnectMessage:
            e2 instanceof Error ? e2.message : "Fallo la reconexión. Reconecta el USB y reintenta.",
        });
      }
    }
  },

  shutdown: async () => {
    stopTelemetryLoop();
    await displayEngine.stop();
    await webAdb.disconnect();
    set({
      phase: "landing",
      appBoot: { message: "", progress: 0 },
      engineBoot: { message: "", progress: 0 },
      bootError: null,
      bootFatal: false,
      reconnecting: false,
      reconnectMessage: "",
      battery: null,
      mediaSessions: [],
      userApps: [],
      systemApps: [],
      panels: {
        drawerOpen: false,
        mediaOpen: false,
        deviceOpen: false,
        settingsOpen: false,
        shortcutsOpen: false,
      },
    });
  },
}));

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  timeoutMsg: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(interval);
        // No bloqueamos el boot si el video tarda pero ya arrancó
        resolve();
        void timeoutMsg;
      }
    }, 200);
  });
}

function startTelemetryLoop(): void {
  stopTelemetryLoop();
  telemetryTimer = setInterval(() => {
    const s = useStore.getState();
    if (s.phase === "desktop" && !s.reconnecting) {
      void s.refreshTelemetry();
    }
  }, 5000);
}

function stopTelemetryLoop(): void {
  if (telemetryTimer) {
    clearInterval(telemetryTimer);
    telemetryTimer = null;
  }
}

// Vigilancia global de desconexión (ReconnectionManager port)
webAdb.onDisconnected(() => {
  const s = useStore.getState();
  if (s.phase === "desktop" && !s.reconnecting) {
    void s.reconnectDesktop();
  }
});
