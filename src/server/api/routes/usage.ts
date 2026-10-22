import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_PAGE_SIZE_DEFAULT, API_PAGE_SIZE_MAX } from "../../../shared/defaults.ts";
import { usageDtoSchema } from "../../../shared/dto/usage.ts";
import { TOKEN_USAGE_FEATURES } from "../../../shared/enums.ts";
import type { UsageService } from "../../application/usage.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";

const timeSchema = z.coerce.number().int().nonnegative();
const usageQuerySchema = z
  .object({
    from: timeSchema.exactOptional(),
    to: timeSchema.exactOptional(),
    feature: z.enum(TOKEN_USAGE_FEATURES).exactOptional(),
    cursor: z.string().min(1).exactOptional(),
    limit: z.coerce.number().int().min(1).max(API_PAGE_SIZE_MAX).default(API_PAGE_SIZE_DEFAULT),
  })
  .strict();

/** `GET /api/usage`. */
export function registerUsageRoutes(app: FastifyInstance, deps: { usage: UsageService }): void {
  app.get("/api/usage", async (request, reply) => {
    const query = parseInput(usageQuerySchema, request.query, "query");
    return sendValidated(reply, 200, usageDtoSchema, deps.usage.list(principalOf(request), query));
  });
}
