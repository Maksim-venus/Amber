import { beforeEach, describe, expect, it } from "vitest";
import type { SqliteConnection } from "../../../../../src/server/adapters/sqlite/database.ts";
import { SqliteRepository } from "../../../../../src/server/adapters/sqlite/repository.ts";
import { countRows, insertRow, openTempDatabase } from "../../../../tools/sqlite.ts";

const T0 = 1_790_000_000_000;
let db: SqliteConnection;
let repository: SqliteRepository;

const builtin = [
  { id: "summary.core", name: "summaryTemplate.core", versions: [{ version: 1, prompt: "core v1" }] },
  { id: "summary.terms", name: "summaryTemplate.terms", versions: [{ version: 1, prompt: "terms v1" }] },
];

beforeEach(() => {
  db = openTempDatabase().db;
  repository = new SqliteRepository(db);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
  repository.withTransaction((scope) => scope.summaryTemplates.syncBuiltin(builtin, T0));
});

const custom = (id: string, userId: string, prompt = "mine v1") =>
  repository.withTransaction((scope) =>
    scope.summaryTemplates.insert(
      { id, userId, builtin: false, name: id, currentVersion: 1 },
      { templateId: id, version: 1, prompt, createdAt: T0 + 1 },
    ),
  );

describe("builtin templates", () => {
  it("are visible to everyone and synced idempotently", () => {
    repository.withTransaction((scope) => scope.summaryTemplates.syncBuiltin(builtin, T0 + 5));
    expect(countRows(db, "summary_template")).toBe(2);
    expect(countRows(db, "summary_template_version")).toBe(2);
    for (const owner of ["alice", "bob"]) {
      expect(repository.withTransaction((scope) => scope.summaryTemplates.get(owner, "summary.core"))).toEqual({
        id: "summary.core", builtin: true, name: "summaryTemplate.core", currentVersion: 1,
      });
    }
    expect(repository.withTransaction((scope) => scope.summaryTemplates.getVersion("bob", "summary.core", 1))).toEqual({
      templateId: "summary.core", version: 1, prompt: "core v1", createdAt: T0,
    });
  });

  it("append versions the table lacks without rewriting existing ones", () => {
    const next = [{ ...builtin[0]!, versions: [{ version: 1, prompt: "changed in code" }, { version: 2, prompt: "core v2" }] }];
    repository.withTransaction((scope) => scope.summaryTemplates.syncBuiltin(next, T0 + 9));
    const versions = repository.withTransaction((scope) => scope.summaryTemplates.listVersions("alice", "summary.core"));
    expect(versions.map((version) => [version.version, version.prompt, version.createdAt])).toEqual([
      [1, "core v1", T0],
      [2, "core v2", T0 + 9],
    ]);
    expect(repository.withTransaction((scope) => scope.summaryTemplates.get("alice", "summary.core"))?.currentVersion).toBe(2);
  });

  it("cannot be renamed, versioned or deleted through the owner paths", () => {
    expect(() => repository.withTransaction((scope) => scope.summaryTemplates.rename("alice", "summary.core", "x"))).toThrow();
    expect(() =>
      repository.withTransaction((scope) => scope.summaryTemplates.addVersion("alice", { templateId: "summary.core", version: 2, prompt: "x", createdAt: T0 })),
    ).toThrow();
    expect(repository.withTransaction((scope) => scope.summaryTemplates.softDelete("alice", "summary.core", T0))).toBe(false);
  });
});

describe("custom templates", () => {
  it("are visible to their owner only and listed after builtin ones", () => {
    custom("t2", "alice");
    custom("t1", "alice");
    custom("tb", "bob");
    expect(repository.withTransaction((scope) => scope.summaryTemplates.list("alice")).map((template) => template.id)).toEqual([
      "summary.core", "summary.terms", "t1", "t2",
    ]);
    expect(repository.withTransaction((scope) => scope.summaryTemplates.get("bob", "t1"))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.summaryTemplates.getVersion("bob", "t1", 1))).toBeUndefined();
    expect(repository.withTransaction((scope) => scope.summaryTemplates.listVersions("bob", "t1"))).toEqual([]);
  });

  it("append versions strictly after the current one", () => {
    custom("t", "alice");
    const add = (owner: string, version: number) =>
      repository.withTransaction((scope) => scope.summaryTemplates.addVersion(owner, { templateId: "t", version, prompt: `v${version}`, createdAt: T0 + version }));
    expect(() => add("alice", 3)).toThrow();
    expect(() => add("alice", 1)).toThrow();
    expect(() => add("bob", 2)).toThrow();
    add("alice", 2);
    expect(repository.withTransaction((scope) => scope.summaryTemplates.get("alice", "t"))?.currentVersion).toBe(2);
    expect(repository.withTransaction((scope) => scope.summaryTemplates.listVersions("alice", "t")).map((version) => version.prompt)).toEqual(["mine v1", "v2"]);
  });

  it("rename keeps the version; soft delete hides it from the default list but keeps it resolvable", () => {
    custom("t", "alice");
    repository.withTransaction((scope) => scope.summaryTemplates.rename("alice", "t", "Renamed"));
    expect(() => repository.withTransaction((scope) => scope.summaryTemplates.rename("bob", "t", "x"))).toThrow();
    expect(repository.withTransaction((scope) => scope.summaryTemplates.softDelete("bob", "t", T0))).toBe(false);
    expect(repository.withTransaction((scope) => scope.summaryTemplates.softDelete("alice", "t", T0 + 7))).toBe(true);
    expect(repository.withTransaction((scope) => scope.summaryTemplates.softDelete("alice", "t", T0 + 8))).toBe(false);
    expect(repository.withTransaction((scope) => scope.summaryTemplates.list("alice")).map((template) => template.id)).toEqual(["summary.core", "summary.terms"]);
    expect(repository.withTransaction((scope) => scope.summaryTemplates.list("alice", { includeDeleted: true })).map((template) => template.id)).toContain("t");
    expect(repository.withTransaction((scope) => scope.summaryTemplates.get("alice", "t"))).toEqual({
      id: "t", userId: "alice", builtin: false, name: "Renamed", currentVersion: 1, deletedAt: T0 + 7,
    });
    expect(repository.withTransaction((scope) => scope.summaryTemplates.getVersion("alice", "t", 1))?.prompt).toBe("mine v1");
    expect(() =>
      repository.withTransaction((scope) => scope.summaryTemplates.addVersion("alice", { templateId: "t", version: 2, prompt: "x", createdAt: T0 })),
    ).toThrow();
  });

  it("refuses an insert shaped like a builtin", () => {
    expect(() =>
      repository.withTransaction((scope) =>
        scope.summaryTemplates.insert({ id: "x", builtin: true, name: "x", currentVersion: 1 }, { templateId: "x", version: 1, prompt: "p", createdAt: T0 }),
      ),
    ).toThrow();
  });
});
