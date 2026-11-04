import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { iconButton } from "./controls";

interface Props {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: string;
  /** Prevents closing by Escape or clicking outside, for steps that must be answered explicitly. */
  modal?: boolean;
  /** Replaces the default of focusing the first field, which selects all of its text. */
  onOpenAutoFocus?: (event: Event) => void;
  /** Shows a close button in the top-right corner. */
  closeButton?: boolean;
  /** Stays pinned to the bottom while the body scrolls. */
  footer?: ReactNode;
}

export function Modal({
  title,
  open,
  onClose,
  children,
  width = "max-w-md",
  modal = false,
  onOpenAutoFocus,
  closeButton = false,
  footer,
}: Props) {
  const block = (event: Event) => {
    if (modal) event.preventDefault();
  };
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/40 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={onOpenAutoFocus}
          onEscapeKeyDown={block}
          onPointerDownOutside={block}
          className={`fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] ${width} -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line-strong bg-raised shadow-overlay`}
        >
          <Dialog.Title className={`shrink-0 px-5 pb-4 pt-5 text-[15px] font-semibold tracking-tight ${closeButton ? "pr-12" : ""}`}>
            {title}
          </Dialog.Title>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
          {footer && <div className="shrink-0 border-t border-line px-5 py-3">{footer}</div>}
          {/* Last in the markup, so opening the dialog focuses its first control rather than this. */}
          {closeButton && (
            <Dialog.Close aria-label="关闭" className={`${iconButton} absolute right-3.5 top-4`}>
              <X size={15} />
            </Dialog.Close>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
