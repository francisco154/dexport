# DexPort

**Tu Android, reimaginado para el escritorio — ahora 100% en tu navegador.**

Port web del proyecto [Android DEX](https://github.com/Shrey113/Android-Dex) de
[Shrey113](https://github.com/Shrey113): convierte un teléfono Android en un
escritorio DeX completo (apps en ventanas freeform, audio, control de mouse y
teclado) sin instalar nada — solo un navegador con WebUSB (Chrome / Edge).

> 🔗 **Demo en vivo:** <https://dexport-mu.vercel.app>

> 🚀 **v12** — **DexPort Agent v5: paquete único + hibernación + multitarea 100 % ADB**:
> · **UNA frecuencia, leída UNA vez** — al conectar, la web pide un único
>   `package.get` con TODO (apps lanzables + TODOS los íconos + launcher +
>   notificaciones); el agente retiene la respuesta hasta tener el paquete
>   COMPLETO (long-poll interno). Recibido el paquete → `agent.hibernate` →
>   el puente TCP se APAGA: notificación fuera, servicio muerto, cero
>   consumo de CPU/batería. Sin lotes, sin reintentos, sin polling.
> · **SIN servicio de accesibilidad (eliminado)** — la detección de apps
>   abiertas, el foco por display y Atrás/Inicio/Recientes son ahora 100 %
>   ADB shell (dumpsys + input -d): imposible que el agente interfiera con
>   el teléfono (fix definitivo del «no puedo abrir apps en mi teléfono»).
> · **Despertar por ADB** — `am start-foreground-service` enciende el
>   puente cuando la web lo necesita (al conectar o al abrir el centro de
>   notificaciones); tras 90 s ocioso hiberna solo.
> · **Notificaciones BAJO DEMANDA** — ya NO se sondean cada 5 s: se
>   refrescan al abrir el centro de notificaciones (y cada 12 s mientras
>   esté abierto). Cerrado el panel: cero tráfico del agente.
> · **Estabilidad** — con el agente dormido y cero polling, desaparecen de
>   raíz las fugas que congelaban el navegador a los 20-30 min. El agente
>   v1-v4 se auto-actualiza solo a v5 (y limpia el rastro de la vieja
>   accesibilidad: tu teléfono queda 100 % libre).

> 🚀 **v11** — **DexPort Agent v4 + «Liberar teléfono» + estabilidad de sesión larga**:
> · **Fix de los íconos a medias** — el `icons.get` del agente ahora agenda
>   el drenaje del worker por cada lote (antes solo se drenaba en el arranque:
>   los íconos quedaban trabados en los primeros ~6) y la web espera con
>   paciencia real (~3 min) + autorreparación cada 32 s.
> · **Notificaciones ligeras** — el poll de 5 s ya NO transporta el PNG
>   base64 de cada app emisora (decenas de KB repetidos): la web resuelve el
>   ícono por paquete desde su caché de apps.
> · **«Liberar teléfono» (suspender escritorio)** — destruye el display
>   virtual y deja el teléfono 100 % libre (apps, multitarea, split-screen),
>   con la conexión USB viva: «Reanudar» lo reconstruye en segundos. También
>   AUTOMÁTICO (modo ecológico): pestaña ~3 min en segundo plano → suspensión
>   sola; al volver, se reanuda sola.
> · **Anti-congelamiento del navegador (sesiones 20-30 min)** — cero tráfico
>   con la pestaña oculta (loops gated), timers del race siempre limpios,
>   `seenNotifKeys` acotado, y el `dumpsys` pesado se reutiliza 8 s cuando el
>   agente está conectado (mitad de tráfico USB).
> · **Agente OPCIONAL** — se puede **Desactivar** (modo solo ADB: dumpsys +
>   pm list, sin íconos reales ni notificaciones) o **Desinstalar** por ADB,
>   desde Ajustes. El agente v1-v3 se auto-actualiza solo a v4.

> 🚀 **v9** — **DexPort Agent v2: íconos reales + notificaciones + HOME fijo**:
> · **Íconos y nombres GENUINOS** — el agente ahora entrega el ícono real
>   (PNG 64px, drawable del launcher) y la etiqueta exacta del
>   PackageManager de cada app, por lotes y con caché en localStorage: el
>   app drawer, la franja de tareas, «Apps abiertas» y los controles de
>   ventana muestran los íconos originales (adiós al avatar con la inicial).
> · **Centro de notificaciones** (la nueva utilidad del agente) —
>   NotificationListenerService espeja las notificaciones activas del
>   teléfono al escritorio: panel lateral estilo action center con ícono de
>   la app, título, texto y hora; descartar una a una o «limpiar todo»,
>   toasts de las nuevas y clic = abrir la app. El permiso se concede por
>   ADB (`cmd notification allow_listener`), sin tocar el teléfono.
> · **HOME determinista** — el botón Inicio lanza SIEMPRE el launcher
>   PREDETERMINADO del teléfono (resuelto por el agente vía
>   `PackageManager.resolveActivity(HOME)`): mismo sitio siempre, en el
>   display virtual, con verificación y auto-reparación de respaldo.
> · **Componente exacto por app** — el agente da el
>   `pkg/Activity` lanzable real: arranque directo con `am start -n`
>   (adiós `monkey`) y nombres reales en toda la UI.
> · El agente v1 se **auto-actualiza solo** a v2 por ADB al reconectar.

> 🚀 **v8** — **DexPort Agent + escritorio estilo Windows real**:
> · **Taskbar flotante y ocultable** — la barra ahora flota sobre el
>   escritorio (DeX style) con un botón de **minimizar** que la convierte en
>   una pastilla pequeña en la esquina; un clic la devuelve a su estado
>   natural.
> · **Controles de ventana estilo Windows** — minimizar · ventana · pantalla
>   completa · cerrar en la esquina del escritorio, aplicados a la app activa
>   del display virtual.
> · **DexPort Agent** (nuevo, 45 KB): app con **permiso de accesibilidad**
>   que mapea lo que ADB no puede ver — apps y ventanas abiertas de AMBAS
>   pantallas con título, actividad, foco y (Android 13+) display de cada
>   ventana — y ejecuta ATRÁS/HOME/Recientes de forma fiable
>   (`performGlobalAction`). Se instala **y recibe permisos por ADB**, sin
>   tocar el teléfono. Protocolo de líneas JSON en `tcp:8458`.
> · **Fix «No hay apps abiertas»**: la detección ahora es multi-fuente
>   (agente + `dumpsys activity` + `dumpsys window windows` + `am stack list`
>   + foco global) fusionada con prioridad por fiabilidad — el viejo grep se
>   agotaba antes de llegar al display virtual.
> · **ATRÁS definitivo**: cadena `input -d` → agente → control scrcpy →
>   keyevent plano.

> 🚀 **v7** — **Gestión de ventanas estilo Windows**: el botón «Recientes»
> ya no abre los recientes del teléfono — abre la nueva vista **«Apps
> abiertas»** con las tareas reales del display virtual. La barra de tareas
> muestra las apps abiertas (ícono + indicador de foco) con clic = traer al
> frente / minimizar y **clic derecho = menú de Windows** (traer al frente,
> abrir en ventana freeform, pantalla completa, minimizar, cerrar).
> «Atrás» ahora se dirige **al escritorio** (`input -d <display> keyevent`)
> en lugar de irse al teléfono, y «Inicio» es instantáneo con auto-reparación
> del launcher. Minimizar = `am move-task` (la app sigue viva en el teléfono
> y se restaura al escritorio con un clic).

> 🚀 **v3** — **Launcher original incluido**: el APK companion del proyecto
> original (`com.shrey.androiddex` v1.2, extraído del release oficial por
> ingeniería inversa) se sirve byte-idéntico y se **instala por WebADB con un
> clic** al conectar el teléfono (fetch → `adb.sync` push → `pm install -r`).
> Aporta el escritorio HOME en el display virtual, fondos DeX y el análisis
> de apps con nombres e íconos reales a través del puente local del companion
> (puerto 8457, mismo canal que usaba el JAR original).

> 🚀 **v2** — rebuild con ingeniería inversa del build original (AndroidDex v1.2):
> launcher del teléfono en el escritorio virtual, lanzamiento de apps reales
> (`am start --display` / START_APP de scrcpy 3.3), boot no bloqueante,
> monitor de apps en ejecución y audio funcional.

---

## Cómo funciona

El original era una app de escritorio (Flutter + Kotlin + Java) que se
comunicaba con el teléfono vía `adb` local. Este port sustituye **todo el
transporte local por WebADB**, manteniendo la misma arquitectura y los mismos
comandos:

| Original (escritorio)                        | DexPort (navegador)                                            |
| :------------------------------------------- | :------------------------------------------------------------- |
| `adb.exe` + Process.run                      | `@yume-chan/adb` (protocolo ADB nativo sobre WebUSB)           |
| `@yume-chan/adb-backend-webusb` (v1)         | `@yume-chan/adb-daemon-webusb` (v2, sucesor del paquete v1)    |
| Credenciales RSA del daemon                  | `@yume-chan/adb-credential-web` (IndexedDB)                    |
| `scrcpy.exe --new-display=1920x1080`         | `AdbScrcpyClient` (scrcpy-server 3.3.3 vía socket shell ADB)   |
| Ventana Win32 embebida (SetParent)           | `<canvas>` + `WebCodecsVideoDecoder` (WebGL/Bitmap)            |
| Audio por WebSocket (APK companion)          | Audio opus de scrcpy → `AudioDecoder` → `AudioWorklet`         |
| Logic Engine JAR (`app_process`)             | Comandos shell reenviados (`settings put`, `pm list`, `am …`)  |
| Telemetría WebSocket del Feature Hub (APK)   | Polling `dumpsys battery` / `dumpsys media_session`            |
| APK companion (`adb install AndroidDex.apk`) | Instalador WebADB (fetch → sync push → `pm install -r`)         |
| Puente local del APK (JAR → tcp:8457)        | `adb.createSocket("tcp:8457")` (protocolo JSON de líneas)      |
| `get_all_apps` (análisis de apps del JAR)    | `companionBridge.getApps()` — nombres + íconos base64 reales   |

### Launcher original (v3)

El release oficial de Android-Dex empaqueta `AndroidDex.apk`, el companion
que convierte el display virtual en un escritorio real:

- `com.shrey.androiddex/.MainActivity` — actividad **HOME** (launcher)
- `ServerStartService` — puente de servicios (batería, apps, íconos, notificaciones)
  escuchando en `127.0.0.1:8457` del dispositivo
- Protocolo de líneas JSON: `{"type":"get_all_apps"}` → lista de apps con
  `app_name`, `package_name`, `version_name`, `is_system` e `icon_base64`

DexPort lo sirve en `/androiddex-launcher.apk` (byte-idéntico al original,
SHA-256 `76f09aac…ac3b30`) y al conectar el teléfono ofrece instalarlo y
lanzarlo automáticamente en el display virtual — sin PC.

### Comandos DeX reenviados (idénticos al original)

```bash
settings put global enable_freeform_support 1
settings put global force_desktop_mode_on_external_displays 1
```

El display virtual se levanta con las opciones equivalentes a:

```bash
scrcpy --new-display=1920x1080 --vd-system-decorations --video-codec=h264 \
       --audio-codec=opus --tunnel-forward
```

…pero ejecutadas desde el navegador a través del socket shell de WebADB.

## Requisitos

- Navegador **Chromium** con WebUSB (Chrome, Edge, Brave, Opera…) — no Safari/Firefox
- Teléfono Android 7+ con **Depuración USB** activada (Opciones de desarrollador)
- Cable USB
- Android 11+ para audio

## Uso

1. Abre <https://dexport-app.vercel.app> (o tu deploy)
2. Conecta el teléfono por USB
3. **Iniciar DexPort** → elige el dispositivo en el diálogo WebUSB
4. Acepta «Permitir depuración USB» en el teléfono (marca «Siempre»)
5. Cuando aparezca la tarjeta del **launcher original**, pulsa
   **Instalar launcher original (44 MB)** — se descarga, se sube por WebADB y
   se instala con `pm install -r`; al terminar se abre solo en el escritorio
6. Escritorio DeX en el navegador 🎉

> También puedes descargar el APK directamente desde la landing
> (`Descargar APK`) e instalarlo con `adb install AndroidDex.apk` si lo
> prefieres manualmente.

### Controles

| Acción                | Resultado                       |
| :-------------------- | :------------------------------ |
| Clic izquierdo        | Toque                           |
| Clic derecho          | Atrás (BACK)                    |
| Clic central          | Inicio (HOME)                   |
| Rueda                 | Scroll                          |
| Teclado               | Keycodes Android + texto        |
| `Ctrl+F`              | Pantalla completa               |
| `F1`                  | Atajos                          |
| Taskbar               | Home/Back/Recientes/Notif./Vol. |
| Media Center          | Play/Pausa/Anterior/Siguiente   |

## Arquitectura del port

```
src/
├── services/
│   ├── adb.ts          → AdbProvider + DeviceManager (WebUSB, auth RSA, shell)
│   └── scrcpy.ts       → ScrcpyVideoManager (display virtual, decoders, control)
├── store/store.ts      → AppManager (boot dual) + AndroidCore (estado reactivo)
├── audio/opusPlayer.ts → Streaming de audio (WebCodecs + AudioWorklet)
├── utils/
│   ├── androidKeys.ts  → Mapa teclado → keycodes AKEYCODE_*
│   ├── appNames.ts     → Diccionario de apps (app drawer)
│   └── telemetry.ts    → Parsers dumpsys (batería, media, volúmenes)
└── components/
    ├── Landing.tsx     → Port de la landing original
    ├── BootScreen.tsx  → Barras duales APP/ENGINE (BOOT_FLOW.md)
    ├── DesktopShell.tsx→ Wallpaper DeX + taskbar + paneles
    ├── DisplayCanvas.tsx → Canvas + inyección de input (protocolo scrcpy)
    ├── Taskbar.tsx     → Taskbar con mini media player y bandeja
    ├── AppDrawer.tsx   → USER/SYSTEM apps con búsqueda
    └── Panels.tsx      → Media Center, Dispositivo, Ajustes, Atajos
```

Los documentos de arquitectura del repo original (`doc/`) fueron la
especificación del port: boot de 2 barras con handshakes, reconnection manager
de 2 fases, error handling con reintento, y data model de telemetría.

## Desarrollo

```bash
npm install
npm run dev      # http://localhost:5173 (WebUSB funciona en localhost)
npm run build    # dist/ estático
```

Deploy: el proyecto es un SPA estático — `vercel.json` ya incluye los headers
(`Permissions-Policy: usb=(self)`) y el rewrite SPA. Basta conectar el repo a
Vercel o desplegar la carpeta `dist/`.

## Créditos

- **[Android DEX](https://github.com/Shrey113/Android-Dex)** de Shrey113 —
  proyecto original (portado con su documentación pública como blueprint)
- **[ya-webadb / WebADB](https://github.com/yume-chan/ya-webadb)** — librerías
  `@yume-chan/*` que implementan ADB en TypeScript
- **[scrcpy](https://github.com/Genymobile/scrcpy)** de Genymobile/rom1v —
  motor de display virtual (servidor v3.3.3 incluido)
- Capturas de pantalla cortesía del repo original de Android DEX

## Licencia

El código del port se libera como software libre. scrcpy-server está bajo
Apache 2.0 (Copyright Genymobile / Romain Vimont).
