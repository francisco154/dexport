/**
 * Test del parser parseTasks con salidas realistas de dumpsys.
 * Se ejecuta con: npx esbuild test-parse.ts --bundle --format=cjs --outfile=/tmp/test-parse.cjs && node /tmp/test-parse.cjs
 */
import { parseTasks, parseCurrentFocus } from "../src/utils/telemetry";

// ── Android 13/14 (formato displayId= / * Task{} / * ActivityRecord{}) ──
const DUMP_A13 = `
ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
  displayId=0 rootTaskId=1
  * Task{9c3a24c #1 type=home A=10285:com.google.android.apps.nexuslauncher U=0 visible=true}
    * ActivityRecord{1a2b3c4 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t1}
  displayId=2 rootTaskId=44
  * Task{8f2f6a1 #44 type=standard A=10285:com.whatsapp U=0 visible=true}
    * ActivityRecord{5e4d3c2 u0 com.whatsapp/.Home t44}
  * Task{7a1b2c3 #45 type=standard A=10285:com.android.chrome U=0 visible=false}
    * ActivityRecord{9f8e7d6 u0 com.android.chrome/com.google.android.apps.chrome.Main t45}
  * Task{2c3d4e5 #46 type=home A=10285:com.binary.hyperdroid U=0 visible=false}
    * ActivityRecord{4b5c6d7 u0 com.binary.hyperdroid/.HomeActivity t46}
`;

// ── Android 10/11 (formato Display #N / TaskRecord / Hist #) ──
const DUMP_A11 = `
ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
Display #0 (activities from global stack):
  ResumedActivity: ActivityRecord{abc1234 u0 com.android.launcher3/.Launcher t12}
  Hist #1: ActivityRecord{def5678 u0 com.whatsapp/.Home t42}
  Hist #0: ActivityRecord{abc1234 u0 com.android.launcher3/.Launcher t12}
Display #2 (activities from global stack):
  Hist #0: ActivityRecord{aaa1111 u0 com.binary.hyperdroid/.HomeActivity t55}
  TaskRecord{bbb2222 #55 A=10285:com.binary.hyperdroid u0}
`;

// ── Samsung One UI (mixto, sin displayId en Task) ──
const DUMP_SAMSUNG = `
  Display #2
    mResumedActivity: ActivityRecord{xy12 u0 com.sec.android.app.launcher/.Launcher t77}
    Task{abc111 #77 type=home A=10250:com.sec.android.app.launcher U=0 visible=true}
      Hist #0: ActivityRecord{xy12 u0 com.sec.android.app.launcher/.Launcher t77}
    Task{def222 #78 A=10285:com.sec.android.app.sbrowser U=0 visible=true}
      Hist #0: ActivityRecord{zz34 u0 com.sec.android.app.sbrowser/.SBrowserMainActivity t78}
`;

const FOCUS = `mCurrentFocus=Window{7a1b u0 com.whatsapp/com.whatsapp.Home}`;
const FOCUS_LAUNCHER = `mCurrentFocus=Window{9c3a u0 com.binary.hyperdroid/com.binary.hyperdroid.HomeActivity}`;

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("✗ FALLO:", msg);
    process.exitCode = 1;
  } else {
    console.log("✓", msg);
  }
}

// ── A13 ──
const a13 = parseTasks(DUMP_A13, FOCUS);
assert(a13.length === 4, `A13: 4 tareas (got ${a13.length})`);
const wa = a13.find((t) => t.packageName === "com.whatsapp");
assert(!!wa, "A13: whatsapp presente");
assert(wa!.taskId === 44, "A13: whatsapp taskId=44");
assert(wa!.displayId === 2, "A13: whatsapp en display 2");
assert(wa!.activity === "com.whatsapp/.Home", `A13: activity whatsapp (got ${wa!.activity})`);
assert(wa!.focused === true, "A13: whatsapp enfocada (por mCurrentFocus)");
const chrome = a13.find((t) => t.packageName === "com.android.chrome");
assert(chrome!.visible === false, "A13: chrome visible=false");
assert(chrome!.activity === "com.android.chrome/com.google.android.apps.chrome.Main", "A13: activity chrome completa");

// ── A11 ──
const a11 = parseTasks(DUMP_A11, FOCUS_LAUNCHER);
const hyper = a11.find((t) => t.packageName === "com.binary.hyperdroid");
assert(!!hyper && hyper.displayId === 2, "A11: hyperdroid en display 2");
assert(hyper!.activity === "com.binary.hyperdroid/.HomeActivity", `A11: activity hyperdroid (got ${hyper!.activity})`);
const wa11 = a11.find((t) => t.packageName === "com.whatsapp");
assert(!!wa11 && wa11.displayId === 0, "A11: whatsapp en display 0 (Hist)");

// ── Samsung ──
const sam = parseTasks(DUMP_SAMSUNG, null as unknown as string | undefined);
assert(sam.length === 2, `Samsung: 2 tareas (got ${sam.length})`);
const sb = sam.find((t) => t.packageName === "com.sec.android.app.sbrowser");
assert(!!sb && sb.taskId === 78 && sb.displayId === 2, "Samsung: browser taskId 78 display 2");
assert(sb!.activity === "com.sec.android.app.sbrowser/.SBrowserMainActivity", `Samsung: activity browser (got ${sb!.activity})`);
// launcher (top del display) queda enfocado cuando no hay info de foco
const secLauncher = sam.find((t) => t.packageName === "com.sec.android.app.launcher");
assert(secLauncher!.focused === true, "Samsung: launcher top=focused");

// ── foco ──
assert(parseCurrentFocus(FOCUS) === "com.whatsapp", "parseCurrentFocus whatsapp");
assert(parseCurrentFocus(FOCUS_LAUNCHER) === "com.binary.hyperdroid", "parseCurrentFocus hyperdroid");

// ── vacío ──
assert(parseTasks("").length === 0, "vacío → []");

console.log("\nResultado:", process.exitCode ? "CON ERRORES" : "TODO OK");
