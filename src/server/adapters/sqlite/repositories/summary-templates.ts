import type { SummaryTemplate, SummaryTemplateVersion } from "../../../domain/artifact.ts";
import type { SummaryTemplateRepository } from "../../../ports/repository.ts";
import type { SqliteConnection } from "../database.ts";
import { notFound, withoutNulls } from "./rows.ts";

interface TemplateRow {
  id: string;
  user_id: string | null;
  builtin: number;
  name: string;
  current_version: number;
  deleted_at: number | null;
}

interface VersionRow {
  template_id: string;
  version: number;
  prompt: string;
  created_at: number;
}

function toTemplate(row: TemplateRow): SummaryTemplate {
  return withoutNulls<SummaryTemplate>({
    id: row.id,
    userId: row.user_id,
    builtin: row.builtin === 1,
    name: row.name,
    currentVersion: row.current_version,
    deletedAt: row.deleted_at,
  });
}

function toVersion(row: VersionRow): SummaryTemplateVersion {
  return { templateId: row.template_id, version: row.version, prompt: row.prompt, createdAt: row.created_at };
}

/**
 * Builtin templates (no owner) are visible to every user; custom ones only to their owner.
 * Version rows are append-only: nothing here rewrites an existing version.
 */
export function sqliteSummaryTemplateRepository(db: SqliteConnection): SummaryTemplateRepository {
  const visible = db.prepare("SELECT * FROM summary_template WHERE id = ? AND (user_id IS NULL OR user_id = ?)");
  const listVisible = db.prepare(
    `SELECT * FROM summary_template WHERE (user_id IS NULL OR user_id = ?) AND (? = 1 OR deleted_at IS NULL)
     ORDER BY builtin DESC, id`,
  );
  const version = db.prepare("SELECT * FROM summary_template_version WHERE template_id = ? AND version = ?");
  const versions = db.prepare("SELECT * FROM summary_template_version WHERE template_id = ? ORDER BY version");
  const insertTemplate = db.prepare(
    `INSERT INTO summary_template (id, user_id, builtin, name, current_version, deleted_at)
     VALUES (@id, @userId, @builtin, @name, @currentVersion, NULL)`,
  );
  const insertVersion = db.prepare(
    "INSERT INTO summary_template_version (template_id, version, prompt, created_at) VALUES (@templateId, @version, @prompt, @createdAt)",
  );
  const owned = db.prepare("SELECT * FROM summary_template WHERE id = ? AND user_id = ?");
  const builtinRow = db.prepare("SELECT * FROM summary_template WHERE id = ? AND builtin = 1");
  const anyRow = db.prepare("SELECT 1 FROM summary_template WHERE id = ?");
  const setCurrentVersion = db.prepare("UPDATE summary_template SET current_version = ? WHERE id = ?");
  const rename = db.prepare("UPDATE summary_template SET name = ? WHERE id = ? AND user_id = ?");
  const softDelete = db.prepare("UPDATE summary_template SET deleted_at = ? WHERE id = ? AND user_id = ? AND builtin = 0 AND deleted_at IS NULL");

  const visibleRow = (ownerUserId: string, templateId: string) => visible.get(templateId, ownerUserId) as TemplateRow | undefined;

  return {
    get(ownerUserId, templateId) {
      const row = visibleRow(ownerUserId, templateId);
      return row === undefined ? undefined : toTemplate(row);
    },
    list(ownerUserId, options) {
      return (listVisible.all(ownerUserId, options?.includeDeleted === true ? 1 : 0) as TemplateRow[]).map(toTemplate);
    },
    getVersion(ownerUserId, templateId, number) {
      if (visibleRow(ownerUserId, templateId) === undefined) {
        return undefined;
      }
      const row = version.get(templateId, number) as VersionRow | undefined;
      return row === undefined ? undefined : toVersion(row);
    },
    listVersions(ownerUserId, templateId) {
      if (visibleRow(ownerUserId, templateId) === undefined) {
        return [];
      }
      return (versions.all(templateId) as VersionRow[]).map(toVersion);
    },
    insert(template, firstVersion) {
      if (template.builtin || template.userId === undefined) {
        throw new TypeError("only custom templates with an owner are inserted here");
      }
      if (firstVersion.templateId !== template.id || firstVersion.version !== template.currentVersion) {
        throw new TypeError("the first version must belong to the template and be its current version");
      }
      insertTemplate.run({ id: template.id, userId: template.userId, builtin: 0, name: template.name, currentVersion: template.currentVersion });
      insertVersion.run({ ...firstVersion });
    },
    addVersion(ownerUserId, next) {
      const row = owned.get(next.templateId, ownerUserId) as TemplateRow | undefined;
      if (row === undefined || row.deleted_at !== null) {
        throw notFound("summary template", next.templateId);
      }
      if (next.version !== row.current_version + 1) {
        throw new TypeError("a new template version must follow the current one");
      }
      insertVersion.run({ ...next });
      setCurrentVersion.run(next.version, next.templateId);
    },
    rename(ownerUserId, templateId, name) {
      if (rename.run(name, templateId, ownerUserId).changes === 0) {
        throw notFound("summary template", templateId);
      }
    },
    softDelete(ownerUserId, templateId, deletedAt) {
      return softDelete.run(deletedAt, templateId, ownerUserId).changes > 0;
    },
    syncBuiltin(templates, createdAt) {
      for (const template of templates) {
        const ordered = [...template.versions].sort((a, b) => a.version - b.version);
        const latest = ordered.at(-1);
        if (latest === undefined) {
          throw new TypeError(`builtin template ${template.id} has no version`);
        }
        let row = builtinRow.get(template.id) as TemplateRow | undefined;
        if (row === undefined) {
          if (anyRow.get(template.id) !== undefined) {
            throw new TypeError(`template id ${template.id} is taken by a custom template`);
          }
          insertTemplate.run({ id: template.id, userId: null, builtin: 1, name: template.name, currentVersion: latest.version });
          row = builtinRow.get(template.id) as TemplateRow;
        }
        for (const entry of ordered) {
          if (version.get(template.id, entry.version) === undefined) {
            insertVersion.run({ templateId: template.id, version: entry.version, prompt: entry.prompt, createdAt });
          }
        }
        if (latest.version > row.current_version) {
          setCurrentVersion.run(latest.version, template.id);
        }
      }
    },
  };
}
