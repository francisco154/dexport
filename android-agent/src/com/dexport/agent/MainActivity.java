package com.dexport.agent;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;

import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * Pantalla de estado del DexPort Agent (UI en Java puro, sin dependencias).
 * v5: el puente ya NO requiere permiso de accesibilidad — vive en un
 * servicio en primer plano que DexPort enciende/apaga por ADB y que
 * HIBERNA solo (cero consumo) cuando no hay nada que servir.
 */
public class MainActivity extends Activity {

    private TextView statusLine;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(0xFF0B0D10);
        scroll.setFillViewport(true);

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(26);
        box.setPadding(pad, pad, pad, pad);
        scroll.addView(box, new LinearLayout.LayoutParams(-1, -2));

        // ── cabecera ──
        TextView title = new TextView(this);
        title.setText("DexPort Agent");
        title.setTextSize(26);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.BOLD));
        title.setTextColor(0xFF7DD3FC);
        box.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("Puente de datos para DexPort (navegador) — sin permiso de accesibilidad");
        subtitle.setTextSize(13);
        subtitle.setTextColor(0xFF9AA3B2);
        box.addView(subtitle);

        // ── estado ──
        statusLine = new TextView(this);
        statusLine.setTextSize(14.5f);
        statusLine.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        statusLine.setPadding(dp(14), dp(12), dp(14), dp(12));
        GradientDrawable card = new GradientDrawable();
        card.setColor(0xFF141922);
        card.setCornerRadius(dp(14));
        card.setStroke(1, 0xFF243040);
        statusLine.setBackground(card);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(-1, -2);
        slp.topMargin = dp(22);
        box.addView(statusLine, slp);

        // ── botón: abrir el puente ahora ──
        Button openBridge = new Button(this);
        openBridge.setText("Abrir puente ahora (90 s de gracia)");
        openBridge.setTextColor(Color.WHITE);
        openBridge.setTextSize(14);
        GradientDrawable btnBg = new GradientDrawable();
        btnBg.setColor(0xFF1D4ED8);
        btnBg.setCornerRadius(dp(12));
        openBridge.setBackground(btnBg);
        openBridge.setPadding(dp(16), dp(12), dp(16), dp(12));
        openBridge.setOnClickListener(v -> startBridge());
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(-1, -2);
        blp.topMargin = dp(14);
        box.addView(openBridge, blp);

        // ── botón: hibernar ya ──
        Button hibernate = new Button(this);
        hibernate.setText("Hibernar ya (cero consumo)");
        hibernate.setTextColor(0xFFB9C0CC);
        hibernate.setTextSize(13);
        GradientDrawable hbBg = new GradientDrawable();
        hbBg.setColor(0xFF141922);
        hbBg.setCornerRadius(dp(12));
        hbBg.setStroke(1, 0xFF243040);
        hibernate.setBackground(hbBg);
        hibernate.setPadding(dp(16), dp(10), dp(16), dp(10));
        hibernate.setOnClickListener(v -> stopService(
                new Intent(this, AgentServerService.class)));
        LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(-1, -2);
        hlp.topMargin = dp(8);
        box.addView(hibernate, hlp);

        // ── instrucciones ──
        box.addView(sectionTitle("Cómo funciona (v5)"), sectionLp());
        box.addView(paragraph(
                "1. DexPort (la web) instala este agente automáticamente por ADB cuando pulsas «Instalar Agent» — solo en el perfil principal del teléfono (nunca en perfiles de trabajo como Island).\n\n"
                        + "2. SIN permiso de accesibilidad: el puente vive en un servicio en primer plano que DexPort enciende por USB (am start-foreground-service) solo cuando lo necesita.\n\n"
                        + "3. UNA única solicitud («paquete»): apps lanzables + TODOS los íconos + launcher predefinido. Recibido el paquete, el agente HIBERNA: servidor apagado, notificación fuera, cero consumo de CPU y batería.\n\n"
                        + "4. La multitarea (apps abiertas, foco por display, Atrás/Inicio/Recientes) la hace DexPort 100 % por ADB shell — el agente ya no participa ahí, así que NUNCA interfiere con tu teléfono.\n\n"
                        + "5. Las notificaciones se espejan solo cuando abres el centro de notificaciones de la web (el agente despierta un instante y vuelve a dormir).\n\n"
                        + "6. No sale ningún dato del dispositivo: la conexión pasa por el cable USB (ADB)."));

        box.addView(sectionTitle("Privacidad"), sectionLp());
        box.addView(paragraph(
                "El agente no envía datos a Internet ni los guarda. Solo escucha en localhost "
                        + "y responde a las consultas de DexPort que llegan por USB. Puedes "
                        + "desinstalarlo cuando quieras desde la propia web (Ajustes) o del teléfono."));

        box.addView(sectionTitle("Puente"), sectionLp());
        box.addView(paragraph(
                "Comandos v5: ping · package.get · agent.hibernate · notifications.get · "
                        + "notification.dismiss · notifications.clear_all · launcher.get\n"
                        + "Protocolo: una línea JSON por request → una línea JSON de respuesta "
                        + "(puerto 127.0.0.:" + AgentServer.PORT + ").\n"
                        + "Eliminados en v5 (100 % ADB): tasks/windows/events/foreground/action.*"));

        setContentView(scroll);

        // abrir el puente también al abrir la app (comodidad)
        startBridge();
    }

    private void startBridge() {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                startForegroundService(new Intent(this, AgentServerService.class));
            } else {
                startService(new Intent(this, AgentServerService.class));
            }
        } catch (Exception ignored) {
        }
        // refrescar el estado en un momento (el servicio arranca async)
        statusLine.postDelayed(this::updateStatus, 600);
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateStatus();
    }

    private void updateStatus() {
        if (statusLine == null) {
            return;
        }
        boolean running = AgentServerService.isBridgeRunning();
        boolean notif = AgentNotificationListener.isConnected();
        String sdk = Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")";
        int userId = android.os.Process.myUid() / 100_000;
        if (running) {
            statusLine.setTextColor(0xFF4ADE80);
            statusLine.setText("● PUENTE ACTIVO v5 — 127.0.0.1:" + AgentServer.PORT
                    + "\nAndroid " + sdk
                    + "\nNotificaciones: " + (notif ? "espejadas ✓" : "no concedidas")
                    + "\nPerfil: " + (userId == 0 ? "principal ✓" : ("TRABAJO (" + userId + ") — reinstalá desde DexPort"))
                    + "\nHiberna solo tras 90 s sin consultas");
        } else {
            statusLine.setTextColor(0xFF7DD3FC);
            statusLine.setText("◌ HIBERNANDO v5 — cero consumo"
                    + "\nAndroid " + sdk
                    + "\nDexPort lo despierta por USB cuando lo necesita"
                    + "\n(perfil " + (userId == 0 ? "principal ✓" : ("TRABAJO (" + userId + ")")) + ")");
        }
    }

    private TextView sectionTitle(String t) {
        TextView v = new TextView(this);
        v.setText(t);
        v.setTextSize(15);
        v.setTypeface(Typeface.DEFAULT_BOLD);
        v.setTextColor(Color.WHITE);
        return v;
    }

    private LinearLayout.LayoutParams sectionLp() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = dp(22);
        return lp;
    }

    private TextView paragraph(String text) {
        TextView v = new TextView(this);
        v.setText(text);
        v.setTextSize(13);
        v.setTextColor(0xFFB9C0CC);
        v.setLineSpacing(dp(3), 1f);
        return v;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
