import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { modelPricingRequestSchema } from "../../../shared/dto/model-pricing.ts";
import {
  otherModelOrderRequestSchema,
  otherModelProfileCreateSchema,
  otherModelProfileDtoSchema,
  otherModelProfileListDtoSchema,
  otherModelProfilePatchSchema,
} from "../../../shared/dto/other-model.ts";
import type { OtherModelService } from "../../application/other-models.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";

const profileParamsSchema = z.object({ id: z.string().min(1) });

/** `/api/other-models*`. */
export function registerOtherModelRoutes(app: FastifyInstance, deps: { otherModels: OtherModelService }): void {
  const { otherModels } = deps;

  app.get("/api/other-models", async (request, reply) => sendValidated(reply, 200, otherModelProfileListDtoSchema, otherModels.list(principalOf(request))));

  app.post("/api/other-models", async (request, reply) => {
    const body = parseInput(otherModelProfileCreateSchema, request.body, "body");
    return sendValidated(reply, 201, otherModelProfileDtoSchema, otherModels.create(principalOf(request), body));
  });

  app.put("/api/other-models/order", async (request, reply) => {
    const { profileIds } = parseInput(otherModelOrderRequestSchema, request.body, "body");
    return sendValidated(reply, 200, otherModelProfileListDtoSchema, otherModels.reorder(principalOf(request), profileIds));
  });

  app.patch("/api/other-models/:id", async (request, reply) => {
    const { id } = parseInput(profileParamsSchema, request.params, "params");
    const body = parseInput(otherModelProfilePatchSchema, request.body, "body");
    return sendValidated(reply, 200, otherModelProfileDtoSchema, otherModels.update(principalOf(request), id, body));
  });

  app.delete("/api/other-models/:id", async (request, reply) => {
    const { id } = parseInput(profileParamsSchema, request.params, "params");
    otherModels.delete(principalOf(request), id);
    return reply.code(204).send();
  });

  app.put("/api/other-models/:id/model-pricing", async (request, reply) => {
    const { id } = parseInput(profileParamsSchema, request.params, "params");
    const body = parseInput(modelPricingRequestSchema, request.body, "body");
    return sendValidated(reply, 200, otherModelProfileDtoSchema, otherModels.setModelPricing(principalOf(request), id, body));
  });
}
