import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
