import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupHeaderSchema } from "../../../../src/shared/backup.ts";
import {
  backupEstimateDtoSchema,
  backupExportAcceptedDtoSchema,
  backupExportJobDtoSchema,
  restoreReadinessDtoSchema,
} from "../../../../src/shared/dto/backup.ts";
import { readArchive } from "../../../fixtures/backup/library.ts";
import { composeLocalStack, type ComposedLocalStack } from "../../../fixtures/server/composed-local-stack.ts";
import { composeServerStack } from "../../../fixtures/server/composed-stack.ts";
import { tempDataDir } from "../../../tools/sqlite.ts";

const stacks: ComposedLocalStack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.close();
});

async function stack(options: { background?: boolean } = {}): Promise<ComposedLocalStack> {
  const created = await composeLocalStack();
  stacks.push(created);
  if (options.background !== false) await created.composition.startBackground();
  return created;
}

async function settledJob(s: ComposedLocalStack, jobId: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const job = backupExportJobDtoSchema.parse((await s.send({ method: "GET", url: `/api/backup/exports/${jobId}` })).json());
    if (job.status !== "running") return job;
    if (Date.now() > deadline) throw new Error("export did not finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("backup routes", () => {
  it("export a fresh library end to end through the shell's grant", async () => {
    const s = await stack();
    const estimate = backupEstimateDtoSchema.parse(
      (await s.send({ method: "POST", url: "/api/backup/estimate", payload: { includeOriginals: true, includeCache: false } })).json(),
    );
    expect(estimate.originals).toEqual({ count: 0, bytes: 0, unreadable: [] });
    expect(estimate.database.bytes).toBeGreaterThan(0);

    const target = join(tempDataDir("amber-route-backup-"), "备份.amberbackup");
    const started = await s.send({
      method: "POST",
      url: "/api/backup/exports",
      payload: { grant: s.grant(target, "backup_output"), includeOriginals: true, includeCache: false, uiPreferences: { "amber.notes.color.underline": "blue", other: "x" } },
    });
    expect(started.statusCode).toBe(202);
    const accepted = backupExportAcceptedDtoSchema.parse(started.json());
    expect(accepted.preferencesDropped).toEqual([{ key: "other", reason: "not_allowed" }]);
    const job = await settledJob(s, accepted.jobId);
    expect(job.status).toBe("succeeded");
    expect(job.result?.sizeBytes).toBe(readFileSync(target).length);
    const entries = await readArchive(target);
    const header = backupHeaderSchema.parse(JSON.parse(entries[0]?.bytes.toString("utf8") ?? ""));
    expect(header.uiPreferences).toEqual({ "amber.notes.color.underline": "blue" });
    expect(entries.map((entry) => entry.path)).toEqual(["header.json", "database.sqlite", "manifest.json"]);

    const cancelled = await s.send({ method: "POST", url: `/api/backup/exports/${accepted.jobId}/cancel` });
    expect(backupExportJobDtoSchema.parse(cancelled.json()).status).toBe("succeeded");
    expect((await s.send({ method: "GET", url: "/api/backup/exports/01UNKNOWN" })).statusCode).toBe(404);
  });

  it("refuse an export before the start-up sweep finished, and a missing or stale grant", async () => {
    const s = await stack({ background: false });
    const target = join(tempDataDir("amber-route-backup-"), "a.amberbackup");
    const early = await s.send({ method: "POST", url: "/api/backup/exports", payload: { grant: s.grant(target, "backup_output"), includeOriginals: true, includeCache: false } });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("conflict.starting_up");
    await s.composition.startBackground();

    const missing = await s.send({ method: "POST", url: "/api/backup/exports", payload: { includeOriginals: true, includeCache: false } });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe("unauthenticated.file_grant");
    const forged = await s.send({
      method: "POST",
      url: "/api/backup/exports",
      payload: { grant: { ...s.grant(target, "backup_output"), expiresAt: Date.now() - 1 }, includeOriginals: true, includeCache: false },
    });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error.code).toBe("unauthenticated.file_grant");
    expect(existsSync(target)).toBe(false);
  });

  it("report restore readiness: fresh, then the settings a restore would replace", async () => {
    const s = await stack();
    expect(restoreReadinessDtoSchema.parse((await s.send({ method: "GET", url: "/api/backup/restore-readiness" })).json())).toEqual({
      fresh: true,
      nonEmpty: [],
      willReplace: [],
    });
    await s.send({ method: "PATCH", url: "/api/settings", payload: { theme: "dark" } });
    expect(restoreReadinessDtoSchema.parse((await s.send({ method: "GET", url: "/api/backup/restore-readiness" })).json())).toEqual({
      fresh: true,
      nonEmpty: [],
      willReplace: ["appearance"],
    });
  });

  it("do not exist in server mode", async () => {
    const created = await composeServerStack();
    try {
      for (const request of [
        { method: "POST", url: "/api/backup/estimate", payload: { includeOriginals: true, includeCache: false } },
        { method: "POST", url: "/api/backup/exports", payload: {} },
        { method: "GET", url: "/api/backup/exports/01X" },
        { method: "POST", url: "/api/backup/exports/01X/cancel" },
        { method: "GET", url: "/api/backup/restore-readiness" },
      ] as const) {
        expect((await created.send(request, created.adminCookie)).statusCode, request.url).toBe(404);
      }
    } finally {
      await created.close();
    }
  });
});
