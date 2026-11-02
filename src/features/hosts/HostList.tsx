import { useMemo, useState } from "react";
import { FileDown, FolderPlus, Pencil, Plus, Search, Server, Trash2 } from "lucide-react";
import type { Group, Host } from "../../ipc";
import { iconButton } from "../../ui/controls";

interface Props {
  hosts: Host[];
  groups: Group[];
  onConnect: (host: Host) => void;
  onNewHost: () => void;
  onEditHost: (host: Host) => void;
  onDeleteHost: (host: Host) => void;
  onNewGroup: () => void;
  onEditGroup: (group: Group) => void;
  onDeleteGroup: (group: Group) => void;
  onImport: () => void;
}

function matches(host: Host, query: string) {
  const text = `${host.name} ${host.user}@${host.host}:${host.port}`.toLowerCase();
  return text.includes(query.trim().toLowerCase());
}

function HostRow({ host, onConnect, onEdit, onDelete }: {
  host: Host;
  onConnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="group flex items-center rounded-md hover:bg-line/60">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
        title="连接"
        onClick={onConnect}
      >
        <Server size={14} className="shrink-0 text-muted" />
        <span className="min-w-0">
          <span className="block truncate text-sm">{host.name}</span>
          <span className="block truncate text-xs text-muted">
            {host.user}@{host.host}
            {host.port !== 22 && `:${host.port}`}
          </span>
        </span>
      </button>
      <span className="flex shrink-0 pr-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
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

export function HostList(props: Props) {
  const { hosts, groups, onConnect, onEditHost, onDeleteHost } = props;
  const [query, setQuery] = useState("");

  const sections = useMemo(() => {
    const visible = hosts.filter((host) => matches(host, query));
    const byName = (a: Host, b: Host) => a.name.localeCompare(b.name);
    const known = new Set(groups.map((group) => group.id));
    const ungrouped = visible.filter((host) => !host.groupId || !known.has(host.groupId)).sort(byName);
    return {
      ungrouped,
      grouped: groups.map((group) => ({
        group,
        hosts: visible.filter((host) => host.groupId === group.id).sort(byName),
      })),
    };
  }, [hosts, groups, query]);

  const row = (host: Host) => (
    <HostRow
      key={host.id}
      host={host}
      onConnect={() => onConnect(host)}
      onEdit={() => onEditHost(host)}
      onDelete={() => onDeleteHost(host)}
    />
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <h1 className="text-sm font-semibold">主机</h1>
        <span className="flex">
          <button type="button" aria-label="从 SSH 配置导入" title="从 SSH 配置导入" className={iconButton} onClick={props.onImport}>
            <FileDown size={15} />
          </button>
          <button type="button" aria-label="新建分组" title="新建分组" className={iconButton} onClick={props.onNewGroup}>
            <FolderPlus size={15} />
          </button>
          <button type="button" aria-label="新建主机" title="新建主机" className={iconButton} onClick={props.onNewHost}>
            <Plus size={15} />
          </button>
        </span>
      </div>
      <div className="px-3 pb-2">
        <label className="flex items-center gap-2 rounded-md border border-line bg-canvas px-2 py-1">
          <Search size={13} className="text-muted" />
          <input
            aria-label="搜索主机"
            className="w-full bg-transparent text-sm outline-none"
            placeholder="搜索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {hosts.length === 0 ? (
          <div className="px-2 pt-6 text-center text-sm text-muted">
            <p>还没有主机</p>
            <button type="button" className="mt-2 text-accent" onClick={props.onNewHost}>
              新建主机
            </button>
            <span> 或 </span>
            <button type="button" className="text-accent" onClick={props.onImport}>
              从 SSH 配置导入
            </button>
          </div>
        ) : (
          <>
            <ul>{sections.ungrouped.map(row)}</ul>
            {sections.grouped.map(({ group, hosts: members }) =>
              query && members.length === 0 ? null : (
                <section key={group.id} className="mt-3">
                  <div className="group flex items-center justify-between px-2 py-1">
                    <h2 className="truncate text-xs font-medium text-muted">{group.name}</h2>
                    <span className="flex opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                      <button type="button" aria-label={`重命名分组 ${group.name}`} className={iconButton} onClick={() => props.onEditGroup(group)}>
                        <Pencil size={12} />
                      </button>
                      <button type="button" aria-label={`删除分组 ${group.name}`} className={iconButton} onClick={() => props.onDeleteGroup(group)}>
                        <Trash2 size={12} />
                      </button>
                    </span>
                  </div>
                  {members.length === 0 ? (
                    <p className="px-2 text-xs text-muted">空分组</p>
                  ) : (
                    <ul>{members.map(row)}</ul>
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
