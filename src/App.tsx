/**
 * DexPort — App raíz
 * ════════════════════════════════════════════════════════════
 * Máquina de fases: landing → boot → desktop.
 * El DesktopShell se monta desde el arranque para que el canvas
 * del display exista cuando el motor scrcpy arranque.
 */

import { useStore } from "./store/store";
import { Landing } from "./components/Landing";
import { BootScreen } from "./components/BootScreen";
import { DesktopShell } from "./components/DesktopShell";

export default function App() {
  const phase = useStore((s) => s.phase);

  return (
    <div className="h-full w-full overflow-hidden bg-[#090a0c]">
      {phase === "landing" && <Landing />}
      {phase !== "landing" && <DesktopShell />}
      {phase === "boot" && <BootScreen />}
    </div>
  );
}
