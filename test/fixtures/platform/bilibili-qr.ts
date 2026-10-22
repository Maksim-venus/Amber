import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScriptedResponse } from "./scripted-io.ts";

/**
 * bilibili web QR login answers as recorded from a real scan (`recorded/bilibili-qr-*.json`,
 * written by `test/e2e-real/platform-login.test.ts`): generate → `data.url` +
 * `data.qrcode_key`; poll → outer `code` 0, progress in `data.code` (86101 not scanned,
 * 86090 scanned, 0 confirmed with the login in `Set-Cookie`, 86038 expired). The recording
 * replaced every token, URL and cookie value; the code's URL and key get distinct
 * placeholders here so tests can tell whether they leak.
 */

export const QR_KEY = "<qrcode-key-placeholder>";
export const QR_URL = "https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&qrcode_key=placeholder";

interface RecordedAnswer {
  status: number;
  body: { code: number; data: Record<string, unknown> };
  setCookies?: string[];
}

function recorded(state: string): RecordedAnswer {
  const file = join(import.meta.dirname, "recorded", `bilibili-qr-${state}.json`);
  return (JSON.parse(readFileSync(file, "utf8")) as { answer: RecordedAnswer }).answer;
}

function scripted(answer: RecordedAnswer): ScriptedResponse {
  return { status: answer.status, body: answer.body, ...(answer.setCookies === undefined ? {} : { setCookies: answer.setCookies }) };
}

const generate = recorded("generate");
export const GENERATE = scripted({
  ...generate,
  body: { ...generate.body, data: { ...generate.body.data, url: QR_URL, qrcode_key: QR_KEY } },
});

export const POLL_PENDING = scripted(recorded("pending"));
export const POLL_SCANNED = scripted(recorded("scanned"));
export const POLL_EXPIRED = scripted(recorded("expired"));
/** Cookie values are the recording's placeholder; the attributes are the platform's own. */
export const POLL_CONFIRMED = scripted(recorded("confirmed"));
