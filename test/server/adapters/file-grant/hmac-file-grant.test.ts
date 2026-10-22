import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HmacFileGrantVerifier, parseFileGrantKey, signFileGrant } from "../../../../src/server/adapters/file-grant/hmac-file-grant.ts";
import { FILE_GRANT_TTL_MS } from "../../../../src/shared/defaults.ts";

const NOW = 1_000_000;

describe("HmacFileGrantVerifier", () => {
  const key = randomBytes(32);
  const verifier = new HmacFileGrantVerifier(key, () => NOW);
  const grant = signFileGrant(key, { path: "/videos/a.mp4", purpose: "local_file", expiresAt: NOW + FILE_GRANT_TTL_MS });

  it("accepts an unexpired grant for exactly the picked path and purpose", () => {
    expect(verifier.verify(grant, { path: "/videos/a.mp4", purpose: "local_file" })).toBe(true);
  });

  it("rejects another path, another purpose, expiry, an overlong lifetime and a forged signature", () => {
    expect(verifier.verify(grant, { path: "/etc/passwd", purpose: "local_file" })).toBe(false);
    expect(verifier.verify({ ...grant, path: "/etc/passwd" }, { path: "/etc/passwd", purpose: "local_file" })).toBe(false);
    expect(verifier.verify(grant, { path: "/videos/a.mp4", purpose: "relink" })).toBe(false);
    expect(new HmacFileGrantVerifier(key, () => NOW + FILE_GRANT_TTL_MS).verify(grant, { path: "/videos/a.mp4", purpose: "local_file" })).toBe(false);
    const overlong = signFileGrant(key, { path: "/videos/a.mp4", purpose: "local_file", expiresAt: NOW + FILE_GRANT_TTL_MS + 1 });
    expect(verifier.verify(overlong, { path: "/videos/a.mp4", purpose: "local_file" })).toBe(false);
    const otherKey = signFileGrant(randomBytes(32), { path: "/videos/a.mp4", purpose: "local_file", expiresAt: NOW + 1000 });
    expect(verifier.verify(otherKey, { path: "/videos/a.mp4", purpose: "local_file" })).toBe(false);
    expect(verifier.verify({ ...grant, sig: "AAAA" }, { path: "/videos/a.mp4", purpose: "local_file" })).toBe(false);
  });

  it("requires a 32-byte base64url key", () => {
    expect(parseFileGrantKey(randomBytes(32).toString("base64url")).length).toBe(32);
    for (const bad of [undefined, "", "short", randomBytes(16).toString("base64url"), `${randomBytes(32).toString("base64")}==`]) {
      expect(() => parseFileGrantKey(bad)).toThrow(/AMBER_FILE_GRANT_KEY/);
    }
  });
});

// Known-answer vectors shared verbatim with the desktop shell's signer and verifier: both
// sides must agree on the signed bytes (UTF-8 `purpose|path|expiresAt`) and the encoding.
const KAT_KEY = Buffer.from("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", "base64url");
const KAT_VECTORS = [
  { purpose: "local_file", path: "C:\\Users\\测试 用户\\Videos\\lecture 1.mp4", expiresAt: 1767225600000, sig: "VYYCA1fnKrVJwZYiup-qcp7W-3Z1rHpOURT3ynl14To" },
  {
    purpose: "burn_output",
    path: "C:\\Users\\测试 用户\\AppData\\Roaming\\Amber\\assets\\u1\\c1\\a1",
    expiresAt: 1767225900000,
    sig: "SKmzcEZo2nOZDrKclgOluQG9ci2UOaD2GViMRoq5VfE",
  },
  { purpose: "relink", path: "/home/amber/视频/第 2 讲.mkv", expiresAt: 1767225600123, sig: "WxvKTAj1FJujtvxozGJ2ZR8J6RTNw33y5lPdPAgb-js" },
  { purpose: "cache_dir", path: "D:\\Amber Cache", expiresAt: 1767226200000, sig: "DozJ0x_XB54SCE358IOqi8PHZxtMcRT5xmIZZjLLiOM" },
  {
    purpose: "cache_save",
    path: "C:\\Users\\测试 用户\\AppData\\Roaming\\Amber\\media\\第 1 讲 (2).mp4",
    expiresAt: 1767226500000,
    sig: "pVNVlwJu7bPMB5W5GafJ4Q5kTVcjaLhy4pwBPlUpLqI",
  },
] as const;

describe("file grant known-answer vectors", () => {
  it("uses the key 0x00..0x1f", () => {
    expect([...KAT_KEY]).toEqual(Array.from({ length: 32 }, (_, index) => index));
  });

  it.each(KAT_VECTORS)("signs and verifies the $purpose vector", (vector) => {
    const { sig, ...unsigned } = vector;
    expect(signFileGrant(KAT_KEY, unsigned).sig).toBe(sig);
    const verifier = new HmacFileGrantVerifier(KAT_KEY, () => vector.expiresAt - 1);
    expect(verifier.verify({ ...vector }, { path: vector.path, purpose: vector.purpose })).toBe(true);
    expect(verifier.verify({ ...vector, sig: sig.replace(/^./, (first) => (first === "A" ? "B" : "A")) }, { path: vector.path, purpose: vector.purpose })).toBe(false);
  });
});

describe("HmacFileGrantVerifier.issue", () => {
  it("keeps purpose and path, expires FILE_GRANT_TTL_MS from now and verifies under the same key", () => {
    const key = randomBytes(32);
    const verifier = new HmacFileGrantVerifier(key, () => NOW);
    const issued = verifier.issue({ path: "/data/assets/local/c1/a1", purpose: "burn_output" });
    expect(issued).toMatchObject({ path: "/data/assets/local/c1/a1", purpose: "burn_output", expiresAt: NOW + FILE_GRANT_TTL_MS });
    expect(issued.sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifier.verify(issued, { path: "/data/assets/local/c1/a1", purpose: "burn_output" })).toBe(true);
    expect(new HmacFileGrantVerifier(randomBytes(32), () => NOW).verify(issued, { path: "/data/assets/local/c1/a1", purpose: "burn_output" })).toBe(false);
  });

  it("signs cache_save grants that verify only for that purpose", () => {
    const verifier = new HmacFileGrantVerifier(randomBytes(32), () => NOW);
    const issued = verifier.issue({ path: "/data/media/第 1 讲.mp3", purpose: "cache_save" });
    expect(verifier.verify(issued, { path: "/data/media/第 1 讲.mp3", purpose: "cache_save" })).toBe(true);
    expect(verifier.verify(issued, { path: "/data/media/第 1 讲.mp3", purpose: "burn_output" })).toBe(false);
  });
});
