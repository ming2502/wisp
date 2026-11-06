/** Backups sit next to the file as `<name>.bak<yyyyMMddHHmm>`, stamped in local time. */
const BACKUP_NAME = /^(.+)\.bak\d{12}$/;

export function backupName(name: string, now: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}${two(now.getHours())}${two(now.getMinutes())}`;
  return `${name}.bak${stamp}`;
}

/** The name a backup restores to, or null when the name is not a backup's. */
export function restoredName(name: string): string | null {
  return BACKUP_NAME.exec(name)?.[1] ?? null;
}
