import { describe, expect, it } from "vitest";
import type { TransferInfo } from "../../ipc";
import { createSpeedTracker } from "./speed";

const running = (id: number, transferred: number): TransferInfo => ({
  id,
  owner: 1,
  direction: "upload",
  name: "f",
  local: "/f",
  remote: "/f",
  size: 1e9,
  transferred,
  state: { kind: "running" },
});

describe("createSpeedTracker", () => {
  it("averages over recent samples and forgets stopped transfers", () => {
    const track = createSpeedTracker();
    expect(track([running(1, 0)], 0).get(1)).toBeUndefined();
    expect(track([running(1, 1000)], 1000).get(1)).toBe(1000);
    expect(track([running(1, 5000)], 2000).get(1)).toBe(2500);
    // Samples older than the window drop out.
    expect(track([running(1, 9000)], 5000).get(1)).toBeCloseTo((9000 - 5000) / 3);
    expect(track([], 6000).size).toBe(0);
    expect(track([running(1, 9000)], 7000).get(1)).toBeUndefined();
  });
});
