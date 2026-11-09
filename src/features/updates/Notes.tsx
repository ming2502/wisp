import type { ReactNode } from "react";
import { changelogBlocks, inlineSpans } from "./changelog";

function inline(text: string): ReactNode[] {
  return inlineSpans(text).map((span, i) =>
    span.kind === "code" ? (
      <code key={i} className="rounded bg-hover px-1 py-px font-mono text-[0.9em]">
        {span.text}
      </code>
    ) : span.kind === "strong" ? (
      <strong key={i} className="font-semibold">
        {span.text}
      </strong>
    ) : (
      span.text
    ),
  );
}

/** Release notes, a CHANGELOG section, as formatted text. */
export function Notes({ markdown, className = "" }: { markdown: string; className?: string }) {
  const blocks = changelogBlocks(markdown);
  const out: ReactNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.kind === "heading") {
      out.push(
        <h4 key={i} className="mt-3 text-xs font-semibold text-muted first:mt-0">
          {inline(block.text)}
        </h4>,
      );
    } else if (block.kind === "text") {
      out.push(
        <p key={i} className="mt-1.5 first:mt-0">
          {inline(block.text)}
        </p>,
      );
    } else {
      // Consecutive items make one list.
      const items: ReactNode[] = [];
      for (; i < blocks.length && blocks[i].kind === "item"; i++) {
        items.push(
          <li key={i} className="pl-0.5">
            {inline(blocks[i].text)}
          </li>,
        );
      }
      i--;
      out.push(
        <ul key={`list-${i}`} className="mt-1.5 list-disc space-y-1 pl-4 marker:text-muted first:mt-0">
          {items}
        </ul>,
      );
    }
  }
  return <div className={`text-[13px] leading-5 ${className}`}>{out}</div>;
}
