import type { Request, Route } from "@playwright/test";
import { modelPricingRequestSchema } from "../../src/shared/dto/model-pricing.ts";
import {
  otherModelOrderRequestSchema,
  otherModelProfileCreateSchema,
  otherModelProfileDtoSchema,
  otherModelProfileListDtoSchema,
  otherModelProfilePatchSchema,
  type OtherModelInput,
  type OtherModelProfileDto,
} from "../../src/shared/dto/other-model.ts";

/** The user's register of models Amber does not call, kept in memory. */
export class OtherModelsState {
  readonly profiles: OtherModelProfileDto[] = [];
  private next = 0;

  /** Kept models keep their price, as the server does. */
  models(previous: OtherModelProfileDto | undefined, input: readonly OtherModelInput[]): OtherModelProfileDto["models"] {
    return input.map((model) => {
      const pricing = previous?.models.find((item) => item.modelId === model.modelId)?.pricing;
      return { modelId: model.modelId, kind: model.kind, ...(pricing === undefined ? {} : { pricing }) };
    });
  }

  nextId(): string {
    this.next += 1;
    return `01J00000000000000000OTHER${this.next}`;
  }
}

/** `/api/other-models` and its pricing route; answers `false` for any other path. */
export async function handleOtherModels(state: OtherModelsState, route: Route, request: Request, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/other-models")) return false;
  const method = request.method();
  const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const list = () => otherModelProfileListDtoSchema.parse({ items: state.profiles });

  if (path === "/api/other-models" && method === "GET") {
    await json(list());
    return true;
  }
  if (path === "/api/other-models" && method === "POST") {
    const body = otherModelProfileCreateSchema.parse(request.postDataJSON());
    const created = otherModelProfileDtoSchema.parse({
      id: state.nextId(),
      name: body.name,
      ...(body.note === undefined ? {} : { note: body.note }),
      models: state.models(undefined, body.models),
      createdAt: Date.now(),
    });
    state.profiles.push(created);
    await json(created, 201);
    return true;
  }
  if (path === "/api/other-models/order" && method === "PUT") {
    const { profileIds } = otherModelOrderRequestSchema.parse(request.postDataJSON());
    const byId = new Map(state.profiles.map((profile) => [profile.id, profile]));
    state.profiles.splice(0, state.profiles.length, ...profileIds.flatMap((id) => byId.get(id) ?? []));
    await json(list());
    return true;
  }
  const match = /^\/api\/other-models\/([^/]+)(\/model-pricing)?$/.exec(path);
  const index = match === null ? -1 : state.profiles.findIndex((profile) => profile.id === decodeURIComponent(match[1] ?? ""));
  const profile = state.profiles[index];
  if (match === null || profile === undefined) {
    await json({ error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } }, 404);
    return true;
  }
  if (match[2] !== undefined && method === "PUT") {
    const { modelId, pricing } = modelPricingRequestSchema.parse(request.postDataJSON());
    const models = profile.models.map((model) => {
      if (model.modelId !== modelId) return model;
      const { pricing: _old, ...rest } = model;
      return pricing === null ? rest : { ...rest, pricing };
    });
    state.profiles[index] = otherModelProfileDtoSchema.parse({ ...profile, models });
    await json(state.profiles[index]);
    return true;
  }
  if (method === "PATCH") {
    const patch = otherModelProfilePatchSchema.parse(request.postDataJSON());
    const { note: _note, ...rest } = profile;
    const note = patch.note === undefined ? profile.note : (patch.note ?? undefined);
    state.profiles[index] = otherModelProfileDtoSchema.parse({
      ...rest,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(note === undefined ? {} : { note }),
      ...(patch.models === undefined ? {} : { models: state.models(profile, patch.models) }),
    });
    await json(state.profiles[index]);
    return true;
  }
  if (method === "DELETE") {
    state.profiles.splice(index, 1);
    await route.fulfill({ status: 204 });
    return true;
  }
  return false;
}
