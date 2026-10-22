import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./lib/files.ts";
import { materializeTemplates } from "./lib/fixture.ts";
import { committableFiles, secretScan } from "./lib/secret-scan.ts";

describe("working-tree credential scan", () => {
  it("finds no credential pattern in committable files", () => {
    expect(secretScan(REPO_ROOT, committableFiles(REPO_ROOT))).toEqual([]);
  });

  it("rejects every counter-example and accepts placeholders", () => {
    const { root, files } = materializeTemplates("secret-scan");
    expect(files).toEqual(["leaks.txt", "placeholders.txt"]);
    expect(secretScan(root, files)).toEqual(
      [
        "openai-style-key",
        "underscore-sk-key",
        "aws-access-key-id",
        "github-token",
        "bilibili-sessdata",
        "cookie-header",
        "pem-private-key",
        "env-secret-assignment",
        "high-entropy-assignment",
      ].map((rule) => ({ file: "leaks.txt", rule })),
    );
  });
});
