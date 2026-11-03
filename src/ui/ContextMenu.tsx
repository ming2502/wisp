import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}

interface Props {
  /** Where the pointer was, in viewport coordinates. */
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

const EDGE = 8;

/** A menu at the pointer that closes on a choice, Escape, or any press, scroll or resize elsewhere. */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // Keeps the menu inside the window when opened near its right or bottom edge.
  useLayoutEffect(() => {
    const box = menu.current!.getBoundingClientRect();
    setPosition({
      left: Math.max(EDGE, Math.min(x, window.innerWidth - box.width - EDGE)),
      top: Math.max(EDGE, Math.min(y, window.innerHeight - box.height - EDGE)),
    });
    menu.current!.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);

  useEffect(() => {
    const closeOutside = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    buttons[(current + step + buttons.length) % buttons.length]?.focus();
  }

  return createPortal(
    <div
      ref={menu}
      role="menu"
      className="fixed z-50 min-w-40 select-none rounded-lg border border-line-strong bg-raised p-1 text-[13px] shadow-overlay"
      style={position}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors duration-150 hover:bg-hover focus-visible:bg-hover disabled:pointer-events-none disabled:opacity-40 [&>svg]:text-muted"
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
