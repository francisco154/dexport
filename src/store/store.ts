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
  scanHomeLaunchers,
  launchLauncherOnDisplay,
  quietRelaunchOnDisplay,
  launcherLabel,
  parsePerPackageHome,
  type LauncherInfo,
  type LauncherScanReport,
} from "../services/launcher";
import { COMPANION_PKG, COMPANION_MAIN_ACTIVITY } from "../services/companion";
import {
  DisplayEngine,
  DEFAULT_DISPLAY_SETTINGS,
  computeDisplaySizeForContainer,
  type DisplaySettings,
} from "../services/scrcpy";
import {
  type BatteryState,
  type MediaSession,
  type TaskInfo,
  pollTelemetryBatch,
  TASK_DUMP_COMMAND,
  parseTasks,
  parseWindowDump,
  parseStackList,
  splitTaskDump,
  mergeTaskSources,
  parseCurrentFocus,
} from "../utils/telemetry";
import { parsePackageList, packageToLabel, type AppEntry } from "../utils/appNames";
import {
  agentBridge,
  type AgentPing,
  type AgentInstallProgress,
  type AgentTask,
  type AgentNotification,
  type AgentAppInfo,
} from "../services/agent";

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
  /** v7: vista «Apps abiertas» (estilo Windows, botón Recientes) */
  taskViewOpen: boolean;
  /** v9: centro de notificaciones (espejo del teléfono vía DexPort Agent) */
  notificationsOpen: boolean;
}

/**
 * v3 — flujo del LAUNCHER ORIGINAL (companion APK com.shrey.androiddex).
 * Estado de la instalación/uso del launcher extraído del release oficial.
 */
export type CompanionFlow = "idle" | "checking" | "prompt" | "installing" | "ready" | "skipped";

/**
 * v4 — decisión del selector de launcher (el boot espera esta decisión).
 * "none"   → el usuario aún no eligió (picker visible)
 * "decided"→ hay launcher elegido y lanzado
 * "skipped"→ continuar sin launcher
 */
export type LauncherDecision = "none" | "decided" | "skipped";

/**
 * v6 — preferencias de la interfaz (instantáneas, sin reiniciar nada).
 * Port del panel de personalización que pedía el usuario: ocultar el
 * widget del reloj, botones propios, auto-ocultar la barra…
 */
export interface UiPrefs {
  /** widget del reloj analógico del escritorio */
  showClock: boolean;
  /** grupo de navegación propio (inicio/atrás/recientes/notifs) en la taskbar */
  showTaskbarNav: boolean;
  /** la taskbar se esconde sola y aparece al acercar el mouse abajo */
  autoHideTaskbar: boolean;
  /** v8: la taskbar flotante está minimizada (pastilla pequeña) */
  taskbarCollapsed: boolean;
  /** v8: controles estilo Windows de la app activa en una esquina */
  showWindowControls: boolean;
}

const UI_PREFS_KEY = "dexport.ui.v3";

function loadUiPrefs(): UiPrefs {
  const defaults: UiPrefs = {
    showClock: true,
    showTaskbarNav: true,
    autoHideTaskbar: false,
    taskbarCollapsed: false,
    showWindowControls: true,
  };
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch {
    /* noop */
  }
  return defaults;
}

function saveUiPrefs(p: UiPrefs): void {
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify(p));
  } catch {
    /* noop */
  }
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

  // ── v4/v5: selector de launcher principal ──
  /** launchers HOME instalados en el dispositivo (vía ADB) */
  launchers: LauncherInfo[];
  launchersLoading: boolean;
  /** v5: informe de diagnóstico del último escaneo (salida cruda por estrategia) */
  launcherScan: LauncherScanReport[];
  /** pantalla de selección de launcher visible */
  launcherPickerOpen: boolean;
  /** componente elegido y persistido ("com.pkg/.Activity") */
  selectedLauncherComponent: string | null;
  /** último lanzamiento verificado en el display virtual */
  launcherActive: boolean;
  /** operación en curso (instalar/lanzar/verificar) */
  launcherBusy: boolean;
  /** log de diagnóstico del último intento (salidas crudas de am/pm) */
  lastLauncherLog: string | null;
  /** decisión del selector — el boot espera aquí (93%) */
  launcherDecision: LauncherDecision;

  // ── Telemetría (AndroidCore port) ──
  battery: BatteryState | null;
  mediaSessions: MediaSession[];
  clipboard: string;

  // ── Apps ──
  userApps: AppEntry[];
  systemApps: AppEntry[];
  appsLoading: boolean;
  /** v7: tareas abiertas en TODOS los displays (gestión estilo Windows) */
  runningApps: TaskInfo[];

  // ── v8: DexPort Agent (accesibilidad) ──
  /** "checking" | "missing" | "no-permission" | "connected" | "unknown" */
  agentStatus: "checking" | "missing" | "no-permission" | "connected" | "unknown";
  agentPing: AgentPing | null;
  /** progreso de la instalación (para la UI) */
  agentInstall: AgentInstallProgress;
  /** tareas crudas del agente (títulos reales de ventanas) */
  agentTasks: AgentTask[];

  // ── v9: DexPort Agent v2 (apps reales + notificaciones) ──
  /** apps reales sincronizadas (labels + componentes del PackageManager) */
  agentAppsSynced: boolean;
  /** notificaciones activas espejadas desde el teléfono */
  notifications: AgentNotification[];
  /** false → el listener no tiene permiso (se pidió por ADB pero la ROM lo negó) */
  notifListenerEnabled: boolean;
  /** launcher PREDETERMINADO del teléfono (HOME determinista) */
  defaultLauncherComponent: string | null;

  // ── Panels ──
  panels: PanelState;
  toasts: { id: number; message: string; kind: "info" | "error" | "success" }[];

  // ── Settings ──
  settings: DisplaySettings;

  // ── v6: preferencias de la interfaz (instantáneas) ──
  uiPrefs: UiPrefs;

  // ── Acciones ──
  setPhase: (p: Phase) => void;
  setAppBoot: (e: Partial<BootEvent>) => void;
  setEngineBoot: (e: Partial<BootEvent>) => void;
  setBootError: (err: string | null, fatal?: boolean) => void;
  setSettings: (s: Partial<DisplaySettings>) => void;
  /** v6: preferencias de la interfaz (instantáneas, persistidas) */
  setUiPrefs: (p: Partial<UiPrefs>) => void;
  /** v6: redimensiona el display virtual al tamaño actual de la ventana (en vivo) */
  resizeDisplayToWindow: (silent?: boolean) => Promise<boolean>;
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
  /** v4: selector de launcher principal */
  refreshLaunchers: () => Promise<void>;
  openLauncherPicker: () => void;
  closeLauncherPicker: () => void;
  /** elige (y lanza con verificación) un launcher; instala el original si falta */
  selectLauncher: (component: string) => Promise<boolean>;
  skipLauncher: () => void;
  /** v5: añade un launcher manualmente por paquete/componente (si el escaneo falla) */
  addManualLauncher: (input: string) => Promise<boolean>;
  refreshApps: () => Promise<void>;
  refreshTelemetry: () => Promise<void>;
  refreshRunningApps: () => Promise<void>;
  /** v8: estado del DexPort Agent (instalado / permiso / puente) */
  checkAgent: () => Promise<void>;
  /** v8: instala el agente + permiso de accesibilidad por ADB */
  installAgent: () => Promise<void>;
  /** v8: acciones globales del agente (ATRÁS/HOME/… fiables) */
  agentAction: (a: "back" | "home" | "recents" | "notifications" | "quick_settings" | "lock_screen" | "all_apps") => Promise<boolean>;
  /** v9: sincroniza apps reales (labels + componentes) e íconos por lotes */
  syncAgentApps: () => Promise<void>;
  /** v9: descarga los íconos que falten (lotes de 12, progresivo) */
  syncAgentIcons: () => Promise<void>;
  /** v9: refresca el espejo de notificaciones (con toasts de las nuevas) */
  refreshNotifications: () => Promise<void>;
  /** v9: descarta una notificación por key */
  dismissNotification: (key: string) => Promise<void>;
  /** v9: limpia todas las notificaciones descartables */
  clearNotifications: () => Promise<void>;
  /** v9: resuelve el launcher PREDETERMINADO (agente → shell → null) */
  resolveHomeLauncher: () => Promise<string | null>;
  setAudioMuted: (m: boolean) => void;
  setVolume: (v: number) => void;
  goHome: () => void;
  sendKeyAction: (keycode: number) => void;
  /** v7: tecla de navegación DIRIGIDA al display virtual (fix ATRÁS) */
  sendNavKey: (keycode: number) => Promise<void>;
  /** v7: HOME instantáneo (keyevent al display) con auto-reparación del launcher */
  goHomeSmart: () => Promise<void>;
  /** v7: acciones de ventana estilo Windows sobre una tarea abierta */
  taskAction: (
    task: { taskId: number; packageName: string; activity: string | null; displayId: number },
    action: "front" | "minimize" | "kill" | "freeform" | "fullscreen",
  ) => Promise<void>;
  reconnectDesktop: () => Promise<void>;
  shutdown: () => Promise<void>;
}

const SETTINGS_KEY = "dexport.settings.v1";
const LAUNCHER_KEY = "dexport.launcher.v1";
const ICONS_KEY = "dexport.icons.v1";

// ═════════════════════════════════════════════════════════
// v9: caché de íconos/labels reales (localStorage)
// — el agente los entrega por lotes; se guardan para que el
//   drawer/taskbar arranque con íconos reales al reconectar
// ═════════════════════════════════════════════════════════
interface IconCacheEntry {
  label: string;
  icon?: string;
  component?: string;
}
const iconCache = new Map<string, IconCacheEntry>();
try {
  const raw = localStorage.getItem(ICONS_KEY);
  if (raw) {
    const obj = JSON.parse(raw) as Record<string, IconCacheEntry>;
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v.label === "string") iconCache.set(k, v);
    }
  }
} catch {
  /* caché corrupta → empezar vacía */
}

let iconCacheTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleIconCacheSave(): void {
  if (iconCacheTimer) return;
  iconCacheTimer = setTimeout(() => {
    iconCacheTimer = null;
    try {
      const obj: Record<string, IconCacheEntry> = {};
      // cap: 400 entradas (≈3 MB con íconos de 64px) para no reventar la cuota
      const entries = [...iconCache.entries()].slice(-400);
      for (const [k, v] of entries) obj[k] = v;
      localStorage.setItem(ICONS_KEY, JSON.stringify(obj));
    } catch {
      try {
        localStorage.removeItem(ICONS_KEY);
      } catch {
        /* noop */
      }
    }
  }, 2_500);
}

/** Superpone labels/íconos/componentes cacheados sobre una lista de apps. */
function overlayIconCache(list: AppEntry[]): AppEntry[] {
  if (iconCache.size === 0) return list;
  return list.map((e) => {
    const c = iconCache.get(e.packageName);
    if (!c) return e;
    return {
      ...e,
      label: c.label || e.label,
      ...(c.icon ? { icon: c.icon } : {}),
      ...(c.component ? { component: c.component } : {}),
    };
  });
}

function loadLauncherPref(): string | null {
  try {
    return localStorage.getItem(LAUNCHER_KEY);
  } catch {
    return null;
  }
}

function saveLauncherPref(component: string | null): void {
  try {
    if (component) localStorage.setItem(LAUNCHER_KEY, component);
    else localStorage.removeItem(LAUNCHER_KEY);
  } catch {
    /* noop */
  }
}

/** v5: fuentes de un launcher sin duplicados ("vía X" en el selector). */
function dedupeSources(sources: string[]): string[] {
  return [...new Set(sources)];
}

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
/** v9: guard de syncAgentIcons (una sola tanda de lotes a la vez) */
let iconSyncBusy = false;
/** v10: auto-actualización del agente a v3 — un intento por sesión */
let agentUpgradeAttempted = false;
/** v10: limpieza de perfiles de trabajo (Island) — una vez por sesión */
let agentProfilesCleaned = false;
/** v10: guard de refreshNotifications (sin solapamientos) */
let notifRefreshBusy = false;
/** v9: notificaciones ya vistas (para toasts solo de las NUEVAS) */
const seenNotifKeys = new Set<string>();
let notifFirstLoad = true;
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

  launchers: [],
  launchersLoading: false,
  launcherScan: [],
  launcherPickerOpen: false,
  selectedLauncherComponent: null,
  launcherActive: false,
  launcherBusy: false,
  lastLauncherLog: null,
  launcherDecision: "none",

  battery: null,
  mediaSessions: [],
  clipboard: "",

  userApps: [],
  systemApps: [],
  appsLoading: false,
  runningApps: [],

  // ── v8: DexPort Agent (accesibilidad) ──
  agentStatus: "checking",
  agentPing: null,
  agentInstall: { phase: "idle", progress: 0, message: "" },
  agentTasks: [],

  // ── v9: agente v2 (apps reales + notificaciones + HOME determinista) ──
  agentAppsSynced: false,
  notifications: [],
  notifListenerEnabled: false,
  defaultLauncherComponent: null,

  panels: {
    drawerOpen: false,
    mediaOpen: false,
    deviceOpen: false,
    settingsOpen: false,
    shortcutsOpen: false,
    taskViewOpen: false,
    notificationsOpen: false,
  },
  toasts: [],

  settings: loadSettings(),
  uiPrefs: loadUiPrefs(),

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

  setUiPrefs: (partial) => {
    const next = { ...get().uiPrefs, ...partial };
    saveUiPrefs(next);
    set({ uiPrefs: next });
  },

  /**
   * v6: ajusta el display virtual al tamaño ACTUAL de la ventana EN VIVO
   * (mensaje RESIZE_DISPLAY del fork — las apps sobreviven). Es el
   * «pantalla completa real»: sin bandas negras, aspect idéntico.
   */
  resizeDisplayToWindow: async (silent = false) => {
    const s = get();
    if (!s.settings.virtualDisplay || s.displayId == null) {
      if (!silent) s.toast("Sin display virtual activo", "error");
      return false;
    }
    const container = document.querySelector("#dex-display-canvas")?.parentElement;
    if (!container) return false;
    const size = computeDisplaySizeForContainer(
      container.clientWidth,
      container.clientHeight,
      Math.max(s.settings.width, s.settings.height),
    );
    const changed = await displayEngine.resizeDisplay(size.width, size.height);
    if (changed) {
      set({ displaySize: { width: size.width, height: size.height } });
      if (!silent) {
        s.toast(`Pantalla ajustada a ${size.width}×${size.height} (en vivo)`, "success");
      }
    } else if (!silent) {
      s.toast("El display ya está ajustado a la ventana", "info");
    }
    return changed;
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

      // ── v6: mantener el dispositivo DESPIERTO (fix «se desactiva a los
      // segundos»): el original adquiere un PARTIAL_WAKE_LOCK al arrancar;
      // el equivalente shell es STAY_ON_WHILE_PLUGGED_IN + wakeup ──
      try {
        await applyPowerKeepAwake(get().settings.keepScreenOn);
        if (get().settings.keepScreenOn) {
          await webAdb.shellSafe("input keyevent 224", 4_000); // KEYCODE_WAKEUP
        }
      } catch {
        /* noop — scrcpy también aplica stay_awake por su cuenta */
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
      // v6: el tamaño real puede diferir de los ajustes (fitToWindow) —
      // usar el que aplicó el motor; onSizeChanged lo mantendrá al día.
      set({
        displaySize: displayEngine.currentSize.width
          ? { ...displayEngine.currentSize }
          : { width: get().settings.width, height: get().settings.height },
      });

      // ── 0.84: esperar primer frame (equivale handshake jar.hello) ──
      store.setAppBoot({
        message: "Esperando flujo de video…",
        progress: 0.84,
      });
      await waitFor(
        () => get().engineBoot.progress >= 1,
        20_000,
      );

      // ── 0.93→1.00: selector de launcher + apps EN BACKGROUND ──
      store.setAppBoot({
        message: "Preparando escritorio…",
        progress: 0.93,
      });

      // v4: esperar la decisión del selector de launcher (pantalla de
      // selección: original recomendado + launchers del teléfono).
      // Solo aplica con display virtual; si el selector no llega a abrirse
      // (error de shell), el boot continúa tras la ventana de gracia.
      if (!get().mirrorMode) {
        await waitFor(
          () =>
            get().launcherDecision !== "none" ||
            get().launcherPickerOpen ||
            get().mirrorMode,
          25_000,
        );
        if (get().launcherPickerOpen && get().launcherDecision === "none") {
          // selector visible e interactivo — esperar la elección del usuario
          await waitFor(
            () => get().launcherDecision !== "none",
            600_000,
          );
        }
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
      startLauncherWatchdog();
      // v8: detectar el DexPort Agent (accesibilidad) al conectar
      void get().checkAgent();
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
    // v6: el companion NO tiene activity LAUNCHER (solo HOME), así que
    // START_APP no puede lanzarlo — usar el protocolo del launcher.
    if (pkg === COMPANION_PKG) {
      await get().launchHome();
      get().togglePanel("drawerOpen", false);
      return;
    }
    get().toast(`Lanzando ${pkg}…`, "info");
    // v9: componente EXACTO del agente (am start -n directo)
    const entry = [...get().userApps, ...get().systemApps].find(
      (a) => a.packageName === pkg,
    );
    const component = entry?.component ?? null;
    const fallbackStart = async () => {
      if (displayName != null && displayName > 0) {
        return component
          ? webAdb.startActivityOnDisplay(component, displayName)
          : webAdb.launchOnDisplay(pkg, displayName);
      }
      await webAdb.shellSafe(
        component
          ? `am start -n ${component}`
          : `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`,
      );
      return true;
    };
    try {
      if (controller) {
        // scrcpy 3.3: START_APP arranca la app EN el display virtual
        // (mismo código que el JAR original: setLaunchDisplayId)
        await controller.startApp(pkg, { forceStop: false, searchByName: false });
      } else {
        await fallbackStart();
      }
      get().togglePanel("drawerOpen", false);
      // v7: la taskbar muestra la app al momento (sin esperar el tick de 4s)
      setTimeout(() => void useStore.getState().refreshRunningApps(), 1_200);
    } catch {
      try {
        await fallbackStart();
        get().togglePanel("drawerOpen", false);
        setTimeout(() => void useStore.getState().refreshRunningApps(), 1_200);
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
          // v4: protocolo robusto con verificación + log de diagnóstico
          const result = await launchLauncherOnDisplay(
            {
              component: COMPANION_MAIN_ACTIVITY,
              pkg: COMPANION_PKG,
              label: "AndroidDex · Launcher original",
              isDefault: false,
              isCompanion: true,
              sources: ["proyecto original"],
            },
            displayId,
            { controller: displayEngine.controller ?? null, forceStop: true },
          );
          const ok = result.ok;
          set({
            companionInstall: { phase: "done", progress: 1, message: ok ? "Launcher abierto ✓" : "Instalado — elige el launcher en el selector" },
            lastLauncherLog: result.log.join("\n---\n").slice(0, 6_000),
            launcherActive: ok,
            ...(ok
              ? {
                  selectedLauncherComponent: COMPANION_MAIN_ACTIVITY,
                  launcherDecision: "decided" as const,
                }
              : {}),
          });
          if (ok) {
            saveLauncherPref(COMPANION_MAIN_ACTIVITY);
            get().toast("Launcher AndroidDex abierto en el escritorio ✓", "success");
          }
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
      // v4: re-lanzar para que el selector de launcher registre el error
      throw e instanceof Error ? e : new Error(msg);
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
    // v4: delega en el protocolo robusto (verificación + log)
    return get().selectLauncher(COMPANION_MAIN_ACTIVITY);
  },

  /**
   * v10.1: HOME del escritorio — prioridad v8 REPARADA:
   *   1. el launcher ELEGIDO por el usuario (persistido)
   *   2. el launcher ORIGINAL (companion) si está instalado
   *   3. un launcher del teléfono que NO sea el predefinido (su tarea
   *      no vive en el display 0 → puede crearse en el display virtual)
   *   4. el PREDETERMINADO — último recurso, con el protocolo robusto
   *      (force-stop + verificación; en muchos teléfonos el sistema lo
   *      revive en el display 0, pero es la última opción, no la primera)
   *
   * (La v9 ponía el predefinido el PRIMERO — regresión del launcher en
   * la pantalla principal. `resolveHomeLauncher` se mantiene SOLO como
   * información para el panel/selector, no decide el HOME.)
   */
  launchHome: async () => {
    const displayId = get().displayId;
    if (displayId == null || displayId <= 0) {
      // modo espejo o sin display virtual → HOME físico del teléfono
      get().sendKeyAction(3); // KEYCODE_HOME
      return;
    }

    const selected = get().selectedLauncherComponent;
    const launchers = get().launchers;
    const notDefault = launchers.find(
      (l) => !l.isDefault && l.component !== selected,
    );
    const fallbackDefault = launchers.find((l) => l.isDefault);
    const candidates = (
      [
        selected,
        get().companionInstalled ? COMPANION_MAIN_ACTIVITY : null,
        notDefault?.component ?? null,
        fallbackDefault?.component ?? null,
      ] as (string | null)[]
    ).filter((c): c is string => !!c);

    for (const component of candidates) {
      const ok = await get().selectLauncher(component);
      if (ok) return;
    }

    get().toast("No se pudo abrir el launcher — elige uno en el selector", "error");
    set({ launcherPickerOpen: true });
  },

  // ═════════════════════════════════════════════════════════
  // v4: SELECTOR DE LAUNCHER PRINCIPAL
  // ═════════════════════════════════════════════════════════

  /**
   * v5: enumera los launchers HOME del dispositivo vía ADB con el
   * ESCANEO MULTIESTRATEGIA (query-activities + resolve-activity +
   * shortcut + dumpsys + escaneo difuso por nombre de paquete).
   * Guarda también el informe de diagnóstico por estrategia para
   * poder ver en el selector exactamente qué devolvió el teléfono.
   */
  refreshLaunchers: async () => {
    set({ launchersLoading: true });
    try {
      // estado del launcher original (companion) primero
      await get().checkCompanion().catch(() => false);
      const { launchers, report } = await scanHomeLaunchers();
      // enriquecer etiquetas con las apps ya conocidas (bridge/íconos v3)
      const known = new Map<string, AppEntry>();
      for (const a of get().userApps) known.set(a.packageName, a);
      for (const a of get().systemApps) known.set(a.packageName, a);
      for (const l of launchers) {
        if (!l.isCompanion) {
          const app = known.get(l.pkg);
          if (app?.label) l.label = app.label;
        }
      }
      set({ launchers, launcherScan: report });
    } catch {
      /* la lista mínima (original + default) se muestra igualmente */
    } finally {
      set({ launchersLoading: false });
    }
  },

  openLauncherPicker: () => {
    set({ launcherPickerOpen: true });
    void get().refreshLaunchers();
  },

  closeLauncherPicker: () => {
    // cerrar sin elegir durante el boot = continuar sin launcher
    if (get().launcherDecision === "none") {
      set({ launcherDecision: "skipped" });
    }
    set({ launcherPickerOpen: false });
  },

  skipLauncher: () => {
    set({ launcherDecision: "skipped", launcherPickerOpen: false });
    get().toast("Continuando sin launcher — las apps se abren desde el drawer", "info");
  },

  /**
   * v5: añade manualmente un launcher por paquete o componente
   * ("com.binary.hyperdroid" o "com.pkg/.HomeActivity"). Lo verifica
   * por ADB (¿tiene categoría HOME?) y lo añade a la lista del selector.
   * Escape hatch cuando el escaneo automático no encuentra nada.
   */
  addManualLauncher: async (input) => {
    const raw = input.trim();
    if (!raw || !/^[a-zA-Z][a-zA-Z0-9_.]*(\/[.a-zA-Z0-9_$]+)?$/.test(raw)) {
      get().toast("Escribe un nombre de paquete válido (p.ej. com.binary.hyperdroid)", "error");
      return false;
    }
    const pkg = raw.split("/")[0];
    set({ launchersLoading: true });
    try {
      let component = raw.includes("/") ? raw : pkg;
      if (!raw.includes("/")) {
        // resolver la activity HOME del paquete
        const out = await webAdb.shellSafe(
          `dumpsys package ${pkg} 2>/dev/null | grep -B6 -A1 'android.intent.category.HOME' | head -20`,
          8_000,
        );
        const comp = parsePerPackageHome(out, pkg);
        if (comp) component = comp;
      }
      const installed = await webAdb.shellSafe(`pm list packages ${pkg} 2>/dev/null`, 10_000);
      if (!installed.includes(`package:${pkg}`)) {
        get().toast(`El paquete ${pkg} no está instalado en el dispositivo`, "error");
        return false;
      }
      const existing = get().launchers.find((l) => l.pkg === pkg);
      if (existing) {
        set({
          launchers: get().launchers.map((l) =>
            l.pkg === pkg ? { ...l, component, sources: dedupeSources([...l.sources, "manual"]) } : l,
          ),
        });
      } else {
        const info: LauncherInfo = {
          component,
          pkg,
          label: launcherLabel(pkg),
          isDefault: false,
          isCompanion: pkg === COMPANION_PKG,
          sources: ["manual"],
        };
        set({ launchers: [...get().launchers.filter((l) => !l.isCompanion), info, ...get().launchers.filter((l) => l.isCompanion)] });
      }
      get().toast(`${launcherLabel(pkg)} añadido — pulsa «Usar» para lanzarlo`, "success");
      return true;
    } finally {
      set({ launchersLoading: false });
    }
  },

  /**
   * v4: ELIGE el launcher principal — instala el original si falta y
   * lo lanza en el display virtual con verificación real.
   * Devuelve true si quedó abierto (verificado) en el escritorio.
   */
  selectLauncher: async (component) => {
    if (get().launcherBusy) return false;
    // si la enumeración falló, sintetizar la info mínima del componente
    const info: LauncherInfo =
      get().launchers.find((l) => l.component === component) ?? {
        component,
        pkg: component.split("/")[0],
        label: launcherLabel(component.split("/")[0]),
        isDefault: false,
        isCompanion: component.split("/")[0] === COMPANION_PKG,
        sources: ["sintetizado"],
      };
    set({ launcherBusy: true, lastLauncherLog: null, launcherActive: false });
    const log: string[] = [];
    try {
      // ── 1. si es el ORIGINAL y no está instalado → instalarlo primero ──
      if (info.isCompanion && !get().companionInstalled) {
        await get().installCompanion(false); // lanza excepción si falla
        log.push(`✓ launcher original instalado (${COMPANION_PKG})`);
      }

      const displayId = get().displayId;
      if (displayId == null || displayId <= 0) {
        throw new Error(
          "No hay display virtual activo (modo espejo) — reconecta con display virtual",
        );
      }

      // ── 2. protocolo robusto: A(force-stop+clear-task) B(START_APP) C D ──
      const result = await launchLauncherOnDisplay(info, displayId, {
        controller: displayEngine.controller ?? null,
        forceStop: true,
      });
      log.push(...result.log);

      if (result.ok) {
        // arrancar el puente del companion si es el original (como el
        // escritorio original: el companion provee apps con íconos/batería)
        if (info.isCompanion) void companion.startBridge();
        saveLauncherPref(component);
        set({
          selectedLauncherComponent: component,
          launcherActive: true,
          launcherDecision: "decided",
          lastLauncherLog: log.join("\n---\n").slice(0, 6_000),
          launcherPickerOpen: false,
        });
        get().toast(
          `${info.label} abierto en el escritorio${result.verified ? " ✓" : ""}`,
          "success",
        );
        void get().refreshRunningApps();
        return true;
      }

      // ── 3. fallo: mantener el selector abierto con el diagnóstico ──
      set({
        lastLauncherLog: log.join("\n---\n").slice(0, 6_000),
        launcherPickerOpen: true,
      });
      get().toast(
        "No se pudo abrir el launcher — revisa los detalles y prueba otro",
        "error",
      );
      return false;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.push(`✗ error: ${msg}`);
      set({
        lastLauncherLog: log.join("\n---\n").slice(0, 6_000),
        launcherPickerOpen: true,
      });
      get().toast(`Launcher falló: ${msg.slice(0, 140)}`, "error");
      return false;
    } finally {
      set({ launcherBusy: false });
    }
  },

  /**
   * v2/v4: port del flujo del original al crear el display virtual:
   * 1) enumera launchers del dispositivo (query-activities HOME)
   * 2) aplica la elección persistida, o abre la PANTALLA DE SELECCIÓN
   *    (original recomendado + launchers del teléfono, p.ej. HyperDroid)
   * 3) sincroniza las apps visibles (AppMonitor)
   */
  initDesktopAfterDisplay: async (displayId: number) => {
    const s = get();
    if (s.phase !== "boot" && s.phase !== "desktop") return;
    try {
      // 1) launcher por defecto del teléfono (info del panel)
      const launcher = await webAdb.getDefaultLauncher();
      set({ launcherPkg: launcher });

      // 2) estado del launcher original + enumeración de launchers
      await get().refreshLaunchers();

      // 3) ¿elección persistida? → aplicarla automáticamente
      const pref = loadLauncherPref();
      if (pref) {
        // el flujo de selección decide y cierra solo si funciona;
        // si falla, abre el selector con el error a la vista
        await get().selectLauncher(pref);
        void get().refreshRunningApps();
        return;
      }

      // 4) sin elección → PANTALLA DE SELECCIÓN de launcher principal
      set({ launcherPickerOpen: true });
      get().toast(
        "Elige el launcher del escritorio — original (recomendado) o el de tu teléfono",
        "info",
      );
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
      // v9: superponer labels/íconos/componentes REALES cacheados (del
      // agente v2) — al reconectar el drawer nace con íconos genuinos
      set({
        userApps: overlayIconCache(userApps),
        systemApps: overlayIconCache(systemApps),
        appsLoading: false,
      });
      // v9: si el agente ya está conectado, refrescar también la fuente
      // real (labels del PackageManager + íconos que falten)
      if (useStore.getState().agentStatus === "connected") {
        void useStore.getState().syncAgentApps();
      }
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

  /**
   * v8: refresco multi-fuente de las apps abiertas.
   *   1. DexPort Agent (si está conectado) — ventanas reales con título,
   *      actividad y (API 33+) display de cada una. Fuente EXACTA.
   *   2. dumpsys activity activities — taskId + tipo por display.
   *   3. dumpsys window windows — display real de cada VENTANA (freeform).
   *   4. am stack list — taskId + display alternativos.
   *   5. mCurrentFocus — foco global.
   * Todo el dump en UN stream con marcadores; el agente en paralelo.
   */
  refreshRunningApps: async () => {
    const vd = get().displayId;
    const agentConnected = get().agentStatus === "connected";
    const agentPromise: Promise<AgentTask[]> = agentConnected
      ? agentBridge.getTasks().catch(() => [])
      : Promise.resolve([]);

    try {
      const [out, agent] = await Promise.all([
        webAdb.shellSafe(TASK_DUMP_COMMAND, 15_000),
        agentPromise,
      ]);
      const { act, win, stack, focus } = splitTaskDump(out);
      const tasks = mergeTaskSources({
        act: parseTasks(act), // foco interno por top de display
        windows: parseWindowDump(win),
        stacks: parseStackList(stack),
        focusPkg: focus ? parseCurrentFocus(focus) : null,
        virtualDisplayId: vd,
        agent: agent.map((a) => ({
          packageName: a.packageName,
          activity: a.activity,
          title: a.title,
          displayId: a.displayId,
          isActive: a.isActive,
          isFocused: a.isFocused,
        })),
      });
      if (agent.length > 0) set({ agentTasks: agent });
      set({ runningApps: tasks });
    } catch {
      /* noop — el próximo tick reintenta */
    }
  },

  /**
   * v8: estado del DexPort Agent:
   *   connected     → puente 8458 responde (permiso activo)
   *   no-permission → APK instalado pero el servicio no está habilitado
   *   missing       → ni siquiera instalado
   */
  checkAgent: async () => {
    if (!webAdb.adb) return;
    set((s) => (s.agentStatus === "connected" ? {} : { agentStatus: "checking" }));
    const pong = await agentBridge.ping();
    if (pong) {
      set({ agentStatus: "connected", agentPing: pong });
      // v10: el agente v1/v2 se ACTUALIZA solo a v3 (reconstrucción sin
      // bloqueos: sin getRoot, sin prefetch de nodos, worker único de fondo)
      if (pong.version < 3) {
        if (!agentUpgradeAttempted) {
          agentUpgradeAttempted = true;
          get().toast(
            "Actualizando DexPort Agent a v3 — reconstruido para no frenar el teléfono…",
            "info",
          );
          void get().installAgent();
          // el servicio de accesibilidad renace tras el upgrade → re-check
          setTimeout(() => void useStore.getState().checkAgent(), 6_000);
        }
        return;
      }
      // v10: ¿el agente quedó corriendo en un perfil de trabajo (Island)?
      // → aviso + limpieza de duplicados (una vez por sesión)
      if (pong.userId > 0) {
        get().toast(
          `El agente corre en el perfil ${pong.userId} (¿Island?) — reinstalando en el perfil principal…`,
          "error",
        );
        if (!agentUpgradeAttempted) {
          agentUpgradeAttempted = true;
          void get().installAgent();
          setTimeout(() => void useStore.getState().checkAgent(), 8_000);
        }
        return;
      }
      if (!agentProfilesCleaned) {
        agentProfilesCleaned = true;
        void agentBridge.cleanOtherProfiles().then((cleaned) => {
          if (cleaned.length > 0) {
            useStore
              .getState()
              .toast(
                `Agente duplicado eliminado de ${cleaned.length} perfil(es) de trabajo ✓`,
                "success",
              );
          }
        });
      }
      // v9: al conectar → apps/íconos reales + launcher predefinido + notifs
      void useStore.getState().syncAgentApps();
      void useStore.getState().resolveHomeLauncher();
      void useStore.getState().refreshNotifications();
      return;
    }
    const installed = await agentBridge.isInstalled();
    set({
      agentStatus: installed ? "no-permission" : "missing",
      agentPing: null,
      agentTasks: [],
    });
  },

  /** v8: instalar el agente + conceder accesibilidad por ADB (automático). */
  installAgent: async () => {
    if (get().agentInstall.phase === "installing") return;
    if (!webAdb.adb) {
      get().toast("Conecta el dispositivo primero", "error");
      return;
    }
    set({
      agentInstall: { phase: "downloading", progress: 0, message: "Iniciando…" },
    });
    try {
      const ok = await agentBridge.install((p) => set({ agentInstall: p }));
      if (ok) {
        set({ agentStatus: "connected" });
        const pong = await agentBridge.ping();
        if (pong) set({ agentPing: pong });
        get().toast("DexPort Agent v2 activo — detección, íconos y notificaciones ✓", "success");
        void get().refreshRunningApps();
        // v9: sincronizar apps reales + íconos + HOME determinista + notifs
        void get().syncAgentApps();
        void get().resolveHomeLauncher();
        void get().refreshNotifications();
      } else {
        set({ agentStatus: "no-permission" });
        get().toast(
          "Agent instalado — actívalo en Ajustes → Accesibilidad → DexPort Agent",
          "info",
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({
        agentInstall: { phase: "error", progress: 0, message: msg, error: msg },
      });
      get().toast(`No se pudo instalar el Agent: ${msg.slice(0, 80)}`, "error");
    }
  },

  /** v8: acción global vía agente (ATRÁS/HOME/… fiables). */
  agentAction: async (a) => {
    if (get().agentStatus !== "connected") return false;
    return agentBridge.performAction(a);
  },

  // ═════════════════════════════════════════════════════════
  // v9: APPS REALES + ÍCONOS + NOTIFICACIONES (agente v2)
  // ═════════════════════════════════════════════════════════

  /**
   * v9: sincroniza las apps LANZABLES reales del teléfono — etiquetas del
   * PackageManager (no el diccionario), componente exacto de cada una y
   * flags de sistema reales. La lista del agente REEMPLAZA la de
   * `pm list packages` (que incluye apps sin ícono lanzable) y hereda los
   * íconos ya cacheados para no perderlos. Después baja los íconos que
   * falten, por lotes.
   */
  syncAgentApps: async () => {
    const s = get();
    if (s.agentStatus !== "connected") return;
    try {
      const apps = await agentBridge.getApps();
      if (apps.length === 0) return;

      const prevByPkg = new Map<string, AppEntry>();
      for (const e of s.userApps) prevByPkg.set(e.packageName, e);
      for (const e of s.systemApps) prevByPkg.set(e.packageName, e);

      const toEntry = (a: AgentAppInfo): AppEntry => {
        const prev = prevByPkg.get(a.packageName);
        const cached = iconCache.get(a.packageName);
        return {
          packageName: a.packageName,
          label: a.label || cached?.label || prev?.label || packageToLabel(a.packageName),
          system: a.system,
          ...(a.component ? { component: a.component } : {}),
          icon: cached?.icon ?? prev?.icon ?? null,
        };
      };

      const user = apps
        .filter((a) => !a.system)
        .map(toEntry)
        .sort((a, b) => a.label.localeCompare(b.label));
      const sys = apps
        .filter((a) => a.system)
        .map(toEntry)
        .sort((a, b) => a.label.localeCompare(b.label));

      set({ userApps: user, systemApps: sys, agentAppsSynced: true });

      // persistir labels/componentes (los íconos se añaden al llegar)
      for (const a of apps) {
        const cached = iconCache.get(a.packageName);
        iconCache.set(a.packageName, {
          label: a.label,
          ...(cached?.icon ? { icon: cached.icon } : {}),
          ...(a.component ? { component: a.component } : {}),
        });
      }
      scheduleIconCacheSave();
    } catch {
      /* el próximo check reintenta */
    }
    void get().syncAgentIcons();
  },

  /**
   * v9: baja los íconos PNG reales que falten — lotes de 12, aplicando
   * cada lote al estado (los íconos van apareciendo progresivamente en
   * el drawer/taskbar/TaskView). Terminado el lote útil (respuesta
   * vacía) o la desconexión, para.
   */
  syncAgentIcons: async () => {
    if (iconSyncBusy) return;
    iconSyncBusy = true;
    try {
      let pendingRounds = 0;
      for (;;) {
        const s = get();
        if (s.agentStatus !== "connected") return;
        const missing = [...s.userApps, ...s.systemApps]
          .filter((a) => !a.icon)
          .map((a) => a.packageName)
          .slice(0, 12);
        if (missing.length === 0) return;
        const { icons: map, pending } = await agentBridge
          .getIcons(missing)
          .catch(() => ({ icons: new Map<string, string>(), pending: [] as string[] }));
        if (map.size > 0) {
          const apply = (list: AppEntry[]) =>
            list.map((e) => {
              const icon = map.get(e.packageName);
              if (!icon) return e;
              const cached = iconCache.get(e.packageName);
              iconCache.set(e.packageName, {
                label: e.label,
                icon,
                ...(e.component ? { component: e.component } : {}),
                ...(cached?.component && !e.component ? { component: cached.component } : {}),
              });
              return { ...e, icon };
            });
          const st = get();
          set({ userApps: apply(st.userApps), systemApps: apply(st.systemApps) });
          scheduleIconCacheSave();
          pendingRounds = 0;
          // respiro entre lotes: el agente genera en fondo y por USB
          // nunca debe haber ráfagas (v3 — gentil con el teléfono)
          await new Promise((r) => setTimeout(r, 350));
        } else if (pending.length > 0 && pendingRounds < 10) {
          // v3: el agente está generando esos íconos en su hilo de fondo
          // (serializado, baja prioridad) → esperar y volver a pedir
          pendingRounds++;
          await new Promise((r) => setTimeout(r, 1_500));
        } else {
          return; // nada útil → no insistir
        }
      }
    } finally {
      iconSyncBusy = false;
    }
  },

  /**
   * v9: refresca el ESPEJO DE NOTIFICACIONES del teléfono. La primera
   * carga no avisa (evita una ráfaga de toasts al conectar); después,
   * cada notificación NUEVA muestra un toast estilo escritorio.
   */
  refreshNotifications: async () => {
    const s = get();
    if (s.agentStatus !== "connected" || notifRefreshBusy) return;
    notifRefreshBusy = true;
    try {
      const res = await agentBridge.getNotifications();
      if (!res) return;
      set({ notifications: res.notifications, notifListenerEnabled: res.enabled });
      if (!res.enabled) return;

      if (notifFirstLoad) {
        for (const n of res.notifications) seenNotifKeys.add(n.key);
        notifFirstLoad = false;
        return;
      }
      // toasts de notificaciones nuevas (máx. 3 por refresco)
      let shown = 0;
      for (const n of res.notifications) {
        if (seenNotifKeys.has(n.key)) continue;
        seenNotifKeys.add(n.key);
        if (shown < 3 && !n.ongoing && (n.title || n.text)) {
          shown++;
          get().toast(
            `${n.label || n.packageName}: ${n.title || n.text}`.slice(0, 110),
            "info",
          );
        }
      }
    } finally {
      notifRefreshBusy = false;
    }
  },

  /** v9: descarta una notificación desde la web (y refresca). */
  dismissNotification: async (key) => {
    const ok = await agentBridge.dismissNotification(key);
    if (ok) {
      seenNotifKeys.delete(key);
      set({ notifications: get().notifications.filter((n) => n.key !== key) });
    } else {
      get().toast("El teléfono no permitió descartar la notificación", "error");
    }
  },

  /** v9: limpia todas las notificaciones descartables. */
  clearNotifications: async () => {
    const ok = await agentBridge.clearNotifications();
    if (ok) {
      for (const n of get().notifications) seenNotifKeys.delete(n.key);
      set({ notifications: [] });
    }
  },

  /**
   * v9: componente del launcher PREDETERMINADO del teléfono — el sitio al
   * que SIEMPRE vuelve el botón HOME. Fuente exacta: el agente (PackageManager
   * .resolveActivity HOME); fallback: `cmd package resolve-activity` por shell.
   */
  resolveHomeLauncher: async () => {
    const cached = get().defaultLauncherComponent;
    if (cached) return cached;
    if (get().agentStatus === "connected") {
      try {
        const l = await agentBridge.getLauncher();
        if (l?.defaultComponent) {
          set({ defaultLauncherComponent: l.defaultComponent });
          return l.defaultComponent;
        }
      } catch {
        /* caer al shell */
      }
    }
    try {
      const out = await webAdb.shellSafe(
        "cmd package resolve-activity --brief -c android.intent.category.HOME -a android.intent.action.MAIN 2>/dev/null | tail -1",
        8_000,
      );
      const comp = (out.trim().split("\n").pop() ?? "").trim();
      if (comp.includes("/") && comp.length > 3) {
        set({ defaultLauncherComponent: comp });
        return comp;
      }
    } catch {
      /* noop */
    }
    return null;
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
    void get().goHomeSmart();
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

  /**
   * v8: tecla de navegación dirigida al display virtual — ahora con
   * CUÁDRUPLE estrategia (fix definitivo del «ATRÁS a medias»):
   * 1) `input -d <vd> keyevent <code>` — evento con setDisplayId al
   *    display virtual (fiable, Android 10+)
   * 2) DexPort Agent `action.back/home/…` — performGlobalAction sobre
   *    la ventana enfocada (funciona aunque el input -d falle)
   * 3) canal de control scrcpy (keycode al display espejado)
   * 4) input keyevent plano (último recurso)
   */
  sendNavKey: async (keycode) => {
    const vd = get().displayId;
    if (vd != null && vd > 0) {
      const ok = await webAdb.inputKeyeventOnDisplay(keycode, vd);
      if (ok) return;
    }
    // 2) agente: performGlobalAction (ATRÁS=4 HOME=3 RECIENTES…)
    if (get().agentStatus === "connected") {
      const AGENT_KEYS: Record<number, "back" | "home" | "recents" | "notifications"> = {
        4: "back",
        3: "home",
        82: "recents",
        83: "notifications",
      };
      const action = AGENT_KEYS[keycode];
      if (action && (await agentBridge.performAction(action))) return;
    }
    const controller = displayEngine.controller;
    if (controller) {
      try {
        await controller.injectKeyCode({ action: 0, keyCode: keycode as never, repeat: 0, metaState: 0 as never });
        await controller.injectKeyCode({ action: 1, keyCode: keycode as never, repeat: 0, metaState: 0 as never });
        return;
      } catch {
        /* caer al input plano */
      }
    }
    await webAdb.inputKeyevent(keycode);
  },

  /**
   * v10.1: HOME del escritorio — REPARADO (regresión v9).
   *
   * La v9 apuntaba el HOME al launcher PREDETERMINADO del teléfono
   * (p.ej. Samsung One UI Home): la tarea de ese launcher vive SIEMPRE en
   * el display 0 y `am start --display N` NO mueve tareas existentes —
   * solo trae la tarea al frente EN EL TELÉFONO. Resultado: el launcher
   * se abría en la pantalla principal, el display virtual quedaba en
   * negro («display fallando») y sin tareas en el vd la taskbar no
   * listaba nada («no lee las apps abiertas») — los 3 síntomas.
   *
   * v10.1 vuelve al objetivo de la v8 (que funcionaba):
   *   · el launcher ELEGIDO (persistido) u el ORIGINAL (companion),
   *     cuya tarea NO existe en el display 0 → `am start --display N`
   *     la crea EN el display virtual
   * Estrategia:
   *   a) si el vd está VACÍO → relanzamiento silencioso del objetivo
   *      directo al display virtual (am start --display vd -n <comp>)
   *   b) HOME del sistema sobre el vd (lo trae al frente al instante)
   *   c) verificación diferida: si el vd sigue sin contenido →
   *      protocolo robusto completo (launchHome) como red de seguridad
   */
  goHomeSmart: async () => {
    const vd = get().displayId;
    if (vd == null || vd <= 0) {
      get().sendKeyAction(3); // HOME físico (modo espejo)
      return;
    }

    // ── a) vd vacío → sembrar el launcher ELEGIDO/ORIGINAL en el vd ──
    //    (nunca el predefinido del teléfono: su tarea vive en el display 0)
    const hasTaskNow = get().runningApps.some((t) => t.displayId === vd);
    if (!hasTaskNow) {
      const selected = get().selectedLauncherComponent;
      const seed =
        selected ?? (get().companionInstalled ? COMPANION_MAIN_ACTIVITY : null);
      if (seed) {
        await quietRelaunchOnDisplay(seed, vd).catch(() => false);
      }
    }

    // ── b+c) keyevent HOME al vd + verificación diferida (flujo v8) ──
    const before = get().runningApps.some((t) => t.displayId === vd);
    await get().sendNavKey(3);
    setTimeout(async () => {
      try {
        await get().refreshRunningApps();
        const s = useStore.getState();
        const vd2 = s.displayId;
        if (vd2 == null || vd2 <= 0) return;
        const hasContent = s.runningApps.some((t) => t.displayId === vd2);
        if (!hasContent || (!before && !hasContent)) {
          await s.launchHome();
        }
      } catch {
        /* noop */
      }
    }, 1_400);
  },

  /**
   * v7: acciones de ventana estilo Windows sobre una tarea abierta.
   *   front      → traer al frente (restore si estaba «minimizada» en el teléfono)
   *   minimize   → mandar la tarea al display del teléfono (sigue viva,
   *                desaparece del escritorio — minimize real)
   *   kill       → am force-stop
   *   freeform   → reabrir en VENTANA (windowingMode 5, estilo DeX)
   *   fullscreen → reabrir a PANTALLA COMPLETA (windowingMode 1)
   */
  taskAction: async (task, action) => {
    const s = get();
    const vd = s.displayId;
    const label = s.userApps.find((a) => a.packageName === task.packageName)?.label
      ?? s.systemApps.find((a) => a.packageName === task.packageName)?.label
      ?? task.packageName;

    const resolveComponent = async (): Promise<string | null> =>
      task.activity ?? (await webAdb.resolveLauncherActivity(task.packageName));

    try {
      if (action === "kill") {
        await webAdb.forceStop(task.packageName);
        s.toast(`${label} cerrada`, "success");
      } else if (action === "front") {
        if (vd == null || vd <= 0) throw new Error("sin display virtual");
        if (task.displayId !== vd && task.taskId > 0) {
          // estaba «minimizada» en el teléfono → devolverla al escritorio
          const moved = await webAdb.moveTask(task.taskId, vd);
          if (!moved) {
            const comp = await resolveComponent();
            if (comp) await webAdb.startActivityOnDisplay(comp, vd);
          }
        } else {
          const comp = await resolveComponent();
          if (!comp) throw new Error("no se pudo resolver la actividad");
          const ok = await webAdb.startActivityOnDisplay(comp, vd);
          if (!ok && task.taskId > 0) await webAdb.moveTask(task.taskId, vd);
        }
        s.togglePanel("taskViewOpen", false);
      } else if (action === "minimize") {
        if (task.displayId === vd) {
          // mandarla al display del teléfono (minimize real estilo Windows:
          // sigue ejecutándose, desaparece del escritorio)
          let ok = false;
          if (task.taskId > 0) ok = await webAdb.moveTask(task.taskId, 0);
          if (!ok) {
            // fallback: HOME en el display virtual (todo a segundo plano)
            if (vd != null && vd > 0) await get().sendNavKey(3);
            else get().sendKeyAction(3);
          }
        } else {
          // ya está en el teléfono — llevarla al fondo (HOME del teléfono)
          get().sendKeyAction(3);
        }
        s.toast(`${label} minimizada`, "info");
      } else if (action === "freeform" || action === "fullscreen") {
        if (vd == null || vd <= 0) throw new Error("sin display virtual");
        const comp = await resolveComponent();
        if (!comp) throw new Error("no se pudo resolver la actividad");
        const mode = action === "freeform" ? 5 : 1;
        const ok = await webAdb.startActivityOnDisplay(comp, vd, {
          windowingMode: mode,
        });
        s.toast(
          ok
            ? action === "freeform"
              ? `${label} en ventana — arrastra la ventana dentro del escritorio`
              : `${label} a pantalla completa`
            : `El dispositivo no permitió cambiar el modo de ventana de ${label}`,
          ok ? "success" : "error",
        );
        s.togglePanel("taskViewOpen", false);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      s.toast(`Acción fallida: ${msg.slice(0, 90)}`, "error");
    } finally {
      // refresco inmediato — la taskbar se actualiza al momento
      void get().refreshRunningApps();
      setTimeout(() => void useStore.getState().refreshRunningApps(), 1_500);
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
    stopLauncherWatchdog();
    await restorePowerSetting();
    await displayEngine.stop();
    await webAdb.disconnect();
    // v9: reiniciar el detector de notificaciones nuevas
    seenNotifKeys.clear();
    notifFirstLoad = true;
    agentUpgradeAttempted = false;
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
      agentStatus: "checking",
      agentPing: null,
      agentInstall: { phase: "idle", progress: 0, message: "" },
      agentTasks: [],
      // v9
      agentAppsSynced: false,
      notifications: [],
      notifListenerEnabled: false,
      defaultLauncherComponent: null,
      displayId: null,
      controlOnline: false,
      mirrorMode: false,
      launcherPkg: null,
      companionFlow: "idle",
      companionInstalled: false,
      companionVersion: null,
      companionInstall: { phase: "idle", progress: 0, message: "" },
      launchers: [],
      launchersLoading: false,
      launcherPickerOpen: false,
      selectedLauncherComponent: null,
      launcherActive: false,
      launcherBusy: false,
      lastLauncherLog: null,
      launcherDecision: "none",
      panels: {
        drawerOpen: false,
        mediaOpen: false,
        deviceOpen: false,
        settingsOpen: false,
        shortcutsOpen: false,
        taskViewOpen: false,
        notificationsOpen: false,
      },
    });
  },
}));

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ═════════════════════════════════════════════════════════════
// v6: MANTENER EL DISPOSITIVO DESPIERTO (port del PARTIAL_WAKE_LOCK
// del JAR original). Guarda el valor actual de STAY_ON_WHILE_PLUGGED_IN,
// lo pone en 7 (AC|USB|wireless) y lo restaura al desconectar.
// ═════════════════════════════════════════════════════════════
let powerOriginalValue: string | null = null;
let powerApplied = false;

async function applyPowerKeepAwake(enable: boolean): Promise<void> {
  if (enable) {
    const current = await webAdb
      .shellSafe("settings get global stay_on_while_plugged_in", 5_000)
      .catch(() => "");
    powerOriginalValue = current.trim() || "0";
    powerApplied = true;
    // 7 = AC(1) | USB(2) | WIRELESS(4) — como el original
    await webAdb.shellSafe("settings put global stay_on_while_plugged_in 7", 5_000);
  } else {
    await restorePowerSetting();
  }
}

async function restorePowerSetting(): Promise<void> {
  if (!powerApplied) return;
  powerApplied = false;
  const value = powerOriginalValue ?? "0";
  try {
    await webAdb.shellSafe(
      `settings put global stay_on_while_plugged_in ${value}`,
      5_000,
    );
  } catch {
    /* noop */
  }
}

// ═════════════════════════════════════════════════════════════
// v6: WATCHDOG DEL LAUNCHER (estabilidad del escritorio).
// Cada 10s: si hay launcher elegido y el display virtual quedó SIN
// contenido visible 2 veces seguidas (murió / lo cerraron), lo
// re-lanza SILENCIOSAMENTE (am start sin force-stop) + despierta el
// dispositivo. Solo actúa si alguna vez se vio contenido en el
// display (los Samsung que no listan VDs en dumpsys quedan excluidos
// para evitar bucles de relanzamiento).
// ═════════════════════════════════════════════════════════════
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let watchdogEmptyStreak = 0;
let watchdogSawContent = false;
let watchdogBusy = false;

function startLauncherWatchdog(): void {
  stopLauncherWatchdog();
  watchdogEmptyStreak = 0;
  watchdogSawContent = false;
  watchdogTimer = setInterval(async () => {
    const s = useStore.getState();
    if (
      watchdogBusy ||
      s.phase !== "desktop" ||
      s.reconnecting ||
      s.mirrorMode ||
      s.displayId == null ||
      s.displayId <= 0 ||
      s.launcherDecision !== "decided" ||
      !s.selectedLauncherComponent
    ) {
      return;
    }
    // aprovechar el último refresco del AppMonitor (corre cada 4s)
    // v7: runningApps contiene tareas de TODOS los displays — contar el VD
    const hasContent = s.runningApps.some((t) => t.displayId === s.displayId);
    if (hasContent) {
      watchdogSawContent = true;
      watchdogEmptyStreak = 0;
      return;
    }
    if (!watchdogSawContent) return; // el display nunca listó contenido → no intervenir
    watchdogEmptyStreak++;
    if (watchdogEmptyStreak < 2) return; // 2 ticks vacíos (~20s) → actuar

    watchdogEmptyStreak = 0;
    watchdogBusy = true;
    try {
      // despertar el dispositivo por si se durmió (keyevent 224 = WAKEUP)
      await webAdb.shellSafe("input keyevent 224", 4_000).catch(() => "");
      const ok = await quietRelaunchOnDisplay(
        s.selectedLauncherComponent,
        s.displayId,
      );
      if (ok) {
        watchdogSawContent = false; // esperar confirmación del próximo tick
        useStore.getState().toast("Launcher restaurado automáticamente", "info");
      }
    } finally {
      watchdogBusy = false;
    }
  }, 10_000);
}

function stopLauncherWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
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
      // v9: espejo de notificaciones cada 5s (con el agente conectado)
      if (s.agentStatus === "connected") {
        void s.refreshNotifications();
      }
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
  let tick = 0;
  appMonitorTimer = setInterval(() => {
    const s = useStore.getState();
    if (s.phase === "desktop" && !s.reconnecting && s.displayId != null) {
      void s.refreshRunningApps();
      // v8: reintentar el agente cada ~24s si no está conectado
      tick++;
      if (s.agentStatus !== "connected" && tick % 6 === 0) {
        void s.checkAgent();
      }
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
