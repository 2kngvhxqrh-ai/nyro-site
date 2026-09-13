import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

/**
 * Demo build.
 *
 * Differs from the normal build in three ways, all forced by the artifact
 * sandbox: relative asset paths (the page is not served from a domain root),
 * no code splitting or asset hashing (fewer files to publish), and a single
 * CSS file. Everything else — including the bundled real router — is identical.
 */
/**
 * Copies artifact.html into the build output.
 *
 * Claude Artifacts supply their own <!doctype>/<html>/<head>/<body>, so the
 * published page must contain only NYRO's head content and mount point —
 * index.html cannot be used as-is. Keeping the shell in source control (rather
 * than hand-editing dist-demo after each build) means the publish is
 * reproducible from `pnpm build:demo`.
 *
 * The shell names its assets by hand, so it can drift from what the build
 * actually emits — it referenced a preload chunk Rollup had stopped emitting,
 * which a browser silently 404s. Every local reference is therefore checked
 * against the bundle, and a stale one fails the build.
 */
function emitArtifactShell() {
  return {
    name: "nyro-artifact-shell",
    async generateBundle(
      this: { emitFile: (f: { type: "asset"; fileName: string; source: string }) => void },
      _options: unknown,
      bundle: Record<string, unknown>,
    ) {
      const { readFile } = await import("node:fs/promises");
      const source = await readFile(resolve(__dirname, "artifact.html"), "utf8");

      const referenced = [...source.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((m) => m[1]!);
      const missing = referenced.filter((name) => !(name in bundle));
      if (missing.length > 0) {
        throw new Error(
          `artifact.html references ${missing.map((n) => `"${n}"`).join(", ")}, ` +
            `which the demo build does not emit. Emitted: ${Object.keys(bundle).join(", ")}.`,
        );
      }

      this.emitFile({ type: "asset", fileName: "artifact.html", source });
    },
  };
}

/** The demo is a distinct artifact, so it carries its own name in the tab. */
function demoTitle() {
  return {
    name: "nyro-demo-title",
    transformIndexHtml(html: string) {
      return html.replace("<title>NYRO</title>", "<title>NYRO Model Router</title>");
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), demoTitle(), emitArtifactShell()],
  base: "./",
  define: { "import.meta.env.VITE_NYRO_DEMO": JSON.stringify("true") },
  build: {
    outDir: "dist-demo",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      output: {
        entryFileNames: "nyro.js",
        chunkFileNames: "nyro-[name].js",
        assetFileNames: "nyro[extname]",
        manualChunks: undefined,
      },
    },
  },
  resolve: {
    alias: { "@api": resolve(__dirname, "../api/src") },
  },
});
