#!/usr/bin/env node
/**
 * Build the UI, apply migrations, then run NYRO as a single process serving
 * both the API and the web app on one port.
 *
 * This is the "just run it" path. `pnpm dev` remains the development path,
 * where Vite serves the UI with hot reload and proxies /api.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: "inherit",
      shell: isWindows, // npm/pnpm are .cmd shims on Windows
      ...opts,
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}`)),
    );
  });
}

try {
  await access(join(root, ".env"));
} catch {
  console.error("\nNo .env found. Run:  pnpm setup\n");
  process.exit(1);
}

console.log("\n[1/3] Building the web app…");
await run("pnpm", ["--filter", "@nyro/web", "build"]);

console.log("\n[2/3] Applying database migrations…");
await run("pnpm", ["--filter", "@nyro/api", "migrate"]);

console.log("\n[3/3] Starting NYRO…");
await run(
  "node",
  ["--env-file-if-exists=../../.env", "--experimental-strip-types", "src/main.ts"],
  {
    cwd: join(root, "apps", "api"),
    env: {
      ...process.env,
      // The API serves the built UI, so there is one process and one origin.
      NYRO_STATIC_DIR: join(root, "apps", "web", "dist"),
    },
  },
);
