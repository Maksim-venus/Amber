import type { StageRequirementId } from "../../shared/enums.ts";
import type { AppError } from "../../shared/errors.ts";
import { appError } from "../domain/errors.ts";
import type { AsrModelRef, ModelRef } from "../domain/model-ref.ts";
import type { RepositoryScope } from "../ports/repository.ts";
import type { SecretStore } from "../ports/secret-store.ts";

export type CredentialStatusSource = Pick<SecretStore, "status">;

/**
 * Why a ModelRef cannot be used by its owner, or `undefined` when it names one of the
 * owner's profiles and a model listed on it. Credentials are not checked here.
 */
export function modelRefProblem(scope: RepositoryScope, ownerUserId: string, modelRef: ModelRef): string | undefined {
  const profile = scope.providerProfiles.get(ownerUserId, modelRef.providerProfileId);
  if (profile === undefined) {
    return "modelRef.providerProfileId does not name one of your providers";
  }
  if (!profile.models.some((model) => model.modelId === modelRef.modelId)) {
    return "modelRef.modelId is not a model of that provider";
  }
  return undefined;
}

/**
 * Why an AsrModelRef cannot be used by its owner, or `undefined` when it names one of the
 * owner's ASR profiles and a model listed on it. Neither the credential nor whether the
 * model's request family still resolves is checked here.
 */
export function asrModelRefProblem(scope: RepositoryScope, ownerUserId: string, ref: AsrModelRef): string | undefined {
  const profile = scope.asrProfiles.get(ownerUserId, ref.asrProfileId);
  if (profile === undefined) {
    return "asrModelRef.asrProfileId does not name one of your ASR profiles";
  }
  if (!profile.models.some((model) => model.modelId === ref.modelId)) {
    return "asrModelRef.modelId is not a model of that ASR profile";
  }
  return undefined;
}

/**
 * The error a stage waits with when its requirement is unmet, else
 * `undefined`. `llm_configured` needs an explicit ModelRef (frozen stage input first, then
 * the Task request) naming an owned profile, a listed model and a usable credential;
 * there is no fallback to "any configured profile". `asr_configured` likewise needs the
 * bound AsrModelRef (frozen stage input first, then the Task request) naming one of the
 * owner's profiles, a model listed on it and a usable credential; the user's default is
 * only ever a picker's initial value, never applied here.
 */
export function unmetRequirement(
  scope: RepositoryScope,
  secrets: CredentialStatusSource,
  input: { requirement: StageRequirementId; ownerUserId: string; modelRef: ModelRef | undefined; asrModelRef: AsrModelRef | undefined },
): AppError | undefined {
  const { ownerUserId } = input;
  switch (input.requirement) {
    case "llm_configured": {
      const { modelRef } = input;
      if (modelRef === undefined || modelRefProblem(scope, ownerUserId, modelRef) !== undefined) {
        return appError("llm_unconfigured");
      }
      const profile = scope.providerProfiles.get(ownerUserId, modelRef.providerProfileId);
      return secrets.status(ownerUserId, profile?.credentialRef) === "configured" ? undefined : appError("llm_unconfigured");
    }
    case "asr_configured": {
      const { asrModelRef } = input;
      if (asrModelRef === undefined || asrModelRefProblem(scope, ownerUserId, asrModelRef) !== undefined) {
        return appError("asr_unconfigured");
      }
      const profile = scope.asrProfiles.get(ownerUserId, asrModelRef.asrProfileId);
      return secrets.status(ownerUserId, profile?.credentialRef) === "configured" ? undefined : appError("asr_unconfigured");
    }
  }
}
