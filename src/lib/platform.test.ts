import { describe, expect, it } from "vitest";
import { isShortcut } from "./platform";

// The test environment has no DOM, so events are plain objects with the fields that are read.
const key = (init: Partial<KeyboardEvent>) =>
  ({ altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, ...init }) as KeyboardEvent;

describe("isShortcut", () => {
  it("uses Ctrl+Shift outside macOS, leaving plain Ctrl to the terminal", () => {
    // The test environment is not a Mac.
    expect(isShortcut(key({ code: "KeyK", ctrlKey: true, shiftKey: true }), "KeyK")).toBe(true);
    expect(isShortcut(key({ code: "KeyK", ctrlKey: true }), "KeyK")).toBe(false);
    expect(isShortcut(key({ code: "KeyK", ctrlKey: true, shiftKey: true, altKey: true }), "KeyK")).toBe(false);
    expect(isShortcut(key({ code: "KeyJ", ctrlKey: true, shiftKey: true }), "KeyK")).toBe(false);
  });
});
