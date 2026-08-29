# DexPort Agent (com.dexport.agent)

App Android auxiliar con **permiso de accesibilidad** que mapea todo lo que
ADB no puede ver y lo sirve por TCP al escritorio DexPort del navegador:

- **Apps y ventanas abiertas** en TODAS las pantallas (teléfono + display
  virtual de scrcpy + ventanas freeform DeX) con paquete, título, actividad,
  foco y capa. En Android 13+ (API 33) además expone el **display** de cada
  ventana (`getWindowsOnAllDisplays()`).
- **App en primer plano** (ventana activa global) — la que el usuario está
  usando ahora.
- **Historial de eventos** de cambio de ventana (paquete + Activity al frente).
- **Acciones globales fiables**: ATRÁS / HOME / RECIENTES / notificaciones /
  ajustes rápidos / bloquear pantalla / all-apps (`performGlobalAction`).

## Protocolo

Servidor de líneas JSON en `127.0.0.1:8458` (idéntico al companion original
de Android-Dex en 8457). La web lo consulta por el túnel de WebADB
(`adb.createSocket("tcp:8458")`):

```
→ {"type": "tasks.get_all", "id": "ag1"}
← {"status": "success", "id": "ag1", "tasks": [
     {"window_id": 9, "package_name": "com.whatsapp",
      "activity": "com.whatsapp/com.whatsapp.Home", "title": "WhatsApp",
      "display_id": 2, "is_active": true, "is_focused": true, "layer": 4}
   ]}
```

Comandos: `ping` · `tasks.get_all` · `windows.get_all` · `events.recent` ·
`foreground.get` · `action.back|home|recents|notifications|quick_settings|lock_screen|all_apps`

## Instalación (automática desde la web)

DexPort la instala solo — botón «Instalar Agent» en el TaskView o en Ajustes:

1. Descarga el APK (`public/dexport-agent.apk`, ~45 KB)
2. Push por ADB sync → `pm install -r -g`
3. Concede el permiso de accesibilidad por ADB:
   ```
   settings put secure enabled_accessibility_services \
     com.dexport.agent/com.dexport.agent.AgentAccessibilityService
   settings put secure accessibility_enabled 1
   ```

En algunas ROMs (MIUI/HyperOS, One UI) el paso 3 requiere activación manual
la primera vez: **Ajustes → Accesibilidad → DexPort Agent → activar**.

## Compilar a mano

Sin Gradle — solo build-tools 34 + platform android-34 + JDK:

```bash
ANDROID_SDK=/ruta/al/sdk ./build.sh
```

El script hace: `aapt2 compile/link` → `javac --release 8` → `d8` →
`zipalign` → `apksigner` (keystore `agent.keystore`, pass `dexportagent`).
También hay un workflow de GitHub Actions (`.github/workflows/build-agent.yml`).

## Estructura

```
AndroidManifest.xml          — INTERNET + AccessibilityService
res/xml/accessibility_service_config.xml — flagRetrieveInteractiveWindows
src/…/AgentAccessibilityService.java     — snapshot de ventanas + eventos
src/…/AgentServer.java                  — servidor TCP 8458 (líneas JSON)
src/…/MainActivity.java                 — estado + acceso a ajustes
```
