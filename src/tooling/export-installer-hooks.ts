import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_ROOTS_FILE, DATA_DIR_NAME, LEGACY_APP_IDENTIFIER, LEGACY_MASTER_KEY_TARGET, MASTER_KEY_TARGET } from "../shared/app-identity.ts";
import { INSTALLER_COPY, NSIS_LANGUAGE_ID_ZH_CN, type UninstallCopy } from "../shared/i18n/installer.ts";

/**
 * Generates the NSIS installer hooks (`bundle.windows.nsis.installerHooks`) that implement
 * "uninstall and delete all data" from `src/shared`:
 *
 * - `NSIS_HOOK_PREUNINSTALL` runs before the template removes any file, while the bundled
 *   `node.exe` still exists. Only when "delete the application data" was ticked, the run is
 *   not an update and not silent, it asks a second time, listing the data directory, every
 *   custom cache directory registered in `cache-roots.txt` and the master key. "No" clears the
 *   checkbox state, so the template's own data removal is skipped too. "Yes" stops Amber and
 *   its Node by executable path, runs `server/uninstall-data.js` and reads its report: the
 *   master key goes only when the data directory is gone; what remains is listed for the
 *   user. Without a runnable remover nothing is deleted and the user is told where the data is.
 * - `NSIS_HOOK_POSTUNINSTALL` waits for the sidecar's `node.exe` to become deletable, so the
 *   install directory does not stay behind with a running Node in it.
 *
 * The template `!include`s the hooks before `MUI_LANGUAGE`, so they cannot declare
 * `LangString`s; the copy is chosen at run time from `$LANGUAGE` instead. NSIS strings hold
 * at most `NSIS_MAX_STRLEN` (1024) characters, so listed paths stop at a budget.
 */

export const INSTALLER_HOOKS_FILE = "src/desktop/gen/uninstall.nsh";

/** Where the remover writes its report; `uninstall-data.ts` defaults to the same name. */
export const REPORT_FILE_NAME = "amber-uninstall-report.txt";

/** The remover inside the install directory (resource `server/` of the bundle). */
export const REMOVER_PATH = "$INSTDIR\\server\\uninstall-data.js";

/** The bundled Node: Tauri strips the target triple from `externalBin` names. */
export const NODE_PATH = "$INSTDIR\\node.exe";

/** `CRED_TYPE_GENERIC`, the type the keyring crate stores the master key as. */
const CRED_TYPE_GENERIC = 1;

/** The WebView2 state directory of builds under the legacy identifier; the remover deletes it. */
export const LEGACY_STATE_DIR = `$LOCALAPPDATA\\${nsisEscape(LEGACY_APP_IDENTIFIER)}`;

/** Characters an NSIS string can hold, minus the terminator (`NSIS_MAX_STRLEN` = 1024). */
const NSIS_MAX_CHARS = 1023;

/** Assumed upper bound of `$APPDATA`'s expansion when budgeting message lengths. */
const APPDATA_MAX_CHARS = 140;

/** Characters a listed path line adds besides the path: line end and indentation. */
const LIST_LINE_OVERHEAD = 6;

/** Polling for the sidecar's Node to exit after uninstalling: 30 × 500 ms. */
const NODE_EXIT_POLL_MS = 500;
const NODE_EXIT_POLLS = 30;

const CRLF = "$\\r$\\n";

/** NSIS escaping for text inside a double-quoted string. */
export function nsisEscape(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (char === "$") {
      out += "$$";
    } else if (char === '"') {
      out += '$\\"';
    } else if (char === "\n") {
      out += CRLF;
    } else if (char === "\r") {
      // Line ends are always emitted as CRLF from "\n".
    } else if (char === "\t") {
      out += "$\\t";
    } else if (char === "`" || code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff)) {
      throw new Error(`character U+${code.toString(16)} cannot be placed in an NSIS string: ${JSON.stringify(text)}`);
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * The NSIS form of a copy template: literal text escaped, each `{name}` replaced by the
 * raw NSIS expression in `values`. An unknown placeholder is an error.
 */
export function nsisText(template: string, values: Readonly<Record<string, string>>): string {
  return template
    .split(/(\{[A-Za-z]+\})/u)
    .map((part) => {
      const placeholder = /^\{([A-Za-z]+)\}$/u.exec(part);
      if (placeholder === null) {
        return nsisEscape(part);
      }
      const value = values[placeholder[1] as string];
      if (value === undefined) {
        throw new Error(`unknown placeholder ${part} in ${JSON.stringify(template)}`);
      }
      return value;
    })
    .join("");
}

/** The data directory as an NSIS expression. */
const DATA_DIR = `$APPDATA\\${nsisEscape(DATA_DIR_NAME)}`;

const PLACEHOLDERS = { dataDir: DATA_DIR, credential: nsisEscape(MASTER_KEY_TARGET) };

const COPY_KEYS = Object.keys(INSTALLER_COPY["zh-CN"].uninstall) as (keyof UninstallCopy)[];

function copyVar(key: keyof UninstallCopy): string {
  return `$AmberUnCopy_${key}`;
}

/** The length a copy entry can reach on a target machine, `$APPDATA` at its assumed maximum. */
function expandedLength(template: string): number {
  return template.replaceAll("{dataDir}", `${"x".repeat(APPDATA_MAX_CHARS)}\\${DATA_DIR_NAME}`).replaceAll("{credential}", MASTER_KEY_TARGET).length;
}

/**
 * How many characters the listed paths of the confirmation, and of the result message, may
 * take so that the whole message stays within one NSIS string in every language.
 */
export function messageBudgets(): { confirmList: number; resultList: number } {
  const total = (templates: readonly string[], lineEnds: number): number =>
    templates.map(expandedLength).reduce((sum, length) => sum + length, 0) + lineEnds * 2;
  let confirmList = Number.POSITIVE_INFINITY;
  let resultList = Number.POSITIVE_INFINITY;
  for (const { uninstall: copy } of Object.values(INSTALLER_COPY)) {
    const confirmFixed = total(
      [
        copy.confirmIntro,
        copy.confirmDataDir,
        copy.confirmCacheDirs,
        copy.confirmMoreCacheDirs,
        copy.confirmCredential,
        copy.confirmKept,
        copy.confirmContract,
        copy.confirmQuestion,
      ],
      10,
    );
    // The failure message repeats the confirmation's list between its own lines.
    const notRunFixed = total([copy.resultNotRun, "    {dataDir}", copy.confirmCacheDirs, copy.confirmMoreCacheDirs, copy.resultNotRunCredential], 6);
    confirmList = Math.min(confirmList, NSIS_MAX_CHARS - confirmFixed, NSIS_MAX_CHARS - notRunFixed);
    // The listed lines carry their status suffix themselves; "    ..." marks a cut list.
    const resultFixed = total([copy.resultIncomplete, "    ...", copy.resultKeyKept], 4);
    resultList = Math.min(resultList, NSIS_MAX_CHARS - resultFixed);
  }
  // At least one maximal Windows path per list must fit, or the copy has grown too long.
  if (confirmList < 300 || resultList < 300) {
    throw new Error(`uninstall copy leaves too little room for paths (confirm ${confirmList}, result ${resultList})`);
  }
  return { confirmList, resultList };
}

function renderLoadCopy(): string[] {
  const assign = (locale: keyof typeof INSTALLER_COPY): string[] =>
    COPY_KEYS.map((key) => `    StrCpy ${copyVar(key)} "${nsisText(INSTALLER_COPY[locale].uninstall[key], PLACEHOLDERS)}"`);
  return [
    "; The uninstaller's language decides the copy: Simplified Chinese, otherwise English.",
    "!macro AMBER_UN_LOAD_COPY",
    `  \${If} $LANGUAGE = ${NSIS_LANGUAGE_ID_ZH_CN}`,
    ...assign("zh-CN"),
    "  ${Else}",
    ...assign("en"),
    "  ${EndIf}",
    "!macroend",
  ];
}

export function renderInstallerHooks(): string {
  const { confirmList, resultList } = messageBudgets();
  const vars = [
    "AmberUnFile",
    "AmberUnOpen",
    "AmberUnEof",
    "AmberUnByte1",
    "AmberUnByte2",
    "AmberUnLine",
    "AmberUnChar",
    "AmberUnLength",
    "AmberUnLineLength",
    "AmberUnRoots",
    "AmberUnRootsMore",
    "AmberUnText",
    "AmberUnReport",
    "AmberUnExit",
    "AmberUnRan",
    "AmberUnDataGone",
    "AmberUnLeft",
    "AmberUnLeftMore",
    "AmberUnHead",
    "AmberUnPath",
    "AmberUnSuffix",
    "AmberUnWait",
    ...COPY_KEYS.map((key) => copyVar(key).slice(1)),
  ];
  const lines = [
    "; Generated by src/tooling/export-installer-hooks.ts from src/shared. Do not edit.",
    "; Uninstall hooks of Amber's NSIS installer.",
    "",
    ...vars.map((name) => `Var ${name}`),
    "",
    ...renderLoadCopy(),
    "",
    "; Opens a UTF-16LE file past its byte order mark; $AmberUnOpen is 1 when it is open.",
    "!macro AMBER_UN_OPEN_UTF16 path",
    "  StrCpy $AmberUnOpen 0",
    "  StrCpy $AmberUnEof 0",
    "  ClearErrors",
    '  FileOpen $AmberUnFile "${path}" r',
    "  ${IfNot} ${Errors}",
    "    StrCpy $AmberUnOpen 1",
    "    FileReadByte $AmberUnFile $AmberUnByte1",
    "    FileReadByte $AmberUnFile $AmberUnByte2",
    "    ${If} $AmberUnByte1 = 255",
    "    ${AndIf} $AmberUnByte2 = 254",
    "      ; Positioned after the byte order mark.",
    "    ${Else}",
    "      FileSeek $AmberUnFile 0 SET",
    "    ${EndIf}",
    "  ${EndIf}",
    "!macroend",
    "",
    "; Reads the next line into $AmberUnLine without its line end; $AmberUnEof is 1 at the end.",
    "!macro AMBER_UN_READ_LINE",
    "  ClearErrors",
    "  FileReadUTF16LE $AmberUnFile $AmberUnLine",
    "  ${If} ${Errors}",
    "    StrCpy $AmberUnEof 1",
    '    StrCpy $AmberUnLine ""',
    "  ${EndIf}",
    "  ${Do}",
    "    StrCpy $AmberUnChar $AmberUnLine 1 -1",
    '    ${If} $AmberUnChar == "$\\r"',
    '    ${OrIf} $AmberUnChar == "$\\n"',
    "      StrCpy $AmberUnLine $AmberUnLine -1",
    "    ${Else}",
    "      ${Break}",
    "    ${EndIf}",
    "  ${Loop}",
    "!macroend",
    "",
    "; Sets $AmberUnLength to the length `list` would reach with $AmberUnLine appended.",
    "!macro AMBER_UN_LENGTH_WITH_LINE list",
    "  StrLen $AmberUnLength ${list}",
    "  StrLen $AmberUnLineLength $AmberUnLine",
    "  IntOp $AmberUnLength $AmberUnLength + $AmberUnLineLength",
    `  IntOp $AmberUnLength $AmberUnLength + ${LIST_LINE_OVERHEAD}`,
    "!macroend",
    "",
    "!macro NSIS_HOOK_PREUNINSTALL",
    "  ${If} $DeleteAppDataCheckboxState = 1",
    "  ${AndIf} $UpdateMode <> 1",
    "    ${If} ${Silent}",
    "      ; Deleting user data always takes the second confirmation, which silent mode cannot show.",
    "      StrCpy $DeleteAppDataCheckboxState 0",
    "    ${Else}",
    "      !insertmacro AMBER_UN_LOAD_COPY",
    '      StrCpy $AmberUnRoots ""',
    "      StrCpy $AmberUnRootsMore 0",
    `      !insertmacro AMBER_UN_OPEN_UTF16 "${DATA_DIR}\\${nsisEscape(CACHE_ROOTS_FILE)}"`,
    "      ${If} $AmberUnOpen = 1",
    "        ${Do}",
    "          !insertmacro AMBER_UN_READ_LINE",
    "          ${If} $AmberUnEof = 1",
    '          ${AndIf} $AmberUnLine == ""',
    "            ${Break}",
    "          ${EndIf}",
    '          ${If} $AmberUnLine != ""',
    "            !insertmacro AMBER_UN_LENGTH_WITH_LINE $AmberUnRoots",
    `            \${If} $AmberUnLength > ${confirmList}`,
    "              StrCpy $AmberUnRootsMore 1",
    "            ${Else}",
    `              StrCpy $AmberUnRoots "$AmberUnRoots${CRLF}    $AmberUnLine"`,
    "            ${EndIf}",
    "          ${EndIf}",
    "        ${LoopUntil} $AmberUnEof = 1",
    "        FileClose $AmberUnFile",
    "      ${EndIf}",
    "      ${If} $AmberUnRoots != \"\"",
    `        StrCpy $AmberUnRoots "${CRLF}${copyVar("confirmCacheDirs")}$AmberUnRoots"`,
    "      ${EndIf}",
    "      ${If} $AmberUnRootsMore = 1",
    `        StrCpy $AmberUnRoots "$AmberUnRoots${CRLF}${copyVar("confirmMoreCacheDirs")}"`,
    "      ${EndIf}",
    `      StrCpy $AmberUnText "${copyVar("confirmIntro")}${CRLF}${copyVar("confirmDataDir")}$AmberUnRoots${CRLF}${copyVar("confirmCredential")}${CRLF}${CRLF}${copyVar("confirmKept")}${CRLF}${copyVar("confirmContract")}${CRLF}${CRLF}${copyVar("confirmQuestion")}"`,
    "      ${IfNot} ${Cmd} `MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \"$AmberUnText\" IDYES`",
    "        StrCpy $DeleteAppDataCheckboxState 0",
    "      ${EndIf}",
    "    ${EndIf}",
    "  ${EndIf}",
    "",
    "  ${If} $DeleteAppDataCheckboxState = 1",
    "  ${AndIf} $UpdateMode <> 1",
    "    ; By executable path, so only this installation's Amber and Node are stopped.",
    '    !insertmacro CheckIfAppIsRunning "$INSTDIR\\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"',
    `    !insertmacro CheckIfAppIsRunning "${NODE_PATH}" "\${PRODUCTNAME}"`,
    `    StrCpy $AmberUnReport "$TEMP\\${nsisEscape(REPORT_FILE_NAME)}"`,
    "    Delete $AmberUnReport",
    "    StrCpy $AmberUnRan 0",
    `    \${If} \${FileExists} "${NODE_PATH}"`,
    `    \${AndIf} \${FileExists} "${REMOVER_PATH}"`,
    "      ClearErrors",
    `      ExecWait '"${NODE_PATH}" "${REMOVER_PATH}" "${DATA_DIR}" "$AmberUnReport" "${LEGACY_STATE_DIR}"' $AmberUnExit`,
    "      ${IfNot} ${Errors}",
    "        StrCpy $AmberUnRan 1",
    "      ${EndIf}",
    "    ${EndIf}",
    "    StrCpy $AmberUnDataGone 0",
    '    StrCpy $AmberUnLeft ""',
    "    StrCpy $AmberUnLeftMore 0",
    "    ${If} $AmberUnRan = 1",
    "      StrCpy $AmberUnRan 0",
    "      !insertmacro AMBER_UN_OPEN_UTF16 $AmberUnReport",
    "      ${If} $AmberUnOpen = 1",
    "        ${Do}",
    "          !insertmacro AMBER_UN_READ_LINE",
    '          StrCpy $AmberUnSuffix ""',
    '          StrCpy $AmberUnPath ""',
    "          StrCpy $AmberUnHead $AmberUnLine 3",
    '          ${If} $AmberUnHead == "OK "',
    '            StrCpy $AmberUnPath $AmberUnLine "" 3',
    `            \${If} $AmberUnPath == "${DATA_DIR}"`,
    "              StrCpy $AmberUnDataGone 1",
    "              ; The data directory's line comes last: the remover finished.",
    "              StrCpy $AmberUnRan 1",
    "            ${EndIf}",
    '            StrCpy $AmberUnPath ""',
    "          ${EndIf}",
    "          StrCpy $AmberUnHead $AmberUnLine 5",
    '          ${If} $AmberUnHead == "LEFT "',
    '            StrCpy $AmberUnPath $AmberUnLine "" 5',
    `            StrCpy $AmberUnSuffix ${copyVar("resultLeft")}`,
    "          ${EndIf}",
    "          StrCpy $AmberUnHead $AmberUnLine 8",
    '          ${If} $AmberUnHead == "MISSING "',
    '            StrCpy $AmberUnPath $AmberUnLine "" 8',
    `            StrCpy $AmberUnSuffix ${copyVar("resultMissing")}`,
    "          ${EndIf}",
    '          ${If} $AmberUnHead == "REFUSED "',
    '            StrCpy $AmberUnPath $AmberUnLine "" 8',
    `            StrCpy $AmberUnSuffix ${copyVar("resultRefused")}`,
    "          ${EndIf}",
    `          \${If} $AmberUnPath == "${DATA_DIR}"`,
    "            StrCpy $AmberUnRan 1",
    "            ; A data directory that does not exist holds nothing the key could decrypt.",
    '            ${If} $AmberUnHead == "MISSING "',
    "              StrCpy $AmberUnDataGone 1",
    '              StrCpy $AmberUnPath ""',
    "            ${EndIf}",
    "          ${EndIf}",
    '          ${If} $AmberUnPath != ""',
    "            StrCpy $AmberUnLine \"$AmberUnPath$AmberUnSuffix\"",
    "            !insertmacro AMBER_UN_LENGTH_WITH_LINE $AmberUnLeft",
    `            \${If} $AmberUnLength > ${resultList}`,
    "              StrCpy $AmberUnLeftMore 1",
    "            ${Else}",
    `              StrCpy $AmberUnLeft "$AmberUnLeft${CRLF}    $AmberUnLine"`,
    "            ${EndIf}",
    "          ${EndIf}",
    "        ${LoopUntil} $AmberUnEof = 1",
    "        FileClose $AmberUnFile",
    "      ${EndIf}",
    "      Delete $AmberUnReport",
    "    ${EndIf}",
    "    ${If} $AmberUnRan = 1",
    "      ${If} $AmberUnDataGone = 1",
    `        System::Call 'advapi32::CredDeleteW(w "${nsisEscape(MASTER_KEY_TARGET)}", i ${CRED_TYPE_GENERIC}, i 0) i .r0'`,
    "        ; What a build under the legacy identifier left when this one never started.",
    `        System::Call 'advapi32::CredDeleteW(w "${nsisEscape(LEGACY_MASTER_KEY_TARGET)}", i ${CRED_TYPE_GENERIC}, i 0) i .r0'`,
    "      ${EndIf}",
    '      StrCpy $AmberUnText ""',
    '      ${If} $AmberUnLeft != ""',
    `        StrCpy $AmberUnText "${copyVar("resultIncomplete")}$AmberUnLeft"`,
    "        ${If} $AmberUnLeftMore = 1",
    `          StrCpy $AmberUnText "$AmberUnText${CRLF}    ..."`,
    "        ${EndIf}",
    "      ${EndIf}",
    "      ${If} $AmberUnDataGone <> 1",
    `        StrCpy $AmberUnText "$AmberUnText${CRLF}${CRLF}${copyVar("resultKeyKept")}"`,
    "      ${EndIf}",
    '      ${If} $AmberUnText != ""',
    '        MessageBox MB_OK|MB_ICONEXCLAMATION "$AmberUnText"',
    "      ${EndIf}",
    "    ${Else}",
    "      ; No report from the remover: keep the key, which may still be needed for what is left.",
    `      StrCpy $AmberUnText "${copyVar("resultNotRun")}${CRLF}    ${DATA_DIR}$AmberUnRoots${CRLF}${copyVar("resultNotRunCredential")}"`,
    '      MessageBox MB_OK|MB_ICONEXCLAMATION "$AmberUnText"',
    "    ${EndIf}",
    "  ${EndIf}",
    "!macroend",
    "",
    "!macro NSIS_HOOK_POSTUNINSTALL",
    "  ; The sidecar's Node may still be exiting after Amber was closed; its files stay locked until then.",
    "  StrCpy $AmberUnWait 0",
    `  \${DoWhile} \${FileExists} "${NODE_PATH}"`,
    `    Delete "${NODE_PATH}"`,
    `    \${IfNot} \${FileExists} "${NODE_PATH}"`,
    "      ${Break}",
    "    ${EndIf}",
    `    \${If} $AmberUnWait >= ${NODE_EXIT_POLLS}`,
    "      ${Break}",
    "    ${EndIf}",
    `    Sleep ${NODE_EXIT_POLL_MS}`,
    "    IntOp $AmberUnWait $AmberUnWait + 1",
    "  ${Loop}",
    `  \${If} \${FileExists} "${NODE_PATH}"`,
    `    !insertmacro CheckIfAppIsRunning "${NODE_PATH}" "\${PRODUCTNAME}"`,
    `    Delete "${NODE_PATH}"`,
    "  ${EndIf}",
    '  RMDir "$INSTDIR"',
    "!macroend",
    "",
  ];
  return lines.join("\r\n");
}

/** The hooks file as written: UTF-8 with a byte order mark, as Tauri writes its own includes. */
export function installerHooksBytes(): Buffer {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(renderInstallerHooks(), "utf8")]);
}

function main(): void {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const target = join(root, INSTALLER_HOOKS_FILE);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, installerHooksBytes());
  console.log(`wrote ${INSTALLER_HOOKS_FILE}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
