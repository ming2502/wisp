import { Compartment, EditorState, type Extension, type Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";

export function themeFor(dark: boolean): Extension {
  return dark ? oneDark : [];
}

/** Loads syntax highlighting for the file name, if there is one for it. */
export async function languageFor(fileName: string): Promise<Extension> {
  const description = LanguageDescription.matchFilename(languages, fileName);
  if (!description) return [];
  try {
    return await description.load();
  } catch {
    return [];
  }
}

const baseTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px" },
  ".cm-scroller": {
    fontFamily: '"JetBrains Mono", Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace',
  },
});

interface Options {
  doc: string;
  dark: boolean;
  readOnly: boolean;
  theme: Compartment;
  language: Compartment;
  onSave: () => void;
  onChange: (doc: Text) => void;
}

export function editorState({ doc, dark, readOnly, theme, language, onSave, onChange }: Options) {
  return EditorState.create({
    doc,
    extensions: [
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            onSave();
            return true;
          },
        },
      ]),
      basicSetup,
      baseTheme,
      theme.of(themeFor(dark)),
      language.of([]),
      EditorState.readOnly.of(readOnly),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange(update.state.doc);
      }),
    ],
  });
}
