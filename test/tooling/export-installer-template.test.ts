import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALLER_COPY, INSTALLER_LOCALES, NSIS_LANGUAGES } from "../../src/shared/i18n/installer.ts";
import { nsisEscape, nsisText } from "../../src/tooling/export-installer-hooks.ts";
import {
  INSTALLER_TEMPLATE_FILE,
  patchInstallerTemplate,
  renderInstallerTemplate,
  replaceOnce,
  UPSTREAM_TEMPLATE_FILE,
  UPSTREAM_TEMPLATE_SHA256,
  UPSTREAM_TEMPLATE_TAG,
} from "../../src/tooling/export-installer-template.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

const upstream = readFileSync(join(REPO_ROOT, UPSTREAM_TEMPLATE_FILE), "utf8");

const PLACEHOLDERS = { product: "${PRODUCTNAME}", installed: "$R4", version: "${VERSION}" };

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Lines only in `before` and lines only in `after`, by a longest common subsequence of lines. */
function lineDiff(before: string[], after: string[]): { removed: string[]; added: string[] } {
  const rows = before.length + 1;
  const cols = after.length + 1;
  const lcs = new Uint16Array(rows * cols);
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lcs[i * cols + j] = before[i] === after[j] ? (lcs[(i + 1) * cols + j + 1] as number) + 1 : Math.max(lcs[(i + 1) * cols + j] as number, lcs[i * cols + j + 1] as number);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      i++;
      j++;
    } else if ((lcs[(i + 1) * cols + j] as number) >= (lcs[i * cols + j + 1] as number)) {
      removed.push(before[i++] as string);
    } else {
      added.push(after[j++] as string);
    }
  }
  removed.push(...before.slice(i));
  added.push(...after.slice(j));
  return { removed, added };
}

function expectedLangStrings(): string[] {
  return INSTALLER_LOCALES.flatMap((locale) => {
    const language = `\${LANG_${NSIS_LANGUAGES[locale].toUpperCase()}}`;
    const copy = INSTALLER_COPY[locale].reinstall;
    return [
      `LangString amberOlderInstalled ${language} "${nsisText(copy.olderInstalled, PLACEHOLDERS)}"`,
      `LangString amberNewerInstalled ${language} "${nsisText(copy.newerInstalled, PLACEHOLDERS)}"`,
      `LangString amberVersionUnknown ${language} "${nsisEscape(copy.versionUnknown)}"`,
    ];
  });
}

describe("upstream template copy", () => {
  it("is the pinned file of the tag matching the pinned @tauri-apps/cli", () => {
    expect(createHash("sha256").update(readFileSync(join(REPO_ROOT, UPSTREAM_TEMPLATE_FILE))).digest("hex")).toBe(UPSTREAM_TEMPLATE_SHA256);
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const cli = pkg.devDependencies?.["@tauri-apps/cli"] ?? pkg.dependencies?.["@tauri-apps/cli"];
    expect(cli).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(UPSTREAM_TEMPLATE_TAG).toBe(`tauri-cli-v${cli}`);
  });

  it("has the patched lines once each, as the patches expect", () => {
    expect(count(upstream, '  ${IfThen} $R0 == "" ${|} StrCpy $R4 "$(unknown)" ${|}\n')).toBe(1);
    expect(count(upstream, "$(unknown)")).toBe(1);
    expect(count(upstream, "$(olderOrUnknownVersionInstalled)")).toBe(1);
    expect(count(upstream, "$(newerVersionInstalled)")).toBe(1);
  });
});

describe("renderInstallerTemplate", () => {
  const rendered = renderInstallerTemplate(upstream);
  const lines = rendered.split("\n");

  it("keeps the template's form: first directive, LF line ends, no byte order mark, no new handlebars", () => {
    expect(lines[0]).toBe("Unicode true");
    expect(rendered).not.toContain("\r");
    expect(rendered.charCodeAt(0)).not.toBe(0xfeff);
    expect(count(rendered, "{{")).toBe(count(upstream, "{{"));
    expect(count(rendered, "}}")).toBe(count(upstream, "}}"));
  });

  it("keeps the installed version in $R4 before SemverCompare overwrites $R0", () => {
    expect(rendered).not.toContain("$(unknown)");
    expect(count(rendered, "$(amberVersionUnknown)")).toBe(1);
    expect(count(rendered, "StrCpy $R4 $R0")).toBe(1);
    const keep = rendered.indexOf("StrCpy $R4 $R0");
    const compare = rendered.indexOf("nsis_tauri_utils::SemverCompare");
    expect(keep).toBeGreaterThan(rendered.indexOf('StrCpy $R4 "$(older)"'));
    expect(compare).toBeGreaterThan(keep);
    expect(count(rendered, "nsis_tauri_utils::SemverCompare")).toBe(1);
  });

  it("shows Amber's messages instead of Tauri's on upgrade and downgrade", () => {
    expect(rendered).not.toContain("$(olderOrUnknownVersionInstalled)");
    expect(rendered).not.toContain("$(newerVersionInstalled)");
    expect(count(rendered, "$(amberOlderInstalled)")).toBe(1);
    expect(count(rendered, "$(amberNewerInstalled)")).toBe(1);
    expect(rendered).toContain('${ElseIf} $R0 = 1\n    StrCpy $R1 "$(amberOlderInstalled)"\n');
    expect(rendered).toContain('${ElseIf} $R0 = -1\n    StrCpy $R1 "$(amberNewerInstalled)"\n');
  });

  it("defines the copy for every installer language after the language files", () => {
    const languageFiles = rendered.indexOf('{{#each language_files}}\n  !include "{{this}}"\n{{/each}}\n');
    expect(languageFiles).toBeGreaterThan(0);
    const end = languageFiles + '{{#each language_files}}\n  !include "{{this}}"\n{{/each}}\n'.length;
    const expected = expectedLangStrings();
    expect(expected).toHaveLength(6);
    for (const line of expected) {
      expect(count(rendered, `${line}\n`)).toBe(1);
      expect(rendered.indexOf(`${line}\n`)).toBeGreaterThan(end);
    }
    expect(rendered).toContain(
      'LangString amberOlderInstalled ${LANG_SIMPCHINESE} "系统中已安装 ${PRODUCTNAME} $R4，本安装包为 ${VERSION}。',
    );
    expect(rendered).toContain('LangString amberOlderInstalled ${LANG_ENGLISH} "${PRODUCTNAME} $R4 is installed; this installer is ${VERSION}.');
  });

  it("changes nothing but the patched lines", () => {
    const { removed, added } = lineDiff(upstream.split("\n"), lines);
    expect(removed).toEqual([
      '  ${IfThen} $R0 == "" ${|} StrCpy $R4 "$(unknown)" ${|}',
      '    StrCpy $R1 "$(olderOrUnknownVersionInstalled)"',
      '    StrCpy $R1 "$(newerVersionInstalled)"',
    ]);
    const comments = added.filter((line) => line.trimStart().startsWith(";"));
    expect(comments.map((line) => line.trimStart().slice(0, 7))).toEqual(["; Amber", "; Amber", "; Amber"]);
    expect(added.filter((line) => !line.trimStart().startsWith(";"))).toEqual([
      '  ${If} $R0 == ""',
      '    StrCpy $R4 "$(amberVersionUnknown)"',
      "  ${Else}",
      "    StrCpy $R4 $R0",
      "  ${EndIf}",
      '    StrCpy $R1 "$(amberOlderInstalled)"',
      '    StrCpy $R1 "$(amberNewerInstalled)"',
      ...expectedLangStrings(),
    ]);
  });

  it("rejects input other than the pinned copy", () => {
    expect(() => renderInstallerTemplate(`${upstream}\n`)).toThrow(/SHA-256/u);
    const withoutAnchor = upstream.replace('    StrCpy $R1 "$(newerVersionInstalled)"\n', "");
    expect(() => renderInstallerTemplate(withoutAnchor)).toThrow(/SHA-256/u);
    expect(() => patchInstallerTemplate(withoutAnchor)).toThrow(/found 0/u);
  });
});

describe("replaceOnce", () => {
  it("replaces the single occurrence", () => {
    expect(replaceOnce("a b c", "b", "x")).toBe("a x c");
  });

  it("rejects a missing or repeated anchor", () => {
    expect(() => replaceOnce("a b c", "d", "x")).toThrow(/found 0.*"d".*upstream template may have changed/u);
    expect(() => replaceOnce("a b b", "b", "x")).toThrow(/found 2/u);
  });
});

describe("reinstall copy", () => {
  it("fits the page's three-line label with long version numbers", () => {
    // The label is 24u high: three lines of about 78 width units (a CJK character counts 2),
    // measured on the installer's own page; 10 units are left for word wrapping.
    const limit = 3 * 78 - 10;
    const width = (text: string): number => [...text].reduce((sum, char) => sum + (/[\u2e80-\uffef]/u.test(char) ? 2 : 1), 0);
    const sample = { product: "Amber", installed: "0.0.18-rc.10", version: "0.0.18-rc.10" };
    const tooLong: string[] = [];
    for (const locale of INSTALLER_LOCALES) {
      const copy = INSTALLER_COPY[locale].reinstall;
      for (const key of ["olderInstalled", "newerInstalled"] as const) {
        const shown = copy[key].replaceAll(/\{([A-Za-z]+)\}/gu, (_, name: string) => sample[name as keyof typeof sample]);
        if (width(shown) > limit) {
          tooLong.push(`${locale}.${key}: ${width(shown)} > ${limit}`);
        }
      }
    }
    expect(tooLong).toEqual([]);
  });
});

describe("tauri.conf.json", () => {
  it("builds with the generated template", () => {
    const conf = JSON.parse(readFileSync(join(REPO_ROOT, "src", "desktop", "tauri.conf.json"), "utf8")) as {
      bundle: { windows: { nsis: { template?: string } } };
    };
    const template = conf.bundle.windows.nsis.template;
    expect(template).toBeDefined();
    expect(join("src", "desktop", template as string)).toBe(join(INSTALLER_TEMPLATE_FILE));
  });
});
