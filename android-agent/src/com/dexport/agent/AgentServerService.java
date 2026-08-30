package com.dexport.agent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

/**
 * DexPort Agent v5 — servicio que aloja el puente TCP.
 * ════════════════════════════════════════════════════════════
 * v5 — ARQUITECTURA «PAQUETE ÚNICO + HIBERNACIÓN»:
 *
 *   · El puente 127.0.0.1:8458 ya NO vive en un servicio de
 *     accesibilidad: vive en este servicio EN PRIMER PLANO que
 *     DexPort (la web) enciende y apaga POR ADB cuando lo
 *     necesita. CERO permisos de accesibilidad → el agente NO
 *     puede volver a interferir con el teléfono (multitarea,
 *     teclado, táctil): el servicio de accesibilidad se eliminó
 *     por completo.
 *
 *   · HIBERNACIÓN REAL: si no llegan requests durante 90 s (o la
 *     web envía «agent.hibernate» tras recibir el paquete), el
 *     servidor TCP se APAGA, la notificación desaparece y el
 *     servicio muere — el proceso queda sin NINGÚN componente
 *     activo consumiendo CPU/batería.
 *
 *   · DESPERTAR: `am start-foreground-service -n
 *     com.dexport.agent/.AgentServerService` desde ADB (lo hace
 *     la web al conectar o al abrir el centro de notificaciones).
 *
 *   · El espejo de notificaciones (AgentNotificationListener)
 *     sigue siendo pasivo: el sistema lo empuja, no consume nada
 *     mientras no llegue una notificación.
 */
public class AgentServerService extends Service {

    private static final String TAG = "DexPortAgent";
    private static final String CHANNEL_ID = "dexport_bridge";
    private static final int NOTIF_ID = 8458;

    /** v5: sin requests durante este tiempo → HIBERNAR. */
    private static final long IDLE_MS = 90_000L;
    /** Periodo de revisión del watchdog (barato). */
    private static final long WATCHDOG_TICK_MS = 15_000L;

    private static volatile AgentServerService sInstance;

    private AgentServer server;
    private final Handler handler = new Handler(Looper.getMainLooper());

    /** Watchdog de hibernación: puente ocioso → apagar TODO. */
    private final Runnable idleWatchdog = new Runnable() {
        @Override
        public void run() {
            AgentServer s = server;
            if (s == null) {
                return; // ya hibernando
            }
            if (s.idleFor() >= IDLE_MS) {
                Log.i(TAG, "v5: ocioso " + (IDLE_MS / 1000) + "s → HIBERNANDO");
                hibernate();
            } else {
                handler.postDelayed(this, WATCHDOG_TICK_MS);
            }
        }
    };

    public static AgentServerService getInstance() {
        return sInstance;
    }

    /** ¿El puente TCP está abierto ahora? (para MainActivity) */
    public static boolean isBridgeRunning() {
        AgentServerService s = sInstance;
        return s != null && s.server != null && s.server.isRunning();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // siempre en primer plano primero (si llegamos por
        // startForegroundService el sistema lo EXIGE en 5 s)
        startForeground(NOTIF_ID, buildNotification());

        // despertar solo para hibernar (intento remoto «duerme ya»)
        if (intent != null && intent.getBooleanExtra("hibernate", false)) {
            hibernate();
            return START_NOT_STICKY;
        }

        if (server == null || !server.isRunning()) {
            server = new AgentServer(getApplicationContext(), new AgentServer.Hibernator() {
                @Override
                public void hibernateNow() {
                    handler.post(new Runnable() {
                        @Override
                        public void run() {
                            hibernate();
                        }
                    });
                }
            });
            server.start();
            // precalentar (apps + launcher) mientras la web conecta
            AppRegistry.get(getApplicationContext()).prewarm();
        }
        server.touch();
        handler.removeCallbacks(idleWatchdog);
        handler.postDelayed(idleWatchdog, IDLE_MS + WATCHDOG_TICK_MS);
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        AgentServer s = server;
        server = null;
        if (s != null) {
            s.shutdown();
        }
        if (sInstance == this) {
            sInstance = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /**
     * HIBERNACIÓN: apagar el servidor TCP, soltar el primer plano
     * y matar el servicio. El proceso (vivo por el listener de
     * notificaciones) queda con CERO componentes activos.
     */
    public void hibernate() {
        handler.removeCallbacksAndMessages(null);
        AgentServer s = server;
        server = null;
        if (s != null) {
            s.shutdown();
        }
        AppRegistry.shutdownShared();
        stopForeground(true);
        stopSelf();
        Log.i(TAG, "v5: HIBERNANDO — puente cerrado (cero consumo)");
    }

    private Notification buildNotification() {
        NotificationManager nm =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Puente DexPort", NotificationManager.IMPORTANCE_MIN);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(
                this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        return b
                .setContentTitle("DexPort Agent")
                .setContentText("Puente activo — hiberna solo al terminar")
                .setSmallIcon(R.drawable.ic_notification)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }
}
