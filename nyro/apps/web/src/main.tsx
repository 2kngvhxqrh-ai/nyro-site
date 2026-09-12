import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App.tsx";
import { DEMO_MODE } from "./demo-mode.ts";

/**
 * Demo mode replaces the API with an in-browser core so the UI can run with no
 * server. The UI itself is unchanged — it still only speaks to /api/*, which is
 * the point: if it needed special-casing here, the frontend would have provider
 * knowledge it should not have.
 *
 * This is an async function rather than a top-level await: top-level await
 * requires an es2022 target, and forcing that on the real production build to
 * support a demo would be the tail wagging the dog.
 */
async function start(): Promise<void> {
  if (DEMO_MODE) {
    // Installed before React mounts, so the very first request is intercepted.
    const { installBrowserNyro } = await import("./demo/in-browser-nyro.ts");
    installBrowserNyro();
  }

  const el = document.getElementById("root");
  if (!el) throw new Error("#root not found");

  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
