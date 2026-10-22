import { randomBytes } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { signFileGrant } from "../../../src/server/adapters/file-grant/hmac-file-grant.ts";
import { compose, type Composition } from "../../../src/server/compose.ts";
import { FILE_GRANT_TTL_MS } from "../../../src/shared/defaults.ts";
import type { FileGrant } from "../../../src/shared/dto/local-media.ts";
import { tempDataDir } from "../../tools/sqlite.ts";

/**
 * The real local-mode composition (`compose()`) on a temporary data directory, driven through
 * `app.inject` with the sidecar token the shell would send. Nothing listens; background work
 * starts only with `startBackground()`.
 */

const TOKEN = "local-stack-token-".padEnd(64, "0");

export interface LocalStackRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  payload?: unknown;
}

export interface ComposedLocalStack {
  composition: Composition;
  dataDir: string;
  send(request: LocalStackRequest): Promise<LightMyRequestResponse>;
  /** A grant as the shell signs it for `path`. */
  grant(path: string, purpose: FileGrant["purpose"]): FileGrant;
  close(): Promise<void>;
}

/** On a new temporary data directory, or on `options.dataDir` to start again on an existing one. */
export async function composeLocalStack(options: { dataDir?: string } = {}): Promise<ComposedLocalStack> {
  const dataDir = options.dataDir ?? tempDataDir("amber-local-stack-");
  const fileGrantKey = randomBytes(32);
  const composition = await compose({
    mode: "local",
    dataDir,
    binDir: dataDir,
    logLevel: "error",
    logDestination: { write: () => undefined },
    env: { AMBER_LOW_WATER_FREE_GB: "0.001", AMBER_LOW_WATER_FREE_RATIO: "0" },
    token: TOKEN,
    fileGrantKey,
  });
  return {
    composition,
    dataDir,
    send: (request) =>
      composition.app.inject({
        method: request.method,
        url: request.url,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(request.payload === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(request.payload === undefined ? {} : { payload: JSON.stringify(request.payload) }),
      }),
    grant: (path, purpose) => signFileGrant(fileGrantKey, { path, purpose, expiresAt: Date.now() + FILE_GRANT_TTL_MS - 1000 }),
    close: () => composition.shutdown(),
  };
}
