import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALLER_COPY, INSTALLER_LOCALES, NSIS_LANGUAGES, type ReinstallCopy } from "../shared/i18n/installer.ts";
import { nsisEscape, nsisText } from "./export-installer-hooks.ts";

/**
 * Generates the NSIS installer template (`bundle.windows.nsis.template`) from a pinned,
 * byte-for-byte copy of the template Tauri's bundler ships.
 *
 * Why a custom template: when a different version is already installed, the upstream
 * `PageReinstall` overwrites the registry's `DisplayVersion` with the result of
 * `SemverCompare` and only says "older" / "unknown" (in Simplified Chinese "version 旧的"),
 * so the user never sees which version is installed. That page is neither reachable from
 * `customLanguageFiles` (the messages embed `$R4`, which holds no version) nor from
 * `installerHooks` (no hook runs inside `PageReinstall`). The patches keep the installed
 * version in `$R4` and replace the two messages with Amber's copy from
 * `src/shared/i18n/installer.ts`; everything else stays as upstream wrote it.
 *
 * The output keeps the copy's LF line ends and has no byte order mark: the bundler reads the
 * template into a string, renders it with handlebars and writes the result with a byte order
 * mark of its own, so one here would end up doubled. Handlebars also parses every `{{`, so
 * the generated parts must add none.
 *
 * When `@tauri-apps/cli` is upgraded, download the template of the new `tauri-cli-v<version>`
 * tag (`crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi`) into
 * `UPSTREAM_TEMPLATE_FILE` and update `UPSTREAM_TEMPLATE_TAG` and `UPSTREAM_TEMPLATE_SHA256`;
 * the anchors below fail loudly if upstream changed the patched lines.
 */

export const UPSTREAM_TEMPLATE_FILE = "src/desktop/nsis/installer.upstream.nsi";

/** The tauri tag the copy was taken from; matches the pinned `@tauri-apps/cli`. */
export const UPSTREAM_TEMPLATE_TAG = "tauri-cli-v2.12.0";

export const UPSTREAM_TEMPLATE_SHA256 = "dabed59013b1d78b879a1a85bc7f2eed2993b33a9a90cdabe5946de3d3950597";

export const INSTALLER_TEMPLATE_FILE = "src/desktop/gen/installer.nsi";

/** Copy keys of the reinstall page and the NSIS language strings they become. */
const LANG_STRINGS: readonly (readonly [string, keyof ReinstallCopy])[] = [
  ["amberOlderInstalled", "olderInstalled"],
  ["amberNewerInstalled", "newerInstalled"],
  ["amberVersionUnknown", "versionUnknown"],
];

/** The NSIS expressions of the reinstall copy's placeholders; `$R4` holds the installed version. */
const REINSTALL_PLACEHOLDERS = { product: "${PRODUCTNAME}", installed: "$R4", version: "${VERSION}" };

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Replaces the single occurrence of `anchor`; any other number of occurrences is an error. */
export function replaceOnce(text: string, anchor: string, replacement: string): string {
  const occurrences = count(text, anchor);
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly one occurrence of the anchor in the installer template, found ${occurrences}: ${JSON.stringify(anchor)}; ` +
        `the upstream template may have changed, sync ${UPSTREAM_TEMPLATE_FILE} with the pinned @tauri-apps/cli`,
    );
  }
  const at = text.indexOf(anchor);
  return text.slice(0, at) + replacement + text.slice(at + anchor.length);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Rejects anything but the pinned upstream copy. */
export function checkUpstream(upstream: string): void {
  const actual = sha256Hex(upstream);
  if (actual !== UPSTREAM_TEMPLATE_SHA256) {
    throw new Error(
      `${UPSTREAM_TEMPLATE_FILE} has SHA-256 ${actual}, expected ${UPSTREAM_TEMPLATE_SHA256}; ` +
        `download the template of ${UPSTREAM_TEMPLATE_TAG} again, or after upgrading @tauri-apps/cli update the tag and hash`,
    );
  }
}

/** The `LangString` lines of the reinstall copy, one block per installer locale. */
export function reinstallLangStrings(): string[] {
  const lines: string[] = [];
  for (const locale of INSTALLER_LOCALES) {
    const language = `\${LANG_${NSIS_LANGUAGES[locale].toUpperCase()}}`;
    for (const [name, key] of LANG_STRINGS) {
      const template = INSTALLER_COPY[locale].reinstall[key];
      if (/\{\{|\}\}|`/u.test(template)) {
        throw new Error(`reinstall copy must not contain "{{", "}}" or backticks: ${JSON.stringify(template)}`);
      }
      const text = key === "versionUnknown" ? nsisEscape(template) : nsisText(template, REINSTALL_PLACEHOLDERS);
      lines.push(`LangString ${name} ${language} "${text}"`);
    }
  }
  return lines;
}

/** The anchors, each a run of whole upstream lines, and what replaces them. */
export function templatePatches(): { anchor: string; replacement: string }[] {
  const languageFiles = '{{#each language_files}}\n  !include "{{this}}"\n{{/each}}\n';
  return [
    {
      anchor: '  ${IfThen} $R0 == "" ${|} StrCpy $R4 "$(unknown)" ${|}\n',
      replacement: [
        "  ; Amber: keep the installed version in $R4 for the messages below; upstream only says older or unknown.",
        '  ${If} $R0 == ""',
        '    StrCpy $R4 "$(amberVersionUnknown)"',
        "  ${Else}",
        "    StrCpy $R4 $R0",
        "  ${EndIf}",
        "",
      ].join("\n"),
    },
    {
      anchor: '    StrCpy $R1 "$(olderOrUnknownVersionInstalled)"\n',
      replacement: '    StrCpy $R1 "$(amberOlderInstalled)"\n',
    },
    {
      anchor: '    StrCpy $R1 "$(newerVersionInstalled)"\n',
      replacement: '    StrCpy $R1 "$(amberNewerInstalled)"\n',
    },
    {
      anchor: languageFiles,
      replacement: [
        languageFiles +
          "; Amber: generated by src/tooling/export-installer-template.ts from src/desktop/nsis/installer.upstream.nsi. Do not edit.",
        "; Amber's copy for the reinstall page, generated from src/shared/i18n/installer.ts.",
        ...reinstallLangStrings(),
        "",
      ].join("\n"),
    },
  ];
}

/** Applies the patches without checking the input's hash. */
export function patchInstallerTemplate(upstream: string): string {
  let text = upstream;
  for (const { anchor, replacement } of templatePatches()) {
    text = replaceOnce(text, anchor, replacement);
  }
  for (const braces of ["{{", "}}"]) {
    if (count(text, braces) !== count(upstream, braces)) {
      throw new Error(`the patches must not add "${braces}", which handlebars would parse`);
    }
  }
  return text;
}

/** The installer template Tauri builds with, from the pinned upstream copy. */
export function renderInstallerTemplate(upstream: string): string {
  checkUpstream(upstream);
  return patchInstallerTemplate(upstream);
}

function main(): void {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const upstream = readFileSync(join(root, UPSTREAM_TEMPLATE_FILE), "utf8");
  const target = join(root, INSTALLER_TEMPLATE_FILE);
  mkdirSync(dirname(target), { recursive: true });
  // Written as UTF-8 without a byte order mark; the bundler adds its own.
  writeFileSync(target, renderInstallerTemplate(upstream), "utf8");
  console.log(`wrote ${INSTALLER_TEMPLATE_FILE}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
