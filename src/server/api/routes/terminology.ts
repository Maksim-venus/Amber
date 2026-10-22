import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { putTerminologyRequestSchema, terminologyDtoSchema, terminologyScopeParamSchema } from "../../../shared/dto/terminology.ts";
import type { TerminologyService } from "../../application/terminology.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";

const scopeQuerySchema = z.object({ scope: terminologyScopeParamSchema }).strict();

/** `GET/PUT /api/terminology?scope=`. */
export function registerTerminologyRoutes(app: FastifyInstance, deps: { terminology: TerminologyService }): void {
  const { terminology } = deps;

  app.get("/api/terminology", async (request, reply) => {
    const { scope } = parseInput(scopeQuerySchema, request.query, "query");
    return sendValidated(reply, 200, terminologyDtoSchema, terminology.get(principalOf(request), scope));
  });

  app.put("/api/terminology", async (request, reply) => {
    const { scope } = parseInput(scopeQuerySchema, request.query, "query");
    const body = parseInput(putTerminologyRequestSchema, request.body, "body");
    return sendValidated(reply, 200, terminologyDtoSchema, terminology.put(principalOf(request), scope, body));
  });
}
