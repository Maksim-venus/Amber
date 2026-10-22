import { monotonicFactory } from "ulid";
import { COLLECTION_PARTIAL_SIZE } from "../../../shared/defaults.ts";
import type { ArtifactInputRef, RollupPartial } from "../../domain/artifact.ts";
import { collectionAliasTable, finalizeCitations } from "../../domain/citations.ts";
import { amberError } from "../../domain/errors.ts";
import { COLLECTION_ROLLUP_GOAL, ROLLUP_FINAL_COLLECTION_PROMPT, ROLLUP_PARTIAL_PROMPT, outputLanguageName } from "../../domain/prompts.ts";
import { summarizeCollectionRequestSchema, type SummarizeCollectionRequest } from "../../domain/task-request.ts";
import { termsSection } from "../../domain/terminology.ts";
import type { Repository } from "../../ports/repository.ts";
import type { StageExecutionContext, StageExecutor, StageOutcome } from "../executor.ts";
import { runRollup, storedDataError, type RollupGroup } from "./rollup-runner.ts";
import { displayTitleOf } from "../../domain/content.ts";

export interface CollectionSummaryStageDeps {
  repository: Repository;
  now?: () => number;
  newId?: () => string;
}

type InputItem = SummarizeCollectionRequest["inputItems"][number];

/**
 * The `collection_summary` stage of `summarize_collection`. Its input is
 * frozen at submission: each member's `summary.core` revision and primary transcript. The
 * canonical markers of those summaries are renumbered into one alias table for the Task,
 * the members are summarized rolling in groups of `COLLECTION_PARTIAL_SIZE` lectures under
 * the collection goal, and `rollup.final.collection` writes the course summary. Citations
 * resolve back to the members' own sentences.
 */
export class CollectionSummaryStageExecutor implements StageExecutor {
  private readonly deps: CollectionSummaryStageDeps;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: CollectionSummaryStageDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? monotonicFactory();
  }

  async run(context: StageExecutionContext): Promise<StageOutcome> {
    const { repository } = this.deps;
    const owner = context.task.userId;
    const collectionId = context.task.collectionId;
    if (collectionId === undefined) {
      throw amberError("internal", "a collection summary needs a Collection target");
    }
    const request = summarizeCollectionRequestSchema.parse(context.request);
    const modelRef = context.modelRef;
    if (modelRef === undefined) {
      throw amberError("llm_unconfigured", "no model for the collection summary stage");
    }
    const outputLanguage = outputLanguageName(request.outputLanguage);
    const loaded = repository.withTransaction((scope) => {
      if (scope.collections.get(owner, collectionId) === undefined) {
        return storedDataError("the collection is gone");
      }
      const members = request.inputItems.map((item) => {
        const summary = scope.summaries.getRevision(owner, item.summaryRevisionId);
        if (summary === undefined) {
          return storedDataError("a frozen member summary is gone");
        }
        return { item, body: summary.body, title: displayTitleOf(scope.contents.getIncludingTrashed(owner, item.contentId)) };
      });
      const { table, bodies } = collectionAliasTable(
        members.map((member) => member.body),
        (segmentId) => {
          const segment = scope.transcripts.getSegment(owner, segmentId);
          return segment === undefined ? undefined : { transcriptRevisionId: segment.revisionId, text: segment.text };
        },
      );
      return { members, table, bodies, terms: termsSection(scope.terminology.effectiveForCollection(owner, collectionId)) };
    });
    const { members, table, bodies, terms } = loaded;
    const description = context.llm.describe(modelRef);
    const snapshots = request.inputItems.map(snapshotOf);

    const groups: RollupGroup[] = [];
    for (let first = 0; first < members.length; first += COLLECTION_PARTIAL_SIZE) {
      const slice = members.slice(first, first + COLLECTION_PARTIAL_SIZE);
      groups.push({
        ids: slice.map((member) => `${member.item.collectionItemId}:${member.item.summaryRevisionId}`),
        content: slice
          .map((member, offset) => {
            const k = first + offset + 1;
            const heading = member.title === undefined ? `【第 ${k} 讲】` : `【第 ${k} 讲】${member.title}`;
            return `${heading}\n${bodies[first + offset] as string}`;
          })
          .join("\n\n"),
        inputs: snapshots.slice(first, first + COLLECTION_PARTIAL_SIZE),
      });
    }
    const outcome = await runRollup(context, {
      table,
      modelRef,
      limits: description.capability.limits,
      feature: "collection_summary",
      templateBody: COLLECTION_ROLLUP_GOAL,
      outputLanguage,
      terms,
      groups,
      final: { prompt: ROLLUP_FINAL_COLLECTION_PROMPT, values: {} },
      digestBase: { collectionId, inputItems: request.inputItems },
    });

    const revisionId = this.newId();
    const artifactId = this.newId();
    const createdAt = this.now();
    const { body, citations } = finalizeCitations(outcome.final.text, table);
    const partials: RollupPartial[] = outcome.partials.map((partial) => {
      const finalized = finalizeCitations(partial.text, table);
      return {
        id: this.newId(),
        ownerRevisionId: revisionId,
        index: partial.index,
        inputs: partial.inputs,
        body: finalized.body,
        citations: finalized.citations,
        modelRef: description.snapshot,
        promptRef: ROLLUP_PARTIAL_PROMPT.ref,
        promptSnapshot: outcome.partialSnapshot,
        createdAt,
      };
    });
    return {
      resultJson: { revisionId, groups: groups.length, reasons: outcome.degraded ? ["citation_degraded"] : [] },
      publish: (scope) => {
        scope.collectionSummaries.insertRevision(owner, {
          collectionId,
          artifactId,
          revision: {
            id: revisionId,
            provenance: {
              inputs: snapshots,
              modelRef: description.snapshot,
              promptRef: ROLLUP_FINAL_COLLECTION_PROMPT.ref,
              promptSnapshot: outcome.finalSnapshot,
              createdAt,
            },
            quality: outcome.degraded ? "degraded" : "normal",
            inputItems: request.inputItems.map((item) => ({ ...item })),
            partialIds: partials.map((partial) => partial.id),
            body,
            citations,
          },
        });
        scope.collectionSummaries.setCurrent(owner, collectionId, revisionId);
        scope.collections.touch(owner, collectionId, createdAt);
        scope.rollupPartials.insertMany(owner, "collection_summary", partials);
        outcome.partials.forEach((partial, index) => scope.tokenUsage.attach(owner, partial.invocationIds, (partials[index] as RollupPartial).id));
        scope.tokenUsage.attach(owner, [...outcome.carryInvocationIds, ...outcome.final.invocationIds], revisionId);
      },
    };
  }
}

function snapshotOf(item: InputItem): ArtifactInputRef {
  return {
    kind: "collectionItemSnapshot",
    collectionItemId: item.collectionItemId,
    contentId: item.contentId,
    summaryRevisionId: item.summaryRevisionId,
    transcriptRevisionId: item.transcriptRevisionId,
    position: item.position,
  };
}
