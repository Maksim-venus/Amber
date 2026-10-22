/**
 * Names of the client backup that the desktop shell needs too, kept free of
 * imports so the tooling can generate them into the shell's Rust source.
 */

/** File extension of a backup, without the dot. */
export const BACKUP_FILE_EXTENSION = "amberbackup";

/** Prefix of the subdirectory a restore creates for the originals: `Amber-Restored-<yyyyMMdd-HHmmss>`. */
export const RESTORED_ORIGINALS_DIR_PREFIX = "Amber-Restored-";

/** Line prefix of the restore command's progress output on stdout; JSON follows it. */
export const RESTORE_PROGRESS_PREFIX = "PROGRESS ";
