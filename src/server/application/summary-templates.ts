import { monotonicFactory } from "ulid";
import type {
  SummaryTemplateCreateRequest,
  SummaryTemplateDto,
  SummaryTemplateListDto,
  SummaryTemplatePatchRequest,
  SummaryTemplateVersionListDto,
} from "../../shared/dto/summary.ts";
import type { SummaryTemplate } from "../domain/artifact.ts";
import { amberError } from "../domain/errors.ts";
import type { PromptRef } from "../domain/model-ref.ts";
import { BUILTIN_SUMMARY_TEMPLATES, DEFAULT_SUMMARY_TEMPLATE_ID } from "../domain/prompts.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import { defaultSummaryTemplateIdOf } from "./settings.ts";

export interface SummaryTemplateServiceOptions {
  repository: Repository;
  now?: () => number;
  newId?: () => string;
}

export function summaryTemplateDto(template: SummaryTemplate): SummaryTemplateDto {
  return {
    id: template.id,
    builtin: template.builtin,
    name: template.name,
    currentVersion: template.currentVersion,
    deleted: template.deletedAt !== undefined,
  };
}

/**
 * Brings the builtin template rows in line with the code at startup: their versions come
 * from the built-in prompts, and a builtin's `name` is its i18n key rather than display text.
 */
export function ensureBuiltinSummaryTemplates(repository: Repository, now: number): void {
  const templates = BUILTIN_SUMMARY_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.nameKey,
    versions: [{ version: template.version, prompt: template.prompt }],
  }));
  repository.withTransaction((scope) => scope.summaryTemplates.syncBuiltin(templates, now));
}

/**
 * The template version a new summary is generated from, frozen into the Task request: the
 * given template, else the user's default template, else the builtin default, at its
 * current version. A template the owner cannot see or has deleted cannot be used.
 */
export function resolveTemplateRef(scope: RepositoryScope, owner: string, templateId: string | undefined, detail = "templateId"): PromptRef {
  const template = scope.summaryTemplates.get(owner, templateId ?? defaultSummaryTemplateIdOf(scope, owner) ?? DEFAULT_SUMMARY_TEMPLATE_ID);
  if (template === undefined || template.deletedAt !== undefined) {
    throw amberError("invalid_request", "no usable summary template with this id", { params: { detail } });
  }
  return { id: template.id, version: template.currentVersion };
}

/**
 * Builtin and custom summary templates. Editing a prompt adds a
 * version and never rewrites one, so every PromptRef stays resolvable; renaming alone
 * adds none. Builtin templates are read-only and custom ones are only soft-deleted.
 */
export class SummaryTemplateService {
  private readonly options: SummaryTemplateServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: SummaryTemplateServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
  }

  list(principal: RequestPrincipal): SummaryTemplateListDto {
    return this.options.repository.withTransaction((scope) => ({
      items: scope.summaryTemplates.list(principal.userId).map(summaryTemplateDto),
    }));
  }

  create(principal: RequestPrincipal, body: SummaryTemplateCreateRequest): SummaryTemplateDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const now = this.now();
      const template: SummaryTemplate = { id: this.newId(), userId: owner, builtin: false, name: body.name, currentVersion: 1 };
      scope.summaryTemplates.insert(template, { templateId: template.id, version: 1, prompt: body.prompt, createdAt: now });
      return summaryTemplateDto(template);
    });
  }

  patch(principal: RequestPrincipal, templateId: string, body: SummaryTemplatePatchRequest): SummaryTemplateDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const template = editable(scope, owner, templateId);
      if (body.name !== undefined && body.name !== template.name) {
        scope.summaryTemplates.rename(owner, templateId, body.name);
      }
      if (body.prompt !== undefined) {
        const current = scope.summaryTemplates.getVersion(owner, templateId, template.currentVersion);
        if (current?.prompt !== body.prompt) {
          scope.summaryTemplates.addVersion(owner, { templateId, version: template.currentVersion + 1, prompt: body.prompt, createdAt: this.now() });
        }
      }
      return summaryTemplateDto(scope.summaryTemplates.get(owner, templateId) as SummaryTemplate);
    });
  }

  /** Soft delete: queued Tasks that froze a version still run, and history stays readable. */
  delete(principal: RequestPrincipal, templateId: string): void {
    const owner = principal.userId;
    this.options.repository.withTransaction((scope) => {
      editable(scope, owner, templateId);
      scope.summaryTemplates.softDelete(owner, templateId, this.now());
      // A deleted template cannot stay the default for new summaries.
      scope.userSettings.clearDefaultTemplate(owner, templateId);
    });
  }

  versions(principal: RequestPrincipal, templateId: string): SummaryTemplateVersionListDto {
    const owner = principal.userId;
    return this.options.repository.withTransaction((scope) => {
      const template = scope.summaryTemplates.get(owner, templateId);
      if (template === undefined) {
        throw amberError("not_found", "summary template not found");
      }
      return {
        items: scope.summaryTemplates.listVersions(owner, templateId).map((version) => ({
          templateId: version.templateId,
          version: version.version,
          prompt: version.prompt,
          createdAt: version.createdAt,
        })),
      };
    });
  }
}

/** A custom template of the owner that is not deleted; builtin templates are read-only. */
function editable(scope: RepositoryScope, owner: string, templateId: string): SummaryTemplate {
  const template = scope.summaryTemplates.get(owner, templateId);
  if (template === undefined || template.deletedAt !== undefined) {
    throw amberError("not_found", "summary template not found");
  }
  if (template.builtin) {
    throw amberError("forbidden", "builtin templates cannot be changed");
  }
  return template;
}
