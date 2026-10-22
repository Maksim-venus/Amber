import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { modelPricingRequestSchema } from "../../../shared/dto/model-pricing.ts";
import {
  asrModelTestRequestSchema,
  asrModelTestResultDtoSchema,
  asrProbeDtoSchema,
  asrProfileCreateSchema,
  asrProfileDtoSchema,
  asrProfileListDtoSchema,
  asrProfileOrderRequestSchema,
  asrProfilePatchSchema,
} from "../../../shared/dto/asr-profile.ts";
import type { AsrProfileService } from "../../application/asr-profile.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";
import { requestSignal } from "./contents.ts";

/** Secret-bearing request body: defined here on the server only, never in `src/shared` (the shared-secrets guard). */
const putCredentialRequestSchema = z.object({ value: z.string().min(1) }).strict();
const profileParamsSchema = z.object({ id: z.string().min(1) });

/** `/api/asr-profiles*`. */
export function registerAsrProfileRoutes(app: FastifyInstance, deps: { asrProfiles: AsrProfileService }): void {
  const { asrProfiles } = deps;

  app.get("/api/asr-profiles", async (request, reply) => sendValidated(reply, 200, asrProfileListDtoSchema, asrProfiles.list(principalOf(request))));

  app.post("/api/asr-profiles", async (request, reply) => {
    const body = parseInput(asrProfileCreateSchema, request.body, "body");
    return sendValidated(reply, 201, asrProfileDtoSchema, await asrProfiles.create(principalOf(request), body));
  });

  app.put("/api/asr-profiles/order", async (request, reply) => {
    const { profileIds } = parseInput(asrProfileOrderRequestSchema, request.body, "body");
    return sendValidated(reply, 200, asrProfileListDtoSchema, asrProfiles.reorder(principalOf(request), profileIds));
  });

  app.patch("/api/asr-profiles/:id", async (request, reply) => {
    const { id } = parseInput(profileParamsSchema, request.params, "params");
    const body = parseInput(asrProfilePatchSchema, request.body, "body");
    return sendValidated(reply, 200, asrProfileDtoSchema, await asrProfiles.update(principalOf(request), id, body));
  });

  app.delete("/api/asr-profiles/:id", async (request, reply) => {
    const { id } = parseInput(profileParamsSchema, request.params, "params");
    asrProfiles.delete(principalOf(request), id);
    return reply.code(204).send();
  });

  app.put("/api/asr-profiles/:id/credential", async (request, reply) => {
    const { id } = parseInput(profileParamsSchema, request.params, "params");
    const { value } = parseInput(putCredentialRequestSchema, request.body, "body");
    return sendValidated(reply, 200, asrProfileDtoSchema, asrProfiles.putCredential(principalOf(request), id, value));
  });

  app.post("/api/asr-profiles/:id/probe", async (request, reply) => {
    const { id } = parseInput(profileParamsSchema, request.params, "params");
    return sendValidated(reply, 200, asrProbeDtoSchema, await asrProfiles.probe(principalOf(request), id, requestSignal(reply)));
  });

  app.post("/api/asr-profiles/:id/test", async (request, reply) => {
    const { id } = parseInput(profileParamsSchema, request.params, "params");
    const { modelId } = parseInput(asrModelTestRequestSchema, request.body, "body");
    return sendValidated(reply, 200, asrModelTestResultDtoSchema, await asrProfiles.testModel(principalOf(request), id, modelId, requestSignal(reply)));
  });

  app.put("/api/asr-profiles/:id/model-pricing", async (request, reply) => {
    const { id } = parseInput(profileParamsSchema, request.params, "params");
    const body = parseInput(modelPricingRequestSchema, request.body, "body");
    return sendValidated(reply, 200, asrProfileDtoSchema, asrProfiles.setModelPricing(principalOf(request), id, body));
  });
}
