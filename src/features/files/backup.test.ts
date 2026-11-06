import { describe, expect, it } from "vitest";
import { backupName, restoredName } from "./backup";

describe("backups", () => {
  it("stamps the name with the local minute", () => {
    expect(backupName("nginx.conf", new Date(2026, 0, 5, 9, 7, 59))).toBe("nginx.conf.bak202601050907");
  });

  it("restores to the name before the stamp", () => {
    expect(restoredName("nginx.conf.bak202601050907")).toBe("nginx.conf");
    expect(restoredName(backupName("a.bak202601010000", new Date()))).toBe("a.bak202601010000");
  });

  it("ignores names that are not backups", () => {
    for (const name of ["nginx.conf", "a.bak", "a.bak2026", "a.bak2026010509071", ".bak202601050907", "a.bak20260105090x"]) {
      expect(restoredName(name)).toBeNull();
    }
  });
});
