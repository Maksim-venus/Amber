import { monotonicFactory } from "ulid";
import type { PutTerminologyRequest, TerminologyDto } from "../../shared/dto/terminology.ts";
import { amberError } from "../domain/errors.ts";
import { validateTerminologyEntries, type TerminologyEntry, type TerminologyScope } from "../domain/terminology.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";

export interface TerminologyServiceOptions {
  repository: Repository;
  newId?: () => string;
}

/**
 * `GET/PUT /api/terminology?scope=`: one set per scope, replaced
 * as a whole. Stages read the effective set when they run, so a change applies to the
 * next stage that starts, never to results already produced.
 */
export class TerminologyService {
  private readonly options: TerminologyServiceOptions;
  private readonly newId: () => string;

  constructor(options: TerminologyServiceOptions) {
    this.options = options;
    this.newId = options.newId ?? monotonicFactory();
  }

  get(principal: RequestPrincipal, scopeParam: string): TerminologyDto {
    const owner = principal.userId;
    const scope = parseScope(scopeParam);
    const set = this.options.repository.withTransaction((repo) => {
      requireScope(repo, owner, scope);
      return repo.terminology.get(owner, scope);
    });
    return { scope: scopeParam, entries: (set?.entries ?? []).map(entryDto) };
  }

  /** Over-long, over-many or duplicate entries reject the whole set; nothing is truncated. */
  put(principal: RequestPrincipal, scopeParam: string, request: PutTerminologyRequest): TerminologyDto {
    const owner = principal.userId;
    const scope = parseScope(scopeParam);
    const validated = validateTerminologyEntries(request.entries);
    const entries: TerminologyEntry[] = validated.map((entry) => ({ id: this.newId(), ...entry }));
    this.options.repository.withTransaction((repo) => {
      requireScope(repo, owner, scope);
      const existing = repo.terminology.get(owner, scope);
      repo.terminology.put({ id: existing?.id ?? this.newId(), userId: owner, scope, entries });
    });
    return { scope: scopeParam, entries: entries.map(entryDto) };
  }
}

/** `global`, `collection:<id>` or `content:<id>`. */
function parseScope(param: string): TerminologyScope {
  if (param === "global") {
    return { kind: "global" };
  }
  const [kind, id] = param.split(":", 2);
  if (id !== undefined && id !== "") {
    if (kind === "collection") {
      return { kind: "collection", collectionId: id };
    }
    if (kind === "content") {
      return { kind: "content", contentId: id };
    }
  }
  throw amberError("invalid_request", "unknown terminology scope", { params: { detail: "scope" } });
}

/** A collection or content scope must name one of the owner's own; anything else is not found. */
function requireScope(repo: RepositoryScope, ownerUserId: string, scope: TerminologyScope): void {
  if (scope.kind === "collection" && repo.collections.get(ownerUserId, scope.collectionId) === undefined) {
    throw amberError("not_found", `collection ${scope.collectionId}`);
  }
  if (scope.kind === "content" && repo.contents.get(ownerUserId, scope.contentId) === undefined) {
    throw amberError("not_found", `content ${scope.contentId}`);
  }
}

function entryDto(entry: TerminologyEntry): TerminologyDto["entries"][number] {
  return {
    id: entry.id,
    ordinal: entry.ordinal,
    term: entry.term,
    normalizedKey: entry.normalizedKey,
    ...(entry.translation === undefined ? {} : { translation: entry.translation }),
    ...(entry.rule === undefined ? {} : { rule: entry.rule }),
  };
}
