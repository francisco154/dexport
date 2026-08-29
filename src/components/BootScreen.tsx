/**
 * DexPort — BootScreen
 * ════════════════════════════════════════════════════════════
 * Port fiel del boot screen original: DOS barras de progreso
 * independientes (APP = sistema, ENGINE = despliegue del motor,
 * que en el original era la barra del JAR) + panel de error con
 * reintento.
 */

import { useEffect, useRef } from "react";
import { AlertTriangle, RefreshCw, MonitorSmartphone, Usb, ShieldCheck } from "lucide-react";
import { useStore } from "../store/store";
import { LauncherPicker } from "./LauncherPicker";

function ProgressBar({
  label,
  message,
  progress,
  error,
}: {
  label: string;
  message: string;
  progress: number;
  error?: boolean;
}) {
  const pct = Math.round(progress * 100);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-widest text-[#9499a3]">
          {label}
        </span>
        <span className="font-mono text-[11px] text-[#5a606c]">{pct.toFixed(0).padStart(2, "0")}%</span>
      </div>
      <div className="dex-progress-track">
        <div
          className={`dex-progress-fill ${error ? "!bg-red-400 !shadow-none" : ""}`}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
      <p className={`mt-2 text-[12.5px] ${error ? "text-red-300" : "text-[#cfd4dc]"}`}>{message}</p>
    </div>
  );
}

export function BootScreen() {
  const appBoot = useStore((s) => s.appBoot);
  const engineBoot = useStore((s) => s.engineBoot);
  const bootError = useStore((s) => s.bootError);
  const bootFatal = useStore((s) => s.bootFatal);
  const retryBoot = useStore((s) => s.retryBoot);
  const shutdown = useStore((s) => s.shutdown);
  const startBoot = useStore((s) => s.startBoot);
  const pickerOpen = useStore((s) => s.launcherPickerOpen);
  const startedRef = useRef(false);

  // Arranque automático al montarse (el canvas ya está en el DOM)
  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      void startBoot();
    }
  }, [startBoot]);

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center">
      <div className="page-bg">
        <div className="page-bg-grid" />
        <div className="page-bg-glow" />
      </div>

      <div className="glass fade-in relative w-full max-w-xl rounded-3xl p-8 shadow-2xl">
        {/* Logo */}
        <div className="mb-8 flex items-center gap-4">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-[#0d3a42] to-[#051c2b] shadow-lg ring-1 ring-white/10">
            <MonitorSmartphone size={26} className="text-[#3ddc84]" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-white">
              DexPort <span className="font-serif italic text-[#9499a3]">boot</span>
            </h1>
            <p className="text-[12px] text-[#5a606c]">
              Android DEX · port WebADB + scrcpy para navegador
            </p>
          </div>
        </div>

        {/* Barras duales (APP + ENGINE) */}
        <div className="flex flex-col gap-6">
          <ProgressBar
            label="APP · Sistema"
            message={appBoot.message || "En espera…"}
            progress={appBoot.progress}
            error={appBoot.isError}
          />
          <ProgressBar
            label="ENGINE · Display virtual"
            message={engineBoot.message || "En espera…"}
            progress={engineBoot.progress}
          />
        </div>

        {/* Panel de error (como el original: aparece bajo las barras) */}
        {bootError && (
          <div className="mt-6 rounded-2xl border border-red-500/25 bg-red-500/10 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-red-400" />
              <div>
                <p className="text-[13px] font-medium text-red-200">{bootError}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {bootFatal && (
                    <button className="btn-solid !py-2 !text-[12.5px]" onClick={() => void retryBoot()}>
                      <RefreshCw size={13} /> Reintentar arranque
                    </button>
                  )}
                  <button className="btn-outline !py-2 !text-[12.5px]" onClick={() => void shutdown()}>
                    Volver al inicio
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Consejos de conexión */}
        {!bootError && !pickerOpen && (
          <div className="mt-7 flex flex-col gap-2.5 border-t border-white/8 pt-5 text-[12px] text-[#5a606c]">
            <div className="flex items-center gap-2">
              <Usb size={13} /> Conecta el teléfono por USB con la <b className="text-[#9499a3]">depuración USB</b> activada
            </div>
            <div className="flex items-center gap-2">
              <ShieldCheck size={13} /> Acepta el diálogo <b className="text-[#9499a3]">«Permitir depuración USB»</b> en el teléfono
            </div>
          </div>
        )}
      </div>

      {/* v4: PANTALLA DE SELECCIÓN DE LAUNCHER (original recomendado +
          launchers del teléfono) — overlay sobre el boot (z-40) */}
      <LauncherPicker />
    </div>
  );
}
