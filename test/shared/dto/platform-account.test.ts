import { describe, expect, it } from "vitest";
import {
  platformAccountDtoSchema,
  platformAccountListDtoSchema,
  platformCheckDtoSchema,
  platformQrAttemptDtoSchema,
  platformQrStatusDtoSchema,
} from "../../../src/shared/dto/platform-account.ts";

describe("platform account DTOs", () => {
  it("describe an account by status only, never by its cookie", () => {
    const shapeKeys = Object.keys(platformAccountDtoSchema.shape);
    expect(shapeKeys.sort()).toEqual(["checkedAt", "credentialStatus", "hasCredential", "platform", "status"]);
    const parsed = platformAccountDtoSchema.parse({ platform: "bilibili", credentialStatus: "configured", hasCredential: true, status: "unknown", cookies: "<placeholder>" });
    expect(parsed).not.toHaveProperty("cookies");
  });

  it("accept an absent account and reject unknown platforms and statuses", () => {
    expect(platformAccountListDtoSchema.safeParse({ accounts: [{ platform: "youtube", credentialStatus: "missing", hasCredential: false }] }).success).toBe(true);
    expect(platformAccountDtoSchema.safeParse({ platform: "vimeo", credentialStatus: "missing", hasCredential: false }).success).toBe(false);
    expect(platformCheckDtoSchema.safeParse({ status: "valid" }).success).toBe(true);
    expect(platformCheckDtoSchema.safeParse({ status: "ok" }).success).toBe(false);
  });

  it("describe a QR attempt and its four states", () => {
    expect(platformQrAttemptDtoSchema.safeParse({ attemptId: "a1", qrUrl: "https://example.com/qr", expiresAt: 1 }).success).toBe(true);
    expect(platformQrAttemptDtoSchema.safeParse({ attemptId: "", qrUrl: "https://example.com/qr", expiresAt: 1 }).success).toBe(false);
    for (const status of ["pending", "scanned", "confirmed", "expired"]) {
      expect(platformQrStatusDtoSchema.safeParse({ status }).success).toBe(true);
    }
    expect(platformQrStatusDtoSchema.safeParse({ status: "valid" }).success).toBe(false);
  });
});
