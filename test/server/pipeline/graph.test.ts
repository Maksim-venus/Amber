import { describe, expect, it } from "vitest";
import { downstreamStages, stageGraph } from "../../../src/server/pipeline/graph.ts";
import { TASK_KINDS } from "../../../src/shared/enums.ts";

const shape = (kind: Parameters<typeof stageGraph>[0], source: Parameters<typeof stageGraph>[1]) =>
  stageGraph(kind, source).map((spec) => [spec.stage, spec.dependencies.join("+"), spec.condition ?? "", spec.requirement ?? ""]);

describe("Task.kind → StageRun graph", () => {
  it("chains the platform process_content graph with its conditions and requirements", () => {
    expect(shape("process_content", "bilibili")).toEqual([
      ["source", "", "", ""],
      ["subtitle", "source", "", ""],
      ["asr", "subtitle", "needs_asr", "asr_configured"],
      ["proofread", "asr", "auto_proofread_enabled", "llm_configured"],
      ["chapter", "proofread", "no_platform_chapters", "llm_configured"],
      ["summary", "chapter", "", "llm_configured"],
    ]);
  });

  it("starts local processing with a heavy media probe", () => {
    const graph = stageGraph("process_content", "local");
    expect(graph.map((spec) => spec.stage)).toEqual(["media", "asr", "proofread", "chapter", "summary"]);
    expect(graph[0]?.heavy).toBe(true);
  });

  it("gives every other kind its single stage", () => {
    expect(TASK_KINDS.filter((kind) => kind !== "process_content").map((kind) => [kind, shape(kind, "local")])).toEqual([
      ["regenerate_summary", [["summary", "", "", "llm_configured"]]],
      ["reproofread", [["proofread", "", "", "llm_configured"]]],
      ["retranscribe", [["asr", "", "", "asr_configured"]]],
      ["regenerate_chapters", [["chapter", "", "", "llm_configured"]]],
      ["recompute_highlights", [["highlight", "", "", "llm_configured"]]],
      ["translate", [["translate", "", "", "llm_configured"]]],
      ["summarize_collection", [["collection_summary", "", "", "llm_configured"]]],
      ["burn", [["burn", "", "client_only", ""]]],
      ["cache_media", [["cache_media", "", "client_only", ""]]],
    ]);
  });

  it("finds direct and transitive dependants", () => {
    const graph = stageGraph("process_content", "youtube");
    expect(downstreamStages(graph, "subtitle")).toEqual(["asr", "proofread", "chapter", "summary"]);
    expect(downstreamStages(graph, "summary")).toEqual([]);
  });
});
