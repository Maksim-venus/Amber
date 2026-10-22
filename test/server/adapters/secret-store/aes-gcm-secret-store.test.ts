import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AesGcmSecretStore } from "../../../../src/server/adapters/secret-store/aes-gcm-secret-store.ts";
import type { SqliteConnection } from "../../../../src/server/adapters/sqlite/database.ts";
import { sqliteSecretEnvelopeStore } from "../../../../src/server/adapters/sqlite/repositories/secret-envelopes.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import type { SecretEnvelopeStore } from "../../../../src/server/ports/secret-store.ts";
import { insertRow, openTempDatabase } from "../../../tools/sqlite.ts";

/** Placeholder credential; not a real key. */
const PLACEHOLDER = "<placeholder-llm-key>-0123456789abcdef";
const T0 = 1_790_000_000_000;

let db: SqliteConnection;
let envelopes: SecretEnvelopeStore;
let key: Buffer;
const withKey = (masterKey: Uint8Array | undefined) => new AesGcmSecretStore({ masterKey, envelopes, now: () => T0 });
const store = () => withKey(key);

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : `non-AmberError: ${String(error)}`;
  }
  return undefined;
}

beforeEach(() => {
  db = openTempDatabase().db;
  envelopes = sqliteSecretEnvelopeStore(db);
  key = randomBytes(32);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
});

describe("round trip and stored form", () => {
  it("reads back what was stored, and the secret table holds no plaintext substring", () => {
    const secrets = store();
    const ref = secrets.store("alice", PLACEHOLDER);
    expect(secrets.reveal("alice", ref)).toBe(PLACEHOLDER);

    const rows = db.prepare("SELECT * FROM secret").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const dump = rows
      .flatMap((row) => Object.values(row))
      .map((value) => (Buffer.isBuffer(value) ? value.toString("latin1") + value.toString("utf8") : String(value)))
      .join("\n");
    for (const needle of [PLACEHOLDER, "placeholder-llm-key", "0123456789abcdef"]) {
      expect(dump.includes(needle), needle).toBe(false);
    }
    expect(rows[0]).toMatchObject({ id: ref, user_id: "alice", envelope_version: 1 });
    expect((rows[0]?.["kdf_salt"] as Buffer).length).toBe(16);
    expect((rows[0]?.["nonce"] as Buffer).length).toBe(12);
    expect((rows[0]?.["auth_tag"] as Buffer).length).toBe(16);
  });

  it("uses a fresh salt and nonce for every write, even for equal plaintexts", () => {
    const secrets = store();
    const first = envelopes.get("alice", secrets.store("alice", PLACEHOLDER));
    const second = envelopes.get("alice", secrets.store("alice", PLACEHOLDER));
    expect(Buffer.from(first?.kdfSalt ?? []).equals(Buffer.from(second?.kdfSalt ?? []))).toBe(false);
    expect(Buffer.from(first?.nonce ?? []).equals(Buffer.from(second?.nonce ?? []))).toBe(false);
    expect(Buffer.from(first?.ciphertext ?? []).equals(Buffer.from(second?.ciphertext ?? []))).toBe(false);
  });
});

describe("replace and remove", () => {
  it("replace keeps the credentialRef and re-encrypts in place", () => {
    const secrets = store();
    const ref = secrets.store("alice", PLACEHOLDER);
    const before = envelopes.get("alice", ref);
    secrets.replace("alice", ref, "<placeholder-second-key>");
    const after = envelopes.get("alice", ref);
    expect(secrets.reveal("alice", ref)).toBe("<placeholder-second-key>");
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(Buffer.from(after?.nonce ?? []).equals(Buffer.from(before?.nonce ?? []))).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM secret").get()).toEqual({ n: 1 });
  });

  it("remove is idempotent and works without a master key", () => {
    const ref = store().store("alice", PLACEHOLDER);
    const keyless = withKey(undefined);
    keyless.remove("alice", ref);
    keyless.remove("alice", ref);
    expect(keyless.status("alice", ref)).toBe("missing");
  });
});

describe("owner binding", () => {
  it("never resolves another user's reference", () => {
    const secrets = store();
    const ref = secrets.store("alice", PLACEHOLDER);
    expect(codeOf(() => secrets.reveal("bob", ref))).toBe("not_found");
    expect(codeOf(() => secrets.replace("bob", ref, "x"))).toBe("not_found");
    expect(secrets.status("bob", ref)).toBe("missing");
    secrets.remove("bob", ref);
    expect(secrets.reveal("alice", ref)).toBe(PLACEHOLDER);
  });

  it("fails authentication when a ciphertext is moved onto another owner's row", () => {
    const secrets = store();
    const ref = secrets.store("alice", PLACEHOLDER);
    db.prepare("UPDATE secret SET user_id = 'bob' WHERE id = ?").run(ref);
    expect(secrets.status("bob", ref)).toBe("unavailable");
    expect(codeOf(() => secrets.reveal("bob", ref))).toBe("internal.secret_unavailable");
  });
});

describe("credentialStatus", () => {
  it("is missing without a reference or envelope, configured when decryptable", () => {
    const secrets = store();
    expect(secrets.status("alice", undefined)).toBe("missing");
    expect(secrets.status("alice", "01J00000000000000000000000")).toBe("missing");
    expect(secrets.status("alice", secrets.store("alice", PLACEHOLDER))).toBe("configured");
  });

  it("is unavailable when the master key is absent or different, and nothing is silently re-keyed", () => {
    const ref = store().store("alice", PLACEHOLDER);
    const before = db.prepare("SELECT * FROM secret").all();
    for (const other of [withKey(undefined), withKey(randomBytes(32))]) {
      expect(other.status("alice", ref)).toBe("unavailable");
      expect(codeOf(() => other.reveal("alice", ref))).toBe("internal.secret_unavailable");
    }
    expect(codeOf(() => withKey(undefined).store("alice", PLACEHOLDER))).toBe("internal.secret_unavailable");
    expect(db.prepare("SELECT * FROM secret").all()).toEqual(before);
  });

  it("rejects a master key of the wrong length", () => {
    expect(() => withKey(randomBytes(16))).toThrow(/32 bytes/);
  });
});

describe("replacing the master key in place", () => {
  it("seals and opens with the new key; envelopes of the old key become unavailable", () => {
    const secrets = store();
    const old = secrets.store("alice", PLACEHOLDER);
    const next = randomBytes(32);
    secrets.replaceMasterKey(next);
    expect(secrets.status("alice", old)).toBe("unavailable");
    const fresh = secrets.store("alice", PLACEHOLDER);
    expect(withKey(next).reveal("alice", fresh)).toBe(PLACEHOLDER);
    expect(() => secrets.replaceMasterKey(randomBytes(16))).toThrow(TypeError);
  });
});

describe("deleteAll", () => {
  it("removes every envelope of every owner", () => {
    const secrets = store();
    secrets.store("alice", PLACEHOLDER);
    secrets.store("bob", PLACEHOLDER);
    expect(envelopes.deleteAll()).toBe(2);
    expect(envelopes.anyExists()).toBe(false);
  });
});
