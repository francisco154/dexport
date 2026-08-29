/**
 * DexPort — Landing
 * ════════════════════════════════════════════════════════════
 * Port de la landing del sitio original de Android DEX
 * (hero con Playfair italic, glass chips, glow ambiental,
 * badges de tecnología) adaptada al contexto web: el CTA
 * inicia el flujo WebUSB en lugar de descargar binarios.
 */

import {
  MonitorSmartphone,
  AppWindow,
  Volume2,
  BellRing,
  Music4,
  Gamepad2,
  Usb,
  ShieldCheck,
  Globe2,
  Zap,
  ArrowRight,
  Keyboard,
  BatteryCharging,
  ExternalLink,
} from "lucide-react";
import { useStore } from "../store/store";

const FEATURES = [
  {
    icon: <AppWindow size={20} />,
    title: "Apps en ventanas libres",
    desc: "Display virtual DeX con soporte freeform: lanza tus apps en un escritorio 1080p independiente del teléfono, tal como el Android DEX original.",
  },
  {
    icon: <MonitorSmartphone size={20} />,
    title: "Espejo + control total",
    desc: "Mouse y teclado del PC reenviados vía protocolo scrcpy: clic derecho = Atrás, clic central = Home, rueda = scroll, texto directo al dispositivo.",
  },
  {
    icon: <Volume2 size={20} />,
    title: "Audio en el navegador",
    desc: "El audio del dispositivo se transmite por ADB (opus) y se decodifica con WebCodecs — sin cables de audio ni apps companion.",
  },
  {
    icon: <Music4 size={20} />,
    title: "Media Center",
    desc: "Sesiones multimedia activas con título/artista y controles play/pausa/siguiente, como el Media Center de escritorio del original.",
  },
  {
    icon: <BellRing size={20} />,
    title: "Panel de notificaciones",
    desc: "Abre el shade de notificaciones del display virtual con un clic, más clipboard autosync en ambos sentidos.",
  },
  {
    icon: <Gamepad2 size={20} />,
    title: "Modo juego",
    desc: "Los juegos corren en tu hardware real: el dispositivo recibe toques exactos por el protocolo nativo de scrcpy, sin emulador.",
  },
];

const STEPS = [
  {
    icon: <Usb size={18} />,
    title: "Conecta por USB",
    desc: "Activa la Depuración USB en Opciones de desarrollador y conecta el teléfono al PC.",
  },
  {
    icon: <ShieldCheck size={18} />,
    title: "Autoriza el dispositivo",
    desc: "Acepta «Permitir depuración USB» en el teléfono y el diálogo de WebUSB en el navegador.",
  },
  {
    icon: <Zap size={18} />,
    title: "Escritorio instantáneo",
    desc: "DexPort aplica los settings DeX, despliega el motor scrcpy y lanza tu display virtual.",
  },
];

export function Landing() {
  const setPhase = useStore((s) => s.setPhase);

  return (
    <div className="scrollable h-full w-full">
      {/* Fondo ambiental (port del sitio original) */}
      <div className="page-bg">
        <div className="page-bg-grid" />
        <div className="page-bg-glow" />
      </div>

      <div className="relative z-10 mx-auto w-full max-w-6xl px-6">
        {/* ── Nav ── */}
        <nav className="flex items-center justify-between py-6">
          <div className="flex items-center gap-3">
            <img src="assets/logo.webp" alt="DexPort" className="h-9 w-9 rounded-xl shadow-lg" />
            <div>
              <span className="text-[15px] font-semibold text-white">DexPort</span>
              <span className="ml-2 rounded-full bg-[#3ddc84]/12 px-2 py-0.5 font-mono text-[10px] text-[#3ddc84]">
                web port
              </span>
            </div>
          </div>
          <a
            href="https://github.com/Shrey113/Android-Dex"
            target="_blank"
            rel="noreferrer"
            className="btn-outline !py-2 !text-[12.5px]"
          >
            <ExternalLink size={13} /> Proyecto original
          </a>
        </nav>

        {/* ── Hero ── */}
        <header className="pb-4 pt-10 text-center">
          <div className="mx-auto mb-6 flex w-fit items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 text-[12px] text-[#9499a3]">
            <Globe2 size={13} className="text-[#3ddc84]" />
            100% en tu navegador · Chrome / Edge · sin instalar nada
          </div>
          <h1 className="mx-auto max-w-3xl text-4xl font-bold leading-tight text-white sm:text-5xl md:text-[3.4rem]">
            Tu teléfono Android,
            <br />
            <em className="font-serif font-normal italic text-[#3ddc84]">
              reimaginado como escritorio
            </em>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-[#9499a3]">
            Port web de <b className="text-[#cfd4dc]">Android DEX</b>: el mismo
            escritorio DeX con apps en ventanas, audio y control — ahora
            funcionando en la nube con WebADB y scrcpy, listo para cualquier
            navegador con WebUSB.
          </p>
          <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-[#3ddc84]/30 bg-[#3ddc84]/10 px-3 py-1 text-[11px] font-medium text-[#3ddc84]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#3ddc84]" />
            v2 — launcher en el escritorio, apps reales y telemetría estable
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <button className="btn-solid !px-7 !py-3.5 !text-[15px]" onClick={() => setPhase("boot")}>
              <Zap size={16} /> Iniciar DexPort
              <ArrowRight size={15} />
            </button>
            <a href="#setup" className="btn-outline !px-7 !py-3.5 !text-[15px]">
              Cómo conectar
            </a>
          </div>
          <p className="mt-4 font-mono text-[11px] text-[#5a606c]">
            requerimiento: teléfono Android 7+ · cable USB · depuración USB activada
          </p>
        </header>

        {/* ── Hero visual (capturas reales del proyecto original) ── */}
        <section className="relative py-10">
          <div className="glass mx-auto max-w-4xl overflow-hidden rounded-3xl p-2 shadow-2xl">
            <div className="overflow-hidden rounded-2xl">
              <img
                src="assets/home_screen.webp"
                alt="Escritorio DexPort con apps Android en ventanas"
                className="w-full"
              />
            </div>
          </div>
          {/* Glass chips flotantes (estilo del hero original) */}
          <div className="glass absolute -left-2 top-6 hidden items-center gap-2 rounded-full px-4 py-2 text-[12px] text-white md:flex">
            <AppWindow size={14} className="text-[#3ddc84]" /> Ventanas freeform
          </div>
          <div className="glass absolute -right-2 top-1/3 hidden items-center gap-2 rounded-full px-4 py-2 text-[12px] text-white md:flex">
            <Volume2 size={14} className="text-[#7dd3fc]" /> Audio opus vía ADB
          </div>
          <div className="glass absolute -left-2 bottom-6 hidden items-center gap-2 rounded-full px-4 py-2 text-[12px] text-white md:flex">
            <Keyboard size={14} className="text-[#fbbf24]" /> Mouse + teclado nativos
          </div>
        </section>

        {/* ── Capturas adicionales ── */}
        <section className="grid gap-4 py-8 md:grid-cols-3">
          {[
            ["assets/multi_apps.webp", "Multi-app", "Varias apps a la vez en el display virtual"],
            ["assets/app_list.webp", "App drawer", "Todas tus apps con búsqueda instantánea"],
            ["assets/media_control.webp", "Media Center", "Control de reproducción desde la taskbar"],
          ].map(([src, title, desc]) => (
            <figure key={src} className="glass overflow-hidden rounded-2xl p-2">
              <div className="overflow-hidden rounded-xl">
                <img src={src} alt={title} className="w-full" loading="lazy" />
              </div>
              <figcaption className="flex flex-col gap-1 px-2 py-3">
                <span className="text-[13px] font-semibold text-white">{title}</span>
                <span className="text-[11.5px] text-[#9499a3]">{desc}</span>
              </figcaption>
            </figure>
          ))}
        </section>

        {/* ── Features ── */}
        <section className="py-10" id="features">
          <h2 className="text-center font-serif text-3xl italic text-white">
            Todo el Android DEX, <em className="text-[#3ddc84] not-italic">sin instalar nada</em>
          </h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <article
                key={f.title}
                className="glass rounded-2xl p-5 transition hover:border-white/20 hover:bg-white/[0.05]"
              >
                <div className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-[#3ddc84]/10 text-[#3ddc84]">
                  {f.icon}
                </div>
                <h3 className="text-[14px] font-semibold text-white">{f.title}</h3>
                <p className="mt-2 text-[12.5px] leading-relaxed text-[#9499a3]">{f.desc}</p>
              </article>
            ))}
          </div>
        </section>

        {/* ── Setup ── */}
        <section className="py-10" id="setup">
          <h2 className="text-center font-serif text-3xl italic text-white">
            Conexión en <em className="text-[#3ddc84] not-italic">3 pasos</em>
          </h2>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <div key={s.title} className="glass relative rounded-2xl p-6">
                <span className="absolute right-5 top-5 font-mono text-2xl font-bold text-white/10">
                  0{i + 1}
                </span>
                <div className="mb-4 grid h-10 w-10 place-items-center rounded-xl bg-white/5 text-[#7dd3fc]">
                  {s.icon}
                </div>
                <h3 className="text-[14px] font-semibold text-white">{s.title}</h3>
                <p className="mt-2 text-[12.5px] leading-relaxed text-[#9499a3]">{s.desc}</p>
              </div>
            ))}
          </div>
          <div className="glass mx-auto mt-6 flex max-w-2xl items-start gap-3 rounded-2xl p-5 text-[12.5px] leading-relaxed text-[#9499a3]">
            <BatteryCharging size={16} className="mt-0.5 shrink-0 text-[#3ddc84]" />
            <p>
              <b className="text-[#cfd4dc]">Nota:</b> el teléfono permanece conectado por USB
              durante toda la sesión (WebUSB no funciona por Wi-Fi). El display virtual se
              cierra limpiamente al desconectar — scrcpy no deja nada instalado en el
              dispositivo.
            </p>
          </div>
        </section>

        {/* ── Footer / créditos ── */}
        <footer className="border-t border-white/8 py-8 text-center">
          <p className="text-[12.5px] text-[#9499a3]">
            DexPort — port web del proyecto{" "}
            <a
              href="https://github.com/Shrey113/Android-Dex"
              target="_blank"
              rel="noreferrer"
              className="text-[#3ddc84] underline-offset-4 hover:underline"
            >
              Android DEX de Shrey113
            </a>
          </p>
          <p className="mt-2 font-mono text-[11px] text-[#5a606c]">
            construido con WebADB (@yume-chan/ya-webadb) · scrcpy 3.3.3 · React + Vite ·
            desplegado en Vercel
          </p>
        </footer>
      </div>
    </div>
  );
}
