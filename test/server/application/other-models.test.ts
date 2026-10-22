import { afterEach, describe, expect, it } from "vitest";
import { OtherModelService } from "../../../src/server/application/other-models.ts";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { BOB, createHarness, LOCAL, type Harness } from "../../fixtures/pipeline/harness.ts";
import { countRows } from "../../tools/sqlite.ts";

const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

function setup() {
  const h = createHarness();
  open.push(h);
  let clock = 1_000;
  const service = new OtherModelService({ repository: h.repository, newId: h.newId, now: () => (clock += 1) });
  return { h, service };
}

function code(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : String(error);
  }
  return undefined;
}

const PER_IMAGE = { currency: "USD" as const, items: [{ unit: "per_image" as const, amount: "0.04" }] };
const PER_CHARS = { currency: "CNY" as const, items: [{ unit: "characters_per_ten_thousand" as const, amount: "2" }], note: "按字符计费" };

describe("OtherModelService", () => {
  it("creates, lists in the user's order, edits and deletes register entries", () => {
    const { h, service } = setup();
    const tts = service.create(LOCAL, { name: " 语音合成 ", note: " 备用 ", models: [{ modelId: "cosyvoice-v3", kind: "tts" }] });
    expect(tts).toEqual({ id: tts.id, name: "语音合成", note: "备用", models: [{ modelId: "cosyvoice-v3", kind: "tts" }], createdAt: 1_001 });
    const empty = service.create(LOCAL, { name: "以后再填", models: [] });
    expect(empty).not.toHaveProperty("note");
    expect(service.list(LOCAL).items.map((item) => item.id)).toEqual([tts.id, empty.id]);

    const edited = service.update(LOCAL, tts.id, { name: "TTS", note: null });
    expect(edited).toEqual({ id: tts.id, name: "TTS", models: [{ modelId: "cosyvoice-v3", kind: "tts" }], createdAt: 1_001 });
    expect(service.update(LOCAL, tts.id, { note: "再写" }).note).toBe("再写");
    // An absent note stays as it is.
    expect(service.update(LOCAL, tts.id, { name: "TTS 2" }).note).toBe("再写");

    service.delete(LOCAL, empty.id);
    expect(service.list(LOCAL).items.map((item) => item.id)).toEqual([tts.id]);
    expect(code(() => service.delete(LOCAL, empty.id))).toBe("not_found");
    expect(countRows(h.db, "other_model_profile")).toBe(1);
  });

  it("refuses repeated model ids", () => {
    const { service } = setup();
    const models = [
      { modelId: "x", kind: "tts" as const },
      { modelId: "x", kind: "other" as const },
    ];
    expect(code(() => service.create(LOCAL, { name: "a", models }))).toBe("invalid_request");
    const created = service.create(LOCAL, { name: "a", models: [] });
    expect(code(() => service.update(LOCAL, created.id, { models }))).toBe("invalid_request");
  });

  it("prices models in any unit and keeps the price of kept ids when the list is replaced, kind changes included", () => {
    const { service } = setup();
    const created = service.create(LOCAL, {
      name: "生成",
      models: [
        { modelId: "image-1", kind: "image_generation" },
        { modelId: "tts-1", kind: "tts" },
      ],
    });
    service.setModelPricing(LOCAL, created.id, { modelId: "image-1", pricing: PER_IMAGE });
    expect(service.setModelPricing(LOCAL, created.id, { modelId: "tts-1", pricing: PER_CHARS }).models).toEqual([
      { modelId: "image-1", kind: "image_generation", pricing: PER_IMAGE },
      { modelId: "tts-1", kind: "tts", pricing: PER_CHARS },
    ]);
    const replaced = service.update(LOCAL, created.id, {
      models: [
        { modelId: "tts-1", kind: "other" },
        { modelId: "video-1", kind: "video_generation" },
      ],
    });
    expect(replaced.models).toEqual([
      { modelId: "tts-1", kind: "other", pricing: PER_CHARS },
      { modelId: "video-1", kind: "video_generation" },
    ]);
    // A removed model's price goes with it.
    expect(service.update(LOCAL, created.id, { models: [{ modelId: "image-1", kind: "image_generation" }] }).models).toEqual([{ modelId: "image-1", kind: "image_generation" }]);
    expect(service.setModelPricing(LOCAL, created.id, { modelId: "image-1", pricing: PER_IMAGE }).models[0]?.pricing).toEqual(PER_IMAGE);
    expect(service.setModelPricing(LOCAL, created.id, { modelId: "image-1", pricing: null }).models[0]).not.toHaveProperty("pricing");
    expect(code(() => service.setModelPricing(LOCAL, created.id, { modelId: "absent", pricing: PER_IMAGE }))).toBe("not_found");
  });

  it("orders the user's entries as given, every one exactly once", () => {
    const { service } = setup();
    const a = service.create(LOCAL, { name: "a", models: [] });
    const b = service.create(LOCAL, { name: "b", models: [] });
    const c = service.create(LOCAL, { name: "c", models: [] });
    expect(service.reorder(LOCAL, [c.id, a.id, b.id]).items.map((item) => item.name)).toEqual(["c", "a", "b"]);
    expect(service.list(LOCAL).items.map((item) => item.name)).toEqual(["c", "a", "b"]);
    const d = service.create(LOCAL, { name: "d", models: [] });
    expect(service.list(LOCAL).items.map((item) => item.id)).toEqual([c.id, a.id, b.id, d.id]);
    for (const wrong of [[c.id, a.id, b.id], [c.id, a.id, b.id, d.id, d.id], [c.id, a.id, b.id, "missing"]]) {
      expect(code(() => service.reorder(LOCAL, wrong))).toBe("invalid_request");
    }
  });

  it("keeps two users' registers apart", () => {
    const { service } = setup();
    const mine = service.create(LOCAL, { name: "mine", models: [{ modelId: "image-1", kind: "image_generation" }] });
    const theirs = service.create(BOB, { name: "theirs", models: [] });
    expect(service.list(LOCAL).items.map((item) => item.id)).toEqual([mine.id]);
    expect(service.list(BOB).items.map((item) => item.id)).toEqual([theirs.id]);
    expect(code(() => service.update(BOB, mine.id, { name: "taken" }))).toBe("not_found");
    expect(code(() => service.setModelPricing(BOB, mine.id, { modelId: "image-1", pricing: PER_IMAGE }))).toBe("not_found");
    expect(code(() => service.delete(BOB, mine.id))).toBe("not_found");
    expect(code(() => service.reorder(BOB, [mine.id]))).toBe("invalid_request");
    expect(code(() => service.reorder(BOB, [mine.id, theirs.id]))).toBe("invalid_request");
    expect(service.list(LOCAL).items).toEqual([mine]);
  });
});
