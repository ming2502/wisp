import type { Host } from "../../ipc";

/** Where a dragged host lands: a group (`null` for ungrouped), before a host or last. */
export interface Drop {
  groupId: string | null;
  before: string | null;
}

/** Moves a host the way the store does, so the list can show the result before it is saved. */
export function moveHost(hosts: Host[], id: string, { groupId, before }: Drop): Host[] {
  const moving = hosts.find((host) => host.id === id);
  if (!moving || before === id) return hosts;
  const rest = hosts.filter((host) => host.id !== id);
  const at = before === null ? -1 : rest.findIndex((host) => host.id === before);
  const index = at === -1 ? rest.length : at;
  return [...rest.slice(0, index), { ...moving, groupId }, ...rest.slice(index)];
}

/** Whether dropping there would leave the host where it already is. */
export function isNoop(hosts: Host[], id: string, { groupId, before }: Drop): boolean {
  const moving = hosts.find((host) => host.id === id);
  if (!moving || (moving.groupId ?? null) !== groupId) return false;
  const section = hosts.filter((host) => (host.groupId ?? null) === groupId);
  const next = section[section.indexOf(moving) + 1];
  return before === id || (next ? before === next.id : before === null);
}
