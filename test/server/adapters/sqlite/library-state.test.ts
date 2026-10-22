import { describe, expect, it } from "vitest";
import { nonEmptyCategories } from "../../../../src/server/adapters/sqlite/library-state.ts";
import { SqliteRepository } from "../../../../src/server/adapters/sqlite/repository.ts";
import { ensureLocalUser } from "../../../../src/server/application/ensure-local-user.ts";
import { ensureInstanceSettings } from "../../../../src/server/application/instance-settings.ts";
import { ensureBuiltinSummaryTemplates } from "../../../../src/server/application/summary-templates.ts";
import { LIBRARY_CATEGORIES } from "../../../../src/shared/backup.ts";
import { insertRow, openTempDatabase } from "../../../tools/sqlite.ts";

function firstStart() {
  const opened = openTempDatabase();
  const repository = new SqliteRepository(opened.db);
  ensureLocalUser(repository);
  ensureBuiltinSummaryTemplates(repository, 1);
  ensureInstanceSettings(repository);
  return opened.db;
}

describe("nonEmptyCategories", () => {
  it("finds nothing in a database as the first start leaves it, built-in templates and settings included", () => {
    const db = firstStart();
    insertRow(db, "user_settings", { user_id: "local", theme: "dark", language: "en", shortcuts_json: "{}", updated_at: 1 });
    expect(nonEmptyCategories(db)).toEqual([]);
    db.close();
  });

  it("names each kind of user data, in the fixed order", () => {
    const db = firstStart();
    insertRow(db, "terminology_set", { id: "t", user_id: "local", scope_kind: "global" });
    insertRow(db, "summary_template", { id: "u", user_id: "local", builtin: 0, name: "mine", current_version: 1 });
    insertRow(db, "collection", { id: "c", user_id: "local", name: "课程", created_at: 1 });
    db.prepare("UPDATE instance_settings SET cache_root = '/elsewhere'").run();
    expect(nonEmptyCategories(db)).toEqual(["collection", "terminology_set", "summary_template", "cache_root"]);
    expect(LIBRARY_CATEGORIES.indexOf("collection")).toBeLessThan(LIBRARY_CATEGORIES.indexOf("cache_root"));
    db.close();
  });
});
