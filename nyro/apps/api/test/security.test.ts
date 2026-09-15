/**
 * Security tests (spec §68, §120, §121).
 * These check the promises that, if broken, leak the user's API keys.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, parseMasterKey, secretFingerprint, secretHint } from "../src/util/crypto.ts";
import { redact, redactString, REDACTED } from "../src/util/redact.ts";
import { NyroError } from "../src/core/errors.ts";

const KEY = randomBytes(32);

describe("secret encryption", () => {
  test("round-trips a value", () => {
    const secret = "sk-ant-api03-abcdefghijklmnop";
    assert.equal(decryptSecret(encryptSecret(secret, KEY), KEY), secret);
  });

  test("the same plaintext encrypts differently each time (random IV)", () => {
    const a = encryptSecret("same", KEY);
    const b = encryptSecret("same", KEY);
    assert.notEqual(a, b, "identical ciphertexts would leak that two providers share a key");
    assert.equal(decryptSecret(a, KEY), decryptSecret(b, KEY));
  });

  test("ciphertext does not contain the plaintext", () => {
    const secret = "sk-super-secret-value-123456";
    assert.ok(!encryptSecret(secret, KEY).includes(secret));
  });

  test("a tampered ciphertext fails authentication rather than returning garbage", () => {
    const packed = encryptSecret("tamper-me", KEY);
    const parts = packed.split(".");
    const ct = Buffer.from(parts[3]!, "base64url");
    ct[0] = ct[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], ct.toString("base64url")].join(".");
    assert.throws(() => decryptSecret(tampered, KEY), (e: unknown) => e instanceof NyroError);
  });

  test("the wrong master key cannot decrypt", () => {
    const packed = encryptSecret("value", KEY);
    assert.throws(() => decryptSecret(packed, randomBytes(32)), (e: unknown) => e instanceof NyroError);
  });

  test("a malformed stored secret is a clear error", () => {
    assert.throws(() => decryptSecret("garbage", KEY), (e: unknown) => e instanceof NyroError && e.code === "config_error");
  });

  test("parseMasterKey accepts base64 and hex, and rejects the wrong length", () => {
    assert.equal(parseMasterKey(randomBytes(32).toString("base64")).length, 32);
    assert.equal(parseMasterKey(randomBytes(32).toString("hex")).length, 32);
    assert.throws(() => parseMasterKey(undefined), (e: unknown) => e instanceof NyroError);
    assert.throws(() => parseMasterKey(randomBytes(16).toString("base64")), (e: unknown) => e instanceof NyroError);
  });

  test("hint and fingerprint reveal nothing usable", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz";
    const hint = secretHint(secret);
    assert.equal(hint, "…wxyz");
    assert.ok(!secretFingerprint(secret).includes("abcdefgh"));
  });
});

describe("redaction", () => {
  test("sensitive keys are redacted at any nesting depth", () => {
    const out = redact({
      ok: "visible",
      apiKey: "sk-leak-me",
      nested: { authorization: "Bearer xyz", deep: { password: "hunter2" } },
    }) as Record<string, unknown>;
    assert.equal(out["ok"], "visible");
    assert.equal(out["apiKey"], REDACTED);
    const nested = out["nested"] as Record<string, unknown>;
    assert.equal(nested["authorization"], REDACTED);
    assert.equal((nested["deep"] as Record<string, unknown>)["password"], REDACTED);
  });

  test("known key shapes are redacted even in a free-text field", () => {
    for (const leak of [
      "sk-proj-abcdefghijklmnopqrstuv",
      "sk-ant-api03-abcdefghijklmnop",
      "gsk_abcdefghijklmnopqrstuvwxyz",
      "xai-abcdefghijklmnopqrstuvwxyz",
      "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456",
    ]) {
      const out = redactString(`upstream said: ${leak} is invalid`);
      assert.ok(!out.includes(leak), `failed to redact ${leak.slice(0, 8)}…`);
      assert.ok(out.includes(REDACTED));
    }
  });

  test("redaction survives arrays and errors", () => {
    const out = redact([{ token: "abc" }, new Error("sk-proj-abcdefghijklmnopqrstuv failed")]) as unknown[];
    assert.equal((out[0] as Record<string, unknown>)["token"], REDACTED);
    assert.ok(!String(out[1]).includes("sk-proj-abcdefghijklmnopqrstuv"));
  });

  test("redaction terminates on a cyclic object", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    assert.doesNotThrow(() => redact(cyclic));
  });
});

describe("error surfaces", () => {
  test("toPublic never includes the detail field", () => {
    const e = new NyroError("provider_auth", "Bad key.", { component: "test", detail: "sk-leak-me-123456789012" });
    const pub = JSON.stringify(e.toPublic());
    assert.ok(!pub.includes("sk-leak-me"));
    assert.ok(!pub.includes("detail"));
  });

  test("cancellation is not retryable; a rate limit is", () => {
    assert.equal(new NyroError("cancelled", "x", { component: "t" }).retryable, false);
    assert.equal(new NyroError("provider_rate_limited", "x", { component: "t" }).retryable, true);
  });
});
