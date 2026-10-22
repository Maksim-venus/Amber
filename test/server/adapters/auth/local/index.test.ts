import { describe, expect, it } from "vitest";
import { LocalAuthAdapter } from "../../../../../src/server/adapters/auth/local/index.ts";

const TOKEN = "t".repeat(64);

describe("LocalAuthAdapter", () => {
  const adapter = new LocalAuthAdapter(TOKEN);

  it("maps the sidecar token to the implicit local admin", () => {
    expect(adapter.authenticate({ headers: { authorization: `Bearer ${TOKEN}` } })).toEqual({ userId: "local", mode: "local", role: "admin", mustChangePassword: false });
  });

  it("rejects a missing, wrong, differently sized or non-bearer credential", () => {
    for (const authorization of [undefined, `Bearer ${"u".repeat(64)}`, `Bearer ${TOKEN}x`, `Basic ${TOKEN}`, TOKEN, ["Bearer", TOKEN]]) {
      expect(adapter.authenticate({ headers: { authorization } })).toBeNull();
    }
  });
});
