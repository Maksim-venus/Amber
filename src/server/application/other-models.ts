import { monotonicFactory } from "ulid";
import type { ModelPricingRequest } from "../../shared/dto/model-pricing.ts";
import type {
  OtherModelInput,
  OtherModelProfileCreate,
  OtherModelProfileDto,
  OtherModelProfileListDto,
  OtherModelProfilePatch,
} from "../../shared/dto/other-model.ts";
import { pricingFitsScope } from "../../shared/model-pricing.ts";
import { amberError } from "../domain/errors.ts";
import type { OtherModelEntry, OtherModelProfile } from "../domain/provider-profile.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";

export interface OtherModelServiceOptions {
  repository: Repository;
  newId?: () => string;
  now?: () => number;
}

/**
 * `/api/other-models*`: the user's register of models Amber does
 * not call (speech synthesis, image or video generation …), each profile a name, a note and
 * models with their kind and the user's price. Nothing here holds a key or an address, and
 * nothing in Amber reads it besides the settings page; rows go with their user.
 */
export class OtherModelService {
  private readonly repository: Repository;
  private readonly newId: () => string;
  private readonly now: () => number;

  constructor(options: OtherModelServiceOptions) {
    this.repository = options.repository;
    this.newId = options.newId ?? monotonicFactory();
    this.now = options.now ?? Date.now;
  }

  list(principal: RequestPrincipal): OtherModelProfileListDto {
    const owner = principal.userId;
    return { items: this.repository.withTransaction((scope) => scope.otherModelProfiles.list(owner)).map(toDto) };
  }

  create(principal: RequestPrincipal, body: OtherModelProfileCreate): OtherModelProfileDto {
    const note = body.note?.trim();
    const profile: OtherModelProfile = {
      id: this.newId(),
      userId: principal.userId,
      name: body.name.trim(),
      ...(note === undefined ? {} : { note }),
      models: modelList(body.models, []),
      createdAt: this.now(),
    };
    this.repository.withTransaction((scope) => scope.otherModelProfiles.insert(profile));
    return toDto(profile);
  }

  /** `models` replaces the list in the given order; a kept model id keeps its price, its kind may change. */
  update(principal: RequestPrincipal, profileId: string, body: OtherModelProfilePatch): OtherModelProfileDto {
    const owner = principal.userId;
    return toDto(
      this.repository.withTransaction((scope) => {
        const { note: previousNote, ...current } = requireProfile(scope, owner, profileId);
        const note = body.note === undefined ? previousNote : body.note === null ? undefined : body.note.trim();
        const next: OtherModelProfile = {
          ...current,
          ...(body.name === undefined ? {} : { name: body.name.trim() }),
          ...(note === undefined ? {} : { note }),
          models: body.models === undefined ? current.models : modelList(body.models, current.models),
        };
        scope.otherModelProfiles.update(next);
        return next;
      }),
    );
  }

  delete(principal: RequestPrincipal, profileId: string): void {
    const owner = principal.userId;
    this.repository.withTransaction((scope) => {
      if (!scope.otherModelProfiles.delete(owner, profileId)) {
        throw amberError("not_found", "no such other-models profile");
      }
    });
  }

  /** The user's own order of their profiles: every profile exactly once. */
  reorder(principal: RequestPrincipal, profileIds: readonly string[]): OtherModelProfileListDto {
    const owner = principal.userId;
    const profiles = this.repository.withTransaction((scope) => {
      const present = scope.otherModelProfiles.list(owner).map((profile) => profile.id);
      const given = new Set(profileIds);
      if (given.size !== profileIds.length || given.size !== present.length || present.some((id) => !given.has(id))) {
        throw amberError("invalid_request", "profileIds must list every profile exactly once", { params: { detail: "profileIds" } });
      }
      scope.otherModelProfiles.reorder(owner, profileIds);
      return scope.otherModelProfiles.list(owner);
    });
    return { items: profiles.map(toDto) };
  }

  /** Sets or clears one model's price; every unit is offered here. */
  setModelPricing(principal: RequestPrincipal, profileId: string, body: ModelPricingRequest): OtherModelProfileDto {
    const owner = principal.userId;
    const { pricing } = body;
    if (pricing !== null && !pricingFitsScope(pricing, "other")) {
      throw amberError("invalid_request", "a price unit is not offered here", { params: { detail: "pricing" } });
    }
    return toDto(
      this.repository.withTransaction((scope) => {
        const current = requireProfile(scope, owner, profileId);
        if (!current.models.some((model) => model.modelId === body.modelId)) {
          throw amberError("not_found", "model not on this other-models profile");
        }
        const next: OtherModelProfile = {
          ...current,
          models: current.models.map((model) => {
            if (model.modelId !== body.modelId) {
              return model;
            }
            const { pricing: _previous, ...rest } = model;
            return pricing === null ? rest : { ...rest, pricing };
          }),
        };
        scope.otherModelProfiles.update(next);
        return next;
      }),
    );
  }
}

function requireProfile(scope: RepositoryScope, owner: string, profileId: string): OtherModelProfile {
  const profile = scope.otherModelProfiles.get(owner, profileId);
  if (profile === undefined) {
    throw amberError("not_found", "no such other-models profile");
  }
  return profile;
}

/** The list as requested, without repeated ids; a kept id keeps its price and takes the given kind. */
function modelList(input: readonly OtherModelInput[], existing: readonly OtherModelEntry[]): OtherModelEntry[] {
  const ids = input.map((model) => model.modelId.trim());
  if (new Set(ids).size !== ids.length) {
    throw amberError("invalid_request", "duplicate modelId", { params: { detail: "models" } });
  }
  return input.map((model, index) => {
    const modelId = ids[index] as string;
    const pricing = existing.find((entry) => entry.modelId === modelId)?.pricing;
    return { modelId, kind: model.kind, ...(pricing === undefined ? {} : { pricing }) };
  });
}

function toDto(profile: OtherModelProfile): OtherModelProfileDto {
  return {
    id: profile.id,
    name: profile.name,
    ...(profile.note === undefined ? {} : { note: profile.note }),
    models: profile.models.map((model) => ({
      modelId: model.modelId,
      kind: model.kind,
      ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
    })),
    createdAt: profile.createdAt,
  };
}
