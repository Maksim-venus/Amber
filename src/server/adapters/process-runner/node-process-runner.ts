import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  assertChildEnvSafe,
  type ProcessResult,
  type ProcessRunOptions,
  type ProcessRunner,
  type ProcessSpec,
} from "../../ports/process-runner.ts";

/** Per-stream cap on retained output; the tail is kept because tools report failures last. */
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export type ProcessFailureReason = "spawn_failed" | "timeout" | "aborted";

export class ProcessRunError extends Error {
  readonly reason: ProcessFailureReason;

  constructor(reason: ProcessFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProcessRunError";
    this.reason = reason;
  }
}

/**
 * Keeps the last `limit` bytes of a stream. Bytes, not characters, bound memory; a
 * multi-byte character cut at the boundary decodes as a replacement character.
 */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 0) {
      const head = this.chunks[0] as Buffer;
      const excess = this.size - this.limit;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/** Splits a byte stream into lines for progress callbacks; a trailing partial line is flushed on end. */
class LineSplitter {
  private pending = "";
  private readonly onLine: (line: string) => void;
  // A multi-byte character may straddle two chunks; the decoder holds its first bytes back.
  private readonly decoder = new StringDecoder("utf8");

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine;
  }

  push(chunk: Buffer): void {
    const parts = (this.pending + this.decoder.write(chunk)).split(/\r?\n/);
    this.pending = parts.pop() ?? "";
    for (const line of parts) {
      this.onLine(line);
    }
  }

  end(): void {
    this.pending += this.decoder.end();
    if (this.pending !== "") {
      this.onLine(this.pending);
      this.pending = "";
    }
  }
}

/**
 * Kills the child and everything it started. Windows has no process groups for this, so
 * `taskkill /T` walks the tree; it is addressed by absolute path because the sidecar runs
 * without PATH. On POSIX the child leads its own process group (see `detached` below).
 */
function killTree(child: ChildProcess, systemRoot: string | undefined): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    const taskkill = join(systemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export interface NodeProcessRunnerOptions {
  outputLimitBytes?: number;
  /** Source of `SystemRoot` for locating taskkill; defaults to this process's environment. */
  systemRoot?: string;
}

export class NodeProcessRunner implements ProcessRunner {
  private readonly outputLimitBytes: number;
  private readonly systemRoot: string | undefined;

  constructor(options: NodeProcessRunnerOptions = {}) {
    this.outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
    this.systemRoot = options.systemRoot ?? process.env["SystemRoot"];
  }

  run(spec: ProcessSpec, opts: ProcessRunOptions): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      assertChildEnvSafe(spec.env);
      if (opts.signal.aborted) {
        reject(new ProcessRunError("aborted", "aborted before start"));
        return;
      }
      const child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: { ...spec.env },
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdout = new TailBuffer(this.outputLimitBytes);
      const stderr = new TailBuffer(this.outputLimitBytes);
      const stdoutLines = opts.onStdoutLine ? new LineSplitter(opts.onStdoutLine) : undefined;
      const stderrLines = opts.onStderrLine ? new LineSplitter(opts.onStderrLine) : undefined;
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        stdoutLines?.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        stderrLines?.push(chunk);
      });

      let failure: ProcessRunError | undefined;
      const stop = (reason: ProcessFailureReason, message: string): void => {
        failure ??= new ProcessRunError(reason, message);
        killTree(child, this.systemRoot);
      };
      const onAbort = (): void => stop("aborted", "aborted");
      opts.signal.addEventListener("abort", onAbort, { once: true });
      const timer =
        spec.timeoutMs === undefined
          ? undefined
          : setTimeout(() => stop("timeout", `timed out after ${spec.timeoutMs} ms`), spec.timeoutMs);

      const cleanup = (): void => {
        opts.signal.removeEventListener("abort", onAbort);
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      };

      child.once("error", (error) => {
        cleanup();
        reject(new ProcessRunError("spawn_failed", error.message, { cause: error }));
      });
      child.once("close", (exitCode, signal) => {
        cleanup();
        stdoutLines?.end();
        stderrLines?.end();
        if (failure !== undefined) {
          reject(failure);
          return;
        }
        resolve({ exitCode, signal, stdout: stdout.text(), stderr: stderr.text() });
      });
    });
  }
}
