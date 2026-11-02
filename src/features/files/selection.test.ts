import { describe, expect, it } from "vitest";
import { emptySelection, moveFocus, prune, select, selectAll } from "./selection";

const order = ["a", "b", "c", "d", "e"];
const plain = { toggle: false, range: false };

describe("select", () => {
  it("click selects one, toggle adds and removes", () => {
    let s = select(emptySelection, order, "b", plain);
    expect([...s.selected]).toEqual(["b"]);
    s = select(s, order, "d", { toggle: true, range: false });
    expect([...s.selected].sort()).toEqual(["b", "d"]);
    s = select(s, order, "b", { toggle: true, range: false });
    expect([...s.selected]).toEqual(["d"]);
  });

  it("shift selects a range from the anchor in either direction", () => {
    let s = select(emptySelection, order, "d", plain);
    s = select(s, order, "b", { toggle: false, range: true });
    expect([...s.selected]).toEqual(["b", "c", "d"]);
    s = select(s, order, "e", { toggle: false, range: true });
    expect([...s.selected]).toEqual(["d", "e"]);
  });

  it("shift with toggle extends the existing selection", () => {
    let s = select(emptySelection, order, "a", plain);
    s = select(s, order, "d", { toggle: true, range: false });
    s = select(s, order, "e", { toggle: true, range: true });
    expect([...s.selected].sort()).toEqual(["a", "d", "e"]);
  });

  it("arrow keys move from the focus, and Shift keeps extending from the anchor", () => {
    let s = select(emptySelection, order, "b", plain);
    s = moveFocus(s, order, 1, true);
    s = moveFocus(s, order, 1, true);
    expect([...s.selected]).toEqual(["b", "c", "d"]);
    s = moveFocus(s, order, -1, true);
    expect([...s.selected]).toEqual(["b", "c"]);
    s = moveFocus(s, order, 1, false);
    expect([...s.selected]).toEqual(["d"]);
    s = moveFocus(s, order, 10, false);
    expect([...s.selected]).toEqual(["e"]);
  });

  it("arrow keys start at the top when nothing is focused", () => {
    expect([...moveFocus(emptySelection, order, 1, false).selected]).toEqual(["a"]);
  });

  it("select all focuses the last entry", () => {
    const s = selectAll(order);
    expect(s.selected.size).toBe(5);
    expect(s.focus).toBe("e");
  });

  it("prune drops vanished entries", () => {
    const s = select(select(emptySelection, order, "a", plain), order, "c", { toggle: true, range: false });
    const pruned = prune(s, ["a", "b"]);
    expect([...pruned.selected]).toEqual(["a"]);
    expect(pruned.anchor).toBeNull();
  });
});
