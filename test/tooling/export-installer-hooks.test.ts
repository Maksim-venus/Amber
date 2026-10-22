import { describe, expect, it } from "vitest";
import { CACHE_ROOTS_FILE, DATA_DIR_NAME, LEGACY_MASTER_KEY_TARGET, MASTER_KEY_TARGET } from "../../src/shared/app-identity.ts";
import { INSTALLER_COPY, INSTALLER_LOCALES, NSIS_LANGUAGE_ID_ZH_CN } from "../../src/shared/i18n/installer.ts";
import { UNINSTALL_REPORT_FILE } from "../../src/server/uninstall-data.ts";
import {
  installerHooksBytes,
  messageBudgets,
  LEGACY_STATE_DIR,
  NODE_PATH,
  nsisEscape,
  nsisText,
  REMOVER_PATH,
  renderInstallerHooks,
  REPORT_FILE_NAME,
} from "../../src/tooling/export-installer-hooks.ts";

/** The body of `!macro <name>` up to its `!macroend`. */
function macroBody(nsh: string, name: string): string {
  const start = nsh.indexOf(`!macro ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  return nsh.slice(start, nsh.indexOf("!macroend", start));
}

describe("nsisEscape", () => {
  it("escapes dollars, quotes, line ends and tabs and keeps other text", () => {
    expect(nsisEscape("a $b ${c} $(d)")).toBe("a $$b $${c} $$(d)");
    expect(nsisEscape('say "hi"')).toBe('say $\\"hi$\\"');
    expect(nsisEscape("一\n二")).toBe("一$\\r$\\n二");
    expect(nsisEscape("一\r\n二")).toBe("一$\\r$\\n二");
    expect(nsisEscape("a\tb")).toBe("a$\\tb");
    expect(nsisEscape("C:\\path\\x 「是」 '单引号'")).toBe("C:\\path\\x 「是」 '单引号'");
  });

  it("rejects what cannot appear in the generated strings", () => {
    expect(() => nsisEscape("a`b")).toThrow();
    expect(() => nsisEscape("a\u0000b")).toThrow();
    expect(() => nsisEscape("\ud800")).toThrow();
  });
});

describe("nsisText", () => {
  it("fills in raw NSIS expressions and escapes the literal text around them", () => {
    expect(nsisText("$ {dataDir} 中", { dataDir: "$APPDATA\\Amber" })).toBe("$$ $APPDATA\\Amber 中");
    expect(() => nsisText("{unknown}", {})).toThrow(/unknown placeholder/u);
  });
});

describe("installer copy", () => {
  it("has every key in both languages, non-empty, with the same placeholders", () => {
    const [zh, en] = INSTALLER_LOCALES.map((locale) => INSTALLER_COPY[locale]);
    for (const section of ["uninstall", "shell", "reinstall"] as const) {
      const zhSection = zh?.[section] as unknown as Record<string, string>;
      const enSection = en?.[section] as unknown as Record<string, string>;
      expect(Object.keys(enSection).sort()).toEqual(Object.keys(zhSection).sort());
      for (const key of Object.keys(zhSection)) {
        const placeholders = (text: string): string[] => [...text.matchAll(/\{[A-Za-z]+\}/gu)].map((match) => match[0]).sort();
        expect(zhSection[key]?.trim()).not.toBe("");
        expect(enSection[key]?.trim()).not.toBe("");
        expect(placeholders(enSection[key] as string)).toEqual(placeholders(zhSection[key] as string));
      }
    }
  });

  it("leaves room for at least one long path in every message", () => {
    const { confirmList, resultList } = messageBudgets();
    expect(confirmList).toBeGreaterThanOrEqual(300);
    expect(resultList).toBeGreaterThanOrEqual(300);
  });
});

describe("renderInstallerHooks", () => {
  const nsh = renderInstallerHooks();

  it("defines the two Tauri hook macros and only uses CRLF line ends", () => {
    expect(nsh).toContain("!macro NSIS_HOOK_PREUNINSTALL\r\n");
    expect(nsh).toContain("!macro NSIS_HOOK_POSTUNINSTALL\r\n");
    expect(nsh).not.toMatch(/[^\r]\n/u);
    expect(nsh).not.toContain("LangString");
    expect(nsh).not.toMatch(/RMDir \/r/iu);
  });

  it("is written as UTF-8 with a byte order mark", () => {
    const bytes = installerHooksBytes();
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString("utf8")).toBe(nsh);
  });

  it("asks only for a ticked, interactive, non-update uninstall and treats No as unticked", () => {
    const pre = macroBody(nsh, "NSIS_HOOK_PREUNINSTALL");
    expect(pre).toContain("${If} $DeleteAppDataCheckboxState = 1\r\n  ${AndIf} $UpdateMode <> 1");
    expect(pre).toContain("${If} ${Silent}\r\n      ; Deleting user data always takes the second confirmation, which silent mode cannot show.\r\n      StrCpy $DeleteAppDataCheckboxState 0");
    expect(pre).toContain('${IfNot} ${Cmd} `MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "$AmberUnText" IDYES`\r\n        StrCpy $DeleteAppDataCheckboxState 0');
    expect(pre).toContain(`AMBER_UN_OPEN_UTF16 "$APPDATA\\${DATA_DIR_NAME}\\${CACHE_ROOTS_FILE}"`);
    expect(macroBody(nsh, "AMBER_UN_READ_LINE")).toContain("FileReadUTF16LE $AmberUnFile $AmberUnLine");
  });

  it("chooses the copy by the uninstaller language", () => {
    const load = macroBody(nsh, "AMBER_UN_LOAD_COPY");
    expect(load).toContain(`\${If} $LANGUAGE = ${NSIS_LANGUAGE_ID_ZH_CN}`);
    for (const locale of INSTALLER_LOCALES) {
      for (const [key, text] of Object.entries(INSTALLER_COPY[locale].uninstall)) {
        const expected = nsisText(text, { dataDir: `$APPDATA\\${DATA_DIR_NAME}`, credential: MASTER_KEY_TARGET });
        expect(load).toContain(`StrCpy $AmberUnCopy_${key} "${expected}"`);
      }
    }
  });

  it("stops Amber and its Node by path before running the remover with the data directory", () => {
    const pre = macroBody(nsh, "NSIS_HOOK_PREUNINSTALL");
    const stopApp = pre.indexOf('!insertmacro CheckIfAppIsRunning "$INSTDIR\\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"');
    const stopNode = pre.indexOf('!insertmacro CheckIfAppIsRunning "$INSTDIR\\node.exe" "${PRODUCTNAME}"');
    const run = pre.indexOf(
      `ExecWait '"$INSTDIR\\node.exe" "$INSTDIR\\server\\uninstall-data.js" "$APPDATA\\${DATA_DIR_NAME}" "$AmberUnReport" "${LEGACY_STATE_DIR}"' $AmberUnExit`,
    );
    expect(stopApp).toBeGreaterThan(0);
    expect(stopNode).toBeGreaterThan(stopApp);
    expect(run).toBeGreaterThan(stopNode);
    expect(NODE_PATH).toBe("$INSTDIR\\node.exe");
    expect(REMOVER_PATH).toBe("$INSTDIR\\server\\uninstall-data.js");
    expect(pre).toContain(`StrCpy $AmberUnReport "$TEMP\\${REPORT_FILE_NAME}"`);
    expect(REPORT_FILE_NAME).toBe(UNINSTALL_REPORT_FILE);
    // Without the remover nothing is deleted.
    expect(pre).toContain('${If} ${FileExists} "$INSTDIR\\node.exe"\r\n    ${AndIf} ${FileExists} "$INSTDIR\\server\\uninstall-data.js"');
  });

  it("deletes the master key only after the data directory is gone, by the keyring's target name", () => {
    const pre = macroBody(nsh, "NSIS_HOOK_PREUNINSTALL");
    const credDelete = `System::Call 'advapi32::CredDeleteW(w "${MASTER_KEY_TARGET}", i 1, i 0) i .r0'`;
    expect(MASTER_KEY_TARGET).toBe("master-key-v1.com.lifefindsitsway.amber");
    expect(pre.split(credDelete)).toHaveLength(2);
    expect(pre).toContain(`\${If} $AmberUnDataGone = 1\r\n        ${credDelete}`);
    expect(pre).toContain(`\${If} $AmberUnPath == "$APPDATA\\${DATA_DIR_NAME}"\r\n              StrCpy $AmberUnDataGone 1`);
    for (const status of ["OK ", "LEFT ", "MISSING ", "REFUSED "]) {
      expect(pre).toContain(`== "${status}"`);
    }
  });

  it("also deletes what a build under the legacy identifier left: its credential, and its WebView2 state through the remover", () => {
    const pre = macroBody(nsh, "NSIS_HOOK_PREUNINSTALL");
    const current = `System::Call 'advapi32::CredDeleteW(w "${MASTER_KEY_TARGET}", i 1, i 0) i .r0'`;
    const legacy = `System::Call 'advapi32::CredDeleteW(w "${LEGACY_MASTER_KEY_TARGET}", i 1, i 0) i .r0'`;
    expect(LEGACY_MASTER_KEY_TARGET).toBe("master-key-v1.io.github.lifefindsitsway.amber");
    expect(LEGACY_STATE_DIR).toBe("$LOCALAPPDATA\\io.github.lifefindsitsway.amber");
    expect(pre.split(legacy)).toHaveLength(2);
    expect(pre).toContain(`\${If} $AmberUnDataGone = 1\r\n        ${current}\r\n`);
    expect(pre.indexOf(legacy)).toBeGreaterThan(pre.indexOf(current));
    expect(pre.indexOf(legacy)).toBeLessThan(pre.indexOf('StrCpy $AmberUnText ""'));
  });

  it("waits for the sidecar's Node before removing the install directory", () => {
    const post = macroBody(nsh, "NSIS_HOOK_POSTUNINSTALL");
    expect(post).toContain('${DoWhile} ${FileExists} "$INSTDIR\\node.exe"');
    expect(post).toContain("Sleep 500");
    expect(post).toContain("${If} $AmberUnWait >= 30");
    expect(post).toContain('!insertmacro CheckIfAppIsRunning "$INSTDIR\\node.exe" "${PRODUCTNAME}"');
    expect(post.trimEnd().endsWith('RMDir "$INSTDIR"')).toBe(true);
  });

  it("declares every variable it uses", () => {
    const declared = new Set([...nsh.matchAll(/^Var (\w+)$/gmu)].map((match) => match[1]));
    const used = new Set([...nsh.matchAll(/\$(AmberUn\w+)/gu)].map((match) => match[1]));
    for (const name of used) {
      expect(declared.has(name), name).toBe(true);
    }
  });
});
