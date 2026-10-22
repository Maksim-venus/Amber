import type { AsrUsageDto, TokenUsageDto, UsageDto, UsageTotalDto } from "../../shared/dto/usage.ts";
import type { TokenUsageFeature } from "../../shared/enums.ts";
import { amberError } from "../domain/errors.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { AsrUsage, TokenUsage } from "../domain/usage.ts";
import type { Repository } from "../ports/repository.ts";

export interface UsageQuery {
  /** Inclusive lower bound on `createdAt`. */
  from?: number;
  /** Exclusive upper bound on `createdAt`. */
  to?: number;
  feature?: TokenUsageFeature;
  cursor?: string;
  limit: number;
}

type Kind = "llm" | "asr";
type Row = { kind: "llm"; usage: TokenUsage } | { kind: "asr"; usage: AsrUsage };
type Position = [createdAt: number, kind: Kind, id: string];

/**
 * `GET /api/usage`. LLM and ASR rows form one timeline, newest
 * first, paged together; totals cover the whole filtered range. A feature filter names an
 * LLM feature, so ASR rows drop out, except under `test_connection`, which ASR model tests
 * share: then ASR test rows stay too. No cost: usage counts calls, tokens and audio time,
 * and the users' own prices are display only.
 */
export class UsageService {
  private readonly repository: Repository;

  constructor(options: { repository: Repository }) {
    this.repository = options.repository;
  }

  list(principal: RequestPrincipal, query: UsageQuery): UsageDto {
    const owner = principal.userId;
    const range = { ...(query.from === undefined ? {} : { since: query.from }), ...(query.to === undefined ? {} : { until: query.to }) };
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const { llm, asr } = this.repository.withTransaction((scope) => ({
      llm: scope.tokenUsage.list(owner, { ...range, ...(query.feature === undefined ? {} : { feature: query.feature }) }),
      asr:
        query.feature === undefined
          ? scope.asrUsage.list(owner, range)
          : query.feature === "test_connection"
            ? scope.asrUsage.list(owner, range).filter((usage) => usage.feature === "test_connection")
            : [],
    }));
    const timeline: Row[] = [
      ...llm.map((usage) => ({ kind: "llm" as const, usage })),
      ...asr.map((usage) => ({ kind: "asr" as const, usage })),
    ].sort((a, b) => compareNewestFirst(positionOf(a), positionOf(b)));
    const remaining = after === undefined ? timeline : timeline.filter((row) => compareNewestFirst(positionOf(row), after) > 0);
    const page = remaining.slice(0, query.limit);
    const last = page.at(-1);
    return {
      llm: page.flatMap((row) => (row.kind === "llm" ? [tokenUsageDto(row.usage)] : [])),
      asr: page.flatMap((row) => (row.kind === "asr" ? [asrUsageDto(row.usage)] : [])),
      totals: [...llmTotals(llm), ...asrTotals(asr)],
      ...(remaining.length > query.limit && last !== undefined ? { nextCursor: encodeCursor(positionOf(last)) } : {}),
    };
  }
}

function positionOf(row: Row): Position {
  return [row.usage.createdAt, row.kind, row.usage.id];
}

/** Negative when `a` comes first: newer first, then by kind and id descending, a total order. */
function compareNewestFirst(a: Position, b: Position): number {
  if (a[0] !== b[0]) {
    return b[0] - a[0];
  }
  if (a[1] !== b[1]) {
    return a[1] < b[1] ? 1 : -1;
  }
  return a[2] === b[2] ? 0 : a[2] < b[2] ? 1 : -1;
}

function encodeCursor(position: Position): string {
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Position {
  try {
    const [createdAt, kind, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown[];
    if (typeof createdAt === "number" && Number.isInteger(createdAt) && (kind === "llm" || kind === "asr") && typeof id === "string" && id !== "") {
      return [createdAt, kind, id];
    }
  } catch {
    // Falls through to the error below.
  }
  throw amberError("invalid_request", "malformed cursor", { params: { detail: "cursor" } });
}

/** Grouped by profile, model and feature; names come from the group's newest row. */
function llmTotals(rows: readonly TokenUsage[]): UsageTotalDto[] {
  const groups = new Map<string, TokenUsage[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.modelRef.providerProfileId, row.modelRef.modelId, row.feature]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => {
    const newest = group.reduce((a, b) => (b.createdAt > a.createdAt || (b.createdAt === a.createdAt && b.id > a.id) ? b : a));
    const inputs = group.flatMap((row) => (row.inputTokens === undefined ? [] : [row.inputTokens]));
    const outputs = group.flatMap((row) => (row.outputTokens === undefined ? [] : [row.outputTokens]));
    const { providerProfileId, modelId, providerNameSnapshot, modelDisplaySnapshot } = newest.modelRef;
    return {
      kind: "llm" as const,
      modelRef: { providerProfileId, modelId, providerNameSnapshot, modelDisplaySnapshot },
      feature: newest.feature,
      calls: group.length,
      ...(inputs.length === 0 ? {} : { inputTokens: sum(inputs) }),
      ...(outputs.length === 0 ? {} : { outputTokens: sum(outputs) }),
      incomplete: group.some((row) => row.inputTokens === undefined || row.outputTokens === undefined),
    };
  });
}

/** Grouped by provider, model and feature, so model tests stay apart from transcriptions. */
function asrTotals(rows: readonly AsrUsage[]): UsageTotalDto[] {
  const groups = new Map<string, AsrUsage[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.provider, row.model, row.feature]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => ({
    kind: "asr" as const,
    provider: (group[0] as AsrUsage).provider,
    model: (group[0] as AsrUsage).model,
    feature: (group[0] as AsrUsage).feature,
    calls: group.length,
    audioMs: sum(group.map((row) => row.audioMs)),
    incomplete: false,
  }));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function tokenUsageDto(usage: TokenUsage): TokenUsageDto {
  const { providerProfileId, modelId, providerNameSnapshot, modelDisplaySnapshot } = usage.modelRef;
  return {
    id: usage.id,
    modelRef: { providerProfileId, modelId, providerNameSnapshot, modelDisplaySnapshot },
    feature: usage.feature,
    ...optional({
      taskId: usage.taskId,
      workUnitId: usage.workUnitId,
      artifactRevisionId: usage.artifactRevisionId,
      chatMessageId: usage.chatMessageId,
      contentId: usage.contentId,
    }),
    outcome: usage.outcome,
    ...optional({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens: usage.reasoningTokens,
    }),
    createdAt: usage.createdAt,
  };
}

function asrUsageDto(usage: AsrUsage): AsrUsageDto {
  return {
    id: usage.id,
    ...optional({ asrProfileId: usage.asrProfileId }),
    provider: usage.provider,
    model: usage.model,
    feature: usage.feature,
    outcome: usage.outcome,
    audioMs: usage.audioMs,
    ...optional({ taskId: usage.taskId, contentId: usage.contentId }),
    createdAt: usage.createdAt,
  };
}

/** Drops absent fields so optional DTO keys are omitted rather than `undefined`. */
function optional<T extends Record<string, unknown>>(fields: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}
