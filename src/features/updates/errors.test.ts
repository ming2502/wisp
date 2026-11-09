import { describe, expect, it } from "vitest";
import { describeUpdateError } from "./errors";

describe("describeUpdateError", () => {
  it("explains failed downloads by their status", () => {
    expect(describeUpdateError("Download request failed with status: 504 Gateway Timeout", "download")).toBe(
      "下载更新失败：GitHub 返回 504，多为网络或代理不稳定，稍后重试通常可以解决",
    );
  });

  it("recognises network and signature problems", () => {
    expect(describeUpdateError("error sending request for url (https://github.com/...)", "check")).toMatch(
      /^检查更新失败：无法连接到 GitHub/,
    );
    expect(describeUpdateError("operation timed out", "download")).toMatch(/连接超时/);
    expect(describeUpdateError("signature verification failed", "install")).toMatch(/签名校验失败/);
  });

  it("passes anything else through", () => {
    expect(describeUpdateError(new Error("odd"), "install")).toBe("安装更新失败：odd");
  });
});
