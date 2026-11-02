import { describe, expect, it } from "vitest";
import { formatBytes, formatOctal, formatPermissions, parseOctal } from "./format";

describe("format", () => {
  it("formats sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(200 * 1024 * 1024)).toBe("200 MB");
    expect(formatBytes(3 * 1024 ** 4)).toBe("3.0 TB");
  });

  it("formats permissions like ls", () => {
    expect(formatPermissions(0o755)).toBe("rwxr-xr-x");
    expect(formatPermissions(0o640)).toBe("rw-r-----");
    expect(formatPermissions(0o4755)).toBe("rwsr-xr-x");
    expect(formatPermissions(0o1777)).toBe("rwxrwxrwt");
    expect(formatPermissions(0o2644)).toBe("rw-r-Sr--");
    expect(formatPermissions(null)).toBe("");
  });

  it("parses and prints octal modes", () => {
    expect(parseOctal("644")).toBe(0o644);
    expect(parseOctal(" 0755 ")).toBe(0o755);
    expect(parseOctal("4755")).toBe(0o4755);
    expect(parseOctal("888")).toBeNull();
    expect(parseOctal("75")).toBeNull();
    expect(formatOctal(0o644)).toBe("644");
    expect(formatOctal(0o4755)).toBe("4755");
  });
});
