import { Command } from "cmdk";
import * as Dialog from "@radix-ui/react-dialog";
import { FileText, Server, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import type { Host } from "../../ipc";
import type { Tab } from "../../app/tabs";

export interface PaletteAction {
  id: string;
  label: string;
  icon: ReactNode;
  shortcut?: string;
  run: () => void;
}

interface Props {
  hosts: Host[];
  tabs: Tab[];
  actions: PaletteAction[];
  onConnect: (host: Host) => void;
  onSwitch: (key: string) => void;
  onClose: () => void;
}

const itemClass =
  "flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-sm data-[selected=true]:bg-accent/15";

export function CommandPalette({ hosts, tabs, actions, onConnect, onSwitch, onClose }: Props) {
  const run = (action: () => void) => {
    onClose();
    action();
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/20" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[15vh] z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-canvas shadow-2xl"
        >
          <Dialog.Title className="sr-only">命令面板</Dialog.Title>
          <Command label="命令面板" loop>
            <Command.Input
              autoFocus
              placeholder="搜索主机、标签页或操作…"
              className="w-full border-b border-line bg-transparent px-4 py-3 text-sm outline-none"
            />
            <Command.List className="max-h-80 overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted">没有匹配的结果</Command.Empty>
              {tabs.length > 0 && (
                <Command.Group heading="标签页" className="text-xs text-muted [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1">
                  {tabs.map((tab) => (
                    <Command.Item
                      key={tab.key}
                      value={`tab ${tab.key} ${tab.title} ${tab.kind === "editor" ? tab.path : ""}`}
                      className={itemClass}
                      onSelect={() => run(() => onSwitch(tab.key))}
                    >
                      {tab.kind === "editor" ? <FileText size={15} /> : <SquareTerminal size={15} />}
                      <span className="truncate text-ink">{tab.title}</span>
                      {tab.kind === "editor" && <span className="truncate text-xs text-muted">{tab.path}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {hosts.length > 0 && (
                <Command.Group heading="连接到" className="text-xs text-muted [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1">
                  {hosts.map((host) => (
                    <Command.Item
                      key={host.id}
                      value={`host ${host.id} ${host.name} ${host.user}@${host.host}`}
                      className={itemClass}
                      onSelect={() => run(() => onConnect(host))}
                    >
                      <Server size={15} />
                      <span className="truncate text-ink">{host.name}</span>
                      <span className="truncate text-xs text-muted">
                        {host.user}@{host.host}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="操作" className="text-xs text-muted [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1">
                {actions.map((action) => (
                  <Command.Item
                    key={action.id}
                    value={`action ${action.id} ${action.label}`}
                    className={itemClass}
                    onSelect={() => run(action.run)}
                  >
                    {action.icon}
                    <span className="flex-1 text-ink">{action.label}</span>
                    {action.shortcut && <kbd className="text-xs text-muted">{action.shortcut}</kbd>}
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
