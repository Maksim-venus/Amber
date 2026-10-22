/**
 * Copy shown outside the WebView: by the Windows uninstaller's hooks and by the native shell
 * before the sidecar starts. Neither has access to the SPA's i18n runtime,
 * so `src/tooling/export-installer-hooks.ts` and `src/tooling/export-desktop-defaults.ts`
 * generate NSIS and Rust strings from here at build time.
 *
 * The installer ships Simplified Chinese and English; the uninstaller picks Chinese when its
 * language is 2052 and English otherwise, the shell when the user's UI language is Chinese.
 *
 * Placeholders: `{dataDir}` is the data directory, `{credential}` the Credential Manager
 * entry of the master key (both filled in when the hooks are generated); `{path}` and
 * `{error}` are filled in by the shell at run time. The reinstall page's `{product}`,
 * `{installed}` and `{version}` become NSIS expressions in the generated installer template
 * (`src/tooling/export-installer-template.ts`).
 */

/** The languages the installer is built with, in `bundle.windows.nsis.languages` order. */
export const INSTALLER_LOCALES = ["zh-CN", "en"] as const;
export type InstallerLocale = (typeof INSTALLER_LOCALES)[number];

/** The NSIS language id of Simplified Chinese (`LANG_SIMPCHINESE`). */
export const NSIS_LANGUAGE_ID_ZH_CN = 2052;

/** The NSIS language name of each installer locale, as listed in `bundle.windows.nsis.languages`. */
export const NSIS_LANGUAGES: Readonly<Record<InstallerLocale, string>> = { "zh-CN": "SimpChinese", en: "English" };

export interface UninstallCopy {
  /** First paragraph of the second confirmation after "delete application data" was ticked. */
  confirmIntro: string;
  /** The data directory line; `{dataDir}`. */
  confirmDataDir: string;
  /** Heading of the registered custom cache directories. */
  confirmCacheDirs: string;
  /** Replaces the rest of the list when it does not fit into one message. */
  confirmMoreCacheDirs: string;
  /** The Credential Manager line; `{credential}`. */
  confirmCredential: string;
  /** What is never deleted. */
  confirmKept: string;
  /** The cache directory contract: renamed files inside it go too. */
  confirmContract: string;
  /** The Yes / No question; "No" uninstalls the program and keeps all data. */
  confirmQuestion: string;
  /** Heading of the directories that were not removed. */
  resultIncomplete: string;
  /** Suffix of a directory that could not be removed completely. */
  resultLeft: string;
  /** Suffix of a directory that was not found, e.g. on a disconnected drive. */
  resultMissing: string;
  /** Suffix of a directory skipped because it is a link or lacks Amber's marker. */
  resultRefused: string;
  /** Why the master key was kept; `{credential}`. */
  resultKeyKept: string;
  /** The remover could not run; nothing is known to be deleted. */
  resultNotRun: string;
  /** Last line of `resultNotRun`: the credential to remove by hand; `{credential}`. */
  resultNotRunCredential: string;
}

export interface ShellCopy {
  /** Title of the shell's native message boxes. */
  title: string;
  /** The data directory exists, is not empty and has no marker; `{path}`. */
  dataDirForeign: string;
  /** The data directory is a symbolic link or junction; `{path}`. */
  dataDirLink: string;
  /** The data directory cannot be inspected or created; `{path}`, `{error}`. */
  dataDirUnusable: string;
}

/**
 * The installer's "already installed" page when a different version is installed. Tauri's own
 * text names no version (its Simplified Chinese reads "version 旧的"), so both are shown.
 */
export interface ReinstallCopy {
  /** An older version is installed; `{product}`, `{installed}`, `{version}` (this installer's). */
  olderInstalled: string;
  /** A newer version is installed; same placeholders. */
  newerInstalled: string;
  /** Stands in for `{installed}` when the registry holds no version. */
  versionUnknown: string;
}

export interface InstallerCopy {
  uninstall: UninstallCopy;
  shell: ShellCopy;
  reinstall: ReinstallCopy;
}

export const INSTALLER_COPY: Readonly<Record<InstallerLocale, InstallerCopy>> = {
  "zh-CN": {
    uninstall: {
      confirmIntro: "确定要删除 Amber 的全部数据吗？删除后无法恢复。将删除：",
      confirmDataDir: "• 数据目录 {dataDir}（含其中的缓存目录 media）",
      confirmCacheDirs: "• 自定义缓存目录：",
      confirmMoreCacheDirs: "    ……以及更多（清单见数据目录中的 cache-roots.txt）",
      confirmCredential: "• Windows 凭据管理器中的 Amber 主密钥 {credential}",
      confirmKept: "不会删除：你导入的原始音视频与字幕文件、另存为和导出的文件。",
      confirmContract: "缓存目录 media 由 Amber 管理，其中的文件会全部删除，包括你在里面改过名的文件；需要保留的请先移到缓存目录之外。",
      confirmQuestion: "选「是」删除以上全部数据；选「否」只卸载程序、保留全部数据。",
      resultIncomplete: "以下目录没有删除或没有删完，请手动处理：",
      resultLeft: "（未能删完）",
      resultMissing: "（未找到，所在磁盘可能未连接）",
      resultRefused: "（是链接或缺少 Amber 的标记，已跳过）",
      resultKeyKept: "数据目录没有完全删除，凭据管理器中的主密钥 {credential} 已保留，以免残留数据无法解密。",
      resultNotRun: "数据清理程序未能运行或未完成，Amber 的数据可能仍在。如需删除，请手动删除：",
      resultNotRunCredential: "• Windows 凭据管理器中的 {credential}",
    },
    shell: {
      title: "Amber",
      dataDirForeign: "文件夹 {path} 已存在，但不是 Amber 的数据目录。为避免误动其中的文件，Amber 不会启动。\n\n请把这个文件夹移走或改名，然后再启动 Amber。",
      dataDirLink: "{path} 是符号链接或目录联接。Amber 不使用链接作为数据目录，以免卸载时误删链接指向的文件。\n\n请删除这个链接（它指向的文件夹不受影响），然后再启动 Amber。",
      dataDirUnusable: "无法使用数据目录 {path}：{error}\n\nAmber 不会启动。",
    },
    reinstall: {
      olderInstalled: "系统中已安装 {product} {installed}，本安装包为 {version}。推荐先卸载当前版本后再进行安装。选择你想要执行的操作后点击下一步以继续。",
      newerInstalled:
        "系统中已安装更新的 {product} {installed}，本安装包为 {version}。不推荐安装旧版本；如确需安装，推荐先卸载当前版本。选择你想要执行的操作后点击下一步以继续。",
      versionUnknown: "（版本未知）",
    },
  },
  en: {
    uninstall: {
      confirmIntro: "Delete all Amber data? This cannot be undone. To be deleted:",
      confirmDataDir: "• Data directory {dataDir} (with its media cache)",
      confirmCacheDirs: "• Custom cache directories:",
      confirmMoreCacheDirs: "    ...and more, listed in cache-roots.txt in the data directory",
      confirmCredential: "• Master key {credential} in Credential Manager",
      confirmKept: "Kept: the files you imported, saved or exported.",
      confirmContract: "Every file in a media cache directory is deleted, including files you renamed there. Move out anything you want to keep first.",
      confirmQuestion: "Yes deletes all of this. No only uninstalls the program.",
      resultIncomplete: "These directories were not deleted, or not completely. Please handle them manually:",
      resultLeft: " (not completely deleted)",
      resultMissing: " (not found; its drive may be disconnected)",
      resultRefused: " (skipped: a link, or Amber's marker is missing)",
      resultKeyKept: "As the data directory was not deleted completely, the master key {credential} was kept in Credential Manager so the remaining data can still be decrypted.",
      resultNotRun: "The data remover could not run or did not finish, so Amber's data may still be there. To delete it, remove these manually:",
      resultNotRunCredential: "• {credential} in Windows Credential Manager",
    },
    shell: {
      title: "Amber",
      dataDirForeign:
        "The folder {path} already exists but is not Amber's data directory. Amber will not start, so that nothing in it is touched.\n\nMove or rename this folder, then start Amber again.",
      dataDirLink:
        "{path} is a symbolic link or junction. Amber does not use a link as its data directory, so that uninstalling cannot delete what it points to.\n\nRemove the link (the folder it points to is not affected), then start Amber again.",
      dataDirUnusable: "The data directory {path} cannot be used: {error}\n\nAmber will not start.",
    },
    reinstall: {
      olderInstalled:
        "{product} {installed} is installed; this installer is {version}. It's recommended that you uninstall the current version first. Select the operation you want to perform and click Next to continue.",
      newerInstalled:
        "A newer {product} {installed} is installed; this installer is {version}. Downgrading is not recommended; if you must, uninstall the current version first. Select the operation you want to perform and click Next to continue.",
      versionUnknown: "(unknown version)",
    },
  },
};
