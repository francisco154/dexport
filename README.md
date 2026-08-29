# DexPort

**Tu Android, reimaginado para el escritorio — ahora 100% en tu navegador.**

Port web del proyecto [Android DEX](https://github.com/Shrey113/Android-Dex) de
[Shrey113](https://github.com/Shrey113): convierte un teléfono Android en un
escritorio DeX completo (apps en ventanas freeform, audio, control de mouse y
teclado) sin instalar nada — solo un navegador con WebUSB (Chrome / Edge).

> 🔗 **Demo en vivo:** <https://dexport-app.vercel.app>

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
5. Escritorio DeX en el navegador 🎉

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
