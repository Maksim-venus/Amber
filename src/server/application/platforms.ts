import { PLATFORMS, type Platform } from "../domain/platform.ts";
import { amberError } from "../domain/errors.ts";
import type { ParsedPlatformUrl, PlatformSourceAdapter } from "../ports/platform-source.ts";

export interface RecognizedUrl {
  adapter: PlatformSourceAdapter;
  parsed: ParsedPlatformUrl;
}

function unsupported(): Error {
  return amberError("source_unsupported_url", "no platform adapter accepts the link", { params: { supported: PLATFORMS.join(", ") } });
}

/**
 * The composed platform adapters, looked up by `Content.source.kind` or by URL. Services
 * reach platform behavior only through here, never by platform name (the platform-literals
 * guard).
 */
export class PlatformRegistry {
  private readonly adapters: readonly PlatformSourceAdapter[];

  constructor(adapters: readonly PlatformSourceAdapter[]) {
    this.adapters = adapters;
  }

  get all(): readonly PlatformSourceAdapter[] {
    return this.adapters;
  }

  adapterFor(kind: Platform): PlatformSourceAdapter {
    const adapter = this.adapters.find((candidate) => candidate.kind === kind);
    if (adapter === undefined) {
      throw new TypeError(`no adapter is composed for ${kind}`);
    }
    return adapter;
  }

  /** Pure recognition; no network. */
  parse(url: string): RecognizedUrl | undefined {
    const trimmed = url.trim();
    for (const adapter of this.adapters) {
      const parsed = adapter.parse(trimmed);
      if (parsed !== null) {
        return { adapter, parsed };
      }
    }
    return undefined;
  }

  /**
   * Recognizes a URL, expanding a platform short link through the adapter that owns it
   * when plain recognition fails. Anything else is `source_unsupported_url` and never
   * reaches a Task.
   */
  async recognize(url: string, signal: AbortSignal): Promise<RecognizedUrl> {
    const direct = this.parse(url);
    if (direct !== undefined) {
      return direct;
    }
    for (const adapter of this.adapters) {
      const expanded = adapter.resolveUrl === undefined ? null : await adapter.resolveUrl(url.trim(), signal);
      if (expanded !== null) {
        const parsed = adapter.parse(expanded);
        if (parsed !== null) {
          return { adapter, parsed };
        }
      }
    }
    throw unsupported();
  }
}
