/**
 * DexPort v4 — LauncherPicker
 * ════════════════════════════════════════════════════════════
 * PANTALLA DE SELECCIÓN DE LAUNCHER PRINCIPAL (pedido explícito
 * del usuario): al conectar el dispositivo vía ADB se puede elegir
 *   1. el LAUNCHER ORIGINAL de Android DEX (companion APK del
 *      release oficial — RECOMENDADO, se instala si falta), o
 *   2. cualquier launcher instalado en el teléfono (HyperDroid,
 *      One UI Home, Pixel Launcher…), listados vía
 *      `cmd package query-activities -c HOME`.
 *
 * El elegido se lanza en el display virtual con VERIFICACIÓN real
 * (port del AppMonitor original) y se recuerda para las próximas
 * sesiones. Si el lanzamiento falla, el selector permanece abierto
 * y muestra el diagnóstico crudo (salida real de am/pm) para poder
 * revisar qué pasó — junto a consejos para launchers de fabricante.
 *
 * Aparece:
 *   - durante el boot (tras crear el display virtual), y
 *   - desde el panel Dispositivo → «Elegir launcher…».
 */

import {
  AlertTriangle,
  AppWindow,
  BadgeCheck,
  Check,
  ChevronDown,
  Download,
  Home,
  Loader2,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  Search,
  Smartphone,
  X,
} from "lucide-react";
import { useState } from "react";
import { useStore } from "../store/store";
import { COMPANION_APK_SIZE } from "../services/companion";
import type { LauncherInfo } from "../services/launcher";

const MB = COMPANION_APK_SIZE / 1_048_576;

export function LauncherPicker() {
  const open = useStore((s) => s.launcherPickerOpen);
  const phase = useStore((s) => s.phase);
  if (!open) return null;
  // durante el boot se muestra integrado en la tarjeta de boot (z-40);
  // en el escritorio es un modal por encima de todo (z-50)
  return (
    <div
      className={
        phase === "boot"
          ? "absolute inset-0 z-40 flex items-center justify-center"
          : "absolute inset-0 z-50 flex items-center justify-center"
      }
    >
      <div className="page-bg">
        <div className="page-bg-grid" />
        <div className="page-bg-glow" />
      </div>
      <LauncherPickerCard />
    </div>
  );
}

function LauncherPickerCard() {
  const launchers = useStore((s) => s.launchers);
  const loading = useStore((s) => s.launchersLoading);
  const busy = useStore((s) => s.launcherBusy);
  const displayId = useStore((s) => s.displayId);
  const mirrorMode = useStore((s) => s.mirrorMode);
  const selected = useStore((s) => s.selectedLauncherComponent);
  const active = useStore((s) => s.launcherActive);
  const close = useStore((s) => s.closeLauncherPicker);
  const skip = useStore((s) => s.skipLauncher);
  const refresh = useStore((s) => s.refreshLaunchers);
  const phase = useStore((s) => s.phase);

  const companion = launchers.find((l) => l.isCompanion) ?? null;
  const others = launchers.filter((l) => !l.isCompanion);

  return (
    <div className="glass fade-in relative max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-3xl p-7 shadow-2xl">
      {/* Cabecera */}
      <div className="mb-1 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3.5">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-[#0d3a42] to-[#051c2b] shadow-lg ring-1 ring-white/10">
            <MonitorSmartphone size={22} className="text-[#3ddc84]" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">
              Launcher principal del escritorio
            </h2>
            <p className="text-[12px] text-[#5a606c]">
              {mirrorMode
                ? "Modo espejo — sin display virtual el launcher se abre en el teléfono"
                : displayId != null
                  ? `Se abrirá en el display virtual #${displayId} de tu dispositivo, vía ADB`
                  : "Se abrirá en el display virtual de tu dispositivo, vía ADB"}
            </p>
          </div>
        </div>
        <button
          className="btn-ghost !p-2"
          onClick={close}
          title="Cerrar (continuar sin launcher)"
        >
          <X size={16} />
        </button>
      </div>

      {/* Operación en curso */}
      {busy && (
        <div className="mt-4 flex items-center gap-3 rounded-2xl border border-sky-400/25 bg-sky-400/8 p-3.5">
          <Loader2 size={16} className="animate-spin text-sky-300" />
          <p className="text-[12.5px] text-sky-100">
            Lanzando el launcher y verificando que quede visible en el
            display virtual… (puede tardar unos segundos)
          </p>
        </div>
      )}

      {/* Error del último intento (con diagnóstico crudo) */}
      <LastErrorBox />

      {/* Launcher ORIGINAL (recomendado) */}
      <div className="mt-5">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-[#5a606c]">
          Proyecto original
        </p>
        {companion ? (
          <CompanionCard info={companion} selectedComponent={selected} active={active} />
        ) : loading ? (
          <div className="glass flex items-center gap-2.5 rounded-2xl p-3.5 text-[12.5px] text-[#8a93a3]">
            <Loader2 size={14} className="animate-spin" /> Buscando el launcher original…
          </div>
        ) : null}
      </div>

      {/* Launchers del teléfono */}
      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-[#5a606c]">
            Launchers de tu teléfono
          </p>
          <button
            className="btn-ghost !gap-1 !py-1 !text-[11px]"
            onClick={() => void refresh()}
            title="Volver a leer la lista vía ADB"
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} /> Actualizar
          </button>
        </div>

        {loading && others.length === 0 ? (
          <div className="glass flex items-center gap-2.5 rounded-2xl p-3.5 text-[12.5px] text-[#8a93a3]">
            <Loader2 size={14} className="animate-spin" />
            Buscando launchers (query-activities · resolve-activity · shortcut · dumpsys · escaneo difuso)…
          </div>
        ) : others.length === 0 ? (
          <div className="glass rounded-2xl p-3.5 text-[12.5px] text-[#8a93a3]">
            No se encontraron launchers del teléfono con los 6 métodos de búsqueda.
            Si instalaste uno (p.ej. HyperDroid), pulsa <b>Actualizar</b> — o
            añádelo a mano por su nombre de paquete abajo.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {others.map((l) => (
              <LauncherRow
                key={l.component}
                info={l}
                selectedComponent={selected}
                active={active}
              />
            ))}
          </div>
        )}

        {/* v5: alta manual por nombre de paquete (escape hatch) */}
        <ManualAdd />

        {/* v5: diagnóstico del escaneo (salida cruda de cada método) */}
        <ScanDiagnostics />
      </div>

      {/* Pie: continuar sin launcher */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/8 pt-5">
        <p className="max-w-[380px] text-[11.5px] leading-relaxed text-[#5a606c]">
          Tu elección se recuerda para las próximas conexiones y puedes cambiarla
          cuando quieras desde <b className="text-[#8a93a3]">panel Dispositivo → Elegir launcher</b>.
          Las apps también se abren directamente desde el app drawer.
        </p>
        <button className="btn-outline !py-2 !text-[12.5px]" onClick={skip}>
          {phase === "boot" ? "Continuar sin launcher" : "Cerrar"}
        </button>
      </div>
    </div>
  );
}

/** Tarjeta del launcher ORIGINAL de Android DEX (companion APK). */
function CompanionCard({
  info,
  selectedComponent,
  active,
}: {
  info: LauncherInfo;
  selectedComponent: string | null;
  active: boolean;
}) {
  const installed = useStore((s) => s.companionInstalled);
  const version = useStore((s) => s.companionVersion);
  const install = useStore((s) => s.companionInstall);
  const flow = useStore((s) => s.companionFlow);
  const busy = useStore((s) => s.launcherBusy);
  const selectLauncher = useStore((s) => s.selectLauncher);
  const isSelected = selectedComponent === info.component && active;

  const installing = flow === "installing";
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
    <div className="rounded-2xl border border-emerald-400/30 bg-emerald-400/8 p-4">
      <div className="flex items-start gap-3.5">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#0d3a42] to-[#051c2b] ring-1 ring-emerald-300/25">
          <AppWindow size={20} className="text-emerald-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[13.5px] font-semibold text-white">
              AndroidDex · Launcher original
            </p>
            <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300 ring-1 ring-emerald-400/30">
              Recomendado
            </span>
            {isSelected && (
              <span className="flex items-center gap-1 rounded-full bg-sky-400/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-300 ring-1 ring-sky-400/30">
                <BadgeCheck size={10} /> Activo
              </span>
            )}
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-[#aab3bf]">
            El mismo launcher companion del proyecto Android DEX (v{version ?? "1.2"},{" "}
            <span className="font-mono text-[11px]">{info.pkg}</span>). Diseñado para
            el display virtual: dibuja su pantalla HOME en el escritorio DeX y
            activa el puente de apps con íconos reales.
          </p>

          {installing ? (
            <div className="mt-3">
              <div className="flex items-center gap-2 text-[12px] text-emerald-200">
                <Loader2 size={12} className="animate-spin" />
                {phaseLabel[install.phase] ?? install.phase} · {pct}%
              </div>
              <div className="dex-progress-track mt-2">
                <div
                  className="dex-progress-fill !bg-emerald-400"
                  style={{ width: `${Math.max(3, pct)}%` }}
                />
              </div>
              <p className="mt-1.5 text-[11.5px] text-emerald-200/70">{install.message}</p>
            </div>
          ) : install.phase === "error" ? (
            <p className="mt-2 text-[12px] text-red-300">{install.error}</p>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            {installed ? (
              <button
                className="btn-solid !py-2 !text-[12.5px]"
                disabled={busy}
                onClick={() => void selectLauncher(info.component)}
              >
                {isSelected ? <RefreshCw size={13} /> : <Home size={13} />}
                {isSelected ? "Relanzar en el escritorio" : "Usar este launcher"}
              </button>
            ) : (
              <button
                className="btn-solid !py-2 !text-[12.5px]"
                disabled={busy || installing}
                onClick={() => void selectLauncher(info.component)}
              >
                <Download size={13} /> Instalar y usar ({MB.toFixed(0)} MB)
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Fila de un launcher del teléfono (HyperDroid, One UI Home, …). */
function LauncherRow({
  info,
  selectedComponent,
  active,
}: {
  info: LauncherInfo;
  selectedComponent: string | null;
  active: boolean;
}) {
  const busy = useStore((s) => s.launcherBusy);
  const selectLauncher = useStore((s) => s.selectLauncher);
  const isSelected = selectedComponent === info.component && active;

  return (
    <div
      className={`glass flex items-center gap-3 rounded-2xl p-3.5 ${
        isSelected ? "!border-sky-400/40 ring-1 ring-sky-400/30" : ""
      }`}
    >
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/5 text-[#3ddc84]">
        <Smartphone size={17} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-[13px] font-medium text-white">{info.label}</p>
          {info.isDefault && (
            <span className="rounded-full bg-white/8 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#9499a3] ring-1 ring-white/10">
              Predeterminado del teléfono
            </span>
          )}
          {info.sources.length > 0 && (
            <span
              className="rounded-full bg-white/5 px-2 py-0.5 text-[9.5px] font-medium tracking-wide text-[#5a606c]"
              title={`Encontrado vía: ${info.sources.join(", ")}`}
            >
              vía {info.sources[info.sources.length - 1]}
            </span>
          )}
          {isSelected && (
            <span className="flex items-center gap-1 rounded-full bg-sky-400/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-300 ring-1 ring-sky-400/30">
              <BadgeCheck size={10} /> Activo
            </span>
          )}
        </div>
        <p className="truncate font-mono text-[11px] text-[#5a606c]">
          {info.component}
        </p>
      </div>
      <button
        className="btn-outline shrink-0 !py-1.5 !text-[12px]"
        disabled={busy}
        onClick={() => void selectLauncher(info.component)}
      >
        {isSelected ? (
          <>
            <Check size={12} /> Relanzar
          </>
        ) : (
          "Usar"
        )}
      </button>
    </div>
  );
}

/**
 * v5: alta manual de un launcher por nombre de paquete o componente
 * (p.ej. «com.binary.hyperdroid»). Escape hatch cuando el escaneo
 * automático no encuentra nada — el paquete se verifica por ADB.
 */
function ManualAdd() {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const addManualLauncher = useStore((s) => s.addManualLauncher);

  const submit = async () => {
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      const ok = await addManualLauncher(value);
      if (ok) setValue("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2.5 flex items-center gap-2">
      <div className="glass flex flex-1 items-center gap-2 rounded-2xl px-3 py-2">
        <Search size={13} className="shrink-0 text-[#5a606c]" />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder="Añadir por paquete… p.ej. com.binary.hyperdroid"
          className="w-full bg-transparent font-mono text-[11.5px] text-white placeholder:text-[#454c57] focus:outline-none"
          spellCheck={false}
        />
      </div>
      <button
        className="btn-outline shrink-0 !py-2 !text-[12px]"
        disabled={busy || !value.trim()}
        onClick={() => void submit()}
        title="Verificar el paquete vía ADB y añadirlo a la lista"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
        Añadir
      </button>
    </div>
  );
}

/**
 * v5: diagnóstico del ESCANEO de launchers — la salida cruda que
 * devolvió el teléfono para cada método de búsqueda. Si algo sigue
 * sin funcionar, este panel muestra exactamente el porqué (se puede
 * copiar y reportar).
 */
function ScanDiagnostics() {
  const scan = useStore((s) => s.launcherScan);
  const loading = useStore((s) => s.launchersLoading);
  const [open, setOpen] = useState(false);
  if (scan.length === 0 && !loading) return null;

  const total = scan.filter((s) => s.ok && s.strategy !== "S0 · ping del shell").length;

  return (
    <details
      className="mt-3 rounded-2xl border border-white/8 bg-black/20"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer select-none items-center gap-1.5 px-3.5 py-2.5 text-[11.5px] font-medium text-[#8a93a3]">
        <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        Diagnóstico de búsqueda ({total}/{scan.length - 1} métodos encontraron launchers)
      </summary>
      <div className="max-h-64 space-y-2.5 overflow-y-auto px-3.5 pb-3">
        {scan.map((s) => (
          <div key={s.strategy} className="rounded-xl bg-black/30 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold text-[#aab3bf]">{s.strategy}</p>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide ${
                  s.ok
                    ? s.strategy.includes("ping")
                      ? "bg-white/8 text-[#9499a3]"
                      : "bg-emerald-400/15 text-emerald-300"
                    : "bg-white/5 text-[#5a606c]"
                }`}
              >
                {s.strategy.includes("ping")
                  ? s.ok
                    ? "shell OK"
                    : "shell ROTO"
                  : s.ok
                    ? `${s.found.length} encontrado${s.found.length === 1 ? "" : "s"}`
                    : "vacío"}
                {s.ms > 0 ? ` · ${s.ms}ms` : ""}
              </span>
            </div>
            <p className="mt-1 break-all font-mono text-[9.5px] leading-relaxed text-[#5a606c]">
              $ {s.command}
            </p>
            {s.raw ? (
              <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-[#c9d1d9]">
                {s.raw || "(sin salida)"}
              </pre>
            ) : (
              <p className="mt-1.5 font-mono text-[10px] italic text-[#454c57]">(sin salida)</p>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

/**
 * Caja de error del último intento de lanzamiento, con el
 * diagnóstico crudo (salida real de cada comando am/pm) — pedido
 * del usuario: "revisa por qué me da el error el launcher".
 */
function LastErrorBox() {
  const active = useStore((s) => s.launcherActive);
  const log = useStore((s) => s.lastLauncherLog);
  const busy = useStore((s) => s.launcherBusy);
  if (!log || active || busy) return null;

  return (
    <div className="mt-4 rounded-2xl border border-red-500/25 bg-red-500/10 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-400" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-red-200">
            El último launcher no se pudo abrir en el display virtual
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-red-200/80">
            Causas habituales: los launchers de fabricante (One UI Home, MIUI
            Home…) suelen rechazar displays virtuales; prueba el{" "}
            <b>launcher original</b> (recomendado) o un launcher alternativo
            como HyperDroid. El detalle técnico real está abajo — si persiste,
            cópialo y repórtalo.
          </p>
          <details className="mt-2.5">
            <summary className="flex cursor-pointer select-none items-center gap-1.5 text-[12px] font-medium text-red-200">
              <ChevronDown size={13} /> Ver detalles técnicos (salida real de ADB)
            </summary>
            <pre className="mt-2 max-h-56 overflow-auto rounded-xl bg-black/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-[#c9d1d9]">
              {log}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}
