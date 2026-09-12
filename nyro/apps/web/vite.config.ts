import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Folds DEMO_MODE to false so the browser-demo code is dropped at build time
  // rather than shipped as chunks the real app never loads.
  define: { "import.meta.env.VITE_NYRO_DEMO": JSON.stringify("false") },
  server: {
    port: 5173,
    // The browser only ever talks to the NYRO API. It has no provider URLs,
    // no API keys, and no knowledge that Ollama exists (spec §113).
    proxy: {
      "/api": {
        target: process.env["NYRO_API_URL"] ?? "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
