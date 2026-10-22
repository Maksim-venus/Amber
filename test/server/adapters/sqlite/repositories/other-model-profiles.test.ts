import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import { isAmberError } from "../../../../../src/server/domain/errors.ts";
import type { OtherModelProfile } from "../../../../../src/server/domain/provider-profile.ts";
import { countRows, insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
});

const profile = (id: string, userId: string, extra: Partial<OtherModelProfile> = {}): OtherModelProfile => ({
  id, userId, name: id, models: [], createdAt: T0, ...extra,
});
const get = (owner: string, id: string) => repository.withTransaction((scope) => scope.otherModelProfiles.get(owner, id));
const ids = (owner: string) => repository.withTransaction((scope) => scope.otherModelProfiles.list(owner)).map((item) => item.id);

describe("other model profile repository", () => {
  it("round-trips name, note and models with kind and price in the given order, only for the owner", () => {
    const full = profile("o1", "alice", {
      name: "百炼",
      note: "语音合成与图片",
      models: [
        { modelId: "wanx2.1-t2i-turbo", kind: "image_generation", pricing: { currency: "CNY", items: [{ unit: "per_image", amount: "0.14" }] } },
        { modelId: "cosyvoice-v2", kind: "tts", pricing: { currency: "CNY", items: [{ unit: "characters_per_ten_thousand", amount: "2" }], note: "免费额度" } },
        { modelId: "org/video:1", kind: "video_generation" },
      ],
    });
    repository.withTransaction((scope) => scope.otherModelProfiles.insert(full));
    expect(get("alice", "o1")).toEqual(full);
    expect(get("bob", "o1")).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.otherModelProfiles.list("bob"))).toEqual([]);
  });

  it("rewrites name, note and models of the owner's profile only, keeping its creation time", () => {
    repository.withTransaction((scope) => scope.otherModelProfiles.insert(profile("o1", "alice", { note: "old", models: [{ modelId: "a", kind: "other" }] })));
    const updated = profile("o1", "alice", { name: "renamed", models: [{ modelId: "b", kind: "tts" }, { modelId: "a", kind: "other" }] });
    expect(repository.withTransaction((scope) => scope.otherModelProfiles.update({ ...updated, createdAt: T0 + 99 }))).toBe(true);
    expect(get("alice", "o1")).toEqual(updated);
    expect(get("alice", "o1")).not.toHaveProperty("note");
    expect(repository.withTransaction((scope) => scope.otherModelProfiles.update(profile("o1", "bob", { name: "stolen" })))).toBe(false);
    expect(repository.withTransaction((scope) => scope.otherModelProfiles.update(profile("missing", "alice")))).toBe(false);
    expect(get("alice", "o1")?.name).toBe("renamed");
  });

  it("puts a new profile last and renumbers the owner's profiles in the given order", () => {
    repository.withTransaction((scope) => {
      scope.otherModelProfiles.insert(profile("late", "alice", { createdAt: T0 + 2 }));
      scope.otherModelProfiles.insert(profile("early", "alice", { createdAt: T0 - 5 }));
      scope.otherModelProfiles.insert(profile("bobs", "bob"));
      scope.otherModelProfiles.insert(profile("third", "alice"));
    });
    expect(ids("alice")).toEqual(["late", "early", "third"]);
    repository.withTransaction((scope) => scope.otherModelProfiles.reorder("alice", ["third", "late", "early"]));
    expect(ids("alice")).toEqual(["third", "late", "early"]);
    // Another owner's or an unknown id is not theirs to number; the transaction rolls back.
    for (const foreign of [["early", "bobs"], ["early", "missing"]]) {
      let thrown: unknown;
      try {
        repository.withTransaction((scope) => scope.otherModelProfiles.reorder("alice", foreign));
      } catch (error) {
        thrown = error;
      }
      expect(isAmberError(thrown) && thrown.appError.class).toBe("not_found");
    }
    expect(ids("alice")).toEqual(["third", "late", "early"]);
    expect(ids("bob")).toEqual(["bobs"]);
  });

  it("deletes only the owner's profile, and all of a user's profiles go with the user", () => {
    repository.withTransaction((scope) => {
      scope.otherModelProfiles.insert(profile("a1", "alice"));
      scope.otherModelProfiles.insert(profile("a2", "alice"));
      scope.otherModelProfiles.insert(profile("b1", "bob"));
    });
    expect(repository.withTransaction((scope) => scope.otherModelProfiles.delete("bob", "a1"))).toBe(false);
    expect(repository.withTransaction((scope) => scope.otherModelProfiles.delete("alice", "a1"))).toBe(true);
    expect(repository.withTransaction((scope) => scope.otherModelProfiles.delete("alice", "a1"))).toBe(false);
    expect(ids("alice")).toEqual(["a2"]);
    db.prepare("DELETE FROM user WHERE id = 'alice'").run();
    expect(countRows(db, "other_model_profile", "user_id = 'alice'")).toBe(0);
    expect(ids("bob")).toEqual(["b1"]);
  });

  it("refuses an empty name and a profile of an unknown user", () => {
    expect(() => repository.withTransaction((scope) => scope.otherModelProfiles.insert(profile("o1", "alice", { name: "" })))).toThrow(/CHECK/);
    expect(() => repository.withTransaction((scope) => scope.otherModelProfiles.insert(profile("o2", "nobody")))).toThrow(/FOREIGN KEY/);
  });
});
