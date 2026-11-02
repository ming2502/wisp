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

## 快捷键

macOS 用 ⌘，Windows 用 Ctrl+Shift（单独的 Ctrl 组合键留给终端里的程序）。

| 操作 | macOS | Windows |
|---|---|---|
| 命令面板 | ⌘K | Ctrl+Shift+K |
| 设置 | ⌘, | Ctrl+Shift+, |
| 关闭标签页 | ⌘W | Ctrl+Shift+W |
| 切换到第 N 个标签页 | ⌘1–9 | Ctrl+Shift+1–9 |
| 下一个/上一个标签页 | Ctrl+Tab / Ctrl+Shift+Tab | 同左 |
| 在终端中搜索 | ⌘F | Ctrl+Shift+F |
| 终端复制/粘贴 | ⌘C / ⌘V | Ctrl+Shift+C / Ctrl+Shift+V |
| 保存文件 | ⌘S | Ctrl+S |

## 数据存放位置

- 主机和分组：应用配置目录下的 `hosts.json`（macOS 为 `~/Library/Application Support/com.sshtool.app/`，Windows 为 `%APPDATA%\com.sshtool.app\`）
- 密码和私钥口令：macOS 钥匙串或 Windows 凭据管理器，服务名 `com.sshtool.app`
- 主机密钥：`~/.ssh/known_hosts`，与 OpenSSH 共用
- 设置：应用配置目录下的 `settings.json`

## 结构

- `crates/core`：SSH、SFTP 等核心逻辑，不依赖 Tauri
- `src-tauri`：Tauri 适配层
- `src`：React 前端
