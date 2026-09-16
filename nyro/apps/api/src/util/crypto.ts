/**
 * Secrets at rest (spec §68).
 *
 * AES-256-GCM with a random 12-byte IV per record. The master key comes from
 * NYRO_SECRET_KEY (32 bytes, base64 or hex). Ciphertext is stored in Postgres;
 * plaintext exists only in memory, only inside a provider adapter, and is
 * never logged or returned by the API.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { NyroError } from "../core/errors.ts";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

export function parseMasterKey(raw: string | undefined): Buffer {
  if (!raw || raw.trim() === "") {
    throw new NyroError("config_error", "NYRO_SECRET_KEY is not set. Generate one with: openssl rand -base64 32", {
      component: "crypto",
    });
  }
  const trimmed = raw.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) key = Buffer.from(trimmed, "hex");
  else key = Buffer.from(trimmed, "base64");

  if (key.length !== 32) {
    throw new NyroError("config_error", `NYRO_SECRET_KEY must decode to 32 bytes (got ${key.length}).`, {
      component: "crypto",
    });
  }
  return key;
}

/** Returns a compact `v1.<iv>.<tag>.<ciphertext>` string, all base64url. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(packed: string, key: Buffer): string {
  const parts = packed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new NyroError("config_error", "Stored secret is malformed or from an unknown version.", { component: "crypto" });
  }
  const iv = Buffer.from(parts[1]!, "base64url");
  const tag = Buffer.from(parts[2]!, "base64url");
  const ct = Buffer.from(parts[3]!, "base64url");
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new NyroError("config_error", "Stored secret has an invalid IV or auth tag length.", { component: "crypto" });
  }
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch (cause) {
    throw new NyroError("config_error", "Stored secret could not be decrypted. Has NYRO_SECRET_KEY changed?", {
      component: "crypto",
      cause,
    });
  }
}

/** Non-reversible fingerprint so the UI can say "same key as before" without revealing it. */
export function secretFingerprint(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex").slice(0, 12);
}

/** Last-4 hint for the UI, e.g. "sk-…a1b2". Safe to display. */
export function secretHint(plaintext: string): string {
  if (plaintext.length <= 4) return "…";
  return `…${plaintext.slice(-4)}`;
}
