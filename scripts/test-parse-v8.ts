/**
 * v8: test de los parsers multi-fuente + fusión con el agente.
 * npx esbuild scripts/test-parse-v8.ts --bundle --format=cjs --outfile=/tmp/tp8.cjs && node /tmp/tp8.cjs
 */
import {
  parseTasks,
  parseWindowDump,
  parseStackList,
  splitTaskDump,
  mergeTaskSources,
  type TaskInfo,
} from "../src/utils/telemetry";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("✗ FALLO:", msg);
    process.exitCode = 1;
  } else {
    console.log("✓", msg);
  }
}

// ═══════════ 1. splitTaskDump ═══════════
const raw = [
  "__ACT__",
  "displayId=2 rootTaskId=44",
  "* Task{8f2 #44 type=standard A=1:com.whatsapp U=0 visible=true}",
  "__WIN__",
  "  Window #3 Window{abc u0 com.whatsapp/com.whatsapp.Home}:",
  "    mDisplayId=2 stackId=44",
  "  Window #4 Window{def u0 org.mozilla.firefox/org.mozilla.gecko.BrowserApp}:",
  "    mDisplayId=0 stackId=12",
  "__STACK__",
  "Stack id=44 type=standard activityType=1 bounds=[0,0][1920,1080] displayId=2 userId=0",
  "  taskId=45: com.whatsapp/com.whatsapp.Home type=standard",
  "__FOCUS__",
  "mCurrentFocus=Window{7a1b u0 com.whatsapp/com.whatsapp.Home}",
].join("\n");

const parts = splitTaskDump(raw);
assert(parts.act.includes("com.whatsapp"), "split: act contiene whatsapp");
assert(parts.win.includes("Window #3"), "split: win contiene ventana 3");
assert(parts.stack.includes("Stack id=44"), "split: stack contiene stack 44");
assert(parts.focus.includes("mCurrentFocus"), "split: focus ok");

// ═══════════ 2. parseWindowDump (ventanas con display real) ═══════════
const winDump = [
  "  Window #3 Window{abc u0 com.whatsapp/com.whatsapp.Home}:",
  "    mDisplayId=2 stackId=44",
  "  Window #4 Window{def u0 org.mozilla.firefox/org.mozilla.gecko.BrowserApp}:",
  "    mDisplayId=0 stackId=12",
  "  Window #5 Window{123 u0 com.android.systemui.ImageWallpaper}:",
  "    mDisplayId=0",
  "  Window #6 Window{9f2 u0 com.spotify.music/com.spotify.music.MainActivity}:",
  "    mDisplayId=2",
].join("\n");
const wins = parseWindowDump(winDump);
assert(wins.length === 3, `windows: 3 apps (systemui filtrado) — got ${wins.length}`);
const waWin = wins.find((w) => w.packageName === "com.whatsapp");
assert(!!waWin && waWin.displayId === 2, "windows: whatsapp en display 2");
assert(waWin?.activity === "com.whatsapp/com.whatsapp.Home", "windows: actividad whatsapp");
const ff = wins.find((w) => w.packageName === "org.mozilla.firefox");
assert(!!ff && ff.displayId === 0, "windows: firefox en display 0");
const sp = wins.find((w) => w.packageName === "com.spotify.music");
assert(!!sp && sp.displayId === 2, "windows: spotify en display 2 (freeform VD)");

// ═══════════ 3. parseStackList ═══════════
const stackDump = [
  "Stack id=44 type=standard activityType=1 bounds=[0,0][1920,1080] displayId=2 userId=0",
  "  taskId=45: com.whatsapp/com.whatsapp.Home type=standard",
  "Stack id=1 type=home activityType=1 bounds=[0,0][1080,2400] displayId=0 userId=0",
  "  taskId=5: com.android.launcher3/com.android.launcher3.Launcher type=home",
].join("\n");
const stacks = parseStackList(stackDump);
assert(stacks.length === 2, `stack: 2 tareas — got ${stacks.length}`);
const waStack = stacks.find((t) => t.packageName === "com.whatsapp");
assert(!!waStack && waStack.displayId === 2 && waStack.taskId === 45, "stack: whatsapp id 45 display 2");

// ═══════════ 4. mergeTaskSources — caso A13 puro ═══════════
const actA13 = parseTasks(
  [
    "displayId=0 rootTaskId=1",
    "* Task{a1 #1 type=home A=1:com.android.launcher3 U=0 visible=true}",
    "displayId=2 rootTaskId=44",
    "* Task{b2 #44 type=standard A=1:com.whatsapp U=0 visible=true}",
    "* Task{c3 #46 type=standard A=1:com.android.chrome U=0 visible=false}",
  ].join("\n"),
  "mCurrentFocus=Window{x u0 com.whatsapp/com.whatsapp.Home}",
);
const merged = mergeTaskSources({
  act: actA13,
  windows: [],
  stacks: [],
  focusPkg: "com.whatsapp",
  virtualDisplayId: 2,
});
assert(merged.length === 3, `merge A13: 3 tareas — got ${merged.length}`);
const waM = merged.find((t) => t.packageName === "com.whatsapp");
assert(!!waM && waM.displayId === 2 && waM.focused, "merge A13: whatsapp display 2 enfocada");

// ═══════════ 5. merge — dumpsys VACÍO + agente (API 33+) ═══════════
// escenario: la ROM no lista nada útil pero el agente lo ve TODO
const mergedAgentOnly = mergeTaskSources({
  act: [] as TaskInfo[],
  windows: [],
  stacks: [],
  focusPkg: null,
  virtualDisplayId: 2,
  agent: [
    { packageName: "com.whatsapp", activity: "com.whatsapp/com.whatsapp.Home", title: "WhatsApp", displayId: 2, isActive: true, isFocused: true },
    { packageName: "com.spotify.music", activity: "com.spotify.music/com.spotify.music.MainActivity", title: "Spotify", displayId: 2, isActive: false, isFocused: false },
    { packageName: "com.android.chrome", activity: "com.android.chrome/com.google.android.apps.chrome.Main", title: "Chrome", displayId: 0, isActive: false, isFocused: false },
  ],
});
assert(mergedAgentOnly.length === 3, `merge agente: 3 tareas — got ${mergedAgentOnly.length}`);
const waAg = mergedAgentOnly.find((t) => t.packageName === "com.whatsapp");
assert(!!waAg && waAg.fromAgent && waAg.focused && waAg.title === "WhatsApp", "merge agente: whatsapp exacta con título");
const vdApps = mergedAgentOnly.filter((t) => t.displayId === 2);
assert(vdApps.length === 2, `merge agente: 2 apps en el display virtual — got ${vdApps.length}`);

// ═══════════ 6. merge — agente SIN display (API < 33) + windows ═══════════
const mergedPre33 = mergeTaskSources({
  act: [] as TaskInfo[],
  windows: parseWindowDump(
    [
      "  Window #3 Window{abc u0 com.whatsapp/com.whatsapp.Home}:",
      "    mDisplayId=2 stackId=44",
    ].join("\n"),
  ),
  stacks: [],
  focusPkg: null,
  virtualDisplayId: 2,
  agent: [
    // displayId -1: el agente no puede saberlo en API < 33
    { packageName: "com.whatsapp", activity: "com.whatsapp/com.whatsapp.Home", title: "WhatsApp", displayId: -1, isActive: true, isFocused: true },
  ],
});
const waPre = mergedPre33.find((t) => t.packageName === "com.whatsapp");
assert(!!waPre && waPre.displayId === 2, "merge pre-33: display adoptado del dump de ventanas");
assert(waPre?.title === "WhatsApp" && waPre.fromAgent, "merge pre-33: título del agente conservado");

// ═══════════ 7. merge — actividad del agente gana sobre dump ═══════════
const mergedAct = mergeTaskSources({
  act: [
    {
      taskId: 44,
      packageName: "com.whatsapp",
      activity: null,
      displayId: 2,
      type: "standard",
      visible: true,
      focused: false,
    } as TaskInfo,
  ],
  windows: [],
  stacks: [],
  focusPkg: null,
  virtualDisplayId: 2,
  agent: [
    { packageName: "com.whatsapp", activity: "com.whatsapp/com.whatsapp.Home", title: "", displayId: -1, isActive: false, isFocused: false },
  ],
});
const waAct = mergedAct.find((t) => t.packageName === "com.whatsapp");
assert(waAct?.taskId === 44, "merge: taskId del dump conservado");
assert(waAct?.activity === "com.whatsapp/com.whatsapp.Home", "merge: actividad del agente adoptada");

console.log("\n═══ RESULTADO:", process.exitCode ? "CON ERRORES ✗" : "TODO OK ✓", "═══");
