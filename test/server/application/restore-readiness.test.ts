import { afterEach, describe, expect, it } from "vitest";
import { SqliteBackupStore } from "../../../src/server/adapters/sqlite/backup-store.ts";
import { RestoreReadinessService } from "../../../src/server/application/restore-readiness.ts";
import { configureLlm, createHarness, createLocalContent, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { insertRow } from "../../tools/sqlite.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

/** A harness as a fresh install has it: the local user and built-in templates only (the harness adds a second user). */
function fresh() {
  const h = createHarness();
  open.push(h);
  const service = new RestoreReadinessService({ repository: h.repository, store: new SqliteBackupStore({ db: h.db, file: h.file }) });
  return { h, service };
}

describe("RestoreReadinessService", () => {
  it("reports a fresh install as fresh with nothing to replace", () => {
    const { h, service } = fresh();
    h.settings.effective();
    expect(service.get(LOCAL)).toEqual({ fresh: true, nonEmpty: [], willReplace: [] });
  });

  const additions: ReadonlyArray<readonly [string, (h: Harness) => void]> = [
    ["content", (h: Harness) => void createLocalContent(h)],
    ["provider_profile", (h: Harness) => void configureLlm(h)],
    ["terminology_set", (h: Harness) => insertRow(h.db, "terminology_set", { id: h.newId(), user_id: LOCAL.userId, scope_kind: "global" })],
    ["cache_root", (h: Harness) => {
      h.settings.effective();
      h.db.prepare("UPDATE instance_settings SET cache_root = '/elsewhere'").run();
    }],
  ];
  it.each(additions)("is not fresh once it holds %s", (category, add) => {
    const { h, service } = fresh();
    add(h);
    const readiness = service.get(LOCAL);
    expect(readiness.fresh).toBe(false);
    expect(readiness.nonEmpty).toContain(category);
  });

  it("stays fresh with changed settings and lists exactly the settings that differ from their defaults", () => {
    const { h, service } = fresh();
    h.userSettings.patch(LOCAL, { theme: "dark" });
    h.repository.withTransaction((scope) => {
      const current = scope.userSettings.get(LOCAL.userId);
      if (current !== undefined) scope.userSettings.put({ ...current, shortcuts: { newSummary: "Alt+N" } });
    });
    h.settings.patch(LOCAL, { concurrencyPipeline: 3 });
    expect(service.get(LOCAL)).toEqual({ fresh: true, nonEmpty: [], willReplace: ["appearance", "shortcuts", "task_concurrency"] });
  });
});
