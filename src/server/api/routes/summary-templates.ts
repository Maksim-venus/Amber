import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  summaryTemplateCreateRequestSchema,
  summaryTemplateDtoSchema,
  summaryTemplateListDtoSchema,
  summaryTemplatePatchRequestSchema,
  summaryTemplateVersionListDtoSchema,
} from "../../../shared/dto/summary.ts";
import type { SummaryTemplateService } from "../../application/summary-templates.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";

const idParamsSchema = z.object({ id: z.string().min(1) });

/** `/api/summary-templates*`. */
export function registerSummaryTemplateRoutes(app: FastifyInstance, deps: { summaryTemplates: SummaryTemplateService }): void {
  const { summaryTemplates } = deps;

  app.get("/api/summary-templates", async (request, reply) => {
    return sendValidated(reply, 200, summaryTemplateListDtoSchema, summaryTemplates.list(principalOf(request)));
  });

  app.post("/api/summary-templates", async (request, reply) => {
    const body = parseInput(summaryTemplateCreateRequestSchema, request.body, "body");
    return sendValidated(reply, 201, summaryTemplateDtoSchema, summaryTemplates.create(principalOf(request), body));
  });

  app.patch("/api/summary-templates/:id", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    const body = parseInput(summaryTemplatePatchRequestSchema, request.body, "body");
    return sendValidated(reply, 200, summaryTemplateDtoSchema, summaryTemplates.patch(principalOf(request), id, body));
  });

  app.delete("/api/summary-templates/:id", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    summaryTemplates.delete(principalOf(request), id);
    return reply.code(204).send();
  });

  app.get("/api/summary-templates/:id/versions", async (request, reply) => {
    const { id } = parseInput(idParamsSchema, request.params, "params");
    return sendValidated(reply, 200, summaryTemplateVersionListDtoSchema, summaryTemplates.versions(principalOf(request), id));
  });
}
