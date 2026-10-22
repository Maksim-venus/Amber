import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ElevenLabsAsrProviderFactory } from "../../src/server/adapters/asr/elevenlabs/index.ts";
import { DirectOutboundHttpClient } from "../../src/server/adapters/outbound-http/direct.ts";
import { truncateTerminologyForAsr } from "../../src/server/domain/asr.ts";
import type { AsrProviderProfile } from "../../src/server/domain/provider-profile.ts";
import { checkTranscriptInvariants } from "../../src/server/domain/transcript.ts";
import { AsrStageExecutor } from "../../src/server/pipeline/stages/asr.ts";
import type { OutboundHttpClient, OutboundRequest, OutboundResponse } from "../../src/server/ports/outbound-http.ts";
import { ASR_KEYTERMS_MAX } from "../../src/shared/defaults.ts";
import { KNOWN_MISHEARD_TERMS } from "../fixtures/asr/index.ts";
import { LOCAL, stageStatuses, waitFor } from "../fixtures/pipeline/harness.ts";
import { createMediaStack, type MediaStack } from "../fixtures/pipeline/media-stack.ts";
import { insertRow } from "../tools/sqlite.ts";

/**
 * Real ASR smoke test. Runs only with `AMBER_E2E_ASR=1` and a per-run approval
 * (no paid call without the env switch and per-run approval). Inputs come from the
 * environment and never enter git:
 *
 * - `AMBER_E2E_ELEVENLABS_API_KEY`: stored through the profile service into a throwaway
 *   database, never printed;
 * - `AMBER_E2E_ASR_SAMPLE_FILE`: a short audio clip outside the repo;
 * - `AMBER_E2E_ASR_MODEL` (optional): one of the preset's models, `scribe_v2` if unset;
 * - `AMBER_E2E_RECORD_DIR` (optional): where to write the redacted response and evidence.
 *
 * Three read-only account lookups bracket the one paid submission: two back to back show
 * that "test connection" itself is not billed, the third shows what the submission used.
 */

const enabled = process.env["AMBER_E2E_ASR"] === "1";
const MAX_WAIT_MS = 5 * 60_000;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

interface Captured {
  url: string;
  method: string;
  /** The multipart text fields of an upload, in order; the audio part is left out. */
  fields: Array<[string, string]>;
  status?: number;
  responseText?: string;
}

/** Records what crosses the wire, minus headers (the key) and the audio bytes. */
class CapturingHttp implements OutboundHttpClient {
  readonly exchanges: Captured[] = [];
  private readonly inner = new DirectOutboundHttpClient();

  async request(request: OutboundRequest): Promise<OutboundResponse> {
    const captured: Captured = { url: request.url.split("?")[0] as string, method: request.method, fields: [] };
    this.exchanges.push(captured);
    let forwarded = request;
    const body = request.body;
    if (body !== undefined && typeof body === "object" && "stream" in body) {
      const chunks: Uint8Array[] = [];
      const source = body.stream;
      const tee = (async function* () {
        for await (const chunk of source) {
          chunks.push(chunk);
          yield chunk;
        }
      })();
      forwarded = { ...request, body: { ...body, stream: tee } };
      const response = await this.inner.request(forwarded);
      captured.fields = multipartFields(Buffer.concat(chunks), body.contentType);
      return this.recordResponse(captured, response);
    }
    return this.recordResponse(captured, await this.inner.request(forwarded));
  }

  private async recordResponse(captured: Captured, response: OutboundResponse): Promise<OutboundResponse> {
    const text = await response.text();
    captured.status = response.status;
    captured.responseText = text;
    return {
      status: response.status,
      headers: response.headers,
      body: (async function* () {
        yield Buffer.from(text, "utf8");
      })(),
      text: async () => text,
    };
  }
}

/** Name / value pairs of the parts without a filename. */
function multipartFields(bytes: Buffer, contentType: string): Array<[string, string]> {
  const boundary = /boundary=("?)([^";]+)\1/u.exec(contentType)?.[2];
  if (boundary === undefined) {
    return [];
  }
  const fields: Array<[string, string]> = [];
  for (const part of bytes.toString("latin1").split(`--${boundary}`)) {
    const split = part.indexOf("\r\n\r\n");
    if (split === -1) {
      continue;
    }
    const head = part.slice(0, split);
    const name = /name="([^"]*)"/u.exec(head)?.[1];
    if (name === undefined || /filename=/u.test(head)) {
      continue;
    }
    const value = Buffer.from(part.slice(split + 4).replace(/\r\n$/u, ""), "latin1").toString("utf8");
    fields.push([name, value]);
  }
  return fields;
}

/** The recognition result with identifiers dropped; fit for a fixture. */
function redactedResponse(text: string): unknown {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const { transcription_id: _id, ...rest } = parsed;
  return rest;
}

const open: MediaStack[] = [];
afterEach(async () => {
  for (const stack of open.splice(0)) await stack.close();
});

describe.skipIf(!enabled)("real ASR (ElevenLabs)", () => {
  it(
    "transcribes a short sample with the effective terminology, records usage and a redacted fixture",
    async () => {
      const apiKey = required("AMBER_E2E_ELEVENLABS_API_KEY");
      const sample = required("AMBER_E2E_ASR_SAMPLE_FILE");
      expect(existsSync(sample)).toBe(true);

      const http = new CapturingHttp();
      const stack = createMediaStack();
      open.push(stack);
      const { h } = stack;
      const factory = new ElevenLabsAsrProviderFactory({ http, files: stack.files, secrets: h.secrets });
      h.executors.asr = new AsrStageExecutor({
        repository: h.repository,
        files: stack.files,
        ingest: stack.ingest,
        asr: (provider) => (provider === factory.descriptor.provider ? factory : undefined),
        newId: h.newId,
      });
      const modelId = process.env["AMBER_E2E_ASR_MODEL"] || factory.descriptor.defaultModel;
      expect(factory.descriptor.models).toContain(modelId);
      const profile: AsrProviderProfile = {
        id: h.newId(),
        userId: LOCAL.userId,
        name: "ElevenLabs",
        provider: "elevenlabs",
        models: [{ modelId }],
        credentialRef: h.secrets.store(LOCAL.userId, apiKey),
        createdAt: Date.now(),
      };
      h.repository.withTransaction((scope) => scope.asrProfiles.insert(profile));
      const probe = (signal: AbortSignal) => factory.probe(profile, signal);

      const setId = h.newId();
      insertRow(h.db, "terminology_set", { id: setId, user_id: LOCAL.userId, scope_kind: "global" });
      for (const entry of KNOWN_MISHEARD_TERMS) {
        insertRow(h.db, "terminology_entry", {
          id: h.newId(), set_id: setId, ordinal: entry.ordinal, term: entry.term, normalized_key: entry.normalizedKey,
        });
      }

      const signal = AbortSignal.timeout(60_000);
      const before = await probe(signal);
      const again = await probe(signal);
      expect(again.usedUnits).toBe(before.usedUnits);

      const created = await stack.localImport.importLocalFile(LOCAL, {
        path: sample,
        grant: stack.grant(sample),
        settings: { autoProofread: false, asrModelRef: { asrProfileId: profile.id, modelId } },
        allowDuplicate: true,
      });
      const taskId = created.body.taskIds[0] as string;
      const contentId = created.body.contentIds[0] as string;
      h.scheduler.start();
      await waitFor(() => ["succeeded", "failed"].includes(stageStatuses(h, taskId)["asr"] ?? "") || h.repository.withTransaction((scope) => scope.workUnits.listByTask(LOCAL.userId, taskId)).some((unit) => unit.status === "waiting_user_action"), MAX_WAIT_MS);
      const after = await probe(AbortSignal.timeout(60_000));

      const runs = h.repository.withTransaction((scope) => scope.stageRuns.listByTask(LOCAL.userId, taskId));
      const asrRun = runs.filter((run) => run.stage === "asr").at(-1);
      expect(asrRun?.status, JSON.stringify(asrRun?.error ?? null)).toBe("succeeded");

      const submissions = http.exchanges.filter((exchange) => exchange.url.endsWith("/v1/speech-to-text"));
      expect(submissions).toHaveLength(1);
      const submission = submissions[0] as Captured;
      const effective = h.repository.withTransaction((scope) => scope.terminology.effectiveFor(LOCAL.userId, contentId));
      const expectedTerms = truncateTerminologyForAsr(effective, factory.create(profile, modelId).capabilities, ASR_KEYTERMS_MAX).entries.map((entry) => entry.term);
      expect(submission.fields.filter(([name]) => name === "keyterms").map(([, value]) => value)).toEqual(expectedTerms);
      expect(submission.status).toBe(200);

      const [revision] = h.repository.withTransaction((scope) => scope.transcripts.listRevisions(LOCAL.userId, contentId));
      expect(revision).toMatchObject({ kind: "asr", timingFidelity: "exact_words" });
      const segments = h.repository.withTransaction((scope) => scope.transcripts.listSegments(LOCAL.userId, revision!.id));
      expect(segments.length).toBeGreaterThan(0);
      expect(checkTranscriptInvariants(revision!, segments)).toEqual([]);
      expect(segments.every((segment) => (segment.words?.length ?? 0) > 0)).toBe(true);

      const usage = h.repository.withTransaction((scope) => scope.asrUsage.list(LOCAL.userId, { taskId }));
      expect(usage).toHaveLength(1);
      expect(usage[0]?.outcome).toBe("succeeded");

      const transcript = segments.map((segment) => segment.text).join("\n");
      const evidence = {
        audioMs: usage[0]?.audioMs,
        segmentCount: segments.length,
        language: revision?.language,
        keytermsSent: expectedTerms,
        accountUnits: { before: before.usedUnits, again: again.usedUnits, after: after.usedUnits, limit: after.limitUnits },
        termSpelling: Object.fromEntries(KNOWN_MISHEARD_TERMS.map((entry) => [entry.term, transcript.includes(entry.term)])),
        requestFields: submission.fields.filter(([name]) => name !== "keyterms"),
      };
      console.info(`ASR evidence ${JSON.stringify(evidence)}`);

      const recordDir = process.env["AMBER_E2E_RECORD_DIR"];
      if (recordDir !== undefined && recordDir !== "") {
        mkdirSync(recordDir, { recursive: true });
        writeFileSync(join(recordDir, "elevenlabs-zh-recorded.json"), `${JSON.stringify(redactedResponse(submission.responseText ?? "{}"), null, 2)}\n`);
        writeFileSync(join(recordDir, "asr-evidence.json"), `${JSON.stringify({ ...evidence, transcript }, null, 2)}\n`);
      }
    },
    MAX_WAIT_MS + 60_000,
  );
});
