/**
 * DexPort v6 — tests del motor de display y del protocolo del fork
 * ════════════════════════════════════════════════════════════
 * Ejecutar: node scripts/test-display-v6.mjs
 * (usa esbuild para compilar src/utils/displayMath.ts sin navegador)
 */

import { build } from "esbuild";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

// compilar el módulo puro a CJS temporal
const outfile = join(tmpdir(), "dexport-displaymath.cjs");
await build({
  entryPoints: [join(process.cwd(), "src/utils/displayMath.ts")],
  outfile,
  bundle: true,
  format: "cjs",
  platform: "node",
  logLevel: "silent",
});
const { computeDisplaySizeForContainer, buildResizeDisplayMessage, transformForkArgs } =
  await import(outfile);

console.log("── v6: mensaje RESIZE_DISPLAY (fork tipo 18) ──");
{
  // 1920 = 0x0780, 1080 = 0x0438
  const m = buildResizeDisplayMessage(1920, 1080);
  check("tipo de mensaje = 18 (TYPE_RESIZE_DISPLAY del fork)", m[0] === 18);
  check("width uint16 BE (1920)", m[1] === 0x07 && m[2] === 0x80, `→ ${[...m]}`);
  check("height uint16 BE (1080)", m[3] === 0x04 && m[4] === 0x38);
  check("longitud total = 5", m.length === 5);
  const m2 = buildResizeDisplayMessage(2560, 1440);
  check("2560 → 0x0A00", m2[1] === 0x0a && m2[2] === 0x00);
  const m3 = buildResizeDisplayMessage(1366, 768);
  check("1366 → 0x0556", m3[1] === 0x05 && m3[2] === 0x56);
}

console.log("── v6: tamaño del display según la ventana (fitToWindow) ──");
{
  // 16:9 clásico
  let s = computeDisplaySizeForContainer(1600, 900, 1920);
  check("1600×900 @1920 → 1920×1080", s.width === 1920 && s.height === 1080, `→ ${s.width}x${s.height}`);
  // 16:10
  s = computeDisplaySizeForContainer(1600, 1000, 1920);
  check("1600×1000 @1920 → 1920×1200", s.width === 1920 && s.height === 1200, `→ ${s.width}x${s.height}`);
  // ultra-wide 21:9
  s = computeDisplaySizeForContainer(2100, 900, 2560);
  check(
    "21:9 @2560 → 2560×~1096 (múltiplo de 8)",
    s.width === 2560 && s.height % 8 === 0 && Math.abs(s.height - 1097) <= 8,
    `→ ${s.width}x${s.height}`,
  );
  // ventana alta (portrait)
  s = computeDisplaySizeForContainer(900, 1600, 1920);
  check("portrait 900×1600 @1920 → 1080×1920", s.width === 1080 && s.height === 1920, `→ ${s.width}x${s.height}`);
  // contenedor degenerado → sin NaN
  s = computeDisplaySizeForContainer(0, 0, 1920);
  check("contenedor 0×0 no produce NaN", Number.isFinite(s.width) && Number.isFinite(s.height));
  // tamaño mínimo
  s = computeDisplaySizeForContainer(300, 200, 640);
  check("mínimo respetado (≥320)", s.width >= 320 && s.height >= 320, `→ ${s.width}x${s.height}`);
  // todos múltiplos de 8
  const t = computeDisplaySizeForContainer(1234, 777, 1777);
  check("siempre múltiplos de 8", t.width % 8 === 0 && t.height % 8 === 0);
}

console.log("── v6: transformación del comando al fork del original ──");
{
  const base = [
    "CLASSPATH=/data/local/tmp/scrcpy-server.jar",
    "app_process",
    "/",
    "com.genymobile.scrcpy.Server",
    "3.3.3",
    "video=true",
    "new_display=1920x1080/160",
    "stay_awake=true",
  ];
  let out = transformForkArgs(base, ["screen_off_timeout=86400", "display_ime_policy=hide"], true);
  check("clase sustituida por el fork", out[3] === "com.shrey.re_size_scrcpy.Server");
  check("new_display lleva el marcador :r", out[6] === "new_display=1920x1080/160:r");
  check("extras añadidos al final", out.includes("screen_off_timeout=86400") && out.includes("display_ime_policy=hide"));
  check("el comando original NO se muta", base[3] === "com.genymobile.scrcpy.Server" && !base[6].endsWith(":r"));

  // sin :r (modo espejo)
  out = transformForkArgs(base, [], false);
  check("resizable=false → sin :r", out[6] === "new_display=1920x1080/160");

  // no duplicar extras ya presentes
  out = transformForkArgs(
    [...base, "display_ime_policy=hide"],
    ["display_ime_policy=hide", "screen_off_timeout=86400"],
    true,
  );
  check(
    "extras ya presentes NO se duplican",
    out.filter((a) => a.startsWith("display_ime_policy")).length === 1,
  );

  // comando sin la clase estándar → no romper
  out = transformForkArgs(["echo", "hola"], [], true);
  check("comando sin clase scrcpy queda igual", out[0] === "echo" && out.length === 2);

  // formato real de la librería: vd_system_decorations=false presente
  out = transformForkArgs(
    [...base, "vd_system_decorations=false", "max_fps=60"],
    ["screen_off_timeout=86400"],
    true,
  );
  check(
    "args de la librería se conservan",
    out.includes("vd_system_decorations=false") && out.includes("max_fps=60"),
  );
}

console.log("");
console.log(`Resultado: ${passed} ✓ / ${failed} ✗`);
process.exit(failed > 0 ? 1 : 0);
