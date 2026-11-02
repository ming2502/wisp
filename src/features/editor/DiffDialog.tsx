import { useEffect, useState } from "react";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { Modal } from "../../ui/Modal";
import { secondaryButton } from "../../ui/controls";
import { useSettings } from "../settings/SettingsContext";
import { themeFor } from "./codemirror";

interface Props {
  server: string;
  mine: string;
  onClose: () => void;
}

/** Shows the server's current version beside the unsaved edits, both read-only. */
export function DiffDialog({ server, mine, onClose }: Props) {
  const { dark } = useSettings();
  // The dialog mounts its content after this component renders, so the view is created once the
  // container is attached rather than in the first effect.
  const [host, setHost] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!host) return;
    const extensions = [
      basicSetup,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      themeFor(dark),
    ];
    const view = new MergeView({
      a: { doc: server, extensions },
      b: { doc: mine, extensions },
      parent: host,
      collapseUnchanged: { margin: 3, minSize: 6 },
    });
    return () => view.destroy();
  }, [host, server, mine, dark]);

  return (
    <Modal title="对比修改" open onClose={onClose} width="max-w-5xl">
      <div className="mb-2 grid grid-cols-2 text-xs text-muted">
        <span>服务器上的当前版本</span>
        <span>你的未保存修改</span>
      </div>
      <div ref={setHost} className="max-h-[60vh] overflow-auto rounded-md border border-line text-[13px]" />
      <div className="mt-4 flex justify-end">
        <button type="button" className={secondaryButton} onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
