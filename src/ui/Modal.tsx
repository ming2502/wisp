import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

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
}

export function Modal({
  title,
  open,
  onClose,
  children,
  width = "max-w-md",
  modal = false,
  onOpenAutoFocus,
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
          className={`fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100vw-2rem)] ${width} -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line-strong bg-raised p-5 shadow-overlay`}
        >
          <Dialog.Title className="mb-4 text-[15px] font-semibold tracking-tight">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
