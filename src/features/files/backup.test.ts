import { describe, expect, it } from "vitest";
import { backupName, restoredName } from "./backup";

describe("backups", () => {
  it("dates the name with the local day", () => {
    expect(backupName("nginx.conf", new Date(2026, 10, 9, 23, 59))).toBe("nginx.conf.bak.261109");
    expect(backupName("a", new Date(2030, 0, 5))).toBe("a.bak.300105");
  });

  it("restores to the name before the date", () => {
    expect(restoredName("nginx.conf.bak.261109")).toBe("nginx.conf");
    expect(restoredName(backupName("a.bak.260101", new Date()))).toBe("a.bak.260101");
  });

  it("still restores backups named the earlier way", () => {
    expect(restoredName("nginx.conf.bak202601050907")).toBe("nginx.conf");
  });

  it("ignores names that are not backups", () => {
    for (const name of ["nginx.conf", "a.bak", "a.bak.2611", "a.bak.2611091", ".bak.261109", "a.bak.26110x", "a.bak261109"]) {
      expect(restoredName(name)).toBeNull();
    }
  });
});
