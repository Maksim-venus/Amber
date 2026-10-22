import { describe, expect, it } from "vitest";
import { createLogger, REDACTED, redactFields, redactText, type StructuredLogSink } from "../../../../src/server/adapters/logger/index.ts";

const KEY = "placeholder-key-0000";

describe("redaction", () => {
  it("masks sensitive field names at any depth and keeps the rest", () => {
    expect(
      redactFields({ apiKey: KEY, nested: { Cookie: KEY, list: [{ password: KEY, ok: 1 }] }, value: KEY, credentialRef: "ref", stage: "asr" }),
    ).toEqual({ apiKey: REDACTED, nested: { Cookie: REDACTED, list: [{ password: REDACTED, ok: 1 }] }, value: REDACTED, credentialRef: "ref", stage: "asr" });
  });

  it("masks the server-mode login material: session cookies, the setup token and passwords", () => {
    expect(
      redactFields({ "set-cookie": KEY, "x-amber-setup-token": KEY, newPassword: KEY, currentPassword: KEY, username: "alice" }),
    ).toEqual({ "set-cookie": REDACTED, "x-amber-setup-token": REDACTED, newPassword: REDACTED, currentPassword: REDACTED, username: "alice" });
  });

  it("masks authorization schemes and key-named query parameters inside text", () => {
    expect(redactText(`GET /x?token=${KEY}&page=2 with Bearer ${KEY}`)).toBe(`GET /x?token=${REDACTED}&page=2 with Bearer ${REDACTED}`);
    expect(redactText(`/v1?api%5Fkey=${KEY}`)).toBe(`/v1?api%5Fkey=${REDACTED}`);
  });

  it("reduces errors to name and redacted message", () => {
    expect(redactFields(new TypeError(`bad Bearer ${KEY}`))).toEqual({ name: "TypeError", message: `bad Bearer ${REDACTED}` });
  });
});

describe("createLogger", () => {
  it("redacts every field set, child bindings included, before the sink sees it", () => {
    const seen: unknown[] = [];
    const sink: StructuredLogSink = {
      debug: (fields, message) => void seen.push([message, fields]),
      info: (fields, message) => void seen.push([message, fields]),
      warn: (fields, message) => void seen.push([message, fields]),
      error: (fields, message) => void seen.push([message, fields]),
      child: (bindings) => {
        seen.push(["child", bindings]);
        return sink;
      },
    };
    const logger = createLogger(sink).child({ secret: KEY, component: "x" });
    logger.warn("m", { authorization: KEY });
    expect(seen).toEqual([
      ["child", { secret: REDACTED, component: "x" }],
      ["m", { authorization: REDACTED }],
    ]);
    expect(JSON.stringify(seen)).not.toContain(KEY);
  });
});
