package com.dexport.agent;

import android.content.Context;
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
 * DexPort Agent v5 — servidor TCP (localhost:8458).
 * ════════════════════════════════════════════════════════════
 * Protocolo de líneas JSON (una conexión por request):
 *   request :  {"type": "<cmd>", "id": "<n>"}\n
 *   response:  {"status": "success", ..., "id": "<n>"}\n
 * La web llega por adb.createSocket("tcp:8458").
 *
 * v5 — PAQUETE ÚNICO + HIBERNACIÓN (sin servicio de accesibilidad):
 *  · `package.get` — TODO lo que la web necesita en UNA respuesta:
 *    apps lanzables + TODOS los íconos + launcher. El agente
 *    construye el paquete en su único hilo de fondo y la llamada
 *    espera (long-poll del lado del agente) hasta que está COMPLETO
 *    → la web hace UNA única solicitud, sin lotes ni reintentos.
 *  · `agent.hibernate` — la web lo envía al recibir el paquete:
 *    el servidor se APAGA (notificación fuera, servicio muerto).
 *    También hiberna solo tras 90 s sin requests (watchdog del
 *    AgentServerService).
 *  · pool FIJO de 3 hilos (1 puede quedar esperando el paquete).
 *  · rate-guard: >30 requests/seg se rechazan.
 *  · ping informa user_id (perfil de trabajo/Island) y version:5.
 *
 * ELIMINADO en v5 (multitarea y navegación = 100 % ADB shell):
 *  tasks.get_all · windows.get_all · events.recent · foreground.get ·
 *  action.back|home|recents|notifications|quick_settings|lock_screen|all_apps
 *
 * Comandos v5: ping · package.get · agent.hibernate ·
 *              notifications.get · notification.dismiss ·
 *              notifications.clear_all · launcher.get · apps.get ·
 *              icons.get (compat)
 */
public class AgentServer extends Thread {

    public static final int PORT = 8458;
    private static final String TAG = "DexPortAgent";
    private static final int MAX_REQ_PER_SEC = 30;

    /** Callback para apagar el servicio cuando la web pide hibernar. */
    public interface Hibernator {
        void hibernateNow();
    }

    private final Context appCtx;
    private final Hibernator hibernator;
    private volatile boolean running = false;
    private volatile ServerSocket serverSocket;
    /** v5: pool FIJO — nunca más hilos que esto. */
    private final ExecutorService pool = Executors.newFixedThreadPool(3);

    /** rate-guard: requests en la ventana actual + inicio de ventana. */
    private final AtomicInteger reqWindow = new AtomicInteger(0);
    private final AtomicLong windowStart = new AtomicLong(0);

    /** v5: último request atendido (watchdog de hibernación). */
    private volatile long lastRequestAt = System.currentTimeMillis();

    public AgentServer(Context appCtx, Hibernator hibernator) {
        super("DexPortAgentServer");
        this.appCtx = appCtx;
        this.hibernator = hibernator;
        setDaemon(true);
    }

    public boolean isRunning() {
        return running;
    }

    /** v5: señal de actividad para el watchdog de hibernación. */
    public void touch() {
        lastRequestAt = System.currentTimeMillis();
    }

    /** v5: ms desde el último request atendido. */
    public long idleFor() {
        return System.currentTimeMillis() - lastRequestAt;
    }

    @Override
    public void run() {
        running = true;
        try {
            // solo localhost: la web llega a través del túnel ADB
            serverSocket = new ServerSocket(PORT, 16, InetAddress.getLoopbackAddress());
            Log.i(TAG, "Agent v5 escuchando en 127.0.0.1:" + PORT);
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
            touch();
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
            // v5: hibernación explícita — dar un respiro para que la
            // respuesta cruce el túnel USB y apagar el puente
            if ("agent.hibernate".equals(cmd) && hibernator != null) {
                try {
                    Thread.sleep(400);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                hibernator.hibernateNow();
            }
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
            // v5: la multitarea y la navegación viven 100 % en ADB
            if (cmd.startsWith("action.")
                    || "tasks.get_all".equals(cmd)
                    || "windows.get_all".equals(cmd)
                    || "events.recent".equals(cmd)
                    || "foreground.get".equals(cmd)) {
                res.put("status", "error");
                res.put("error", "eliminado en v5 — multitarea y navegación 100% por ADB");
                return res;
            }
            switch (cmd == null ? "" : cmd) {
                case "ping": {
                    res.put("service", "DexPort Agent");
                    res.put("version", 5);
                    res.put("sdk", Build.VERSION.SDK_INT);
                    res.put("android", Build.VERSION.RELEASE);
                    res.put("device", Build.MANUFACTURER + " " + Build.MODEL);
                    res.put("multi_display", Build.VERSION.SDK_INT >= 33);
                    res.put("notifications", AgentNotificationListener.isConnected());
                    // v5: este agente entrega un paquete y HIBERNA
                    res.put("hibernates", true);
                    // perfil en el que corre (0 = principal). Si la app
                    // quedó duplicada en un perfil de trabajo (Island)
                    // la web lo ve y la reinstala limpia.
                    res.put("user_id", Process.myUid() / 100_000);
                    break;
                }
                case "package.get": {
                    // v5: EL PAQUETE — apps + TODOS los íconos + launcher
                    // en UNA respuesta (long-poll hasta ~165 s mientras
                    // el único hilo de fondo termina de renderizar).
                    JSONObject pkg = AppRegistry.get(appCtx).packageJson(165_000);
                    res.put("package", pkg);
                    // snapshot de notificaciones incluido: con esto la
                    // web NO necesita NINGÚN otro request
                    res.put("notifications", AgentNotificationListener.snapshotJson(
                            AgentNotificationListener.getInstance()));
                    break;
                }
                case "agent.hibernate": {
                    // la web ya recibió el paquete → dormir YA
                    res.put("performed", true);
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
                case "launcher.get": {
                    res.put("launcher", AppRegistry.get(appCtx).launcherStateJson());
                    break;
                }
                case "apps.get": {
                    // compat v≤4 (respuesta instantánea de caches)
                    JSONObject state = AppRegistry.get(appCtx).appsStateJson();
                    res.put("apps", state.optJSONArray("apps"));
                    res.put("pending", state.optBoolean("pending", false));
                    break;
                }
                case "icons.get": {
                    // compat v≤4
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
                    JSONObject icons = AppRegistry.get(appCtx).iconsStateJson(pkgs);
                    res.put("icons", icons.optJSONArray("icons"));
                    res.put("pending", icons.optJSONArray("pending"));
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
