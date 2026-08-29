/**
 * DexPort — AppDrawer
 * ════════════════════════════════════════════════════════════
 * Port del app drawer del original: overlay con blur, secciones
 * SYSTEM APPS / USER APPS, búsqueda y grid de 8 columnas.
 */

import { useMemo, useState } from "react";
import { Search, Loader2, X, RefreshCw, Square } from "lucide-react";
import { useStore } from "../store/store";
import {
  appColor,
  appInitial,
  getAppIcon,
  type AppEntry,
} from "../utils/appNames";
import { webAdb } from "../services/adb";

function AppTile({ app, onLaunch }: { app: AppEntry; onLaunch: (p: string) => void }) {
  const icon = getAppIcon(app.packageName);
  return (
    <button className="app-tile" onClick={() => onLaunch(app.packageName)} title={app.packageName}>
      {app.icon ? (
        // v3: ícono real extraído por el companion original (base64 PNG)
        <img
          src={app.icon}
          alt={app.label}
          loading="lazy"
          className="app-icon !bg-transparent object-contain"
          draggable={false}
        />
      ) : (
        <span className="app-icon" style={{ background: appColor(app.packageName) }}>
          {appInitial(app.label)}
        </span>
      )}
      <span className="max-w-[76px] truncate text-center text-[11px] font-medium text-white/90">
        {app.label}
      </span>
    </button>
  );
}

export function AppDrawer() {
  const open = useStore((s) => s.panels.drawerOpen);
  const togglePanel = useStore((s) => s.togglePanel);
  const userApps = useStore((s) => s.userApps);
  const systemApps = useStore((s) => s.systemApps);
  const appsLoading = useStore((s) => s.appsLoading);
  const launchApp = useStore((s) => s.launchApp);
  const refreshApps = useStore((s) => s.refreshApps);
  const toast = useStore((s) => s.toast);
  const [query, setQuery] = useState("");
  const [showSystem, setShowSystem] = useState(false);

  const filteredUser = useMemo(
    () =>
      userApps.filter(
        (a) =>
          !query ||
          a.label.toLowerCase().includes(query.toLowerCase()) ||
          a.packageName.toLowerCase().includes(query.toLowerCase()),
      ),
    [userApps, query],
  );
  const filteredSystem = useMemo(
    () =>
      systemApps.filter(
        (a) =>
          !query ||
          a.label.toLowerCase().includes(query.toLowerCase()) ||
          a.packageName.toLowerCase().includes(query.toLowerCase()),
      ),
    [systemApps, query],
  );

  const killApp = async (pkg: string) => {
    await webAdb.shellSafe(`am force-stop ${pkg}`);
    toast(`${pkg} detenido`, "info");
  };

  if (!open) return null;

  return (
    <div
      className="absolute inset-0 bottom-[92px] z-20 flex flex-col"
      onClick={(e) => {
        if (e.target === e.currentTarget) togglePanel("drawerOpen", false);
      }}
    >
      <div className="glass-dark scrollable fade-in m-4 mb-2 flex-1 rounded-3xl p-6">
        {/* Header */}
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="font-serif text-2xl italic text-white">Apps</h2>
            <span className="text-[12px] text-[#9499a3]">
              {userApps.length} apps de usuario · {systemApps.length} del sistema
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="taskbar-btn"
              title="Refrescar lista"
              onClick={() => void refreshApps()}
            >
              {appsLoading ? <Loader2 size={16} className="spin-slow" /> : <RefreshCw size={16} />}
            </button>
            <button className="taskbar-btn" title="Cerrar" onClick={() => togglePanel("drawerOpen", false)}>
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Grid de apps de usuario */}
        {appsLoading && userApps.length === 0 ? (
          <div className="flex h-40 items-center justify-center gap-3 text-[#9499a3]">
            <Loader2 size={18} className="spin-slow" />
            <span className="text-sm">Cargando aplicaciones del dispositivo…</span>
          </div>
        ) : (
          <>
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-[#5a606c]">
              User Apps
            </h3>
            {filteredUser.length === 0 ? (
              <p className="mb-6 text-sm text-[#9499a3]">Sin resultados para «{query}»</p>
            ) : (
              <div className="mb-8 grid grid-cols-4 gap-1 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10">
                {filteredUser.map((app) => (
                  <div key={app.packageName} className="group relative">
                    <AppTile app={app} onLaunch={(p) => void launchApp(p)} />
                    <button
                      className="absolute right-1 top-1 hidden h-6 w-6 place-items-center rounded-full bg-black/60 text-white/80 hover:bg-red-500/80 hover:text-white group-hover:grid"
                      title="Forzar detención"
                      onClick={(e) => {
                        e.stopPropagation();
                        void killApp(app.packageName);
                      }}
                    >
                      <Square size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Toggle de apps del sistema */}
            <button
              className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-[#5a606c] transition hover:text-[#9499a3]"
              onClick={() => setShowSystem(!showSystem)}
            >
              System Apps {showSystem ? "▾" : "▸"}
              <span className="normal-case tracking-normal">({filteredSystem.length})</span>
            </button>
            {showSystem && (
              <div className="grid grid-cols-4 gap-1 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10">
                {filteredSystem.map((app) => (
                  <AppTile key={app.packageName} app={app} onLaunch={(p) => void launchApp(p)} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Búsqueda (pill inferior como el original) */}
      <div className="flex justify-center pb-3">
        <div className="glass-dark flex w-full max-w-md items-center gap-3 rounded-full px-5 py-3">
          <Search size={16} className="text-[#9499a3]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar apps…"
            className="flex-1 bg-transparent text-sm text-white placeholder-[#5a606c] outline-none"
          />
          {query && (
            <button onClick={() => setQuery("")} className="text-[#9499a3] hover:text-white">
              <X size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
