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
}

export function Modal({ title, open, onClose, children, width = "max-w-md", modal = false }: Props) {
  const block = (event: Event) => {
    if (modal) event.preventDefault();
  };
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          aria-describedby={undefined}
          onEscapeKeyDown={block}
          onPointerDownOutside={block}
          className={`fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100vw-2rem)] ${width} -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-line bg-canvas p-5 shadow-xl`}
        >
          <Dialog.Title className="mb-4 text-base font-semibold">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
