import { useEffect, useState } from "react";
import { coreVersion } from "../ipc";

export default function App() {
  const [status, setStatus] = useState("正在连接后端…");

  useEffect(() => {
    coreVersion()
      .then((version) => setStatus(`核心模块 v${version}`))
      .catch((error) => setStatus(`后端不可用：${error}`));
  }, []);

  return (
    <div className="flex h-screen">
      <aside className="w-64 shrink-0 border-r border-line bg-panel p-4">
        <h1 className="text-sm font-semibold">主机</h1>
      </aside>
      <main className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted">{status}</p>
      </main>
    </div>
  );
}
