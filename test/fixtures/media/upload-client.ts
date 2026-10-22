import { readFileSync } from "node:fs";
import { request } from "node:http";
import { multipartBody, paddedMp4 } from "./multipart.ts";

/**
 * Uploads a padded MP4 of `AMBER_UPLOAD_SIZE` bytes to a running server from its own
 * process, so memory measured in the server process is the server's alone. Prints the
 * response status on stdout. Run with `node test/fixtures/media/upload-client.ts`.
 */
const [port, token, fixture, size] = ["AMBER_UPLOAD_PORT", "AMBER_UPLOAD_TOKEN", "AMBER_UPLOAD_FIXTURE", "AMBER_UPLOAD_SIZE"].map((name) => {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}) as [string, string, string, string];

const body = multipartBody([
  { name: "allowDuplicate", data: "true" },
  { name: "file", filename: `pad-${size}.mp4`, data: paddedMp4(readFileSync(fixture), Number(size)) },
]);
const outgoing = request(
  { host: "127.0.0.1", port: Number(port), method: "POST", path: "/api/contents/upload", headers: { authorization: `Bearer ${token}`, "content-type": body.contentType } },
  (response) => {
    response.resume();
    response.on("end", () => process.stdout.write(`${response.statusCode}\n`));
  },
);
outgoing.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
body.stream().pipe(outgoing);
