import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./globals.css";
import App from "./App";

// StrictMode está desactivado: los efectos de arranque WebUSB/scrcpy no son
// idempotentes y el doble-montaje de desarrollo rompería la conexión ADB.
createRoot(document.getElementById("root")!).render(<App />);
