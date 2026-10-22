import { describe, expect, it } from "vitest";
import { Argon2PasswordHasher } from "../../../../../src/server/adapters/auth/server/password.ts";
import { ARGON2_ITERATIONS, ARGON2_MEMORY_KIB, ARGON2_PARALLELISM } from "../../../../../src/shared/defaults.ts";

describe("Argon2PasswordHasher", () => {
  it("hashes with the production parameters encoded in a PHC string and verifies", async () => {
    const hasher = new Argon2PasswordHasher();
    const hash = await hasher.hash("correct horse battery");
    expect(hash).toMatch(new RegExp(`^\\$argon2id\\$v=19\\$m=${ARGON2_MEMORY_KIB},t=${ARGON2_ITERATIONS},p=${ARGON2_PARALLELISM}\\$`));
    expect(await hasher.verify(hash, "correct horse battery")).toEqual({ valid: true, needsRehash: false });
    expect(await hasher.verify(hash, "correct horse batterY")).toEqual({ valid: false, needsRehash: false });
    // Salted: the same password never hashes the same twice.
    expect(await hasher.hash("correct horse battery")).not.toBe(hash);
  });

  it("asks for a re-hash when a valid hash used weaker parameters", async () => {
    const weak = new Argon2PasswordHasher({ memoryKiB: 8, iterations: 1, parallelism: 1 });
    const hash = await weak.hash("correct horse battery");
    const current = new Argon2PasswordHasher({ memoryKiB: 16, iterations: 2, parallelism: 1 });
    expect(await current.verify(hash, "correct horse battery")).toEqual({ valid: true, needsRehash: true });
    expect(await current.verify(hash, "wrong")).toEqual({ valid: false, needsRehash: false });
  });

  it("rejects anything that is not an argon2id PHC string", async () => {
    const hasher = new Argon2PasswordHasher({ memoryKiB: 8, iterations: 1, parallelism: 1 });
    for (const hash of ["", "plaintext", "$argon2i$v=19$m=8,t=1,p=1$c2FsdHNhbHQ$aGFzaA", "$argon2id$v=19$m=8,t=1,p=1$!!$!!"]) {
      expect(await hasher.verify(hash, "plaintext")).toEqual({ valid: false, needsRehash: false });
    }
  });
});
