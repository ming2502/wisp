const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatTime(seconds: number | null): string {
  if (seconds === null) return "";
  const date = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `rwxr-x---` style, with setuid, setgid and sticky bits shown as ls does. */
export function formatPermissions(mode: number | null): string {
  if (mode === null) return "";
  const chars = ["r", "w", "x", "r", "w", "x", "r", "w", "x"].map((c, i) =>
    mode & (1 << (8 - i)) ? c : "-",
  );
  const special = (index: number, bit: number, set: string) => {
    if (mode & bit) chars[index] = chars[index] === "x" ? set : set.toUpperCase();
  };
  special(2, 0o4000, "s");
  special(5, 0o2000, "s");
  special(8, 0o1000, "t");
  return chars.join("");
}

export function formatOctal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, "0");
}

/** Accepts three or four octal digits, as chmod does. */
export function parseOctal(text: string): number | null {
  return /^[0-7]{3,4}$/.test(text.trim()) ? parseInt(text.trim(), 8) : null;
}
