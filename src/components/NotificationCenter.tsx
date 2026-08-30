/**
 * DexPort v9 — NotificationCenter
 * ════════════════════════════════════════════════════════════
 * La nueva utilidad del DexPort Agent v2: el CENTRO DE
 * NOTIFICACIONES del escritorio. Las notificaciones activas del
 * teléfono se espejan en vivo (NotificationListenerService,
 * permiso concedido por ADB) y se pueden:
 *
 *   · leer      — app + ícono real + título + texto + hora
 *   · abrir     — un clic lanza la app emisora en el escritorio
 *   · descartar — botón X por notificación o «Limpiar todo»
 *
 * Estilo: panel lateral derecho estilo action center de Windows,
 * con la misma estética glass-dark del resto de paneles.
 */

import { Bell, BellOff, Loader2, Trash2, X, Smartphone } from "lucide-react";
import { useStore } from "../store/store";
import { appColor, appInitial } from "../utils/appNames";
import { QUICK_KEYS } from "../utils/androidKeys";
import { webAdb } from "../services/adb";
import { displayEngine } from "../store/store";

function timeAgo(ts: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "ahora";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

function NotifCard({
  notif,
  icon,
  label,
  onOpen,
  onDismiss,
}: {
  notif: {
    key: string;
    packageName: string;
    label: string;
    title: string;
    text: string;
    when: number;
    postedAt: number;
    ongoing: boolean;
    clearable: boolean;
  };
  icon?: string | null;
  label: string;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="group relative flex cursor-pointer items-start gap-3 rounded-2xl border border-white/5 bg-white/[0.04] p-3.5 transition hover:border-[#38bdf8]/40 hover:bg-white/[0.07]"
      onClick={onOpen}
      title={`Abrir ${label} en el escritorio`}
    >
      {/* ícono real de la app emisora */}
      {icon ? (
        <img
          src={icon}
          alt={label}
          draggable={false}
          className="h-9 w-9 shrink-0 rounded-[10px] object-contain"
        />
      ) : (
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] text-[13px] font-bold text-white"
          style={{ background: appColor(notif.packageName) }}
        >
          {appInitial(label)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[10.5px] font-semibold uppercase tracking-wider text-[#9499a3]">
            {label}
            {notif.ongoing && (
              <span className="ml-1.5 normal-case tracking-normal text-[#3ddc84]">
                · activo
              </span>
            )}
          </span>
          <span className="shrink-0 text-[10px] text-[#5a606c]">
            {timeAgo(notif.when || notif.postedAt)}
          </span>
        </div>
        {notif.title && (
          <p className="mt-0.5 truncate text-[13.5px] font-medium text-white">
            {notif.title}
          </p>
        )}
        {notif.text && (
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-[#c3c9d4]">
            {notif.text}
          </p>
        )}
      </div>
      {notif.clearable && (
        <button
          className="absolute right-2 top-2 hidden h-6 w-6 place-items-center rounded-full bg-black/50 text-white/70 transition hover:bg-red-500/80 hover:text-white group-hover:grid"
          title="Descartar"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

export function NotificationCenter() {
  const open = useStore((s) => s.panels.notificationsOpen);
  const togglePanel = useStore((s) => s.togglePanel);
  const notifications = useStore((s) => s.notifications);
  const notifListenerEnabled = useStore((s) => s.notifListenerEnabled);
  const agentStatus = useStore((s) => s.agentStatus);
  const refreshNotifications = useStore((s) => s.refreshNotifications);
  const dismissNotification = useStore((s) => s.dismissNotification);
  const clearNotifications = useStore((s) => s.clearNotifications);
  const launchApp = useStore((s) => s.launchApp);
  const userApps = useStore((s) => s.userApps);
  const systemApps = useStore((s) => s.systemApps);

  if (!open) return null;

  // íconos ya conocidos de las apps emisoras (del sync del agente v2)
  const iconByPkg = new Map<string, string | null>();
  for (const a of userApps) if (a.icon) iconByPkg.set(a.packageName, a.icon);
  for (const a of systemApps) if (a.icon) iconByPkg.set(a.packageName, a.icon);
  // las notificaciones pueden traer su propio ícono (cache del agente)
  for (const n of notifications) {
    if (n.icon && !iconByPkg.has(n.packageName)) {
      iconByPkg.set(n.packageName, n.icon);
    }
  }

  const clearableCount = notifications.filter((n) => n.clearable).length;

  const openPhoneShade = () => {
    const c = displayEngine.controller;
    if (c) {
      c.expandNotificationPanel().catch(() => undefined);
    } else {
      void webAdb.inputKeyevent(QUICK_KEYS.notification);
    }
  };

  return (
    <div className="absolute inset-0 z-20" onClick={(e) => {
      if (e.target === e.currentTarget) togglePanel("notificationsOpen", false);
    }}>
      {/* fondo semitransparente (el panel es lateral, estilo action center) */}
      <div className="absolute inset-0 bg-black/35" onClick={() => togglePanel("notificationsOpen", false)} />
      <aside className="glass-dark scrollable fade-in absolute bottom-4 right-4 top-4 flex w-full max-w-sm flex-col rounded-3xl p-5">
        {/* cabecera */}
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="font-serif text-2xl italic text-white">Notificaciones</h2>
            {notifications.length > 0 && (
              <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[#38bdf8] px-1.5 text-[10px] font-bold text-[#04121f]">
                {notifications.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              className="taskbar-btn !h-9 !w-9"
              title="Refrescar"
              onClick={() => void refreshNotifications()}
            >
              <Loader2 size={15} />
            </button>
            <button
              className="taskbar-btn !h-9 !w-9"
              title="Abrir el panel de notificaciones del teléfono"
              onClick={openPhoneShade}
            >
              <Smartphone size={15} />
            </button>
            <button
              className="taskbar-btn"
              onClick={() => togglePanel("notificationsOpen", false)}
            >
              <X size={17} />
            </button>
          </div>
        </div>

        {/* estado del espejo */}
        {agentStatus !== "connected" && (
          <div className="mb-3 rounded-2xl border border-[#f59e0b]/30 bg-[#f59e0b]/10 p-3 text-[12px] text-[#fbbf24]">
            El DexPort Agent no está conectado — sin él no se pueden espejar
            las notificaciones. Instálalo desde Ajustes → DexPort Agent.
          </div>
        )}
        {agentStatus === "connected" && !notifListenerEnabled && (
          <div className="mb-3 rounded-2xl border border-[#f59e0b]/30 bg-[#f59e0b]/10 p-3 text-[12px] leading-relaxed text-[#fbbf24]">
            El permiso de notificaciones no quedó activo en esta ROM.
            Reinstala el Agent (botón «Instalar Agent») o actívalo en
            <span className="text-white"> Ajustes → Acceso a notificaciones → DexPort Agent · Notificaciones</span>.
          </div>
        )}

        {/* acciones */}
        {clearableCount > 0 && (
          <button
            className="mb-3 flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] py-2.5 text-[12px] font-medium text-[#c3c9d4] transition hover:bg-red-500/15 hover:text-white"
            onClick={() => void clearNotifications()}
          >
            <Trash2 size={14} />
            Limpiar todo ({clearableCount})
          </button>
        )}

        {/* lista */}
        <div className="scrollable flex-1 space-y-2.5 overflow-y-auto pr-1">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-14 text-[#5a606c]">
              {notifListenerEnabled ? (
                <>
                  <BellOff size={34} strokeWidth={1.4} />
                  <p className="text-[13px]">Sin notificaciones</p>
                  <p className="max-w-[240px] text-center text-[11px] leading-relaxed">
                    Las notificaciones del teléfono aparecerán aquí en tiempo
                    real cuando lleguen.
                  </p>
                </>
              ) : (
                <>
                  <Bell size={34} strokeWidth={1.4} />
                  <p className="text-[13px]">Espejo de notificaciones inactivo</p>
                  <p className="max-w-[240px] text-center text-[11px] leading-relaxed">
                    Concede el permiso de notificaciones al DexPort Agent para
                    verlas aquí.
                  </p>
                </>
              )}
            </div>
          ) : (
            notifications.map((n) => (
              <NotifCard
                key={n.key}
                notif={n}
                icon={iconByPkg.get(n.packageName)}
                label={n.label || n.packageName}
                onOpen={() => {
                  void launchApp(n.packageName);
                  togglePanel("notificationsOpen", false);
                }}
                onDismiss={() => void dismissNotification(n.key)}
              />
            ))
          )}
        </div>

        <p className="mt-3 shrink-0 text-center text-[10px] leading-relaxed text-[#5a606c]">
          Espejo en vivo vía DexPort Agent (USB) · un clic abre la app en el
          escritorio
        </p>
      </aside>
    </div>
  );
}
