package com.dexport.agent;

import android.app.Notification;
import android.content.Context;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * DexPort Agent v2 — espejo de NOTIFICACIONES.
 * ════════════════════════════════════════════════════════════
 * La nueva utilidad del agente: todo lo que ADB no puede ver de las
 * notificaciones activas del teléfono.
 *
 *   · notifications.get    → lista viva: app, ícono, título, texto,
 *                            hora, ongoing, descartable → la web las
 *                            muestra en un CENTRO DE NOTIFICACIONES
 *                            estilo Windows dentro del escritorio
 *   · notification.dismiss → descartar una notificación DESDE la web
 *   · notifications.clear_all → limpiar todas (las descartables)
 *
 * El permiso NotificationListenerService se concede por ADB
 * (`cmd notification allow_listener com.dexport.agent/.AgentNotificationListener`)
 * — el mismo flujo sin tocar el teléfono que usa la accesibilidad.
 */
public class AgentNotificationListener extends NotificationListenerService {

    private static volatile AgentNotificationListener sInstance;

    public static AgentNotificationListener getInstance() {
        return sInstance;
    }

    public static boolean isConnected() {
        return sInstance != null;
    }

    @Override
    public void onListenerConnected() {
        super.onListenerConnected();
        sInstance = this;
    }

    @Override
    public void onListenerDisconnected() {
        sInstance = null;
        super.onListenerDisconnected();
    }

    // ── snapshots para el AgentServer ─────────────────────────

    /**
     * Lista de notificaciones activas (la más reciente primero).
     * Sin permiso → lista vacía con enabled=false (la web puede
     * ofrecer activarlo).
     */
    public static JSONObject snapshotJson(Context ctx) {
        JSONObject out = new JSONObject();
        AgentNotificationListener l = sInstance;
        if (l == null) {
            try {
                out.put("enabled", false);
                out.put("notifications", new JSONArray());
            } catch (Exception ignored) {
            }
            return out;
        }
        try {
            StatusBarNotification[] sbns = l.getActiveNotifications();
            JSONArray arr = new JSONArray();
            AppRegistry reg = AppRegistry.get(ctx);
            // getActiveNotifications no garantiza orden → ordenar por postTime
            long[] times = new long[sbns.length];
            Integer[] idx = new Integer[sbns.length];
            for (int i = 0; i < sbns.length; i++) {
                times[i] = sbns[i] == null ? 0 : sbns[i].getPostTime();
                idx[i] = i;
            }
            java.util.Arrays.sort(idx, (a, b) -> Long.compare(times[b], times[a]));
            for (int i : idx) {
                StatusBarNotification sbn = sbns[i];
                if (sbn == null || sbn.getNotification() == null) {
                    continue;
                }
                try {
                    Notification n = sbn.getNotification();
                    Bundle e = n.extras;
                    String title = str(e.getCharSequence(Notification.EXTRA_TITLE));
                    String text = str(e.getCharSequence(Notification.EXTRA_TEXT));
                    if (text == null || text.isEmpty()) {
                        text = str(e.getCharSequence(Notification.EXTRA_BIG_TEXT));
                    }
                    String pkg = sbn.getPackageName();
                    JSONObject o = new JSONObject();
                    o.put("key", sbn.getKey());
                    o.put("package_name", pkg);
                    o.put("label", reg.labelOf(pkg));
                    if (title != null) {
                        o.put("title", title);
                    }
                    if (text != null) {
                        o.put("text", text);
                    }
                    o.put("when", n.when > 0 ? n.when : sbn.getPostTime());
                    o.put("posted_at", sbn.getPostTime());
                    o.put("ongoing", sbn.isOngoing());
                    o.put("clearable", sbn.isClearable());
                    // ícono de la app (del cache del registro; null si aún
                    // no se generó — la web usa el que ya tenga en su cache)
                    AppRegistry.App app = reg.appFor(pkg);
                    if (app != null && app.icon != null) {
                        o.put("icon", app.icon);
                    }
                    arr.put(o);
                } catch (Exception ignored) {
                    // una notificación rara no rompe el resto
                }
            }
            out.put("enabled", true);
            out.put("notifications", arr);
        } catch (Exception e) {
            try {
                out.put("enabled", true);
                out.put("notifications", new JSONArray());
                out.put("error", String.valueOf(e));
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    /** Descarta una notificación por key. */
    public static boolean dismiss(String key) {
        AgentNotificationListener l = sInstance;
        if (l == null || key == null || key.isEmpty()) {
            return false;
        }
        try {
            l.cancelNotification(key);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** Descarta todas las descartables. */
    public static boolean clearAll() {
        AgentNotificationListener l = sInstance;
        if (l == null) {
            return false;
        }
        try {
            l.cancelAllNotifications();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static String str(CharSequence cs) {
        if (cs == null) {
            return null;
        }
        String s = cs.toString().trim();
        return s.isEmpty() ? null : s;
    }
}
