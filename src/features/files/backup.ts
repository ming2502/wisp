/** Backups sit next to the file as `<name>.bak.<yyMMdd>`, dated in local time. */
const BACKUP_NAME = /^(.+)\.bak\.\d{6}$/;
/** The earlier `<name>.bak<yyyyMMddHHmm>` form, still recognised so those backups can be restored. */
const OLD_BACKUP_NAME = /^(.+)\.bak\d{12}$/;

export function backupName(name: string, now: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${name}.bak.${two(now.getFullYear() % 100)}${two(now.getMonth() + 1)}${two(now.getDate())}`;
}

/** The name a backup restores to, or null when the name is not a backup's. */
export function restoredName(name: string): string | null {
  return (BACKUP_NAME.exec(name) ?? OLD_BACKUP_NAME.exec(name))?.[1] ?? null;
}
