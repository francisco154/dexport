package com.dexport.agent;

import android.app.Notification;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * DexPort Agent v3 — espejo de NOTIFICACIONES (RECONSTRUIDO).
 * ════════════════════════════════════════════════════════════
 * La v2 llamaba getActiveNotifications() (binder al
 * NotificationManager) y getApplicationLabel/getApplicationInfo por
 * CADA notificación en CADA consulta de la web (cada 5s) — todo eso
 * en los hilos del servidor.
 *
 * v3 mantiene un snapshot VIVO en un ConcurrentHashMap que actualizan
 * los propios callbacks del sistema (onNotificationPosted/Removed) y
 * una única llamada inicial al conectar. La consulta de la web es
 * lectura de memoria + JSON — cero binder, cero PackageManager.
 *
 *   · notifications.get    → lista viva: app, ícono (cache), título,
 *                            texto, hora, ongoing, descartable
 *   · notification.dismiss → descartar desde la web
 *   · notifications.clear_all → limpiar las descartables
 */
public class AgentNotificationListener extends NotificationListenerService {

    /** Máximo de notificaciones en el snapshot (las más recientes). */
    private static final int MAX = 50;

    private static volatile AgentNotificationListener sInstance;

    /** Snapshot vivo: key → notificación. */
    private final Map<String, StatusBarNotification> active =
            new ConcurrentHashMap<>(32);

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
        // única enumeración completa: al conectar
        try {
            StatusBarNotification[] sbns = getActiveNotifications();
            if (sbns != null) {
                for (StatusBarNotification sbn : sbns) {
                    if (sbn != null) {
                        active.put(sbn.getKey(), sbn);
                    }
                }
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onListenerDisconnected() {
        sInstance = null;
        active.clear();
        super.onListenerDisconnected();
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (sbn == null) {
            return;
        }
        active.put(sbn.getKey(), sbn);
        trim();
        // v3: si es una app sin entrada en el registro, pedir label+ícono
        // EN EL FONDO (para el centro de notificaciones de la web)
        try {
            AppRegistry.get(this).touch(sbn.getPackageName());
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        if (sbn == null) {
            return;
        }
        active.remove(sbn.getKey());
    }

    private void trim() {
        while (active.size() > MAX + 16) {
            // podar la más vieja
            String oldestKey = null;
            long oldest = Long.MAX_VALUE;
            for (Map.Entry<String, StatusBarNotification> e : active.entrySet()) {
                StatusBarNotification v = e.getValue();
                long t = v == null ? 0 : v.getPostTime();
                if (t < oldest) {
                    oldest = t;
                    oldestKey = e.getKey();
                }
            }
            if (oldestKey == null) {
                return;
            }
            active.remove(oldestKey);
        }
    }

    // ── snapshot para el AgentServer (instantáneo) ────────────

    /**
     * Lista de notificaciones activas (la más reciente primero).
     * Sin permiso → lista vacía con enabled=false (la web ofrece
     * activarlo). CERO binder: memoria + JSON.
     */
    public static JSONObject snapshotJson(AgentNotificationListener l) {
        JSONObject out = new JSONObject();
        if (l == null) {
            try {
                out.put("enabled", false);
                out.put("notifications", new JSONArray());
            } catch (Exception ignored) {
            }
            return out;
        }
        try {
            List<StatusBarNotification> sbns = new ArrayList<>(l.active.values());
            sbns.sort(new Comparator<StatusBarNotification>() {
                @Override
                public int compare(StatusBarNotification a, StatusBarNotification b) {
                    long ta = a == null ? 0 : a.getPostTime();
                    long tb = b == null ? 0 : b.getPostTime();
                    return Long.compare(tb, ta); // nuevas primero
                }
            });
            AppRegistry reg = l.registryOrNull();
            JSONArray arr = new JSONArray();
            int n = 0;
            for (StatusBarNotification sbn : sbns) {
                if (sbn == null || sbn.getNotification() == null || n >= MAX) {
                    continue;
                }
                n++;
                try {
                    Notification notif = sbn.getNotification();
                    String title = str(notif.extras.getCharSequence(Notification.EXTRA_TITLE));
                    String text = str(notif.extras.getCharSequence(Notification.EXTRA_TEXT));
                    if (text == null) {
                        text = str(notif.extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
                    }
                    String pkg = sbn.getPackageName();
                    JSONObject o = new JSONObject();
                    o.put("key", sbn.getKey());
                    o.put("package_name", pkg);
                    String label = reg == null ? "" : reg.labelOf(pkg);
                    o.put("label", label.isEmpty() ? pkg : label);
                    if (title != null) {
                        o.put("title", title);
                    }
                    if (text != null) {
                        o.put("text", text);
                    }
                    o.put("when", notif.when > 0 ? notif.when : sbn.getPostTime());
                    o.put("posted_at", sbn.getPostTime());
                    o.put("ongoing", sbn.isOngoing());
                    o.put("clearable", sbn.isClearable());
                    // ícono SOLO del cache (nunca renderizar aquí)
                    if (reg != null) {
                        String icon = reg.iconOf(pkg);
                        if (icon != null) {
                            o.put("icon", icon);
                        }
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

    private AppRegistry registryOrNull() {
        try {
            return AppRegistry.get(this);
        } catch (Exception e) {
            return null;
        }
    }

    /** Descarta una notificación por key. */
    public static boolean dismiss(AgentNotificationListener l, String key) {
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
    public static boolean clearAll(AgentNotificationListener l) {
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
