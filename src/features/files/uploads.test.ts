import { describe, expect, it } from "vitest";
import { landedIn } from "./uploads";

describe("landedIn", () => {
  it("sees files put straight into the directory", () => {
    expect(landedIn("/home/me", [{ id: 1, remote: "/home/me/a.txt" }])).toBe(true);
  });

  it("sees files of a folder uploaded into the directory", () => {
    expect(landedIn("/home/me", [{ id: 1, remote: "/home/me/site/css/app.css" }])).toBe(true);
  });

  it("handles the root directory", () => {
    expect(landedIn("/", [{ id: 1, remote: "/a.txt" }])).toBe(true);
  });

  it("ignores other directories, including ones that only share a prefix", () => {
    expect(landedIn("/home/me", [{ id: 1, remote: "/home/media/a.txt" }])).toBe(false);
    expect(landedIn("/home/me", [{ id: 1, remote: "/srv/a.txt" }])).toBe(false);
    expect(landedIn("/home/me", [])).toBe(false);
  });
});
