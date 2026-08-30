package com.dexport.agent;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Intent;
import android.os.Build;
import android.util.SparseArray;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * DexPort Agent v3 — servicio de accesibilidad RECONSTRUIDO.
 * ════════════════════════════════════════════════════════════
 * La v2 congelaba el teléfono por dos motivos que aquí NO existen:
 *
 *  1. canRetrieveWindowContent=true → el sistema prefetchaba el árbol
 *     de nodos de TODAS las apps en cada evento (impuesto sobre cada
 *     hilo UI del sistema). v3: false — solo metadatos de eventos.
 *  2. w.getRoot() por ventana en cada consulta (llamada binder al hilo
 *     UI de cada app, de milisegundos a SEGUNDOS si la app estaba
 *     ocupada). v3: CERO getRoot — el paquete de cada ventana se deduce
 *     del mapa windowId→paquete que alimentan los propios eventos
 *     TYPE_WINDOW_STATE_CHANGED (baratos: llegan de todas formas).
 *
 * El handler de eventos es O(1) en alocaciones y NO toca PackageManager,
 * ni binder, ni locks compartidos con el servidor: imposible bloquear el
 * input aunque el resto del agente esté saturado.
 *
 * El servidor arranca en onServiceConnected() y muere en onUnbind().
 */
public class AgentAccessibilityService extends AccessibilityService {

    /** Entrada del historial de eventos (cambio de ventana al frente). */
    private static class Ev {
        final long at;
        final String pkg;
        final String cls;
        Ev(long at, String pkg, String cls) {
            this.at = at;
            this.pkg = pkg;
            this.cls = cls;
        }
    }

    private static volatile AgentAccessibilityService sInstance;
    private volatile AgentServer server;

    /** Historial circular de últimos eventos WINDOW_STATE_CHANGED. */
    private final Deque<Ev> recent = new ArrayDeque<>();

    /**
     * v3: windowId → paquete (alimentado por los propios eventos, sin
     * binder). Copy-on-write: el escritor (hilo principal) copia el mapa
     * entero — los lectores (hilos del servidor) nunca ven estado a medias
     * y NADIE toma un lock. ~64 entradas sobra para teléfono + display
     * virtual + ventanas freeform.
     */
    private volatile Map<Integer, String> windowPkg = new ConcurrentHashMap<>();

    public static AgentAccessibilityService getInstance() {
        return sInstance;
    }

    public static boolean isServiceRunning() {
        AgentAccessibilityService s = sInstance;
        return s != null && s.server != null && s.server.isRunning();
    }

    // ═════════════════════════════════════════════════════════
    // Ciclo de vida
    // ═════════════════════════════════════════════════════════

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        sInstance = this;
        // garantizar el flag de ventanas interactivas (también en el XML).
        // OJO: NADA de flags de touch-exploration ni filter-key-events —
        // esos son los que rompen el táctil/teclado del teléfono.
        try {
            AccessibilityServiceInfo info = getServiceInfo();
            if (info != null) {
                info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
                setServiceInfo(info);
            }
        } catch (Exception ignored) {
        }

        if (server == null) {
            server = new AgentServer(this);
            server.start();
        }

        // v3: precalentar el registro en el hilo de fondo (apps, labels,
        // launcher) para que las primeras consultas de la web ya respondan
        // al instante con datos calientes.
        AppRegistry.get(this).prewarm();
    }

    @Override
    public boolean onUnbind(Intent intent) {
        // el usuario (o DexPort) desactivó el servicio → apagar el puente
        stopServer();
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        stopServer();
        super.onDestroy();
    }

    private void stopServer() {
        AgentServer s = server;
        server = null;
        if (s != null) {
            s.shutdown();
        }
        AppRegistry.shutdownShared();
        if (sInstance == this) {
            sInstance = null;
        }
    }

    // ═════════════════════════════════════════════════════════
    // Eventos — ultraligero (hilo principal)
    // ═════════════════════════════════════════════════════════

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null) {
            return;
        }
        if (event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            return;
        }
        String pkg = safe(event.getPackageName());
        if (pkg == null || pkg.isEmpty() || "com.dexport.agent".equals(pkg)) {
            return;
        }
        String cls = safe(event.getClassName());
        long now = System.currentTimeMillis();

        // 1) historial (para deducir la Activity de cada paquete)
        synchronized (recent) {
            recent.addLast(new Ev(now, pkg, cls == null ? "" : cls));
            while (recent.size() > 200) {
                recent.removeFirst();
            }
        }

        // 2) mapa windowId→pkg — copy-on-write, sin locks de lectura
        int windowId = event.getWindowId();
        if (windowId > 0) {
            Map<Integer, String> next = new ConcurrentHashMap<>(windowPkg);
            next.put(windowId, pkg);
            while (next.size() > 64) {
                // podar la primera entrada (la más vieja en la práctica:
                // los ids crecen monótonamente)
                int oldest = Integer.MAX_VALUE;
                for (Integer k : next.keySet()) {
                    if (k != null && k < oldest) {
                        oldest = k;
                    }
                }
                if (oldest == Integer.MAX_VALUE) {
                    break;
                }
                next.remove(oldest);
            }
            windowPkg = next;
        }
    }

    @Override
    public void onInterrupt() {
        /* nada — este servicio no da feedback */
    }

    // ═════════════════════════════════════════════════════════
    // Snapshot JSON para el AgentServer
    // (v3: SIN getRoot() — todo son getters locales de la lista de
    //  ventanas + el mapa windowId→pkg. Una llamada binder TOTAL.)
    // ═════════════════════════════════════════════════════════

    /** Tareas (apps abiertas): ventanas TYPE_APPLICATION de todos los displays. */
    public JSONArray tasksJson() throws Exception {
        JSONArray out = new JSONArray();
        if (Build.VERSION.SDK_INT >= 33) {
            SparseArray<List<AccessibilityWindowInfo>> all = getWindowsOnAllDisplays();
            for (int i = 0; i < all.size(); i++) {
                appendAppWindows(out, all.valueAt(i), all.keyAt(i));
            }
        } else {
            appendAppWindows(out, getWindows(), -1);
        }
        return out;
    }

    /** Todas las ventanas interactivas (incluye teclado, sistema, popups). */
    public JSONArray windowsJson() throws Exception {
        JSONArray out = new JSONArray();
        if (Build.VERSION.SDK_INT >= 33) {
            SparseArray<List<AccessibilityWindowInfo>> all = getWindowsOnAllDisplays();
            for (int i = 0; i < all.size(); i++) {
                appendWindows(out, all.valueAt(i), all.keyAt(i), false);
            }
        } else {
            appendWindows(out, getWindows(), -1, false);
        }
        return out;
    }

    private void appendAppWindows(JSONArray out, List<AccessibilityWindowInfo> ws, int displayId)
            throws Exception {
        appendWindows(out, ws, displayId, true);
    }

    private void appendWindows(
            JSONArray out,
            List<AccessibilityWindowInfo> ws,
            int displayId,
            boolean appsOnly
    ) throws Exception {
        if (ws == null) {
            return;
        }
        for (AccessibilityWindowInfo w : ws) {
            if (w == null) {
                continue;
            }
            int type = w.getType();
            if (appsOnly && type != AccessibilityWindowInfo.TYPE_APPLICATION) {
                continue;
            }
            // v3: paquete por el mapa de eventos (sin getRoot)
            String pkg = windowPkg.get(w.getId());
            if (pkg == null || pkg.isEmpty()) {
                // ventana abierta antes de que el agente se conectara —
                // la web la cruza con dumpsys (fuente multi-v8)
                continue;
            }
            JSONObject o = new JSONObject();
            o.put("window_id", w.getId());
            o.put("package_name", pkg);
            String title = safe(w.getTitle());
            o.put("title", title == null ? "" : title);
            o.put("type", typeName(type));
            o.put("display_id", displayId);
            o.put("is_active", w.isActive());
            o.put("is_focused", w.isFocused());
            o.put("layer", w.getLayer());
            String act = componentFor(pkg);
            o.put("activity", act == null ? "" : act);
            out.put(o);
        }
    }

    /** Ventana activa global (la que el usuario está usando ahora). */
    public JSONObject foregroundJson() throws Exception {
        JSONObject out = new JSONObject();
        List<AccessibilityWindowInfo> ws =
                Build.VERSION.SDK_INT >= 33 ? flattenAllDisplays(out) : getWindows();
        AccessibilityWindowInfo active = null;
        if (ws != null) {
            for (AccessibilityWindowInfo w : ws) {
                if (w != null && w.isActive() && w.getType() == AccessibilityWindowInfo.TYPE_APPLICATION) {
                    active = w;
                    break;
                }
            }
        }
        if (active == null) {
            out.put("package_name", "");
            return out;
        }
        String pkg = windowPkg.get(active.getId());
        out.put("package_name", pkg == null ? "" : pkg);
        String act = pkg == null ? null : componentFor(pkg);
        out.put("activity", act == null ? "" : act);
        String title = safe(active.getTitle());
        out.put("title", title == null ? "" : title);
        return out;
    }

    /**
     * API 33+: añade al objeto `out` el mapa display→nº de ventanas y
     * devuelve la lista plana de todas las ventanas de todos los displays.
     */
    private List<AccessibilityWindowInfo> flattenAllDisplays(JSONObject out) throws Exception {
        List<AccessibilityWindowInfo> flat = new ArrayList<>();
        SparseArray<List<AccessibilityWindowInfo>> all = getWindowsOnAllDisplays();
        JSONObject displays = new JSONObject();
        for (int i = 0; i < all.size(); i++) {
            List<AccessibilityWindowInfo> list = all.valueAt(i);
            flat.addAll(list == null ? new ArrayList<>() : list);
            displays.put(String.valueOf(all.keyAt(i)), list == null ? 0 : list.size());
        }
        out.put("displays", displays);
        return flat;
    }

    /** Últimos eventos (lo que quedó al frente, en orden). */
    public JSONArray eventsJson() throws Exception {
        JSONArray out = new JSONArray();
        List<Ev> copy = new ArrayList<>();
        synchronized (recent) {
            copy.addAll(recent);
        }
        // del más nuevo al más viejo
        for (int i = copy.size() - 1; i >= 0 && out.length() < 60; i--) {
            Ev e = copy.get(i);
            JSONObject o = new JSONObject();
            o.put("at", e.at);
            o.put("package_name", e.pkg);
            o.put("class_name", e.cls);
            out.put(o);
        }
        return out;
    }

    // ═════════════════════════════════════════════════════════
    // Acciones globales
    // ═════════════════════════════════════════════════════════

    /** Ejecuta una acción global; true si el sistema la aceptó. */
    public boolean performGlobal(int action) {
        try {
            return performGlobalAction(action);
        } catch (Exception e) {
            return false;
        }
    }

    // ═════════════════════════════════════════════════════════
    // Utilidades
    // ═════════════════════════════════════════════════════════

    /**
     * Deduce el componente "pkg/.Activity" de un paquete a partir del
     * último evento WINDOW_STATE_CHANGED cuya clase parezca una Activity.
     */
    private String componentFor(String pkg) {
        if (pkg == null || pkg.isEmpty()) {
            return null;
        }
        List<Ev> copy = new ArrayList<>();
        synchronized (recent) {
            copy.addAll(recent);
        }
        for (int i = copy.size() - 1; i >= 0; i--) {
            Ev e = copy.get(i);
            if (!pkg.equals(e.pkg)) {
                continue;
            }
            String cls = e.cls;
            if (cls == null || cls.isEmpty()) {
                continue;
            }
            if (cls.startsWith("android.") || cls.startsWith("androidx.")
                    || cls.startsWith("java.") || cls.startsWith("com.android.internal.")) {
                continue;
            }
            if (cls.equals(pkg) || cls.startsWith(pkg + ".")) {
                return pkg + "/" + cls;
            }
            // clase de otro paquete (p.ej. actividad de biblioteca) → úsala igual
            if (cls.indexOf('.') > 0 && Character.isUpperCase(cls.charAt(cls.lastIndexOf('.') + 1))) {
                return pkg + "/" + cls;
            }
        }
        return null;
    }

    private static String safe(CharSequence cs) {
        if (cs == null) {
            return null;
        }
        String s = cs.toString().trim();
        return s.isEmpty() ? null : s;
    }

    private static String typeName(int type) {
        switch (type) {
            case AccessibilityWindowInfo.TYPE_APPLICATION:
                return "application";
            case AccessibilityWindowInfo.TYPE_INPUT_METHOD:
                return "input_method";
            case AccessibilityWindowInfo.TYPE_SYSTEM:
                return "system";
            case AccessibilityWindowInfo.TYPE_MAGNIFICATION_OVERLAY:
                return "magnification_overlay";
            default:
                return "other";
        }
    }
}
