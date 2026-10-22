import { describe, expect, it } from "vitest";
import { NodeProcessRunner, ProcessRunError } from "../../../../src/server/adapters/process-runner/node-process-runner.ts";

const node = process.execPath;
const run = (args: string[], extra: { timeoutMs?: number; env?: Record<string, string> } = {}, signal = new AbortController().signal) =>
  new NodeProcessRunner().run(
    { command: node, args, env: extra.env ?? {}, ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }) },
    { signal },
  );

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("NodeProcessRunner", () => {
  it("runs by argument array without a shell and captures output", async () => {
    const result = await run(["-e", "console.log(process.argv[1]); console.error('warn')", "a b; echo injected"]);
    expect(result).toEqual({ exitCode: 0, signal: null, stdout: "a b; echo injected\n", stderr: "warn\n" });
  });

  it("gives the child only the environment in the spec", async () => {
    process.env["AMBER_PROBE_SECRET"] = "must-not-leak";
    try {
      const result = await run(["-e", "console.log(JSON.stringify(Object.keys(process.env).filter(k => k !== 'PWD')))"], {
        env: { ONLY: "1" },
      });
      expect(JSON.parse(result.stdout)).toEqual(["ONLY"]);
    } finally {
      delete process.env["AMBER_PROBE_SECRET"];
    }
  });

  it("keeps only the tail of oversized output", async () => {
    const runner = new NodeProcessRunner({ outputLimitBytes: 10 });
    const result = await runner.run(
      { command: node, args: ["-e", "process.stdout.write('0123456789abcdefghij')"], env: {} },
      { signal: new AbortController().signal },
    );
    expect(result.stdout).toBe("abcdefghij");
  });

  it("reports stdout lines as they arrive", async () => {
    const lines: string[] = [];
    await new NodeProcessRunner().run(
      { command: node, args: ["-e", "process.stdout.write('one\\ntwo\\r\\nthree')"], env: {} },
      { signal: new AbortController().signal, onStdoutLine: (line) => lines.push(line) },
    );
    expect(lines).toEqual(["one", "two", "three"]);
  });

  it("decodes a character whose bytes arrive in different chunks", async () => {
    const lines: string[] = [];
    // "中" is e4 b8 ad; the pause makes the first byte arrive alone.
    const script = "process.stdout.write(Buffer.from([0xe4])); setTimeout(() => process.stdout.write(Buffer.from([0xb8, 0xad, 0x0a])), 50)";
    await new NodeProcessRunner().run({ command: node, args: ["-e", script], env: {} }, { signal: new AbortController().signal, onStdoutLine: (line) => lines.push(line) });
    expect(lines).toEqual(["中"]);
  });

  it("rejects with spawn_failed for a missing executable", async () => {
    const failure = new NodeProcessRunner().run(
      { command: "/nonexistent/amber-tool", args: [], env: {} },
      { signal: new AbortController().signal },
    );
    await expect(failure).rejects.toMatchObject({ name: "ProcessRunError", reason: "spawn_failed" });
  });

  it("kills the whole process tree on timeout", async () => {
    const script =
      "const { spawn } = require('node:child_process');" +
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });" +
      "console.log(grandchild.pid); setInterval(() => {}, 1000);";
    const lines: string[] = [];
    const failure = new NodeProcessRunner().run(
      { command: node, args: ["-e", script], env: {}, timeoutMs: 1500 },
      { signal: new AbortController().signal, onStdoutLine: (line) => lines.push(line) },
    );
    await expect(failure).rejects.toBeInstanceOf(ProcessRunError);
    await expect(failure).rejects.toMatchObject({ reason: "timeout" });
    const grandchildPid = Number(lines[0]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(isAlive(grandchildPid)).toBe(false);
  });

  it("rejects with aborted when the signal fires", async () => {
    const controller = new AbortController();
    const failure = run(["-e", "setInterval(() => {}, 1000)"], {}, controller.signal);
    setTimeout(() => controller.abort(), 200);
    await expect(failure).rejects.toMatchObject({ reason: "aborted" });
  });
});

describe("forbidden variables", () => {
  it("refuses to start a child whose environment carries the master key or the sidecar token", async () => {
    await expect(run(["-e", "0"], { env: { AMBER_SECRET_KEY: "<placeholder>" } })).rejects.toThrow(/AMBER_SECRET_KEY/);
    await expect(run(["-e", "0"], { env: { AMBER_SIDECAR_TOKEN: "<placeholder>" } })).rejects.toThrow(/AMBER_SIDECAR_TOKEN/);
  });
});
