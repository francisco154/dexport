import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "zustand"],
          engine: [
            "@yume-chan/adb",
            "@yume-chan/adb-credential-web",
            "@yume-chan/adb-daemon-webusb",
            "@yume-chan/adb-scrcpy",
            "@yume-chan/scrcpy",
            "@yume-chan/scrcpy-decoder-webcodecs",
            "@yume-chan/scrcpy-decoder-tinyh264",
            "@yume-chan/stream-extra",
          ],
        },
      },
    },
  },
  server: {
    headers: {
      // WebUSB requires a secure context; localhost is already secure.
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
});
