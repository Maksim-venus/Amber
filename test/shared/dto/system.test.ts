import { describe, expect, it } from "vitest";
import { authMeDtoSchema, versionDtoSchema } from "../../../src/shared/dto/system.ts";

describe("system DTOs", () => {
  it("carry the run mode and nothing sensitive", () => {
    expect(versionDtoSchema.parse({ version: "0.1.0", mode: "server", path: "/srv" })).toEqual({ version: "0.1.0", mode: "server" });
    expect(versionDtoSchema.safeParse({ version: "0.1.0", mode: "cloud" }).success).toBe(false);
    const me = { userId: "u", role: "user", mode: "local", mustChangePassword: false };
    expect(authMeDtoSchema.parse(me)).toEqual(me);
    expect(authMeDtoSchema.safeParse({ ...me, mustChangePassword: undefined }).success).toBe(false);
  });
});
