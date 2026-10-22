import { describe, expect, it } from "vitest";
import type { Task } from "../../../src/server/domain/task.ts";
import { laneConflict, laneKeys } from "../../../src/server/pipeline/lane.ts";

const task = (id: string, kind: Task["kind"], request: Record<string, unknown> = {}): Task => ({
  id, userId: "u", contentId: "c", kind, requestJson: JSON.stringify(request), statusProjection: "queued", createdAt: 1,
});

describe("mutation lane: Tasks whose stages overlap on one Content exclude each other", () => {
  it("is the stage set, with summaries per template and translations per language", () => {
    expect(laneKeys(task("a", "process_content"), "bilibili")).toEqual(["source", "subtitle", "asr", "proofread", "chapter", "summary:"]);
    expect(laneKeys(task("b", "regenerate_summary", { templateRef: { id: "summary.terms", version: 1 } }), "local")).toEqual(["summary:summary.terms"]);
    expect(laneKeys(task("c", "translate", { targetLanguages: ["en", "ja"] }), "local")).toEqual(["translate:en", "translate:ja"]);
  });

  it("detects overlaps and leaves disjoint work alone", () => {
    const others = [
      { task: task("t1", "translate", { targetLanguages: ["en"] }), keys: ["translate:en"] },
      { task: task("t2", "regenerate_summary", { templateRef: { id: "summary.core", version: 1 } }), keys: ["summary:summary.core"] },
    ];
    expect(laneConflict(["translate:ja"], others)).toBeUndefined();
    expect(laneConflict(["summary:summary.detailed"], others)).toBeUndefined();
    expect(laneConflict(["asr", "translate:en"], others)?.id).toBe("t1");
  });

  it("keeps cache_media and burn on one Content apart and each serial, without touching other lanes", () => {
    const cache = laneKeys(task("x", "cache_media", { requestSchemaVersion: 2, type: "video", fileName: "a", assetId: "a1" }), "bilibili");
    const burn = laneKeys(task("y", "burn", { mode: "original", revisionId: "r" }), "bilibili");
    expect(cache).toEqual(["cache_media", "burn"]);
    expect(burn).toEqual(["burn"]);
    expect(laneConflict(cache, [{ task: task("y", "burn"), keys: burn }])?.id).toBe("y");
    expect(laneConflict(burn, [{ task: task("x", "cache_media"), keys: cache }])?.id).toBe("x");
    expect(laneConflict(cache, [{ task: task("z", "cache_media"), keys: cache }])?.id).toBe("z");
    expect(laneConflict(burn, [{ task: task("z", "burn"), keys: burn }])?.id).toBe("z");
    const processing = laneKeys(task("p", "process_content"), "bilibili");
    expect(laneConflict(cache, [{ task: task("p", "process_content"), keys: processing }])).toBeUndefined();
    expect(laneConflict(burn, [{ task: task("p", "process_content"), keys: processing }])).toBeUndefined();
  });
});
