/** Binary size units. The named default sizes `*_GB` / `*_MB` are counted in these units. */
export const BYTES_PER_MB = 1024 ** 2;
export const BYTES_PER_GB = 1024 ** 3;

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Binary byte size with one decimal above bytes (`1.5 GB`); unit symbols are not copy. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} ${BYTE_UNITS[0]}` : `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}
