import { createHash } from "node:crypto";
import { z } from "zod";
import type { TokenUsageFeature } from "../../../shared/enums.ts";
import type { ArtifactInputRef } from "../../domain/artifact.ts";
import { canonicalJson } from "../../domain/canonical-json.ts";
import {
  applyRepair,
  checkCitations,
  markUnresolved,
  needsRepair,
  parseRepair,
  renderCandidates,
  repairCandidates,
  type AliasTable,
} from "../../domain/citations.ts";
import { amberError } from "../../domain/errors.ts";
import type { LlmRequest } from "../../domain/llm.ts";
import type { ModelRef } from "../../domain/model-ref.ts";
import {
  CITATION_REPAIR_PROMPT,
  CITATION_RULES_FRAGMENT,
  ROLLUP_CARRY_PROMPT,
  ROLLUP_PARTIAL_PROMPT,
  renderPrompt,
  type BuiltinPrompt,
} from "../../domain/prompts.ts";
import { assertFits, type ModelLimits } from "../../domain/rollup.ts";
import type { StageExecutionContext, UnitIdentity } from "../executor.ts";
import { ROLLUP_CARRY_BUDGET_CHARS } from "../../../shared/defaults.ts";

const generationPayloadSchema = z.object({ text: z.string(), invocationId: z.string() });
const repairPayloadSchema = z.object({ mapping: z.record(z.string(), z.string()), invocationId: z.string(), degraded: z.boolean() });

/** One citing generation after its optional repair: the text with aliases, and what it cost. */
export interface Generated {
  /** Repair applied; aliases still invalid are left for the caller to mark. */
  text: string;
  invocationIds: string[];
  /** Still over `CITATION_INVALID_RATIO_MAX` after the one repair. */
  degraded: boolean;
  /** Digest of `text`, the link of the 6.9 digest chain. */
  digest: string;
}

export interface GenerationCall {
  key: string;
  inputDigest: string;
  prompt: string;
  feature: TokenUsageFeature;
}

/**
 * One citing generation as a paid DB-only WorkUnit, then — only when its invalid-citation
 * ratio is over the limit — one citation repair as its own `<key>:repair` WorkUnit. The
 * generation is persisted before the repair is sent, so a repair whose outcome is unknown is re-sent alone and the generation is never paid twice. The
 * repair's digest covers everything its answer depends on.
 */
export async function generateWithRepair(
  context: StageExecutionContext,
  table: AliasTable,
  modelRef: ModelRef,
  call: GenerationCall,
): Promise<Generated> {
  const generated = generationPayloadSchema.parse(
    await context.runUnit({
      key: call.key,
      inputDigest: call.inputDigest,
      billing: "llm",
      run: async (_signal: AbortSignal, unit: UnitIdentity) => {
        const completion = await context.llm.complete(userRequest(modelRef, call.prompt), { feature: call.feature, workUnitId: unit.id });
        return { text: completion.text, invocationId: completion.invocationId };
      },
    }),
  );
  const check = checkCitations(generated.text, table);
  if (!needsRepair(check)) {
    return { text: generated.text, invocationIds: [generated.invocationId], degraded: false, digest: digestOf(generated.text) };
  }
  const candidates = repairCandidates(generated.text, check.invalidAliases, table);
  const repairPrompt = renderPrompt(CITATION_REPAIR_PROMPT.text, {
    invalid_aliases: check.invalidAliases.join("、"),
    candidates: renderCandidates(candidates, table),
  });
  const repairDigest = digestOf(
    canonicalJson({
      of: call.key,
      outputDigest: digestOf(generated.text),
      invalid: check.invalidAliases,
      candidates: [...candidates].map(([alias, entries]) => [alias, entries.map((entry) => entry.alias)]),
      aliases: digestOf(table.fingerprint()),
      promptRef: CITATION_REPAIR_PROMPT.ref,
      modelRef,
    }),
  );
  const repaired = repairPayloadSchema.parse(
    await context.runUnit({
      key: `${call.key}:repair`,
      inputDigest: repairDigest,
      billing: "llm",
      run: async (_signal: AbortSignal, unit: UnitIdentity) => {
        const completion = await context.llm.complete(userRequest(modelRef, repairPrompt), { feature: "citation_repair", workUnitId: unit.id });
        const mapping = parseRepair(completion.text, check.invalidAliases, table);
        const after = checkCitations(applyRepair(generated.text, mapping), table);
        return { mapping, invocationId: completion.invocationId, degraded: needsRepair(after) };
      },
    }),
  );
  const text = applyRepair(generated.text, repaired.mapping);
  return { text, invocationIds: [generated.invocationId, repaired.invocationId], degraded: repaired.degraded, digest: digestOf(text) };
}

/** One group of a rolling summary: what it is made of and how it is shown to the model. */
export interface RollupGroup {
  /** Digest material naming the group's inputs (sentence or member ids). */
  ids: readonly string[];
  /** `{{group_content}}`. */
  content: string;
  /** Provenance of the RollupPartial built from this group. */
  inputs: ArtifactInputRef[];
}

export interface RollupSpec {
  table: AliasTable;
  modelRef: ModelRef;
  limits: ModelLimits;
  feature: TokenUsageFeature;
  /** `{{template_body}}` of the partial and carry calls. */
  templateBody: string;
  outputLanguage: string;
  terms: string;
  groups: readonly RollupGroup[];
  /** The final call: its prompt and the slot values besides `partials` and `carry`. */
  final: { prompt: BuiltinPrompt; values: Readonly<Record<string, string>> };
  /** Digest material shared by every call (template identity, base revision, …). */
  digestBase: unknown;
}

export interface RollupOutcome {
  partials: Array<{ index: number; text: string; invocationIds: string[]; inputs: ArtifactInputRef[] }>;
  final: Generated;
  /** Carry calls and their repairs, attributed to the revision. */
  carryInvocationIds: string[];
  degraded: boolean;
  /** `rollup.partial` with everything but carry and group content filled in. */
  partialSnapshot: string;
  /** The final prompt with everything but partials and carry filled in. */
  finalSnapshot: string;
}

/**
 * Rolling summarization (the `rollup.*` prompts): for each group a partial under the template
 * and the carry so far, then a carry compressing both; finally one call over every partial
 * and the last carry. Each call is a paid DB-only WorkUnit (`rollup:partial:N`,
 * `rollup:carry:N`, `rollup:final`) run in order; their digests chain through the previous
 * carry and partial, so after a crash finished units are reused and nothing is paid twice.
 * Invalid aliases fed forward are marked `[[unresolved:…]]`; the revision is degraded when
 * any unit stays over the limit after its repair.
 */
export async function runRollup(context: StageExecutionContext, spec: RollupSpec): Promise<RollupOutcome> {
  const { table, modelRef, limits } = spec;
  const shared = {
    citation_rules: CITATION_RULES_FRAGMENT.text,
    output_language: spec.outputLanguage,
    terms_section: spec.terms,
    template_body: spec.templateBody,
  };
  const base = digestOf(canonicalJson({ base: spec.digestBase, modelRef, outputLanguage: spec.outputLanguage, terms: spec.terms, aliases: digestOf(table.fingerprint()) }));
  const partials: RollupOutcome["partials"] = [];
  const carryInvocationIds: string[] = [];
  let degraded = false;
  let carry = "";
  let carryDigest = digestOf("");
  for (const [index, group] of spec.groups.entries()) {
    const partialPrompt = renderPrompt(ROLLUP_PARTIAL_PROMPT.text, { ...shared, carry, group_content: group.content });
    assertFits(limits, partialPrompt);
    const partial = await generateWithRepair(context, table, modelRef, {
      key: `rollup:partial:${index}`,
      inputDigest: digestOf(canonicalJson({ base, promptRef: ROLLUP_PARTIAL_PROMPT.ref, ids: group.ids, carry: carryDigest })),
      prompt: partialPrompt,
      feature: spec.feature,
    });
    degraded ||= partial.degraded;
    const partialText = markUnresolved(partial.text, table);
    partials.push({ index, text: partialText, invocationIds: partial.invocationIds, inputs: group.inputs });
    context.reportProgress((2 * index + 1) / (2 * spec.groups.length + 1));

    const carryPrompt = renderPrompt(ROLLUP_CARRY_PROMPT.text, {
      ...shared,
      carry_budget: String(ROLLUP_CARRY_BUDGET_CHARS),
      carry,
      partial: partialText,
    });
    assertFits(limits, carryPrompt);
    const next = await generateWithRepair(context, table, modelRef, {
      key: `rollup:carry:${index}`,
      inputDigest: digestOf(canonicalJson({ base, promptRef: ROLLUP_CARRY_PROMPT.ref, carry: carryDigest, partial: partial.digest })),
      prompt: carryPrompt,
      feature: spec.feature,
    });
    degraded ||= next.degraded;
    carryInvocationIds.push(...next.invocationIds);
    carry = markUnresolved(next.text, table);
    carryDigest = next.digest;
    context.reportProgress((2 * index + 2) / (2 * spec.groups.length + 1));
  }

  const finalValues = { ...shared, ...spec.final.values };
  const finalPrompt = renderPrompt(spec.final.prompt.text, {
    ...finalValues,
    partials: partials.map((partial) => `【第 ${partial.index + 1} 组】\n${partial.text}`).join("\n\n"),
    carry,
  });
  assertFits(limits, finalPrompt);
  const final = await generateWithRepair(context, table, modelRef, {
    key: "rollup:final",
    inputDigest: digestOf(
      canonicalJson({
        base,
        promptRef: spec.final.prompt.ref,
        partials: partials.map((partial) => digestOf(partial.text)),
        carry: carryDigest,
      }),
    ),
    prompt: finalPrompt,
    feature: spec.feature,
  });
  degraded ||= final.degraded;
  return {
    partials,
    final,
    carryInvocationIds,
    degraded,
    partialSnapshot: renderPrompt(ROLLUP_PARTIAL_PROMPT.text, shared),
    finalSnapshot: renderPrompt(spec.final.prompt.text, finalValues),
  };
}

export function userRequest(modelRef: ModelRef, prompt: string): LlmRequest {
  return { modelRef, system: "", messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] };
}

export function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** A stage-level invariant broken by stored data, never by the user. */
export function storedDataError(message: string): never {
  throw amberError("internal", message);
}
