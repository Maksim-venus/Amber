// Starts the packed sidecar the way the Tauri shell does and waits for its READY line.
// Usage: node src/tooling/smoke-sidecar.mjs <node-binary> <server-dir> <bin-dir>
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [nodeBin, serverDir, binDir] = process.argv.slice(2);
const dataDir = mkdtempSync(join(tmpdir(), "amber-smoke-"));
const child = spawn(nodeBin, ["server.js"], {
  cwd: serverDir,
  env: {
    AMBER_MODE: "local",
    AMBER_SIDECAR_TOKEN: randomBytes(32).toString("hex"),
    AMBER_FILE_GRANT_KEY: randomBytes(32).toString("base64url"),
    AMBER_SECRET_KEY: randomBytes(32).toString("base64"),
    AMBER_DATA_DIR: dataDir,
    AMBER_BIN_DIR: binDir,
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let out = "";
const timer = setTimeout(() => {
  console.error("TIMEOUT waiting for READY\n" + out);
  child.kill("SIGKILL");
  process.exit(1);
}, 60000);
child.stderr.on("data", (d) => process.stderr.write(d));
child.stdout.on("data", (d) => {
  out += d;
  process.stdout.write(d);
  const line = out.split("\n").find((l) => l.startsWith("READY "));
  if (line) {
    clearTimeout(timer);
    const { port } = JSON.parse(line.slice(6));
    fetch(`http://127.0.0.1:${port}/`).then(
      (r) => console.log(`GET / -> ${r.status}`),
      (e) => console.log(`GET / failed: ${e}`),
    ).finally(() => {
      child.stdin.end();
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    });
  }
});
child.on("exit", (code, signal) => {
  console.log(`sidecar exited code=${code} signal=${signal}`);
  process.exit(out.includes("READY ") ? 0 : 1);
});
