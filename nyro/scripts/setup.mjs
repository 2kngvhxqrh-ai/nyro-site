#!/usr/bin/env node
/**
 * First-run setup.
 *
 * Creates .env from .env.example and generates NYRO_SECRET_KEY. Written in
 * Node rather than shell so it works the same on Windows, where the primary
 * NYRO environment lives and where `openssl` is often absent.
 *
 * Never overwrites an existing .env: regenerating the key would silently make
 * every stored provider API key undecryptable.
 */
import { randomBytes } from "node:crypto";
import { readFile, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
const examplePath = join(root, ".env.example");

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

if (await exists(envPath)) {
  const current = await readFile(envPath, "utf8");
  const hasKey = /^NYRO_SECRET_KEY=.+$/m.test(current);
  console.log(`.env already exists — leaving it alone.`);
  if (!hasKey) {
    console.log(`\n  WARNING: NYRO_SECRET_KEY is empty. NYRO will refuse to start.`);
    console.log(`  Add one:  NYRO_SECRET_KEY=${randomBytes(32).toString("base64")}\n`);
    process.exitCode = 1;
  }
} else {
  const example = await readFile(examplePath, "utf8");
  const key = randomBytes(32).toString("base64");
  await writeFile(envPath, example.replace(/^NYRO_SECRET_KEY=$/m, `NYRO_SECRET_KEY=${key}`));
  console.log(`Created .env with a freshly generated NYRO_SECRET_KEY.`);
  console.log(`\n  Back this key up. If it is lost, stored provider API keys cannot be decrypted.\n`);
}
