import { describe, expect, it } from "vitest";
import { changelogBlocks, changelogSection, inlineSpans } from "./changelog";

const text = `# 更新日志

## [Unreleased]

## [0.4.0] - 2026-11-09

### 新增

- 一项
  接着上一行
- 第二项

## [0.3.3] - 2026-11-06

- 旧的
`;

describe("changelog", () => {
  it("finds a version's section", () => {
    expect(changelogSection("0.4.0", text)).toBe("### 新增\n\n- 一项\n  接着上一行\n- 第二项");
    expect(changelogSection("0.3.3", text)).toBe("- 旧的");
    expect(changelogSection("Unreleased", text)).toBeNull();
    expect(changelogSection("9.9.9", text)).toBeNull();
  });

  it("splits headings, items and wrapped lines", () => {
    expect(changelogBlocks(changelogSection("0.4.0", text)!)).toEqual([
      { kind: "heading", text: "新增" },
      { kind: "item", text: "一项 接着上一行" },
      { kind: "item", text: "第二项" },
    ]);
  });

  it("keeps code and bold, and drops link targets", () => {
    expect(inlineSpans("改名为 `a.bak.261109`，**注意** [说明](https://x)")).toEqual([
      { kind: "text", text: "改名为 " },
      { kind: "code", text: "a.bak.261109" },
      { kind: "text", text: "，" },
      { kind: "strong", text: "注意" },
      { kind: "text", text: " 说明" },
    ]);
  });

  it("has a section for every released version in the bundled file", () => {
    for (const version of ["0.3.3", "0.3.2", "0.3.1", "0.3.0", "0.2.0", "0.1.0"]) {
      expect(changelogSection(version), version).not.toBeNull();
    }
  });
});
