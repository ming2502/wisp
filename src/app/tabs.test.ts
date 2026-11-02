import { describe, expect, it } from "vitest";
import { editorKey, nextActive, openEditor, sessionKey, tabsClosedWith, type Tab } from "./tabs";

const session = (id: number): Tab => ({
  kind: "session",
  key: sessionKey(id),
  sessionId: id,
  title: `s${id}`,
  ended: false,
  view: "terminal",
});

describe("tabs", () => {
  it("opens editors after their session's tabs and reuses an open one", () => {
    let tabs = [session(1), session(2)];
    ({ tabs } = openEditor(tabs, 1, "/etc/hosts"));
    ({ tabs } = openEditor(tabs, 1, "/srv/app.conf"));
    const again = openEditor(tabs, 1, "/etc/hosts");
    expect(again.tabs).toBe(tabs);
    expect(again.key).toBe(editorKey(1, "/etc/hosts"));
    expect(tabs.map((tab) => tab.key)).toEqual(["s1", "e1:/etc/hosts", "e1:/srv/app.conf", "s2"]);
    expect(tabs[1].title).toBe("hosts");
  });

  it("closing a session closes its editors too, but not other sessions'", () => {
    let tabs = [session(1), session(2)];
    ({ tabs } = openEditor(tabs, 1, "/a"));
    ({ tabs } = openEditor(tabs, 2, "/b"));
    expect(tabsClosedWith(tabs, "s1").map((tab) => tab.key)).toEqual(["s1", "e1:/a"]);
    expect(tabsClosedWith(tabs, "e2:/b").map((tab) => tab.key)).toEqual(["e2:/b"]);
    expect(tabsClosedWith(tabs, "missing")).toEqual([]);
  });

  it("moves to the left neighbour, or keeps the active tab if it stays", () => {
    const tabs = [session(1), session(2), session(3)];
    expect(nextActive(tabs, [tabs[1]], "s2")).toBe("s1");
    expect(nextActive(tabs, [tabs[0]], "s1")).toBe("s2");
    expect(nextActive(tabs, [tabs[1]], "s3")).toBe("s3");
    expect(nextActive(tabs, tabs, "s1")).toBeNull();
  });
});
