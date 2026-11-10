import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DOMAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { FolderPlus, Pencil, Plus, Search, Server, Trash2 } from "lucide-react";
import type { Group, Host } from "../../ipc";
import { iconButton } from "../../ui/controls";
import { isNoop, type Drop } from "./order";

/** How far the pointer moves before a press on a host becomes a drag rather than a click. */
const DRAG_THRESHOLD = 4;
/** Dragging this close to the list's top or bottom edge scrolls it. */
const SCROLL_EDGE = 28;

interface Props {
  hosts: Host[];
  groups: Group[];
  /** Hosts with an open session, marked in the list. */
  connected: Set<string>;
  onConnect: (host: Host) => void;
  onNewHost: () => void;
  onEditHost: (host: Host) => void;
  onDeleteHost: (host: Host) => void;
  onNewGroup: () => void;
  onEditGroup: (group: Group) => void;
  onDeleteGroup: (group: Group) => void;
  onMoveHost: (host: Host, drop: Drop) => void;
}

function matches(host: Host, query: string) {
  const text = `${host.name} ${address(host)}`.toLowerCase();
  return text.includes(query.trim().toLowerCase());
}

function address(host: Host) {
  return `${host.user}@${host.host}${host.port !== 22 ? `:${host.port}` : ""}`;
}

type PressHandlers = Pick<
  DOMAttributes<HTMLButtonElement>,
  "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel"
>;

function HostRow({ host, connected, dragging, press, onConnect, onEdit, onDelete }: {
  host: Host;
  connected: boolean;
  /** This host is the one being dragged. */
  dragging: boolean;
  press: PressHandlers;
  onConnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      data-host-id={host.id}
      className={`group flex items-center rounded-md transition-colors duration-150 ${
        dragging ? "cursor-grabbing bg-hover opacity-60" : "hover:bg-hover"
      }`}
    >
      <button
        type="button"
        className={`flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left ${dragging ? "cursor-grabbing" : ""}`}
        data-tooltip={dragging ? undefined : `连接 ${address(host)}`}
        onClick={onConnect}
        {...press}
      >
        <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-raised text-muted">
          <Server size={14} />
          {connected && (
            <span aria-label="已连接" className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent ring-2 ring-panel" />
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium leading-5">{host.name}</span>
          {host.name !== address(host) && (
            <span className="block truncate font-mono text-[11px] leading-4 text-muted">{address(host)}</span>
          )}
        </span>
      </button>
      <span className="flex shrink-0 pr-1 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
        <button type="button" aria-label={`编辑 ${host.name}`} className={iconButton} onClick={onEdit}>
          <Pencil size={13} />
        </button>
        <button type="button" aria-label={`删除 ${host.name}`} className={iconButton} onClick={onDelete}>
          <Trash2 size={13} />
        </button>
      </span>
    </li>
  );
}

/** The section and spot under the pointer: the nearest section, before the first row below it. */
function dropAt(list: HTMLElement, y: number, dragged: string): Drop | null {
  let nearest: HTMLElement | null = null;
  let distance = Infinity;
  for (const section of list.querySelectorAll<HTMLElement>("[data-drop-group]")) {
    const box = section.getBoundingClientRect();
    const away = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
    if (away < distance) {
      nearest = section;
      distance = away;
    }
  }
  if (!nearest) return null;
  const rows = [...nearest.querySelectorAll<HTMLElement>("[data-host-id]")].filter(
    (row) => row.dataset.hostId !== dragged,
  );
  const below = rows.find((row) => {
    const box = row.getBoundingClientRect();
    return y < box.top + box.height / 2;
  });
  return { groupId: nearest.dataset.dropGroup || null, before: below?.dataset.hostId ?? null };
}

/** Where a dragged host will land. Zero height, so showing it never shifts the rows. */
function DropLine() {
  return (
    <li aria-hidden className="relative h-0">
      <span className="absolute inset-x-1 -top-px h-0.5 rounded-full bg-accent" />
    </li>
  );
}

export function HostList(props: Props) {
  const { hosts, groups, connected, onConnect, onEditHost, onDeleteHost, onMoveHost } = props;
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; drop: Drop | null } | null>(null);
  const press = useRef<{ id: string; y: number; dragging: boolean; drop: Drop | null } | null>(null);
  // The click that ends a drag must not also connect.
  const swallowClick = useRef(false);

  // Hosts keep the order they are saved in; a search shows the matches in that order.
  const sections = useMemo(() => {
    const visible = hosts.filter((host) => matches(host, query));
    const known = new Set(groups.map((group) => group.id));
    return {
      ungrouped: visible.filter((host) => !host.groupId || !known.has(host.groupId)),
      grouped: groups.map((group) => ({
        group,
        hosts: visible.filter((host) => host.groupId === group.id),
      })),
    };
  }, [hosts, groups, query]);

  const cancelDrag = () => {
    press.current = null;
    setDrag(null);
  };

  // Escape abandons a drag.
  useEffect(() => {
    if (!drag) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelDrag();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drag]);

  // Reordering by drag works on the full list only, since a filtered one hides where hosts go.
  const pressHandlers = (host: Host): PressHandlers =>
    query
      ? {}
      : {
          onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
            if (event.button !== 0) return;
            press.current = { id: host.id, y: event.clientY, dragging: false, drop: null };
            event.currentTarget.setPointerCapture(event.pointerId);
          },
          onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => {
            const current = press.current;
            if (!current || current.id !== host.id || !list.current) return;
            if (!current.dragging) {
              if (Math.abs(event.clientY - current.y) < DRAG_THRESHOLD) return;
              current.dragging = true;
            }
            const box = list.current.getBoundingClientRect();
            if (event.clientY < box.top + SCROLL_EDGE) list.current.scrollTop -= 8;
            else if (event.clientY > box.bottom - SCROLL_EDGE) list.current.scrollTop += 8;
            const drop = dropAt(list.current, event.clientY, host.id);
            current.drop = drop && !isNoop(hosts, host.id, drop) ? drop : null;
            setDrag({ id: host.id, drop: current.drop });
          },
          onPointerUp: () => {
            const current = press.current;
            if (current?.dragging) {
              swallowClick.current = true;
              setTimeout(() => (swallowClick.current = false));
              if (current.drop) onMoveHost(host, current.drop);
            }
            cancelDrag();
          },
          onPointerCancel: cancelDrag,
        };

  const rows = (members: Host[], groupId: string | null) => {
    const out: ReactNode[] = [];
    const drop = drag?.drop && drag.drop.groupId === groupId ? drag.drop : null;
    for (const host of members) {
      if (drop?.before === host.id) out.push(<DropLine key="drop" />);
      out.push(
        <HostRow
          key={host.id}
          host={host}
          connected={connected.has(host.id)}
          dragging={drag?.id === host.id}
          press={pressHandlers(host)}
          onConnect={() => {
            if (!swallowClick.current) onConnect(host);
          }}
          onEdit={() => onEditHost(host)}
          onDelete={() => onDeleteHost(host)}
        />,
      );
    }
    if (drop && drop.before === null) out.push(<DropLine key="drop" />);
    return out;
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex select-none items-center justify-between px-3 pb-1.5 pt-1">
        <h1 className="text-[11px] font-semibold uppercase tracking-wider text-muted">主机</h1>
        <span className="flex">
          <button type="button" aria-label="新建分组" data-tooltip="新建分组" className={iconButton} onClick={props.onNewGroup}>
            <FolderPlus size={15} />
          </button>
          <button type="button" aria-label="新建主机" data-tooltip="新建主机" className={iconButton} onClick={props.onNewHost}>
            <Plus size={15} />
          </button>
        </span>
      </div>
      <div className="px-3 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-md border border-line-strong bg-canvas px-2.5 transition-colors duration-150 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
          <Search size={14} className="shrink-0 text-muted" />
          <input
            aria-label="搜索主机"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted"
            placeholder="搜索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      {/* Not selectable, so a double click on blank space does not highlight the host names. */}
      <div ref={list} className="min-h-0 flex-1 select-none overflow-y-auto px-2 pb-3">
        {hosts.length === 0 ? (
          <div className="mx-1 mt-2 rounded-lg border border-dashed border-line-strong px-3 py-6 text-center text-sm text-muted">
            <Server size={20} className="mx-auto mb-2 text-muted" strokeWidth={1.5} />
            <p className="text-ink">还没有主机</p>
            <button type="button" className="mt-2 text-accent hover:underline" onClick={props.onNewHost}>
              新建主机
            </button>
          </div>
        ) : (
          <>
            {/* While dragging, an empty ungrouped list still takes room so a host can be dropped there. */}
            <ul data-drop-group="" className={drag && sections.ungrouped.length === 0 ? "min-h-8" : ""}>
              {rows(sections.ungrouped, null)}
            </ul>
            {sections.grouped.map(({ group, hosts: members }) =>
              query && members.length === 0 ? null : (
                <section key={group.id} data-drop-group={group.id} className="mt-4">
                  <div className="group flex items-center justify-between px-2 py-1">
                    <h2 className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted">{group.name}</h2>
                    <span className="flex opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                      <button type="button" aria-label={`重命名分组 ${group.name}`} className={iconButton} onClick={() => props.onEditGroup(group)}>
                        <Pencil size={12} />
                      </button>
                      <button type="button" aria-label={`删除分组 ${group.name}`} className={iconButton} onClick={() => props.onDeleteGroup(group)}>
                        <Trash2 size={12} />
                      </button>
                    </span>
                  </div>
                  {members.length === 0 && drag?.drop?.groupId !== group.id ? (
                    <p className="px-2 text-xs text-muted">空分组</p>
                  ) : (
                    <ul>{rows(members, group.id)}</ul>
                  )}
                </section>
              ),
            )}
          </>
        )}
      </div>
    </div>
  );
}
