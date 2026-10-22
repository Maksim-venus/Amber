import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolPath } from "../tools.ts";

/**
 * Media fixtures generated at test time with ffmpeg's lavfi sources, so no binary media
 * enters git. Each is 3 s long; `meta` is what probing must report.
 */
export interface MediaFixture {
  path: string;
  meta: { durationMs: number; hasAudio: boolean; mimeType: string };
}

const VIDEO = ["-f", "lavfi", "-i", "testsrc=size=160x120:rate=25:duration=3"];
const TONE = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=3"];
const H264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p"];

const RECIPES = {
  withAudio: { file: "with-audio.mp4", args: [...VIDEO, ...TONE, ...H264, "-c:a", "aac", "-shortest"], meta: { durationMs: 3000, hasAudio: true, mimeType: "video/mp4" } },
  noAudio: { file: "no-audio.mp4", args: [...VIDEO, ...H264], meta: { durationMs: 3000, hasAudio: false, mimeType: "video/mp4" } },
  audioOnly: { file: "audio-only.mp3", args: [...TONE, "-c:a", "libmp3lame", "-b:a", "64k"], meta: { durationMs: 3000, hasAudio: true, mimeType: "audio/mpeg" } },
} as const;

export type MediaFixtureName = keyof typeof RECIPES;

let generated: Record<MediaFixtureName, MediaFixture> | undefined;

/** Generates the fixtures once per test process into a fresh temp directory. */
export function mediaFixtures(): Record<MediaFixtureName, MediaFixture> {
  if (generated !== undefined) {
    return generated;
  }
  const dir = mkdtempSync(join(tmpdir(), "amber-media-"));
  const ffmpeg = toolPath("ffmpeg");
  const result = {} as Record<MediaFixtureName, MediaFixture>;
  for (const [name, recipe] of Object.entries(RECIPES) as Array<[MediaFixtureName, (typeof RECIPES)[MediaFixtureName]]>) {
    const path = join(dir, recipe.file);
    const run = spawnSync(ffmpeg, ["-nostdin", "-v", "error", "-y", ...recipe.args, path], { encoding: "utf8" });
    if (run.status !== 0) {
      throw new Error(`ffmpeg could not generate ${recipe.file}: ${run.stderr}`);
    }
    result[name] = { path, meta: { ...recipe.meta } };
  }
  generated = result;
  return result;
}
