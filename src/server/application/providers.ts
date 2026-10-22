import { monotonicFactory } from "ulid";
import type {
  CreateProviderRequest,
  ModelCapabilityDto,
  ModelOverrideRequest,
  ProbeResultDto,
  ProviderListDto,
  ProviderProfileDto,
  UpdateProviderRequest,
} from "../../shared/dto/provider.ts";
import type { ModelPricingRequest } from "../../shared/dto/model-pricing.ts";
import { pricingFitsScope } from "../../shared/model-pricing.ts";
import { amberError } from "../domain/errors.ts";
import type { ModelRef } from "../domain/model-ref.ts";
import {
  effectiveCapability,
  newModelCapability,
  withUserLimits,
  type CapabilityFlags,
  type CapabilityLimits,
  type ModelCapability,
  type ProviderProfile,
} from "../domain/provider-profile.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { LlmProbeFlag } from "../ports/llm-provider.ts";
import { PERMISSIVE_TARGET_CHECK, type NetworkTargetCheck } from "../ports/network-target-check.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import type { SecretStore } from "../ports/secret-store.ts";
import { normalizeBaseUrl } from "./base-url.ts";
import { jsonRequestDigest, runIdempotent, type IdempotentResult } from "./idempotency.ts";
import { unfinishedTasksUsingModel } from "./profile-references.ts";

export const PROBE_ROUTE = "POST /api/providers/:id/probe";

/** "Test connection" as the LlmGateway runs it: measures, records usage, writes nothing else. */
export interface ModelProber {
  probe(userId: string, modelRef: ModelRef, signal: AbortSignal): Promise<{ observed: Pick<CapabilityFlags, LlmProbeFlag>; latencyMs: number }>;
}

export interface ProviderServiceOptions {
  repository: Repository;
  secrets: Pick<SecretStore, "store" | "replace" | "status">;
  prober: ModelProber;
  /** Save-time network policy; permissive unless the server mode composes the strict one. */
  targets?: NetworkTargetCheck;
  /**
   * Told after a commit that changed what a profile's calls reach: its endpoint or key (all
   * models), removed models (those only), or the profile itself was deleted. The gateway's
   * model lanes start over for them.
   */
  onChanged?: (profileId: string, modelIds?: readonly string[]) => void;
  now?: () => number;
  newId?: () => string;
}

/**
 * `/api/providers*`: LLM endpoint profiles, their models
 * and the three capability layers. The key is written through SecretStore in the same
 * transaction as the profile and never leaves it; DTOs carry only its status. A profile or
 * model still used by an unfinished Task cannot be removed.
 */
export class ProviderService {
  private readonly options: ProviderServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly targets: NetworkTargetCheck;

  constructor(options: ProviderServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
    this.targets = options.targets ?? PERMISSIVE_TARGET_CHECK;
  }

  /**
   * The save-time half of the outbound network policy: an endpoint the
   * policy refuses is not stored. Called before saving because resolving takes a round trip
   * and a transaction cannot wait for one; every request is checked again anyway.
   */
  async checkBaseUrl(baseURL: string | undefined): Promise<void> {
    if (baseURL !== undefined) {
      await this.targets.check(normalizeBaseUrl(baseURL));
    }
  }

  list(principal: RequestPrincipal): ProviderListDto {
    const owner = principal.userId;
    const profiles = this.options.repository.withTransaction((scope) => scope.providerProfiles.list(owner));
    return { items: profiles.map((profile) => this.dto(profile)) };
  }

  /** The user's own order of their profiles: every profile exactly once. */
  reorder(principal: RequestPrincipal, profileIds: readonly string[]): ProviderListDto {
    const owner = principal.userId;
    const profiles = this.options.repository.withTransaction((scope) => {
      const present = scope.providerProfiles.list(owner).map((profile) => profile.id);
      const given = new Set(profileIds);
      if (given.size !== profileIds.length || given.size !== present.length || present.some((id) => !given.has(id))) {
        throw amberError("invalid_request", "profileIds must list every profile exactly once", { params: { detail: "profileIds" } });
      }
      scope.providerProfiles.reorder(owner, profileIds);
      return scope.providerProfiles.list(owner);
    });
    return { items: profiles.map((profile) => this.dto(profile)) };
  }

  get(principal: RequestPrincipal, profileId: string): ProviderProfileDto {
    return this.dto(this.options.repository.withTransaction((scope) => requireProfile(scope, principal.userId, profileId)));
  }

  create(principal: RequestPrincipal, request: CreateProviderRequest): ProviderProfileDto {
    const profile: ProviderProfile = {
      id: this.newId(),
      userId: principal.userId,
      name: request.name,
      protocol: request.protocol,
      baseURL: normalizeBaseUrl(request.baseURL),
      models: modelList(request.models, []),
      createdAt: this.now(),
    };
    this.options.repository.withTransaction((scope) => scope.providerProfiles.insert(profile));
    return this.dto(profile);
  }

  update(principal: RequestPrincipal, profileId: string, request: UpdateProviderRequest): ProviderProfileDto {
    const owner = principal.userId;
    const baseURL = request.baseURL === undefined ? undefined : normalizeBaseUrl(request.baseURL);
    let changed: { modelIds?: string[] } | undefined;
    const updated = this.options.repository.withTransaction((scope) => {
      const existing = requireProfile(scope, owner, profileId);
      let models = existing.models;
      if (request.models !== undefined) {
        models = modelList(request.models, existing.models);
        const kept = new Set(models.map((model) => model.modelId));
        for (const removed of existing.models.filter((model) => !kept.has(model.modelId))) {
          if (unfinishedTasksUsingModel(scope, owner, profileId, removed.modelId).length > 0) {
            throw amberError("conflict", "an unfinished task still uses a removed model");
          }
        }
      }
      const profile: ProviderProfile = {
        ...existing,
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(baseURL === undefined ? {} : { baseURL }),
        models,
      };
      scope.providerProfiles.update(profile);
      // Remembered and default model choices must keep naming a listed model.
      scope.userSettings.clearModelRefs(owner, profileId, models.map((model) => model.modelId));
      const kept = new Set(models.map((model) => model.modelId));
      const removed = existing.models.map((model) => model.modelId).filter((modelId) => !kept.has(modelId));
      changed = profile.baseURL !== existing.baseURL ? {} : removed.length > 0 ? { modelIds: removed } : undefined;
      return profile;
    });
    if (changed !== undefined) {
      this.options.onChanged?.(profileId, changed.modelIds);
    }
    return this.dto(updated);
  }

  /**
   * Removes the profile and, through the schema trigger, its Secret; usage keeps its
   * snapshot, and model choices that named the profile are cleared with it.
   */
  delete(principal: RequestPrincipal, profileId: string): void {
    const owner = principal.userId;
    this.options.repository.withTransaction((scope) => {
      requireProfile(scope, owner, profileId);
      if (unfinishedTasksUsingModel(scope, owner, profileId).length > 0) {
        throw amberError("conflict", "an unfinished task still uses the profile");
      }
      scope.providerProfiles.delete(owner, profileId);
      scope.userSettings.clearModelRefs(owner, profileId);
    });
    this.options.onChanged?.(profileId);
  }

  /** Stores the key as a Secret; re-entering it replaces the ciphertext under the same reference. */
  putCredential(principal: RequestPrincipal, profileId: string, value: string): ProviderProfileDto {
    const owner = principal.userId;
    const { secrets } = this.options;
    const updated = this.options.repository.withTransaction((scope) => {
      const existing = requireProfile(scope, owner, profileId);
      if (existing.credentialRef === undefined) {
        const profile = { ...existing, credentialRef: secrets.store(owner, value) };
        scope.providerProfiles.update(profile);
        return profile;
      }
      secrets.replace(owner, existing.credentialRef, value);
      return existing;
    });
    this.options.onChanged?.(profileId);
    return this.dto(updated);
  }

  /**
   * "Test connection": the measured flags become the model's `observed`
   * layer only when every check finished; a failed probe writes nothing. A repeated
   * `Idempotency-Key` replays the stored answer without calling the upstream again.
   */
  async probe(principal: RequestPrincipal, profileId: string, modelId: string, signal: AbortSignal, idempotencyKey?: string): Promise<IdempotentResult<ProbeResultDto>> {
    const owner = principal.userId;
    const context = { userId: owner, route: PROBE_ROUTE, key: idempotencyKey, requestDigest: jsonRequestDigest({ profileId, modelId }) };
    const replay = this.options.repository.withTransaction((scope) => {
      const stored = idempotencyKey === undefined ? undefined : scope.idempotency.get(owner, PROBE_ROUTE, idempotencyKey);
      if (stored === undefined) {
        requireModel(requireProfile(scope, owner, profileId), modelId);
        return undefined;
      }
      if (stored.requestDigest !== context.requestDigest) {
        throw amberError("idempotency_conflict", "idempotency key reused with a different request");
      }
      return { status: stored.responseStatus, body: JSON.parse(stored.responseBodyJson) as ProbeResultDto, replayed: true };
    });
    if (replay !== undefined) {
      return replay;
    }
    const measured = await this.options.prober.probe(owner, { providerProfileId: profileId, modelId }, signal);
    const observedAt = this.now();
    return this.options.repository.withTransaction((scope) =>
      runIdempotent(scope, context, observedAt, () => {
        const profile = requireProfile(scope, owner, profileId);
        const model = requireModel(profile, modelId);
        const observed: Partial<CapabilityFlags> = { ...model.flags.observed, ...measured.observed };
        const updated: ModelCapability = { ...model, flags: { ...model.flags, observed }, observedAt };
        scope.providerProfiles.update(replaceModel(profile, updated));
        const body: ProbeResultDto = { modelId, observed: measured.observed, latencyMs: measured.latencyMs, observedAt };
        return { status: 200, body, resourceRefs: [] };
      }),
    );
  }

  /**
   * Replaces the user's override layers: a layer present in the request
   * replaces the stored one with its non-null fields, `null` clearing a field; an absent
   * layer stays as it is, and an emptied layer is removed so lower layers show through.
   */
  putOverride(principal: RequestPrincipal, profileId: string, modelId: string, request: ModelOverrideRequest): ProviderProfileDto {
    const owner = principal.userId;
    const updated = this.options.repository.withTransaction((scope) => {
      const profile = requireProfile(scope, owner, profileId);
      const model = requireModel(profile, modelId);
      const flags = request.flags === undefined ? model.flags.userOverride : nonNull<Partial<CapabilityFlags>>(request.flags);
      const limits = request.limits === undefined ? model.limits.userOverride : nonNull<Partial<CapabilityLimits>>(request.limits);
      const { userOverride: _flags, ...flagLayers } = model.flags;
      const { userOverride: _limits, ...limitLayers } = model.limits;
      const next: ModelCapability = {
        ...model,
        flags: { ...flagLayers, ...(flags === undefined ? {} : { userOverride: flags }) },
        limits: { ...limitLayers, ...(limits === undefined ? {} : { userOverride: limits }) },
      };
      const result = replaceModel(profile, next);
      scope.providerProfiles.update(result);
      return result;
    });
    return this.dto(updated);
  }

  /**
   * Sets or clears one model's price: display only, outside the capability
   * layers, and allowed while Tasks use the model. Units must be those the models section offers.
   */
  setModelPricing(principal: RequestPrincipal, profileId: string, request: ModelPricingRequest): ProviderProfileDto {
    const owner = principal.userId;
    const { pricing } = request;
    if (pricing !== null && !pricingFitsScope(pricing, "llm")) {
      throw amberError("invalid_request", "a price unit is not offered for AI models", { params: { detail: "pricing" } });
    }
    const updated = this.options.repository.withTransaction((scope) => {
      const profile = requireProfile(scope, owner, profileId);
      const { pricing: _previous, ...model } = requireModel(profile, request.modelId);
      const result = replaceModel(profile, pricing === null ? model : { ...model, pricing });
      scope.providerProfiles.update(result);
      return result;
    });
    return this.dto(updated);
  }

  private dto(profile: ProviderProfile): ProviderProfileDto {
    const credentialStatus = this.options.secrets.status(profile.userId, profile.credentialRef);
    return {
      id: profile.id,
      name: profile.name,
      protocol: profile.protocol,
      baseURL: profile.baseURL,
      models: profile.models.map(modelDto),
      createdAt: profile.createdAt,
      credentialStatus,
      hasCredential: credentialStatus !== "missing",
    };
  }
}

function requireProfile(scope: RepositoryScope, ownerUserId: string, profileId: string): ProviderProfile {
  const profile = scope.providerProfiles.get(ownerUserId, profileId);
  if (profile === undefined) {
    throw amberError("not_found", `provider profile ${profileId}`);
  }
  return profile;
}

function requireModel(profile: ProviderProfile, modelId: string): ModelCapability {
  const model = profile.models.find((candidate) => candidate.modelId === modelId);
  if (model === undefined) {
    throw amberError("not_found", "model not on this provider profile");
  }
  return model;
}

function replaceModel(profile: ProviderProfile, model: ModelCapability): ProviderProfile {
  return { ...profile, models: profile.models.map((candidate) => (candidate.modelId === model.modelId ? model : candidate)) };
}

/**
 * The model list as requested, in its order: models kept by id keep their measured and
 * overridden layers and their price, and take the newly stated limits; new ones start all
 * `unknown`.
 */
function modelList(input: CreateProviderRequest["models"], existing: readonly ModelCapability[]): ModelCapability[] {
  const ids = input.map((model) => model.modelId);
  if (new Set(ids).size !== ids.length) {
    throw amberError("invalid_request", "duplicate modelId", { params: { detail: "models" } });
  }
  return input.map(({ modelId, ...limits }) => {
    const kept = existing.find((model) => model.modelId === modelId);
    return kept === undefined ? newModelCapability(modelId, limits) : withUserLimits(kept, limits);
  });
}

/** The fields that are not `null`, or `undefined` when none are left. */
function nonNull<T extends object>(layer: Record<string, unknown>): T | undefined {
  const entries = Object.entries(layer).filter(([, value]) => value !== null && value !== undefined);
  return entries.length === 0 ? undefined : (Object.fromEntries(entries) as T);
}

function modelDto(model: ModelCapability): ModelCapabilityDto {
  const { flags, limits } = model;
  return {
    modelId: model.modelId,
    flags: {
      declared: flags.declared,
      ...(flags.observed === undefined ? {} : { observed: flags.observed }),
      ...(flags.userOverride === undefined ? {} : { userOverride: flags.userOverride }),
    },
    limits: {
      declared: limits.declared,
      ...(limits.observed === undefined ? {} : { observed: limits.observed }),
      ...(limits.userOverride === undefined ? {} : { userOverride: limits.userOverride }),
    },
    ...(model.observedAt === undefined ? {} : { observedAt: model.observedAt }),
    effective: effectiveCapability(model),
    ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
  };
}
