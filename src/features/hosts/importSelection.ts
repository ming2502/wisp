import type { Host, ImportCandidate } from "../../ipc";

export function isSameTarget(candidate: ImportCandidate, host: Host) {
  return (
    candidate.host.toLowerCase() === host.host.toLowerCase() &&
    candidate.port === host.port &&
    candidate.user === host.user
  );
}

/** Entries that already exist, or need a jump host that cannot be saved yet, start unchecked. */
export function defaultSelection(candidates: ImportCandidate[], hosts: Host[]) {
  return candidates.map(
    (candidate) => candidate.proxyJump === null && !hosts.some((host) => isSameTarget(candidate, host)),
  );
}
