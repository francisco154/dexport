package com.dexport.agent;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * DexPort Agent v2 — registro global de apps.
 * ════════════════════════════════════════════════════════════
 * Lo que ADB no puede dar (o da mal) sobre las apps instaladas:
 *
 *   · ETIQUETAS REALES  — PackageManager.getApplicationLabel / loadLabel
 *     (la web ya no necesita su diccionario de nombres populares)
 *   · COMPONENTE EXACTO — la activity LAUNCHER de cada app, para
 *     `am start -n` directo (sin monkey ni resolve-activity)
 *   · ÍCONOS REALES     — el drawable del launcher comprimido a PNG
 *     (64px) y servido como base64 por lotes (`icons.get`)
 *   · LAUNCHER PREDETERMINADO — resolveActivity(HOME): el mismo sitio
 *     al que siempre debe volver el botón HOME de la web
 *
 * El cache es perezoso y compartido: el servidor TCP y el listener de
 * notificaciones piden iconos al mismo mapa (las notificaciones muestran
 * el ícono de la app que las emitió).
 */
public final class AppRegistry {

    /** Entrada de una app lanzable (lo que aparece en el app drawer). */
    public static final class App {
        public final String pkg;
        public String label = "";
        /** "pkg/pkg.Activity" — componente LAUNCHER exacto */
        public String component = "";
        public boolean system = false;
        /** PNG base64 de 64px (null hasta que alguien lo pida) */
        public volatile String icon;
        public volatile long iconAt = 0; // cuándo se generó (cache)

        App(String pkg) {
            this.pkg = pkg;
        }
    }

    private static final int ICON_PX = 64;
    /** regenerar el icono si se pidió hace más de 24h (apps actualizadas) */
    private static final long ICON_TTL_MS = 24L * 60 * 60 * 1000;

    private static volatile AppRegistry sInstance;

    private final PackageManager pm;
    private final Map<String, App> apps = new HashMap<>();
    private volatile long lastRefresh = 0;
    private volatile boolean refreshing = false;

    private String defaultLauncher = null;
    private JSONArray launchersJson = null;

    private AppRegistry(Context ctx) {
        this.pm = ctx.getApplicationContext().getPackageManager();
    }

    public static AppRegistry get(Context ctx) {
        AppRegistry r = sInstance;
        if (r == null) {
            synchronized (AppRegistry.class) {
                r = sInstance;
                if (r == null) {
                    r = new AppRegistry(ctx);
                    sInstance = r;
                }
            }
        }
        return r;
    }

    // ═════════════════════════════════════════════════════════
    // Enumeración (apps lanzables + launchers HOME)
    // ═════════════════════════════════════════════════════════

    /**
     * Refresca el mapa de apps lanzables. Debounced: si se llamó hace
     * menos de 3s no repite (la web pide apps.get varias veces seguidas
     * al reconectarse). Todas las mutaciones/lecturas del mapa usan el
     * MISMO monitor (`apps`) para evitar ConcurrentModificationException
     * entre el hilo del servidor y los lotes de iconos.
     */
    private void refresh() {
        long now = System.currentTimeMillis();
        if (refreshing || now - lastRefresh < 3_000) {
            return;
        }
        refreshing = true;
        try {
            Intent launcher = new Intent(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> ris = pm.queryIntentActivities(launcher, 0);
            Set<String> seen = new HashSet<>();
            synchronized (apps) {
                for (ResolveInfo ri : ris) {
                    if (ri.activityInfo == null || ri.activityInfo.packageName == null) {
                        continue;
                    }
                    String pkg = ri.activityInfo.packageName;
                    if (!seen.add(pkg)) {
                        continue; // una entrada por app (primera activity lanzable)
                    }
                    App app = apps.get(pkg);
                    if (app == null) {
                        app = new App(pkg);
                        apps.put(pkg, app);
                    }
                    try {
                        CharSequence l = ri.loadLabel(pm);
                        app.label = l == null ? pkg : l.toString();
                    } catch (Exception e) {
                        app.label = pkg;
                    }
                    app.component = pkg + "/" + ri.activityInfo.name;
                    try {
                        ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
                        app.system = (ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
                    } catch (Exception e) {
                        app.system = false;
                    }
                }
            }
            lastRefresh = now;
        } finally {
            refreshing = false;
        }
    }

    /** apps.get — etiquetas y componentes reales, SIN iconos (payload chico). */
    public JSONArray appsJson() {
        refresh();
        synchronized (apps) {
            JSONArray out = new JSONArray();
            for (App a : apps.values()) {
                try {
                    JSONObject o = new JSONObject();
                    o.put("package_name", a.pkg);
                    o.put("label", a.label);
                    o.put("component", a.component);
                    o.put("system", a.system);
                    out.put(o);
                } catch (Exception ignored) {
                }
            }
            return out;
        }
    }

    /**
     * icons.get — lote de iconos PNG base64 para los paquetes pedidos
     * (la web pide de a 8-12). Los que no existen se omiten.
     */
    public JSONArray iconsJson(List<String> pkgs) {
        JSONArray out = new JSONArray();
        if (pkgs == null) {
            return out;
        }
        long now = System.currentTimeMillis();
        for (String pkg : pkgs) {
            if (pkg == null || pkg.isEmpty()) {
                continue;
            }
            try {
                App a;
                synchronized (apps) {
                    a = apps.get(pkg);
                }
                if (a == null) {
                    // app sin launch activity (p.ej. un servicio que notifica)
                    a = ensureEntry(pkg);
                }
                if (a.icon != null && now - a.iconAt < ICON_TTL_MS) {
                    JSONObject o = new JSONObject();
                    o.put("package_name", pkg);
                    o.put("icon", a.icon);
                    out.put(o);
                    continue;
                }
                String b64 = renderIcon(pkg);
                if (b64 != null) {
                    a.icon = b64;
                    a.iconAt = now;
                    JSONObject o = new JSONObject();
                    o.put("package_name", pkg);
                    o.put("icon", b64);
                    out.put(o);
                }
            } catch (Exception ignored) {
                // icono de esta app falló → se omite, el resto del lote sigue
            }
        }
        return out;
    }

    /** Entrada mínima (solo etiqueta) para apps sin activity lanzable. */
    private App ensureEntry(String pkg) {
        synchronized (apps) {
            App a = apps.get(pkg);
            if (a != null) {
                return a;
            }
            a = new App(pkg);
            try {
                CharSequence l = pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0));
                a.label = l == null ? pkg : l.toString();
            } catch (Exception e) {
                a.label = pkg;
            }
            apps.put(pkg, a);
            return a;
        }
    }

    /** Etiqueta de una app (para las notificaciones). */
    public String labelOf(String pkg) {
        if (pkg == null) {
            return "";
        }
        App a;
        synchronized (apps) {
            a = apps.get(pkg);
        }
        if (a != null && !a.label.isEmpty()) {
            return a.label;
        }
        return ensureEntry(pkg).label;
    }

    /**
     * Entrada del registro para un paquete (creándola si no existe).
     * Usado por el listener de notificaciones para adjuntar el ícono
     * ya cacheado de la app emisora.
     */
    public App appFor(String pkg) {
        if (pkg == null) {
            return null;
        }
        App a;
        synchronized (apps) {
            a = apps.get(pkg);
        }
        return a != null ? a : ensureEntry(pkg);
    }

    // ═════════════════════════════════════════════════════════
    // Iconos (drawable → bitmap 64px → PNG → base64)
    // ═════════════════════════════════════════════════════════

    private String renderIcon(String pkg) {
        Drawable d = null;
        try {
            d = pm.getApplicationIcon(pkg);
        } catch (Exception e) {
            return null;
        }
        if (d == null) {
            return null;
        }
        try {
            Bitmap src;
            if (d instanceof BitmapDrawable) {
                Bitmap b = ((BitmapDrawable) d).getBitmap();
                if (b == null) {
                    return null;
                }
                src = b;
            } else {
                int w = Math.max(1, d.getIntrinsicWidth());
                int h = Math.max(1, d.getIntrinsicHeight());
                // adaptive icons a veces reportan 108dp — escalar igual
                src = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                Canvas c = new Canvas(src);
                d.setBounds(0, 0, w, h);
                d.draw(c);
            }
            Bitmap out = src;
            if (src.getWidth() != ICON_PX || src.getHeight() != ICON_PX) {
                // mantener aspecto dentro de ICON_PX
                double scale = Math.min(
                        ICON_PX / (double) Math.max(1, src.getWidth()),
                        ICON_PX / (double) Math.max(1, src.getHeight()));
                int nw = Math.max(1, (int) Math.round(src.getWidth() * scale));
                int nh = Math.max(1, (int) Math.round(src.getHeight() * scale));
                out = Bitmap.createScaledBitmap(src, nw, nh, true);
            }
            ByteArrayOutputStream bos = new ByteArrayOutputStream(12 * 1024);
            out.compress(Bitmap.CompressFormat.PNG, 100, bos);
            return Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        } finally {
            // Drawable/Bitmap nativos: nada que liberar manualmente
        }
    }

    // ═════════════════════════════════════════════════════════
    // Launcher predefinido (HOME determinista)
    // ═════════════════════════════════════════════════════════

    /**
     * launcher.get — el launcher PREDETERMINADO del teléfono (el que el
     * sistema resuelve para ACTION_MAIN/CATEGORY_HOME) + todos los HOME
     * instalados. La web usa default.component para que su botón HOME
     * lleve SIEMPRE al mismo sitio, pase lo que pase.
     */
    public JSONObject launcherJson() {
        JSONObject out = new JSONObject();
        try {
            // ── predefinido ──
            if (defaultLauncher == null) {
                Intent home = new Intent(Intent.ACTION_MAIN)
                        .addCategory(Intent.CATEGORY_HOME);
                ResolveInfo ri = pm.resolveActivity(home,
                        PackageManager.MATCH_DEFAULT_ONLY);
                if (ri != null && ri.activityInfo != null
                        && ri.activityInfo.packageName != null) {
                    defaultLauncher = ri.activityInfo.packageName
                            + "/" + ri.activityInfo.name;
                }
            }
            JSONObject def = new JSONObject();
            if (defaultLauncher != null) {
                String pkg = defaultLauncher.split("/")[0];
                def.put("component", defaultLauncher);
                def.put("package_name", pkg);
                def.put("label", labelOf(pkg));
            }
            out.put("default", def);

            // ── todos los HOME instalados ──
            if (launchersJson == null) {
                Intent home = new Intent(Intent.ACTION_MAIN)
                        .addCategory(Intent.CATEGORY_HOME);
                List<ResolveInfo> ris = pm.queryIntentActivities(home, 0);
                JSONArray arr = new JSONArray();
                for (ResolveInfo ri : ris) {
                    if (ri.activityInfo == null || ri.activityInfo.packageName == null) {
                        continue;
                    }
                    String pkg = ri.activityInfo.packageName;
                    JSONObject o = new JSONObject();
                    o.put("component", pkg + "/" + ri.activityInfo.name);
                    o.put("package_name", pkg);
                    try {
                        CharSequence l = ri.loadLabel(pm);
                        o.put("label", l == null ? pkg : l.toString());
                    } catch (Exception e) {
                        o.put("label", pkg);
                    }
                    o.put("is_default", defaultLauncher != null
                            && defaultLauncher.equals(pkg + "/" + ri.activityInfo.name));
                    arr.put(o);
                }
                launchersJson = arr;
            }
            out.put("launchers", launchersJson);
        } catch (Exception ignored) {
        }
        return out;
    }

    /** Invalida el cache de launchers (p.ej. tras cambiar el predefinido). */
    public void invalidateLaunchers() {
        defaultLauncher = null;
        launchersJson = null;
    }
}
