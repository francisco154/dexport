package com.dexport.agent;

import android.accessibilityservice.AccessibilityService;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;

/**
 * DexPort Agent — servidor TCP (localhost:8458).
 * ════════════════════════════════════════════════════════════
 * Mismo protocolo de líneas JSON que el companion original (8457):
 *   request :  {"type": "<cmd>", "id": "<n>"}\n
 *   response:  {"status": "success", ..., "id": "<n>"}\n
 * Una conexión por request (handleClient serializado por conexión).
 * La web llega por adb.createSocket("tcp:8458").
 *
 * Comandos:
 *   ping                → version / sdk / device
 *   tasks.get_all       → apps abiertas (ventanas TYPE_APPLICATION de todos
 *                         los displays) con actividad, título, foco y capa
 *   windows.get_all     → todas las ventanas interactivas
 *   events.recent       → últimos cambios de ventana (pkg + clase + t)
 *   foreground.get      → ventana activa global + nº de ventanas por display
 *   action.back|home|recents|notifications|quick_settings|lock_screen|all_apps
 *                       → performGlobalAction (devuelve performed=true/false)
 */
public class AgentServer extends Thread {

    public static final int PORT = 8458;
    private static final String TAG = "DexPortAgent";

    private final AgentAccessibilityService service;
    private volatile boolean running = false;
    private volatile ServerSocket serverSocket;
    private final ExecutorService pool = Executors.newCachedThreadPool();

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
            Log.i(TAG, "Agent escuchando en 127.0.0.1:" + PORT);
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
            client.setSoTimeout(10_000);
            BufferedReader in = new BufferedReader(
                    new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
            String line = in.readLine();
            if (line == null || line.trim().isEmpty()) {
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
                    res.put("version", 1);
                    res.put("sdk", Build.VERSION.SDK_INT);
                    res.put("android", Build.VERSION.RELEASE);
                    res.put("device", Build.MANUFACTURER + " " + Build.MODEL);
                    res.put("multi_display", Build.VERSION.SDK_INT >= 33);
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
