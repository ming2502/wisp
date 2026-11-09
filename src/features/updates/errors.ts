/** What failed: looking for an update, downloading it, or installing it. */
export type UpdateStep = "check" | "download" | "install";

const STEP: Record<UpdateStep, string> = {
  check: "检查更新失败",
  download: "下载更新失败",
  install: "安装更新失败",
};

/** Turns the updater's errors, which are English and technical, into something to act on. */
export function describeUpdateError(reason: unknown, step: UpdateStep): string {
  const text = String(reason);
  // The plugin reports "Download request failed with status: 504 Gateway Timeout".
  const status = /status(?: code)?:?\s*(\d{3})\b/i.exec(text)?.[1];
  let cause: string;
  if (status) {
    cause = `GitHub 返回 ${status}，多为网络或代理不稳定，稍后重试通常可以解决`;
  } else if (/timed? ?out|timeout/i.test(text)) {
    cause = "连接超时，请检查网络或代理后重试";
  } else if (/dns|resolve|connect|network|sending request|tls|certificate/i.test(text)) {
    cause = "无法连接到 GitHub，请检查网络或代理后重试";
  } else if (/signature/i.test(text)) {
    cause = "更新包签名校验失败，已停止安装";
  } else if (/permission|denied|read-only|EACCES/i.test(text)) {
    cause = "没有写入应用目录的权限，请从下载页手动安装";
  } else {
    cause = text.replace(/^Error:\s*/, "");
  }
  return `${STEP[step]}：${cause}`;
}
