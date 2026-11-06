import { describe, expect, it } from "vitest";
import type { Host } from "../../ipc";
import { isNoop, moveHost } from "./order";

const host = (id: string, groupId: string | null = null) => ({ id, groupId }) as Host;
const ids = (hosts: Host[]) => hosts.map((h) => `${h.id}${h.groupId ? `@${h.groupId}` : ""}`);

describe("moveHost", () => {
  const hosts = [host("a"), host("b"), host("c", "g"), host("d")];

  it("places a host before another", () => {
    expect(ids(moveHost(hosts, "d", { groupId: null, before: "a" }))).toEqual(["d", "a", "b", "c@g"]);
  });

  it("moves into a group, last", () => {
    expect(ids(moveHost(hosts, "a", { groupId: "g", before: null }))).toEqual(["b", "c@g", "d", "a@g"]);
  });

  it("leaves the list alone for unknown hosts", () => {
    expect(moveHost(hosts, "x", { groupId: null, before: null })).toBe(hosts);
  });
});

describe("isNoop", () => {
  const hosts = [host("a"), host("b"), host("c", "g")];

  it("spots drops that change nothing", () => {
    expect(isNoop(hosts, "a", { groupId: null, before: "b" })).toBe(true);
    expect(isNoop(hosts, "b", { groupId: null, before: null })).toBe(true);
    expect(isNoop(hosts, "c", { groupId: "g", before: null })).toBe(true);
  });

  it("sees real moves", () => {
    expect(isNoop(hosts, "b", { groupId: null, before: "a" })).toBe(false);
    expect(isNoop(hosts, "a", { groupId: null, before: null })).toBe(false);
    expect(isNoop(hosts, "c", { groupId: null, before: null })).toBe(false);
  });
});
