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
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * DexPort Agent v3 — registro global de apps (RECONSTRUIDO).
 * ════════════════════════════════════════════════════════════
 * Por qué la v2 congelaba el teléfono y aquí es imposible:
 *
 *  · La v2 renderizaba los ÍCONOS dentro del hilo del servidor HTTP
 *    (inflar drawable adaptive de 108dp + PNG) mientras compartía un
 *    monitor con el resto → ráfagas de lotes = picos de CPU y colas.
 *  · La v2 enumeraba apps en el hilo del servidor (queryIntentActivities
 *    + loadLabel × N) en cada request.
 *
 *  v3: UN SOLO hilo de fondo de baja prioridad ejecuta TODO lo pesado
 *  (enumerar, etiquetas, íconos, launcher). Las consultas del servidor
 *  son lecturas INSTANTÁNEAS de caches publicados como volatile —
 *  jamás tocan PackageManager ni hacen trabajo pesado. Sin monitores:
 *  ConcurrentHashMap + publicación volatile.
 *
 * Además: lista COMPLETA — la v2 solo veía lo que Android 11+ deja ver
 * sin declarar <queries>/QUERY_ALL_PACKAGES (manifiesto v3 ya lo declara)
 * y ahora se enumeran por DOS fuentes (queryIntentActivities +
 * getInstalledApplications con getLaunchIntentForPackage).
 */
public final class AppRegistry {

    /** Entrada de una app lanzable (lo que aparece en el app drawer). */
    public static final class App {
        public final String pkg;
        public volatile String label = "";
        /** "pkg/pkg.Activity" — componente LAUNCHER exacto */
        public volatile String component = "";
        public volatile boolean system = false;
        /** PNG base64 de 64px (null hasta que el worker lo generó) */
        public volatile String icon;
        public volatile long iconAt = 0;    // cuándo se generó (TTL)
        public volatile int iconFails = 0;  // renders fallidos → no insistir

        App(String pkg) {
            this.pkg = pkg;
        }
    }

    private static final int ICON_PX = 64;
    private static final long ICON_TTL_MS = 24L * 60 * 60 * 1000;
    private static final long APPS_TTL_MS = 60_000;
    private static final long LAUNCHER_TTL_MS = 60_000;
    private static final int MAX_ICON_FAILS = 3;

    private static volatile AppRegistry sInstance;

    private final PackageManager pm;
    /** UNICO hilo de fondo para todo el trabajo pesado (serializado). */
    private final ExecutorService worker;
    private final LinkedBlockingQueue<String> iconQueue = new LinkedBlockingQueue<>();
    private final Set<String> iconQueued = ConcurrentHashMap.newKeySet();

    /** Estado publicado — solo se lee desde el servidor. */
    private final Map<String, App> apps = new ConcurrentHashMap<>(256);
    private volatile JSONArray appsCache = new JSONArray();
    private volatile long appsCacheAt = 0;
    private volatile boolean appsReady = false;

    private volatile JSONObject launcherCache = null;
    private volatile long launcherCacheAt = 0;

    private static final AtomicLong THREAD_SEQ = new AtomicLong(1);

    private AppRegistry(Context ctx) {
        this.pm = ctx.getApplicationContext().getPackageManager();
        this.worker = Executors.newSingleThreadExecutor(new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "DexPortAgentWorker-" + THREAD_SEQ.getAndIncrement());
                t.setDaemon(true);
                // baja prioridad: nunca competir con el sistema/UI
                t.setPriority(Thread.MIN_PRIORITY + 1);
                return t;
            }
        });
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

    /** Apaga el singleton (al desactivar el servicio). */
    public static void shutdownShared() {
        AppRegistry r = sInstance;
        sInstance = null;
        if (r != null) {
            r.worker.shutdown();
            try {
                r.worker.awaitTermination(300, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private void submit(Runnable job) {
        try {
            worker.execute(job);
        } catch (RejectedExecutionException ignored) {
            // apagando — se descarta
        }
    }

    /** v3: precalentar al conectar el servicio (apps + launcher). */
    public void prewarm() {
        submit(new Runnable() {
            @Override
            public void run() {
                refreshApps();
                refreshLauncher();
                drainIconQueue();
            }
        });
    }

    // ═════════════════════════════════════════════════════════
    // apps.get — instantáneo; refresca en fondo si venció el cache
    // ═════════════════════════════════════════════════════════

    /**
     * Devuelve el cache YA CONSTRUIDO (JSONArray inmutable en la práctica:
     * se publica vía volatile y nadie lo muta después). Si el cache está
     * vacío o vencido, ENCOLA un refresco y devuelve pending=true para que
     * la web reintente en un par de segundos.
     */
    public JSONObject appsStateJson() {
        long now = System.currentTimeMillis();
        boolean stale = now - appsCacheAt > APPS_TTL_MS;
        if (stale) {
            submit(new Runnable() {
                @Override
                public void run() {
                    refreshApps();
                    drainIconQueue();
                }
            });
        }
        JSONObject out = new JSONObject();
        try {
            out.put("apps", appsCache);
            out.put("pending", !appsReady || stale);
        } catch (Exception ignored) {
        }
        return out;
    }

    /** SOLO el hilo de fondo. Doble fuente = lista COMPLETA. */
    private void refreshApps() {
        try {
            Map<String, String> components = new HashMap<>(); // pkg → "pkg/Activity"

            // fuente 1: activities LAUNCHER (con <queries> + QUERY_ALL_PACKAGES
            // devuelve TODAS, no solo las visibles por defecto de Android 11+)
            Intent launcher = new Intent(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> ris = pm.queryIntentActivities(launcher, PackageManager.GET_META_DATA);
            for (ResolveInfo ri : ris) {
                if (ri.activityInfo == null || ri.activityInfo.packageName == null) {
                    continue;
                }
                String pkg = ri.activityInfo.packageName;
                if ("com.dexport.agent".equals(pkg)) {
                    continue;
                }
                String comp = pkg + "/" + ri.activityInfo.name;
                // la primera (mejor match) gana — queryIntentActivities
                // ya ordena por prioridad
                if (!components.containsKey(pkg)) {
                    components.put(pkg, comp);
                }
            }

            // fuente 2: TODAS las apps instaladas con intent de lanzamiento
            // (QUERY_ALL_PACKAGES las hace todas visibles; atrapa las que
            // queryIntentActivities se salta en algunas ROMs/Samsung)
            List<ApplicationInfo> installed = pm.getInstalledApplications(PackageManager.GET_META_DATA);
            for (ApplicationInfo ai : installed) {
                if (ai == null || ai.packageName == null) {
                    continue;
                }
                if ("com.dexport.agent".equals(ai.packageName)) {
                    continue;
                }
                if (components.containsKey(ai.packageName)) {
                    continue;
                }
                try {
                    Intent li = pm.getLaunchIntentForPackage(ai.packageName);
                    if (li != null && li.getComponent() != null) {
                        components.put(ai.packageName,
                                ai.packageName + "/" + li.getComponent().getClassName());
                    }
                } catch (Exception ignored) {
                    // paquete en estado raro → se salta
                }
            }

            // labels + flags (binder por app, pero en el hilo de fondo)
            Set<String> seen = new HashSet<>();
            List<App> ordered = new ArrayList<>(components.size());
            for (Map.Entry<String, String> e : components.entrySet()) {
                String pkg = e.getKey();
                if (!seen.add(pkg)) {
                    continue;
                }
                App app = apps.get(pkg);
                if (app == null) {
                    app = new App(pkg);
                    apps.put(pkg, app);
                }
                app.component = e.getValue();
                try {
                    CharSequence l = pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0));
                    app.label = l == null ? pkg : l.toString();
                } catch (Exception ex) {
                    if (app.label.isEmpty()) {
                        app.label = pkg;
                    }
                }
                try {
                    ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
                    app.system = (ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
                } catch (Exception ex) {
                    app.system = false;
                }
                ordered.add(app);
            }

            Collections.sort(ordered, new Comparator<App>() {
                @Override
                public int compare(App a, App b) {
                    return a.label.compareToIgnoreCase(b.label);
                }
            });

            JSONArray out = new JSONArray();
            for (App a : ordered) {
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
            appsCache = out;
            appsCacheAt = System.currentTimeMillis();
            appsReady = out.length() > 0;
        } catch (Throwable t) {
            // enumeración falló (raro) → se mantiene el cache anterior
        }
    }

    // ═════════════════════════════════════════════════════════
    // icons.get — instantáneo: devuelve listos + pendientes
    // ═════════════════════════════════════════════════════════

    /**
     * NUNCA renderiza aquí. Los paquetes sin ícono van a la cola del
     * worker (serializado, baja prioridad) y se devuelven en "pending"
     * para que la web los vuelva a pedir en ~1.5s.
     *
     * v4 (fix de los íconos que se quedaban a medias): cada paquete
     * encolado AGENDA TAMBIÉN un drenaje del worker. En la v3 el
     * drenaje solo ocurría dentro de prewarm()/appsStateJson() — si el
     * worker estaba tranquilo cuando la web pedía un lote nuevo, los
     * íconos quedaban en la cola PARA SIEMPRE (solo se renderizaban los
     * primeros ~6-12 del arranque). Ahora cada lote se drena solo.
     */
    public JSONObject iconsStateJson(List<String> pkgs) {
        JSONObject out = new JSONObject();
        JSONArray ready = new JSONArray();
        JSONArray pending = new JSONArray();
        boolean scheduled = false;
        if (pkgs != null) {
            long now = System.currentTimeMillis();
            for (String pkg : pkgs) {
                if (pkg == null || pkg.isEmpty()) {
                    continue;
                }
                try {
                    App a = apps.get(pkg);
                    if (a != null && a.icon != null && now - a.iconAt < ICON_TTL_MS) {
                        JSONObject o = new JSONObject();
                        o.put("package_name", pkg);
                        o.put("icon", a.icon);
                        ready.put(o);
                        continue;
                    }
                    if (a != null && a.iconFails >= MAX_ICON_FAILS) {
                        continue; // sin ícono posible → no insistir
                    }
                    if (enqueueIcon(pkg)) {
                        scheduled = true; // hay trabajo nuevo → drenar
                    }
                    pending.put(pkg);
                } catch (Exception ignored) {
                }
            }
        }
        if (scheduled) {
            submit(new Runnable() {
                @Override
                public void run() {
                    drainIconQueue();
                }
            });
        }
        try {
            out.put("icons", ready);
            out.put("pending", pending);
        } catch (Exception ignored) {
        }
        return out;
    }

    /** Encola un ícono; true si era NUEVO (había que renderizarlo). */
    private boolean enqueueIcon(final String pkg) {
        if (iconQueued.add(pkg)) {
            iconQueue.offer(pkg);
            return true;
        }
        return false;
    }

    /** SOLO el hilo de fondo: drena la cola de íconos con respiros. */
    private void drainIconQueue() {
        while (true) {
            final String pkg = iconQueue.poll();
            if (pkg == null) {
                return;
            }
            iconQueued.remove(pkg);
            try {
                App a = apps.get(pkg);
                if (a == null) {
                    a = ensureEntry(pkg); // app sin launcher (notificaciones)
                }
                long now = System.currentTimeMillis();
                if (a.icon != null && now - a.iconAt < ICON_TTL_MS) {
                    continue; // ya lo generó otro pedido
                }
                String b64 = renderIcon(pkg);
                if (b64 != null) {
                    a.icon = b64;
                    a.iconAt = now;
                    a.iconFails = 0;
                } else {
                    a.iconFails++;
                }
            } catch (Throwable ignored) {
            } finally {
                // respiro entre íconos: el worker NUNCA acapara la CPU
                try {
                    Thread.sleep(20);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
    }

    // ═════════════════════════════════════════════════════════
    // Lookups cacheados (notificaciones) — sin binder jamás
    // ═════════════════════════════════════════════════════════

    /** Etiqueta cacheada (para las notificaciones); "" si se desconoce. */
    public String labelOf(String pkg) {
        if (pkg == null) {
            return "";
        }
        App a = apps.get(pkg);
        return a != null && !a.label.isEmpty() ? a.label : "";
    }

    /** Ícono cacheado (para las notificaciones); null si aún no existe. */
    public String iconOf(String pkg) {
        if (pkg == null) {
            return null;
        }
        App a = apps.get(pkg);
        return a != null ? a.icon : null;
    }

    /**
     * v3: una notificación de una app desconocida → encolar label+ícono
     * en el fondo (para el centro de notificaciones). No bloquea a nadie.
     */
    public void touch(final String pkg) {
        if (pkg == null || pkg.isEmpty() || apps.containsKey(pkg)) {
            return;
        }
        submit(new Runnable() {
            @Override
            public void run() {
                App a = ensureEntry(pkg);
                if (a.label.isEmpty()) {
                    a.label = pkg;
                }
                enqueueIcon(pkg);
                drainIconQueue();
            }
        });
    }

    /** SOLO el hilo de fondo: entrada mínima (label) para apps sin launcher. */
    private App ensureEntry(String pkg) {
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

    // ═════════════════════════════════════════════════════════
    // Iconos (drawable → 64px directo → PNG → base64)
    // ═════════════════════════════════════════════════════════

    /**
     * v3: dibuja DIRECTAMENTE a 64×64 — sin el bitmap intermedio a
     * tamaño intrínseco (los adaptive de 108dp en xxxhdpi eran ~324px
     * y era lo caro de la v2). Solo en el hilo de fondo.
     */
    private String renderIcon(String pkg) {
        Drawable d;
        try {
            d = pm.getApplicationIcon(pkg);
        } catch (Exception e) {
            return null;
        }
        if (d == null) {
            return null;
        }
        try {
            Bitmap bmp;
            if (d instanceof BitmapDrawable) {
                Bitmap b = ((BitmapDrawable) d).getBitmap();
                if (b == null) {
                    return null;
                }
                bmp = Bitmap.createScaledBitmap(b, ICON_PX, ICON_PX, true);
            } else {
                bmp = Bitmap.createBitmap(ICON_PX, ICON_PX, Bitmap.Config.ARGB_8888);
                Canvas c = new Canvas(bmp);
                d.setBounds(0, 0, ICON_PX, ICON_PX);
                d.draw(c);
            }
            ByteArrayOutputStream bos = new ByteArrayOutputStream(8 * 1024);
            bmp.compress(Bitmap.CompressFormat.PNG, 100, bos);
            return Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }

    // ═════════════════════════════════════════════════════════
    // Launcher predefinido (HOME determinista)
    // ═════════════════════════════════════════════════════════

    /** Instantáneo; refresca en fondo si venció. */
    public JSONObject launcherStateJson() {
        long now = System.currentTimeMillis();
        if (launcherCache == null || now - launcherCacheAt > LAUNCHER_TTL_MS) {
            submit(new Runnable() {
                @Override
                public void run() {
                    refreshLauncher();
                }
            });
        }
        JSONObject out = launcherCache;
        if (out == null) {
            out = new JSONObject();
            try {
                out.put("default", new JSONObject());
                out.put("launchers", new JSONArray());
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    /** SOLO el hilo de fondo. */
    private void refreshLauncher() {
        try {
            JSONObject out = new JSONObject();

            // ── predefinido ──
            String defaultLauncher = null;
            Intent home = new Intent(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_HOME);
            ResolveInfo ri = pm.resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY);
            if (ri != null && ri.activityInfo != null
                    && ri.activityInfo.packageName != null) {
                defaultLauncher = ri.activityInfo.packageName
                        + "/" + ri.activityInfo.name;
            }
            JSONObject def = new JSONObject();
            if (defaultLauncher != null) {
                String pkg = defaultLauncher.split("/")[0];
                def.put("component", defaultLauncher);
                def.put("package_name", pkg);
                String label = labelOf(pkg);
                def.put("label", label.isEmpty() ? pkg : label);
            }
            out.put("default", def);

            // ── todos los HOME instalados ──
            List<ResolveInfo> ris = pm.queryIntentActivities(home, 0);
            JSONArray arr = new JSONArray();
            for (ResolveInfo r : ris) {
                if (r.activityInfo == null || r.activityInfo.packageName == null) {
                    continue;
                }
                String pkg = r.activityInfo.packageName;
                JSONObject o = new JSONObject();
                o.put("component", pkg + "/" + r.activityInfo.name);
                o.put("package_name", pkg);
                String label = labelOf(pkg);
                if (label.isEmpty()) {
                    try {
                        CharSequence l = r.loadLabel(pm);
                        label = l == null ? pkg : l.toString();
                    } catch (Exception e) {
                        label = pkg;
                    }
                }
                o.put("label", label);
                o.put("is_default", defaultLauncher != null
                        && defaultLauncher.equals(pkg + "/" + r.activityInfo.name));
                arr.put(o);
            }
            out.put("launchers", arr);
            launcherCache = out;
            launcherCacheAt = System.currentTimeMillis();
        } catch (Throwable ignored) {
        }
    }
}
