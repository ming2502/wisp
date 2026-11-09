// What changed in a version, from CHANGELOG.md. It is bundled at build time, so it works offline
// and always matches the running version. Updates bring their notes in the update manifest, which
// the release workflow fills from the same file.
import changelog from "../../../CHANGELOG.md?raw";

export type Block = { kind: "heading" | "item" | "text"; text: string };
export type Span = { kind: "text" | "code" | "strong"; text: string };

/** The section for `version`, without its own heading, or null when there is none. */
export function changelogSection(version: string, text: string = changelog): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  const body = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
  return body || null;
}

/** Just enough Markdown for a changelog: `###` headings, `-` items, and paragraphs. */
export function changelogBlocks(section: string): Block[] {
  const out: Block[] = [];
  for (const raw of section.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) out.push({ kind: "heading", text: line.replace(/^#+\s*/, "") });
    else if (/^[-*]\s/.test(line)) out.push({ kind: "item", text: line.slice(2).trim() });
    else if (out.length && out[out.length - 1].kind !== "heading" && /^\s{2,}/.test(raw)) {
      // A wrapped continuation of the item or paragraph above.
      out[out.length - 1].text += " " + line;
    } else out.push({ kind: "text", text: line });
  }
  return out;
}

/** Inline Markdown in a line: `code`, **bold**, and [links](url) reduced to their text. */
export function inlineSpans(text: string): Span[] {
  const out: Span[] = [];
  const push = (kind: Span["kind"], part: string) => {
    if (!part) return;
    const last = out[out.length - 1];
    if (last?.kind === kind && kind !== "code") last.text += part;
    else out.push({ kind, text: part });
  };
  text.split("`").forEach((part, i) => {
    if (i % 2) return push("code", part);
    const plain = part.replace(/\[([^\]]+)\]\([^)\s]*\)/g, "$1");
    plain.split(/\*\*(.+?)\*\*/).forEach((piece, j) => push(j % 2 ? "strong" : "text", piece));
  });
  return out;
}
