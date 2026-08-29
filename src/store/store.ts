/**
 * DexPort v2 — Store central
 * ════════════════════════════════════════════════════════════
 * Port del AppManager (orquestador del boot) + AndroidCore (estado
 * reactivo del dispositivo) del original, adaptados a zustand/React.
 *
 * v2 — correcciones de la ingeniería inversa del build original:
 *   - Boot NO bloqueante: la sincronización de telemetría/apps va en
 *     background (v1 se colgaba en el 93% si un dumpsys se bloqueaba).
 *   - initDesktop(): al primer frame se lanza el LAUNCHER del teléfono
 *     en el display virtual (`am start --display N ... HOME`) — así el
 *     display deja de ser negro: wallpaper, app grid y ventanas freeform,
 *     exactamente como el modo Normal del original.
 *   - launchApp usa el mensaje de control START_APP de scrcpy 3.3
 *     (idéntico al AppController.startAppOnDisplay del JAR original),
 *     con fallback a `am start --display N` por shell.
 *   - AppMonitor: port del monitor de tareas del servidor original
 *     (`dumpsys activity activities`, regex Display #N + Task visible).
 *   - controlOnline: feedback visible del canal de control (v1 fallaba
 *     en silencio y "los botones no hacían nada").
 */

import { create } from "zustand";
import { webAdb, type DeviceInfo } from "../services/adb";
import {
  companion,
  type InstallProgress,
} from "../services/companion";
import { companionBridge } from "../services/companionBridge";
import {
  DisplayEngine,
  DEFAULT_DISPLAY_SETTINGS,
  type DisplaySettings,
} from "../services/scrcpy";
import {
  type BatteryState,
  type MediaSession,
  type RunningApp,
  pollTelemetryBatch,
  parseRunningApps,
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

/**
 * v3 — flujo del LAUNCHER ORIGINAL (companion APK com.shrey.androiddex).
 * Estado de la instalación/uso del launcher extraído del release oficial.
 */
export type CompanionFlow = "idle" | "checking" | "prompt" | "installing" | "ready" | "skipped";

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
  /** v2: display virtual real creado por scrcpy en el dispositivo */
  displayId: number | null;
  /** v2: canal de control scrcpy operativo (mouse/teclado) */
  controlOnline: boolean;
  /** v2: modo espejo (fallback cuando el dispositivo no soporta VD) */
  mirrorMode: boolean;
  /** v2: launcher detectado (para relanzar HOME en el display) */
  launcherPkg: string | null;

  // ── v3: launcher original (companion APK) ──
  companionFlow: CompanionFlow;
  companionInstalled: boolean;
  companionVersion: string | null;
  companionInstall: InstallProgress;

  // ── Telemetría (AndroidCore port) ──
  battery: BatteryState | null;
  mediaSessions: MediaSession[];
  clipboard: string;

  // ── Apps ──
  userApps: AppEntry[];
  systemApps: AppEntry[];
  appsLoading: boolean;
  /** v2: apps visibles en el display virtual (AppMonitor port) */
  runningApps: RunningApp[];

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
  launchHome: () => Promise<void>;
  /** v2: flujo post-display: launcher + HOME en el display virtual */
  initDesktopAfterDisplay: (displayId: number) => Promise<void>;
  /** v3: instalar/lanzar el launcher original */
  checkCompanion: () => Promise<boolean>;
  installCompanion: (autoLaunch?: boolean) => Promise<void>;
  skipCompanion: () => void;
  launchCompanionHome: () => Promise<boolean>;
  refreshApps: () => Promise<void>;
  refreshTelemetry: () => Promise<void>;
  refreshRunningApps: () => Promise<void>;
  setAudioMuted: (m: boolean) => void;
  setVolume: (v: number) => void;
  goHome: () => void;
  sendKeyAction: (keycode: number) => void;
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
let appMonitorTimer: ReturnType<typeof setInterval> | null = null;
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
  displayId: null,
  controlOnline: false,
  mirrorMode: false,
  launcherPkg: null,

  companionFlow: "idle",
  companionInstalled: false,
  companionVersion: null,
  companionInstall: { phase: "idle", progress: 0, message: "" },

  battery: null,
  mediaSessions: [],
  clipboard: "",

  userApps: [],
  systemApps: [],
  appsLoading: false,
  runningApps: [],

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
  // v2: telemetría y apps en background — el boot NUNCA se bloquea
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
        onDisplayId: (displayId) => {
          set({ displayId, mirrorMode: false });
          get().toast(`Display virtual #${displayId} activo`, "success");
          // v2: convertir el display vacío en escritorio real
          void get().initDesktopAfterDisplay(displayId);
        },
        onControllerReady: () => set({ controlOnline: true }),
        onExited: async () => {
          const s = get();
          if (s.phase === "desktop") {
            await s.reconnectDesktop();
          } else if (s.phase === "boot" && !s.bootError) {
            // v2: primer intento — fallback a modo espejo
            const engineOk = await displayEngine.retryWithMirror(
              webAdb.adb!,
              document.getElementById("dex-display-canvas") as HTMLCanvasElement,
              get().settings,
            );
            if (engineOk) {
              set({ mirrorMode: true });
              get().toast(
                "Tu dispositivo no soporta displays virtuales — modo espejo activado",
                "info",
              );
              const st = get();
              if (st.engineBoot.progress < 1) {
                st.setEngineBoot({ message: "Espejo de pantalla activo ✓", progress: 1 });
              }
            } else {
              s.setBootError(
                "El motor de display se detuvo inesperadamente. Revisa que el dispositivo soporte displays virtuales (Android 10+) y reintenta.",
                true,
              );
            }
          }
        },
        onClipboard: (text) => {
          if (text) {
            set({ clipboard: text });
            get().toast("Portapapeles del dispositivo actualizado", "info");
          }
        },
        onLog: () => undefined,
        onAudioWarn: (msg) => get().toast(msg, "info"),
      });

      // v2: si el dispositivo no soporta displays virtuales, el servidor scrcpy
      // muere al instante (AdbScrcpyExitedError) → fallback automático a espejo
      try {
        await displayEngine.start(adb, canvas, get().settings);
      } catch (startErr) {
        if (get().settings.virtualDisplay) {
          const msg = startErr instanceof Error ? startErr.message : String(startErr);
          store.setEngineBoot({
            message: "Display virtual no soportado — cambiando a espejo…",
            progress: 0.9,
          });
          const ok = await displayEngine.retryWithMirror(adb, canvas, get().settings);
          if (ok) {
            set({ mirrorMode: true });
            get().toast(
              "Display virtual no soportado en este dispositivo — modo espejo activado",
              "info",
            );
          } else {
            throw new Error(
              `No se pudo iniciar el motor de video: ${msg}. Prueba bajar la resolución en Ajustes o reconecta el USB.`,
            );
          }
        } else {
          throw startErr;
        }
      }
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
        20_000,
      );

      // ── 0.93→1.00: launcher original + apps EN BACKGROUND ──
      store.setAppBoot({
        message: "Preparando escritorio…",
        progress: 0.93,
      });

      // v3: si el LAUNCHER ORIGINAL está por instalarse (companion APK del
      // release oficial), esperamos la decisión del usuario — la tarjeta de
      // instalación con progreso está visible en este mismo boot screen,
      // igual que el instalador del companion del original.
      await waitFor(
        () => {
          const f = get().companionFlow;
          return f === "ready" || f === "skipped" || f === "prompt" || f === "installing";
        },
        18_000,
      );
      const cf = get().companionFlow;
      if (cf === "prompt" || cf === "installing") {
        // decisión/instalación en curso — esperar (máx. 10 min de cortesía)
        await waitFor(
          () => {
            const f = get().companionFlow;
            return f === "ready" || f === "skipped";
          },
          600_000,
        );
      }

      // NO se espera: el boot completa y la sync sigue de fondo
      void get().refreshApps().then(() => {
        const s = get();
        if (s.phase === "boot") {
          s.setAppBoot({ message: "Sistema listo ✓", progress: 1 });
        }
      });
      void get().refreshTelemetry();

      await sleep(250);
      set({ phase: "desktop" });
      get().toast("Escritorio DexPort conectado", "success");

      // arrancar loops de fondo
      startTelemetryLoop();
      startAppMonitorLoop();
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

  /**
   * v2: port del flujo del original al crear el display virtual:
   * 1) detecta el launcher por defecto
   * 2) lanza el HOME en el display virtual → wallpaper + app grid
   * 3) sincroniza el listado de apps para el drawer
   */
  // (método extra colgado fuera de la interfaz zustand — ver abajo)

  launchApp: async (pkg) => {
    const controller = displayEngine.controller;
    const displayName = get().displayId;
    get().toast(`Lanzando ${pkg}…`, "info");
    try {
      if (controller) {
        // scrcpy 3.3: START_APP arranca la app EN el display virtual
        // (mismo código que el JAR original: setLaunchDisplayId)
        await controller.startApp(pkg, { forceStop: false, searchByName: false });
      } else if (displayName != null && displayName > 0) {
        // fallback shell: am start --display N
        await webAdb.launchOnDisplay(pkg, displayName);
      } else {
        await webAdb.shellSafe(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
      }
      get().togglePanel("drawerOpen", false);
    } catch {
      try {
        if (displayName != null && displayName > 0) {
          await webAdb.launchOnDisplay(pkg, displayName);
        } else {
          await webAdb.shellSafe(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
        }
        get().togglePanel("drawerOpen", false);
      } catch {
        get().toast(`No se pudo lanzar ${pkg}`, "error");
      }
    }
  },

  /**
   * v3: instalación del LAUNCHER ORIGINAL (companion APK del release
   * oficial de Android-Dex) — el mismo `installApk()` del escritorio
   * original pero vía WebADB: fetch → sync push → pm install -r.
   */
  checkCompanion: async () => {
    set({ companionFlow: "checking" });
    try {
      const installed = await companion.isInstalled();
      const version = installed ? await companion.getVersion() : null;
      set({ companionInstalled: installed, companionVersion: version });
      return installed;
    } catch {
      set({ companionInstalled: false });
      return false;
    } finally {
      // el estado de flujo lo decide quien llama (prompt/ready/skipped)
    }
  },

  installCompanion: async (autoLaunch = true) => {
    if (get().companionFlow === "installing") return;
    set({
      companionFlow: "installing",
      companionInstall: { phase: "downloading", progress: 0, message: "Iniciando instalación…" },
    });
    try {
      await companion.install((p) => set({ companionInstall: p }));
      set({ companionInstalled: true, companionFlow: "ready" });
      get().toast("Launcher AndroidDex (original) instalado ✓", "success");

      // arrancar el puente del companion (como el escritorio original)
      void companion.startBridge();

      if (autoLaunch) {
        const displayId = get().displayId;
        if (displayId != null && displayId > 0) {
          set({ companionInstall: { phase: "launching", progress: 0.5, message: "Abriendo el launcher en el display virtual…" } });
          const ok = await companion.launchOnDisplay(displayId);
          set({ companionInstall: { phase: "done", progress: 1, message: ok ? "Launcher abierto ✓" : "Instalado — pulsa HOME para abrirlo" } });
          if (ok) get().toast("Launcher AndroidDex abierto en el escritorio ✓", "success");
        } else {
          set({ companionInstall: { phase: "done", progress: 1, message: "Instalado ✓" } });
        }
      }
      void get().refreshApps();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({
        companionFlow: get().companionInstalled ? "ready" : "prompt",
        companionInstall: { phase: "error", progress: 0, message: "", error: msg },
      });
      get().toast(`Instalación fallida: ${msg.slice(0, 120)}`, "error");
    }
  },

  skipCompanion: () => {
    set({ companionFlow: "skipped" });
  },

  /** v3: abre el launcher original en el display virtual actual. */
  launchCompanionHome: async () => {
    const displayId = get().displayId;
    if (displayId == null || displayId <= 0) {
      get().toast("Sin display virtual activo", "error");
      return false;
    }
    const ok = await companion.launchOnDisplay(displayId);
    if (!ok) get().toast("No se pudo abrir el launcher AndroidDex", "error");
    return ok;
  },

  launchHome: async () => {
    const displayId = get().displayId;
    // v3: el launcher ORIGINAL (companion) tiene prioridad — es el mismo
    // comportamiento del escritorio original (HOME = MainActivity del APK)
    if (get().companionInstalled && displayId != null && displayId > 0) {
      const ok = await companion.launchOnDisplay(displayId);
      if (ok) return;
    }
    if (displayId != null && displayId > 0) {
      // fallback: launcher del teléfono en el display virtual
      const ok = await webAdb.launchHomeOnDisplay(displayId);
      if (ok) return;
      // último recurso: HOME del launcher detectado por componente explícito
      const launcher = get().launcherPkg;
      if (launcher) {
        const launched = await webAdb.launchOnDisplay(launcher, displayId);
        if (launched) return;
      }
      get().toast("No se pudo abrir el launcher — usa el botón del panel Dispositivo", "error");
    } else {
      get().sendKeyAction(3); // KEYCODE_HOME
    }
  },

  /**
   * v2: port del flujo del original al crear el display virtual:
   * 1) detecta el launcher por defecto
   * 2) lanza el HOME en el display virtual → wallpaper + app grid
   * 3) sincroniza las apps visibles (AppMonitor)
   */
  initDesktopAfterDisplay: async (displayId: number) => {
    const s = get();
    if (s.phase !== "boot" && s.phase !== "desktop") return;
    try {
      // 1) launcher por defecto del teléfono (fallback)
      const launcher = await webAdb.getDefaultLauncher();
      set({ launcherPkg: launcher });

      // 2) v3: ¿está instalado el LAUNCHER ORIGINAL (companion)?
      const installed = await s.checkCompanion();
      if (installed) {
        // puente del companion arriba (como el original al conectar)
        void companion.startBridge();
        const ok = await companion.launchOnDisplay(displayId);
        set({ companionFlow: "ready" });
        if (ok) {
          get().toast(
            "Launcher AndroidDex (original) abierto en el escritorio ✓",
            "success",
          );
          void get().refreshRunningApps();
          return;
        }
      } else {
        // no instalado → pedir confirmación al usuario (44 MB)
        set({ companionFlow: "prompt" });
        get().toast(
          "Launcher original de Android DEX no instalado — instálalo para el escritorio completo",
          "info",
        );
      }

      // 3) fallback: HOME del teléfono en el display virtual
      const ok = await webAdb.launchHomeOnDisplay(displayId);
      if (ok) {
        get().toast(
          launcher
            ? `Launcher del teléfono (${launcher}) abierto en el display #${displayId}`
            : "Launcher del teléfono abierto en el display virtual",
          "success",
        );
      }

      // 4) refrescar apps visibles
      void get().refreshRunningApps();
    } catch {
      /* el display ya funciona — el launcher es un extra */
    }
  },

  refreshApps: async () => {
    set({ appsLoading: true });
    try {
      // v3: si el LAUNCHER ORIGINAL está instalado, pedir la lista REAL
      // (nombres + íconos + sistema/usuario) al puente 8457 del companion —
      // exactamente el canal que usaba el JAR del original (get_all_apps).
      if (get().companionInstalled) {
        try {
          const apps = await companionBridge.getApps();
          if (apps.length > 0) {
            set({
              userApps: apps
            .filter((a) => !a.isSystem && a.packageName)
            .map((a) => ({
              packageName: a.packageName,
              label: a.appName || a.packageName,
              system: false,
              icon: a.icon,
            }))
            .sort((a, b) => a.label.localeCompare(b.label)),
              systemApps: apps
            .filter((a) => a.isSystem && a.packageName)
            .map((a) => ({
              packageName: a.packageName,
              label: a.appName || a.packageName,
              system: true,
              icon: a.icon,
            }))
            .sort((a, b) => a.label.localeCompare(b.label)),
              appsLoading: false,
            });
            get().toast(
              `Apps analizadas por el companion original: ${apps.length} total`,
              "success",
            );
            return;
          }
        } catch {
          /* puente caído → fallback a pm list */
        }
      }

      const [userOut, sysOut] = await Promise.all([
        webAdb.listPackages("user"),
        webAdb.listPackages("system"),
      ]);
      const { userApps, systemApps } = parsePackageList(userOut, sysOut);
      set({ userApps, systemApps, appsLoading: false });
    } catch {
      set({ appsLoading: false });
    }
  },

  refreshTelemetry: async () => {
    // v3: batería por el puente del companion original (BatteryMonitor)
    // con fallback al polling shell de la v2.
    if (get().companionInstalled) {
      try {
        const cb = await companionBridge.getBattery();
        if (cb && cb.percentage > 0) {
          set({
            battery: {
              percentage: cb.percentage,
              charging: cb.charging,
              temperature: cb.temperature ?? null,
              voltage: cb.voltage ?? null,
              currentMa: cb.currentMa ?? null,
              health: cb.health || null,
              technology: cb.technology || null,
            },
          });
          // media sessions siguen por dumpsys (no soportadas por el puente local)
          const { mediaSessions, volumes } = await pollTelemetryBatch();
          set({
            mediaSessions,
            ...(volumes ? { volume: volumes.music / Math.max(1, volumes.musicMax) } : {}),
          });
          return;
        }
      } catch {
        /* puente caído → fallback */
      }
    }
    try {
      const { battery, mediaSessions, volumes } = await pollTelemetryBatch();
      set({
        battery,
        mediaSessions,
        ...(volumes ? { volume: volumes.music / Math.max(1, volumes.musicMax) } : {}),
      });
    } catch {
      /* noop — el próximo tick reintenta */
    }
  },

  refreshRunningApps: async () => {
    const displayId = get().displayId;
    try {
      const out = await webAdb.shellSafe(
        "timeout 3 dumpsys activity activities 2>/dev/null | grep -E '^(Display #)|(Task\\{)' | head -80",
        10_000,
      );
      const running = parseRunningApps(out, displayId && displayId > 0 ? displayId : null);
      set({ runningApps: running });
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
    get().launchHome();
  },

  /**
   * v2: envía un keycode con triple estrategia:
   * 1) canal de control scrcpy (instantáneo)
   * 2) input keyevent por shell (lento pero seguro)
   * 3) toast de error visible si nada funciona
   */
  sendKeyAction: (keycode) => {
    const controller = displayEngine.controller;
    if (controller) {
      controller
        .injectKeyCode({ action: 0, keyCode: keycode as never, repeat: 0, metaState: 0 as never })
        .then(() => controller.injectKeyCode({ action: 1, keyCode: keycode as never, repeat: 0, metaState: 0 as never }))
        .catch(() => webAdb.inputKeyevent(keycode));
    } else {
      void webAdb.inputKeyevent(keycode);
    }
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
      if (!device && !webAdb.adb) throw new Error("sin dispositivo");

      // Si la conexión ADB sigue viva, reutilizamos
      let adb = webAdb.adb;
      if (!adb) {
        if (!device) throw new Error("sin dispositivo");
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
    stopAppMonitorLoop();
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
      runningApps: [],
      displayId: null,
      controlOnline: false,
      mirrorMode: false,
      launcherPkg: null,
      companionFlow: "idle",
      companionInstalled: false,
      companionVersion: null,
      companionInstall: { phase: "idle", progress: 0, message: "" },
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
): Promise<void> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(interval);
        // No bloqueamos el boot si el video tarda pero ya arrancó
        resolve();
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

/** v2: AppMonitor port — apps visibles en el display virtual cada 4s */
function startAppMonitorLoop(): void {
  stopAppMonitorLoop();
  appMonitorTimer = setInterval(() => {
    const s = useStore.getState();
    if (s.phase === "desktop" && !s.reconnecting && s.displayId != null) {
      void s.refreshRunningApps();
    }
  }, 4000);
}

function stopAppMonitorLoop(): void {
  if (appMonitorTimer) {
    clearInterval(appMonitorTimer);
    appMonitorTimer = null;
  }
}

// Vigilancia global de desconexión (ReconnectionManager port)
webAdb.onDisconnected(() => {
  const s = useStore.getState();
  if (s.phase === "desktop" && !s.reconnecting) {
    void s.reconnectDesktop();
  }
});
