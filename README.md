# sshtool

轻量的 SSH/SFTP 桌面客户端，支持 macOS 和 Windows。基于 Tauri 2、Rust 和 React。

## 开发

需要 Rust stable、Node 24 以上和 pnpm。

```bash
pnpm install
```

```bash
pnpm tauri dev
```

在 macOS 本地打包 DMG 时，Finder 脚本可能超时。设置 `CI=true` 可跳过窗口布局这一步：

```bash
CI=true pnpm tauri build
```

## 结构

- `crates/core`：SSH、SFTP 等核心逻辑，不依赖 Tauri
- `src-tauri`：Tauri 适配层
- `src`：React 前端
