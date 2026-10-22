import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface CurlResponse {
  status: number;
  json: unknown;
}

/**
 * Drives a running server through the real `curl` binary in a child process, as a user
 * would from a shell, and keeps the command line of every request with the token and the
 * address replaced by `$TOKEN` and `$BASE`, so the sequence can be pasted elsewhere.
 */
export class CurlClient {
  readonly transcript: string[] = [];
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async request(method: string, path: string, body?: unknown, options: { record?: boolean } = {}): Promise<CurlResponse> {
    const args = ["-s", "-X", method, "-H", `Authorization: Bearer ${this.token}`];
    const shown = ["curl", "-s", "-X", method, "-H", '"Authorization: Bearer $TOKEN"'];
    if (body !== undefined) {
      const json = JSON.stringify(body);
      args.push("-H", "content-type: application/json", "--data-binary", json);
      shown.push("-H", '"content-type: application/json"', "--data-binary", `'${json}'`);
    }
    args.push("-w", "\n%{http_code}", `${this.baseUrl}${path}`);
    shown.push(`"$BASE${path}"`);
    if (options.record !== false) {
      this.transcript.push(shown.join(" "));
    }
    const { stdout } = await run("curl", args, { maxBuffer: 16 * 1024 * 1024 });
    const split = stdout.lastIndexOf("\n");
    const text = stdout.slice(0, split);
    return { status: Number(stdout.slice(split + 1)), json: text === "" ? undefined : (JSON.parse(text) as unknown) };
  }
}
