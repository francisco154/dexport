package com.dexport.agent;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;

import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * Pantalla de estado del DexPort Agent (UI en Java puro, sin dependencias).
 * Muestra si el servicio de accesibilidad está activo y el puerto del
 * puente, con acceso directo a los ajustes de accesibilidad.
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
        subtitle.setText("Puente de accesibilidad para DexPort (navegador)");
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

        // ── botón ajustes ──
        Button openSettings = new Button(this);
        openSettings.setText("Abrir ajustes de accesibilidad");
        openSettings.setTextColor(Color.WHITE);
        openSettings.setTextSize(14);
        GradientDrawable btnBg = new GradientDrawable();
        btnBg.setColor(0xFF1D4ED8);
        btnBg.setCornerRadius(dp(12));
        openSettings.setBackground(btnBg);
        openSettings.setPadding(dp(16), dp(12), dp(16), dp(12));
        openSettings.setOnClickListener(v -> {
            try {
                startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
            } catch (Exception ignored) {
            }
        });
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(-1, -2);
        blp.topMargin = dp(14);
        box.addView(openSettings, blp);

        // ── instrucciones ──
        box.addView(sectionTitle("Cómo funciona"), sectionLp());
        box.addView(paragraph(
                "1. DexPort (la web) instala este agente automáticamente por ADB cuando pulsas «Instalar Agent» — solo en el perfil principal del teléfono (nunca en perfiles de trabajo como Island).\n\n"
                        + "2. El permiso de accesibilidad también se concede por ADB — al activarse, el agente abre su puente local en el puerto 8458.\n\n"
                        + "3. DexPort consulta ese puente para ver las apps y ventanas abiertas (del teléfono y del escritorio virtual), saber cuál está enfocada y enviar Atrás/Inicio/Recientes de forma fiable.\n\n"
                        + "4. Además espeja las NOTIFICACIONES activas (permiso propio por ADB), entrega los ÍCONOS y nombres reales de TODAS las apps instaladas y resuelve el launcher predefinido.\n\n"
                        + "5. v3 — RECONSTRUIDO para no intervenir NUNCA en el rendimiento: el servicio de accesibilidad es ultraligero (sin inspección de contenido de ventanas) y todo el trabajo pesado pasa por un único hilo de fondo de baja prioridad.\n\n"
                        + "6. No sale ningún dato del dispositivo: la conexión pasa por el cable USB (ADB)."));

        box.addView(sectionTitle("Privacidad"), sectionLp());
        box.addView(paragraph(
                "El agente no envía datos a Internet ni los guarda. Solo escucha en localhost y responde "
                        + "a las consultas de DexPort que llegan por USB. Puedes desactivarlo o desinstalarlo "
                        + "cuando quieras desde Ajustes → Accesibilidad → Apps instaladas."));

        box.addView(sectionTitle("Puente"), sectionLp());
        box.addView(paragraph(
                "Comandos: ping · tasks.get_all · windows.get_all · events.recent · foreground.get · "
                        + "action.back | home | recents | notifications | quick_settings | lock_screen | all_apps · "
                        + "apps.get · icons.get · launcher.get · notifications.get · "
                        + "notification.dismiss · notifications.clear_all\n"
                        + "Protocolo: una línea JSON por request → una línea JSON de respuesta (puerto 127.0.0.1:"
                        + AgentServer.PORT + ")."));

        setContentView(scroll);
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
        boolean enabled = AgentAccessibilityService.isServiceRunning();
        boolean notif = AgentNotificationListener.isConnected();
        String sdk = Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")";
        boolean multi = Build.VERSION.SDK_INT >= 33;
        int userId = android.os.Process.myUid() / 100_000;
        if (enabled) {
            statusLine.setTextColor(0xFF4ADE80);
            statusLine.setText("● ACTIVO v3 — puente 127.0.0.1:" + AgentServer.PORT
                    + "\nAndroid " + sdk + (multi ? " · ventanas por display ✓" : "")
                    + "\nNotificaciones: " + (notif ? "espejadas ✓" : "no concedidas")
                    + "\nPerfil: " + (userId == 0 ? "principal ✓" : ("TRABAJO (" + userId + ") — reinstalá desde DexPort")));
        } else {
            statusLine.setTextColor(0xFFF59E0B);
            statusLine.setText("○ SIN PERMISO — activa «DexPort Agent»\nen Accesibilidad"
                    + "\nAndroid " + sdk);
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
