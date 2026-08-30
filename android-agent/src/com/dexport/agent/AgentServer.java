package com.dexport.agent;

import android.accessibilityservice.AccessibilityService;
import android.os.Build;
import android.os.Process;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * DexPort Agent v3 — servidor TCP (localhost:8458).
 * ════════════════════════════════════════════════════════════
 * Protocolo de líneas JSON (una conexión por request):
 *   request :  {"type": "<cmd>", "id": "<n>"}\n
 *   response:  {"status": "success", ..., "id": "<n>"}\n
 * La web llega por adb.createSocket("tcp:8458").
 *
 * v3 — IMPOSIBLE CONGELAR EL TELÉFONO:
 *  · pool FIJO de 2 hilos (la v2 usaba newCachedThreadPool ILIMITADO:
 *    con consultas lentas se apilaban hilos y saturaba el proceso).
 *  · TODOS los handlers son instantáneos: leen caches volátiles
 *    precalculados por el hilo de fondo (nunca PackageManager ni
 *    binder pesado en el camino del request).
 *  · rate-guard: >30 requests/seg se rechazan (cliente desbocado).
 *  · ping informa user_id: si el agente quedó corriendo en un perfil
 *    de trabajo (Island), la web lo detecta y avisa.
 *
 * Comandos v1: ping · tasks.get_all · windows.get_all · events.recent ·
 *              foreground.get · action.back|home|recents|notifications|
 *              quick_settings|lock_screen|all_apps
 * Comandos v2+: apps.get · icons.get · launcher.get · notifications.get ·
 *               notification.dismiss · notifications.clear_all
 * v3: apps.get/icons.get devuelven "pending" (el fondo aún está
 *     calculando — la web reintente en ~1.5s).
 */
public class AgentServer extends Thread {

    public static final int PORT = 8458;
    private static final String TAG = "DexPortAgent";
    private static final int MAX_REQ_PER_SEC = 30;

    private final AgentAccessibilityService service;
    private volatile boolean running = false;
    private volatile ServerSocket serverSocket;
    /** v3: pool FIJO — nunca más hilos que esto. */
    private final ExecutorService pool = Executors.newFixedThreadPool(2);

    /** rate-guard: requests en la ventana actual + inicio de ventana. */
    private final AtomicInteger reqWindow = new AtomicInteger(0);
    private final AtomicLong windowStart = new AtomicLong(0);

    public AgentServer(AgentAccessibilityService service) {
        super("DexPortAgentServer");
        this.service = service;
        setDaemon(true);
    }

    public boolean isRunning() {
        return running;
    }

    @Override
    public void run() {
        running = true;
        try {
            // solo localhost: la web llega a través del túnel ADB
            serverSocket = new ServerSocket(PORT, 16, InetAddress.getLoopbackAddress());
            Log.i(TAG, "Agent v3 escuchando en 127.0.0.1:" + PORT);
            while (running) {
                final Socket client = serverSocket.accept();
                try {
                    pool.execute(() -> handle(client));
                } catch (RejectedExecutionException e) {
                    closeQuietly(client);
                }
            }
        } catch (Exception e) {
            if (running) {
                Log.w(TAG, "servidor detenido: " + e);
            }
        } finally {
            closeServerSocket();
        }
    }

    public void shutdown() {
        running = false;
        closeServerSocket();
        pool.shutdown();
        try {
            pool.awaitTermination(1, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    private void closeServerSocket() {
        ServerSocket s = serverSocket;
        serverSocket = null;
        if (s != null) {
            try {
                s.close();
            } catch (Exception ignored) {
            }
        }
    }

    private void closeQuietly(Socket s) {
        if (s != null) {
            try {
                s.close();
            } catch (Exception ignored) {
            }
        }
    }

    // ═════════════════════════════════════════════════════════
    // Protocolo
    // ═════════════════════════════════════════════════════════

    private void handle(Socket client) {
        try {
            client.setSoTimeout(20_000);
            BufferedReader in = new BufferedReader(
                    new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
            String line = in.readLine();
            if (line == null || line.trim().isEmpty()) {
                return;
            }
            if (!rateOk()) {
                write(client, error(null, "rate limit"));
                return;
            }
            JSONObject req;
            try {
                req = new JSONObject(line);
            } catch (Exception e) {
                write(client, error(null, "json inválido"));
                return;
            }
            String cmd = req.optString("type", req.optString("command", ""));
            write(client, dispatch(cmd, req));
        } catch (Exception ignored) {
        } finally {
            closeQuietly(client);
        }
    }

    /** Máx N requests por segundo (ventana deslizante simple). */
    private boolean rateOk() {
        long now = System.currentTimeMillis();
        long start = windowStart.get();
        if (now - start >= 1_000) {
            windowStart.set(now);
            reqWindow.set(1);
            return true;
        }
        return reqWindow.incrementAndGet() <= MAX_REQ_PER_SEC;
    }

    private void write(Socket client, JSONObject res) {
        try {
            byte[] payload = (res.toString() + "\n").getBytes(StandardCharsets.UTF_8);
            OutputStream out = client.getOutputStream();
            out.write(payload);
            out.flush();
        } catch (Exception ignored) {
        }
    }

    private JSONObject dispatch(String cmd, JSONObject req) {
        JSONObject res = new JSONObject();
        String id = req.optString("id", "");
        try {
            res.put("id", id);
            res.put("status", "success");
            switch (cmd == null ? "" : cmd) {
                case "ping": {
                    res.put("service", "DexPort Agent");
                    res.put("version", 3);
                    res.put("sdk", Build.VERSION.SDK_INT);
                    res.put("android", Build.VERSION.RELEASE);
                    res.put("device", Build.MANUFACTURER + " " + Build.MODEL);
                    res.put("multi_display", Build.VERSION.SDK_INT >= 33);
                    res.put("notifications", AgentNotificationListener.isConnected());
                    // v3: perfil en el que corre (0 = principal). Si la app
                    // quedó duplicada en un perfil de trabajo (Island) la
                    // web lo ve y la reinstala limpia.
                    res.put("user_id", Process.myUid() / 100_000);
                    break;
                }
                case "apps.get": {
                    JSONObject state = AppRegistry.get(service).appsStateJson();
                    res.put("apps", state.optJSONArray("apps"));
                    res.put("pending", state.optBoolean("pending", false));
                    break;
                }
                case "icons.get": {
                    List<String> pkgs = new ArrayList<>();
                    JSONArray arr = req.optJSONArray("packages");
                    if (arr != null) {
                        for (int i = 0; i < arr.length() && i < 16; i++) {
                            String p = arr.optString(i, "");
                            if (!p.isEmpty()) {
                                pkgs.add(p);
                            }
                        }
                    }
                    JSONObject icons = AppRegistry.get(service).iconsStateJson(pkgs);
                    res.put("icons", icons.optJSONArray("icons"));
                    res.put("pending", icons.optJSONArray("pending"));
                    break;
                }
                case "launcher.get": {
                    res.put("launcher", AppRegistry.get(service).launcherStateJson());
                    break;
                }
                case "notifications.get": {
                    res.put("notifications", AgentNotificationListener.snapshotJson(
                            AgentNotificationListener.getInstance()));
                    break;
                }
                case "notification.dismiss": {
                    String key = req.optString("key", "");
                    boolean ok = AgentNotificationListener.dismiss(
                            AgentNotificationListener.getInstance(), key);
                    res.put("performed", ok);
                    if (!ok) {
                        res.put("status", "error");
                        res.put("error", "no se pudo descartar (¿listener activo?)");
                    }
                    break;
                }
                case "notifications.clear_all": {
                    boolean ok = AgentNotificationListener.clearAll(
                            AgentNotificationListener.getInstance());
                    res.put("performed", ok);
                    break;
                }
                case "tasks.get_all": {
                    res.put("tasks", service.tasksJson());
                    break;
                }
                case "windows.get_all": {
                    res.put("windows", service.windowsJson());
                    break;
                }
                case "events.recent": {
                    res.put("events", service.eventsJson());
                    break;
                }
                case "foreground.get": {
                    res.put("foreground", service.foregroundJson());
                    break;
                }
                case "action.back": {
                    res.put("performed", service.performGlobal(
                            AccessibilityService.GLOBAL_ACTION_BACK));
                    break;
                }
                case "action.home": {
                    res.put("performed", service.performGlobal(
                            AccessibilityService.GLOBAL_ACTION_HOME));
                    break;
                }
                case "action.recents": {
                    res.put("performed", service.performGlobal(
                            AccessibilityService.GLOBAL_ACTION_RECENTS));
                    break;
                }
                case "action.notifications": {
                    res.put("performed", service.performGlobal(
                            AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS));
                    break;
                }
                case "action.quick_settings": {
                    res.put("performed", service.performGlobal(
                            AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS));
                    break;
                }
                case "action.lock_screen": {
                    res.put("performed", service.performGlobal(
                            AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN));
                    break;
                }
                case "action.all_apps": {
                    res.put("performed", service.performGlobal(
                            AccessibilityService.GLOBAL_ACTION_ACCESSIBILITY_ALL_APPS));
                    break;
                }
                default:
                    res.put("status", "error");
                    res.put("error", "comando desconocido: " + cmd);
            }
        } catch (Exception e) {
            try {
                res.put("status", "error");
                res.put("error", String.valueOf(e));
            } catch (Exception ignored) {
            }
        }
        return res;
    }

    private static JSONObject error(String id, String msg) {
        JSONObject o = new JSONObject();
        try {
            o.put("id", id == null ? "" : id);
            o.put("status", "error");
            o.put("error", msg);
        } catch (Exception ignored) {
        }
        return o;
    }
}
