import { describe, expect, it } from "vitest";
import type { Host, ImportCandidate } from "../../ipc";
import { defaultSelection } from "./importSelection";

const candidate = (overrides: Partial<ImportCandidate>): ImportCandidate => ({
  name: "a",
  host: "a.example",
  port: 22,
  user: "root",
  auth: { kind: "password" },
  proxyJump: null,
  ...overrides,
});

const saved: Host = {
  id: "1",
  name: "existing",
  host: "A.example",
  port: 22,
  user: "root",
  groupId: null,
  auth: { kind: "agent" },
  savedSecret: false,
};

describe("defaultSelection", () => {
  it("unchecks existing targets and jump-host entries only", () => {
    const candidates = [
      candidate({}),
      candidate({ port: 2222 }),
      candidate({ user: "deploy" }),
      candidate({ host: "b.example", proxyJump: "bastion" }),
      candidate({ host: "c.example" }),
    ];
    expect(defaultSelection(candidates, [saved])).toEqual([false, true, true, false, true]);
  });
});
