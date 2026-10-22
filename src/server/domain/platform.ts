import { PLATFORMS, type ContentSourceKind, type Platform } from "../../shared/enums.ts";

export { CONTENT_SOURCE_KINDS, PLATFORMS } from "../../shared/enums.ts";
export type { ContentSourceKind, Platform } from "../../shared/enums.ts";

export function isPlatform(kind: ContentSourceKind): kind is Platform {
  return (PLATFORMS as readonly string[]).includes(kind);
}
