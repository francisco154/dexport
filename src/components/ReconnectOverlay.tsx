/**
 * DexPort — ReconnectOverlay
 * ════════════════════════════════════════════════════════════
 * Port del overlay de reconexión del original (ReconnectionManager):
 * congela el escritorio e informa de las fases de recuperación.
 */

import { Loader2, RefreshCw, Power } from "lucide-react";
import { useStore } from "../store/store";

export function ReconnectOverlay() {
  const reconnecting = useStore((s) => s.reconnecting);
  const message = useStore((s) => s.reconnectMessage);
  const reconnectDesktop = useStore((s) => s.reconnectDesktop);
  const shutdown = useStore((s) => s.shutdown);

  if (!reconnecting && !message) return null;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="glass fade-in w-full max-w-md rounded-3xl p-8 text-center">
        <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-full bg-[#3ddc84]/10">
          {reconnecting ? (
            <Loader2 size={28} className="spin-slow text-[#3ddc84]" />
          ) : (
            <RefreshCw size={26} className="text-amber-400" />
          )}
        </div>
        <h2 className="text-lg font-semibold text-white">
          {reconnecting ? "Reconectando…" : "Conexión perdida"}
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-[#9499a3]">
          {message ||
            "Se perdió la conexión con el dispositivo. Verifica el cable USB y vuelve a intentarlo."}
        </p>
        {!reconnecting && (
          <div className="mt-6 flex justify-center gap-2">
            <button className="btn-solid !py-2.5 !text-[13px]" onClick={() => void reconnectDesktop()}>
              <RefreshCw size={14} /> Reintentar
            </button>
            <button
              className="btn-outline !py-2.5 !text-[13px]"
              onClick={() => void shutdown()}
            >
              <Power size={14} /> Desconectar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
