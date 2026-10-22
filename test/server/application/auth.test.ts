import { afterEach, describe, expect, it } from "vitest";
import { Argon2PasswordHasher } from "../../../src/server/adapters/auth/server/password.ts";
import { ADMIN_PASSWORD_ENV, ADMIN_USERNAME_ENV, ensureAdminBootstrap } from "../../../src/server/application/auth.ts";
import { PASSWORD_MIN_LEN } from "../../../src/shared/defaults.ts";
import { createHarness, type Harness } from "../../fixtures/pipeline/harness.ts";
import { FAST_ARGON2 } from "../../fixtures/server/server-app.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

function setup() {
  const h = createHarness();
  open.push(h);
  return { h, hasher: new Argon2PasswordHasher(FAST_ARGON2) };
}

const PASSWORD = "p".repeat(PASSWORD_MIN_LEN);

describe("ensureAdminBootstrap", () => {
  it("creates the preset administrator once with a forced password change and removes the plaintext", async () => {
    const { h, hasher } = setup();
    const env: NodeJS.ProcessEnv = { [ADMIN_USERNAME_ENV]: " Root ", [ADMIN_PASSWORD_ENV]: PASSWORD, OTHER: "kept" };
    expect(await ensureAdminBootstrap({ repository: h.repository, hasher, env })).toBe("preset_admin_created");
    expect(env).toEqual({ OTHER: "kept" });
    const credential = h.repository.withTransaction((scope) => scope.users.findCredentialByUsername("root"));
    expect(credential?.mustChangePassword).toBe(true);
    expect(credential?.passwordHash).not.toContain(PASSWORD);
    expect(await hasher.verify(credential?.passwordHash ?? "", PASSWORD)).toMatchObject({ valid: true });
    expect(h.repository.withTransaction((scope) => scope.users.get(credential?.userId ?? ""))).toMatchObject({ role: "admin", status: "active" });

    // A later start with the variables still set changes nothing, but still drops them.
    const again: NodeJS.ProcessEnv = { [ADMIN_USERNAME_ENV]: "other", [ADMIN_PASSWORD_ENV]: PASSWORD };
    expect(await ensureAdminBootstrap({ repository: h.repository, hasher, env: again })).toBe("initialized");
    expect(again).toEqual({});
    expect(h.db.prepare("SELECT count(*) AS n FROM user_credential").get()).toEqual({ n: 1 });
  });

  it("asks for the wizard when nothing is preset", async () => {
    const { h, hasher } = setup();
    expect(await ensureAdminBootstrap({ repository: h.repository, hasher, env: {} })).toBe("setup_required");
  });

  it("fails start-up on an unacceptable preset without echoing it", async () => {
    for (const env of [
      { [ADMIN_USERNAME_ENV]: "root", [ADMIN_PASSWORD_ENV]: "p".repeat(PASSWORD_MIN_LEN - 1) },
      { [ADMIN_USERNAME_ENV]: "r", [ADMIN_PASSWORD_ENV]: PASSWORD },
      { [ADMIN_USERNAME_ENV]: "root" },
      { [ADMIN_PASSWORD_ENV]: PASSWORD },
    ]) {
      const { h, hasher } = setup();
      const error = await ensureAdminBootstrap({ repository: h.repository, hasher, env: { ...env } }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(PASSWORD.slice(0, PASSWORD_MIN_LEN - 1));
      expect(h.db.prepare("SELECT count(*) AS n FROM user_credential").get()).toEqual({ n: 0 });
    }
  });
});
