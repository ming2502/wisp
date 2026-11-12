import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "./settings";

describe("normalizeSettings", () => {
  it("returns defaults for nothing stored", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("garbage")).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid values and replaces invalid ones", () => {
    const settings = normalizeSettings({
      appearance: "dark",
      checkUpdates: false,
      followTerminal: 1,
      terminal: { fontSize: 99, scheme: "nope", cursorStyle: "bar", cursorBlink: "yes", scrollback: 5000.4 },
      unknown: true,
    });
    expect(settings).toEqual({
      appearance: "dark",
      checkUpdates: false,
      followTerminal: true,
      terminal: { fontSize: 24, scheme: "auto", cursorStyle: "bar", cursorBlink: true, scrollback: 5000 },
    });
  });
});
