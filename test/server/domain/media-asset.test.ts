import { describe, expect, it } from "vitest";
import { defaultRetentionPolicy } from "../../../src/server/domain/media-asset.ts";
import { UPLOAD_RETENTION_DEFAULT } from "../../../src/shared/defaults.ts";

describe("defaultRetentionPolicy", () => {
  it("follows the five MediaAsset lifecycles", () => {
    expect(defaultRetentionPolicy("external_local", UPLOAD_RETENTION_DEFAULT)).toBe("never_delete");
    expect(defaultRetentionPolicy("managed_upload", UPLOAD_RETENTION_DEFAULT)).toBe(UPLOAD_RETENTION_DEFAULT);
    expect(defaultRetentionPolicy("platform_cache", UPLOAD_RETENTION_DEFAULT)).toBe("evictable");
    expect(defaultRetentionPolicy("extracted_audio", UPLOAD_RETENTION_DEFAULT)).toBe("ephemeral");
    expect(defaultRetentionPolicy("temporary", UPLOAD_RETENTION_DEFAULT)).toBe("ephemeral");
  });

  it("takes managed uploads from the effective instance setting and nothing else", () => {
    expect(defaultRetentionPolicy("managed_upload", "discard_after_audio")).toBe("discard_after_audio");
    expect(defaultRetentionPolicy("external_local", "discard_after_audio")).toBe("never_delete");
    expect(defaultRetentionPolicy("platform_cache", "discard_after_audio")).toBe("evictable");
  });
});
