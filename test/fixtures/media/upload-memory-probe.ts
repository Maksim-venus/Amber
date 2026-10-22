import { spawn } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { LOCAL_TOKEN } from "../pipeline/harness.ts";
import { createMediaStack } from "../pipeline/media-stack.ts";
import { mediaFixtures } from "./index.ts";

/**
 * Upload memory probe, one process per measured size: runs the server-mode upload route
 * on a real socket, uploads a small warm-up file, then samples this process's memory every
 * 10 ms while one upload of `AMBER_PROBE_SIZE` bytes streams in from a separate client
 * process. Writes every raw sample to `AMBER_PROBE_OUTPUT` as JSON.
 *
 *   AMBER_PROBE_SIZE=<bytes> AMBER_PROBE_OUTPUT=<file> node test/fixtures/media/upload-memory-probe.ts
 */

const SAMPLE_INTERVAL_MS = 10;
const CLIENT = join(import.meta.dirname, "upload-client.ts");

interface Sample {
  t: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  rss: number;
}

function sample(start: number): Sample {
  const usage = process.memoryUsage();
  return { t: Date.now() - start, heapUsed: usage.heapUsed, external: usage.external, arrayBuffers: usage.arrayBuffers, rss: usage.rss };
}

function upload(port: number, size: number): Promise<string> {
  const client = spawn(process.execPath, [CLIENT], {
    env: {
      AMBER_UPLOAD_PORT: String(port),
      AMBER_UPLOAD_TOKEN: LOCAL_TOKEN,
      AMBER_UPLOAD_FIXTURE: mediaFixtures().withAudio.path,
      AMBER_UPLOAD_SIZE: String(size),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  client.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  return new Promise((resolve, reject) => {
    client.once("exit", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(`upload client exited with ${code}`))));
  });
}

const size = Number(process.env["AMBER_PROBE_SIZE"]);
const output = process.env["AMBER_PROBE_OUTPUT"];
if (!Number.isSafeInteger(size) || size <= 0 || output === undefined) {
  throw new Error("AMBER_PROBE_SIZE and AMBER_PROBE_OUTPUT are required");
}

const stack = createMediaStack();
const { app } = await stack.app("server");
await app.listen({ host: "127.0.0.1", port: 0 });
const port = (app.server.address() as AddressInfo).port;
const fixtureBytes = statSync(mediaFixtures().withAudio.path).size;

// Warm-up: one-time initialization (multipart parser, first ffprobe start, compiled code
// paths) happens here, outside the measured window.
const warmupStatus = await upload(port, fixtureBytes + 1024);

const start = Date.now();
const baseline = sample(start);
const samples: Sample[] = [baseline];
const timer = setInterval(() => samples.push(sample(start)), SAMPLE_INTERVAL_MS);
let status: string;
try {
  status = await upload(port, size);
} finally {
  clearInterval(timer);
}
samples.push(sample(start));
writeFileSync(output, `${JSON.stringify({ size, warmupStatus, status, intervalMs: SAMPLE_INTERVAL_MS, baseline, samples })}\n`);
await stack.close();
