import type { FastifyInstance } from "fastify";
import { searchQuerySchema, searchResultDtoSchema } from "../../../shared/dto/search.ts";
import type { SearchService } from "../../application/search.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";

/** `GET /api/search`. */
export function registerSearchRoutes(app: FastifyInstance, deps: { search: SearchService }): void {
  app.get("/api/search", async (request, reply) => {
    const query = parseInput(searchQuerySchema, request.query, "query");
    return sendValidated(reply, 200, searchResultDtoSchema, deps.search.search(principalOf(request), query));
  });
}
