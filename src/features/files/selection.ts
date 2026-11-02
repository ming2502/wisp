/** File list selection following desktop conventions: click, Cmd/Ctrl+click, Shift+click. */
export interface Selection {
  selected: Set<string>;
  /** Where a Shift range starts. */
  anchor: string | null;
  /** The entry last clicked or moved to, which arrow keys move from. */
  focus: string | null;
}

export const emptySelection: Selection = { selected: new Set(), anchor: null, focus: null };

export function select(
  current: Selection,
  order: string[],
  path: string,
  modifiers: { toggle: boolean; range: boolean },
): Selection {
  if (modifiers.range && current.anchor !== null) {
    const from = order.indexOf(current.anchor);
    const to = order.indexOf(path);
    if (from !== -1 && to !== -1) {
      const [start, end] = from < to ? [from, to] : [to, from];
      const range = order.slice(start, end + 1);
      const selected = modifiers.toggle ? new Set([...current.selected, ...range]) : new Set(range);
      return { selected, anchor: current.anchor, focus: path };
    }
  }
  if (modifiers.toggle) {
    const selected = new Set(current.selected);
    if (selected.has(path)) selected.delete(path);
    else selected.add(path);
    return { selected, anchor: path, focus: path };
  }
  return { selected: new Set([path]), anchor: path, focus: path };
}

/** Keeps only what still exists after a refresh. */
export function selectAll(order: string[]): Selection {
  return { selected: new Set(order), anchor: order[0] ?? null, focus: order[order.length - 1] ?? null };
}

/** Moves the focus by `step` entries, extending the selection from the anchor with Shift. */
export function moveFocus(current: Selection, order: string[], step: number, range: boolean): Selection {
  const from = current.focus ? order.indexOf(current.focus) : -1;
  const index = Math.max(0, Math.min(order.length - 1, from === -1 ? 0 : from + step));
  const target = order[index];
  if (target === undefined) return current;
  return select(current, order, target, { toggle: false, range });
}

export function prune(current: Selection, order: string[]): Selection {
  const present = new Set(order);
  const selected = new Set([...current.selected].filter((path) => present.has(path)));
  const keep = (path: string | null) => (path && present.has(path) ? path : null);
  return { selected, anchor: keep(current.anchor), focus: keep(current.focus) };
}
