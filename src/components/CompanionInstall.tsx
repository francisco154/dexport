/**
 * DexPort v3 — CompanionInstallCard
 * ════════════════════════════════════════════════════════════
 * UI de instalación del LAUNCHER ORIGINAL de Android DEX
 * (com.shrey.androiddex v1.2 — el mismo APK companion del release
 * oficial, extraído por ingeniería inversa).
 *
 * Aparece:
 *   - durante el boot (integrado en BootScreen) cuando el launcher
 *     no está instalado en el dispositivo, o
 *   - desde el panel Dispositivo (botón "Instalar launcher original").
 *
 * Fases: downloading → pushing → installing → launching → done.
 */

import { useEffect } from "react";
import {
  AppWindow,
  CheckCircle2,
  Download,
  Loader2,
  Rocket,
  Smartphone,
  XCircle,
} from "lucide-react";
import { useStore } from "../store/store";
import { COMPANION_APK_SIZE } from "../services/companion";

const MB = COMPANION_APK_SIZE / 1_048_576;

export function CompanionInstallCard({ compact = false }: { compact?: boolean }) {
  const flow = useStore((s) => s.companionFlow);
  const install = useStore((s) => s.companionInstall);
  const version = useStore((s) => s.companionVersion);
  const installCompanion = useStore((s) => s.installCompanion);
  const skipCompanion = useStore((s) => s.skipCompanion);

  // No mostrar nada si ya está resuelto (salvo errores en flujo manual)
  if (flow === "idle" || flow === "checking" || flow === "ready" || flow === "skipped") {
    return null;
  }

  // ── Estado: instalando (con progreso por fase) ──
  if (flow === "installing") {
    const pct = Math.round(install.progress * 100);
    const phaseLabel: Record<string, string> = {
      downloading: "Descargando APK",
      pushing: "Subiendo al dispositivo",
      installing: "Instalando (pm install)",
      launching: "Abriendo launcher",
      done: "Completado",
      error: "Error",
      idle: "",
    };
    return (
      <div className="mt-5 rounded-2xl border border-emerald-400/25 bg-emerald-400/8 p-4">
        <div className="flex items-center gap-3">
          <Loader2 size={18} className="animate-spin text-emerald-300" />
          <div className="flex-1">
            <p className="text-[13px] font-medium text-emerald-100">
              Launcher AndroidDex (original) — {phaseLabel[install.phase] ?? install.phase}
            </p>
            <p className="text-[12px] text-emerald-200/70">{install.message}</p>
          </div>
          <span className="font-mono text-[12px] text-emerald-200">{pct}%</span>
        </div>
        <div className="dex-progress-track mt-3">
          <div
            className="dex-progress-fill !bg-emerald-400"
            style={{ width: `${Math.max(3, pct)}%` }}
          />
        </div>
        {install.phase === "installing" && (
          <p className="mt-2 text-[11.5px] text-emerald-200/60">
            Mira la pantalla del teléfono — puede pedir confirmación de instalación.
          </p>
        )}
      </div>
    );
  }

  // ── Estado: prompt (confirmación de instalación) ──
  return (
    <div
      className={`mt-5 rounded-2xl border border-sky-400/25 bg-sky-400/8 ${compact ? "p-3.5" : "p-4"}`}
    >
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#0d3a42] to-[#051c2b] ring-1 ring-sky-300/20">
          <AppWindow size={18} className="text-sky-300" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-white">
            Launcher original de Android DEX disponible
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[#aab3bf]">
            El escritorio completo (taskbar, app drawer y widgets) del proyecto original lo dibuja
            su <b className="text-white">launcher companion v{version ?? "1.2"}</b> directamente en el
            display virtual. Instálalo ahora ({MB.toFixed(0)} MB,{" "}
            <span className="font-mono text-[11.5px]">com.shrey.androiddex</span>) y DexPort lo
            abrirá automáticamente al conectar — igual que la app de escritorio original.
          </p>

          {install.phase === "error" && (
            <p className="mt-2 flex items-start gap-1.5 text-[12px] text-red-300">
              <XCircle size={13} className="mt-0.5 shrink-0" />
              {install.error ?? "Error desconocido"}
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="btn-solid !py-2 !text-[12.5px]"
              onClick={() => void installCompanion(true)}
            >
              <Download size={13} /> Instalar launcher original ({MB.toFixed(0)} MB)
            </button>
            <button className="btn-outline !py-2 !text-[12.5px]" onClick={skipCompanion}>
              Continuar con el launcher del teléfono
            </button>
          </div>

          <div className="mt-3 flex flex-col gap-1.5 text-[11.5px] text-[#5a606c]">
            <span className="flex items-center gap-1.5">
              <Smartphone size={11} /> Se instala vía WebADB (push + pm install -r) — sin PC
            </span>
            <span className="flex items-center gap-1.5">
              <CheckCircle2 size={11} /> Extraído del release oficial Android-Dex v1.2 (APK firmado original)
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Aviso flotante en el escritorio cuando el launcher original aún no está
 * instalado (aparece si el boot terminó antes de que el usuario decidiera).
 */
export function CompanionPromptFloat() {
  const flow = useStore((s) => s.companionFlow);
  if (flow !== "prompt" && flow !== "installing") return null;
  return (
    <div className="absolute bottom-4 right-4 z-30 w-[420px] max-w-[calc(100vw-2rem)]">
      <div className="glass-dark fade-in rounded-2xl p-1.5 shadow-2xl">
        <CompanionInstallCard compact />
      </div>
    </div>
  );
}

/**
 * Chip de estado del launcher original para el panel Dispositivo.
 */
export function CompanionStatusChip() {
  const installed = useStore((s) => s.companionInstalled);
  const version = useStore((s) => s.companionVersion);
  const flow = useStore((s) => s.companionFlow);
  const launchCompanionHome = useStore((s) => s.launchCompanionHome);
  const installCompanion = useStore((s) => s.installCompanion);

  // refresco de estado al montar
  const checkCompanion = useStore((s) => s.checkCompanion);
  useEffect(() => {
    void checkCompanion();
  }, [checkCompanion]);

  if (flow === "installing") {
    return (
      <div className="flex items-center gap-2 text-[12px] text-emerald-300">
        <Loader2 size={13} className="animate-spin" /> Instalando launcher AndroidDex…
      </div>
    );
  }

  if (installed) {
    return (
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-[12px] text-emerald-300">
          <Rocket size={13} /> Launcher original v{version ?? "?"} instalado
        </span>
        <button
          className="btn-outline !px-2.5 !py-1 !text-[11px]"
          onClick={() => void launchCompanionHome()}
        >
          Abrir en escritorio
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-[12px] text-[#5a606c]">Launcher original: no instalado</span>
      <button
        className="btn-solid !px-2.5 !py-1 !text-[11px]"
        onClick={() => void installCompanion(true)}
      >
        <Download size={11} /> Instalar (44 MB)
      </button>
    </div>
  );
}
