# wisp

轻量的 SSH/SFTP 桌面客户端，支持 macOS 和 Windows。基于 Tauri 2、Rust 和 React，以 Apache-2.0 许可证开源。

## 功能

- **终端**：xterm.js 渲染，支持中文和全屏程序（vim、htop 等）；大量输出时自动限流，界面不会卡死；支持搜索、多种配色和断线重连，重连后保留之前的终端内容。
- **认证**：密码、私钥（含口令）、SSH Agent、键盘交互（2FA）。首次连接需要确认主机指纹，指纹变化时会阻止连接；主机指纹与 OpenSSH 共用 `~/.ssh/known_hosts`。
- **连接管理**：主机分组与搜索；密码只存在系统钥匙串中。
- **文件管理**：SFTP 浏览、新建、重命名、修改权限、删除；拖放上传，上传和下载都支持文件夹。传输队列可以暂停、断点续传、重试；连接断开后，重连即可接着传。
- **远程编辑**：语法高亮；保留原文件的换行符、BOM 和权限；保存前检查服务器上的文件是否已被他人修改，并提供差异对比；默认以原子替换方式保存。

## 安装

从 [GitHub Releases](https://github.com/ming2502/wisp/releases) 下载：macOS 用 `.dmg`（Intel 与 Apple 芯片通用），Windows 用 `-setup.exe`。安装后，应用会自动检查更新。

目前安装包还没有代码签名，首次打开时系统会给出提示：

- **macOS**：在“访达”中右键点按应用，选择“打开”，再确认一次即可。之后正常打开就不会再提示。
- **Windows**：如果 SmartScreen 提示“已保护你的电脑”，点击“更多信息”→“仍要运行”。

## 快捷键

macOS 用 ⌘，Windows 用 Ctrl+Shift（单独的 Ctrl 组合键留给终端里的程序）。

| 操作 | macOS | Windows |
|---|---|---|
| 设置 | ⌘, | Ctrl+Shift+, |
| 关闭标签页 | ⌘W | Ctrl+Shift+W |
| 切换到第 N 个标签页 | ⌘1–9 | Ctrl+Shift+1–9 |
| 下一个/上一个标签页 | Ctrl+Tab / Ctrl+Shift+Tab | 同左 |
| 在终端中搜索 | ⌘F | Ctrl+Shift+F |
| 终端复制/粘贴 | ⌘C / ⌘V | Ctrl+Shift+C / Ctrl+Shift+V |
| 保存文件 | ⌘S | Ctrl+S |

## 数据存放位置

- 主机和分组：应用配置目录下的 `hosts.json`（macOS 为 `~/Library/Application Support/io.github.ming2502.wisp/`，Windows 为 `%APPDATA%\io.github.ming2502.wisp\`）
- 设置：应用配置目录下的 `settings.json`
- 密码和私钥口令：macOS 钥匙串或 Windows 凭据管理器，服务名 `io.github.ming2502.wisp`
- 主机密钥：`~/.ssh/known_hosts`，与 OpenSSH 共用

## 开发

需要 Rust stable、Node 24 以上和 pnpm。

```bash
pnpm install
```

```bash
pnpm tauri dev
```

测试（Rust 测试会在本机有 OpenSSH 时连接一个临时启动的真实 `sshd`）：

```bash
cargo test --workspace && pnpm test
```

在 macOS 本地打包 DMG 时，Finder 脚本可能超时。设置 `CI=true` 可跳过窗口布局这一步：

```bash
CI=true pnpm tauri build
```

### 结构

- `crates/core`：SSH、SFTP、传输、存储等核心逻辑，不依赖 Tauri，可独立测试
- `src-tauri`：Tauri 适配层（命令、权限、插件）
- `src`：React 前端

## 发布

发布由 `pnpm release` 脚本和 `.github/workflows/release.yml` 完成：脚本改好版本号和更新日志并推送标签，工作流构建 macOS（Universal）和 Windows 安装包、签名的更新包和更新清单 `latest.json`，全部成功后自动发布。发布后，已安装的用户就会收到这次更新，并在更新窗口里看到这个版本的更新内容。

### 首次配置（只需一次）

更新签名的公钥和更新地址已经写在 `src-tauri/tauri.conf.json` 的 `plugins.updater` 中，对应的私钥由维护者保管在 `~/.tauri/sshtool.key`。私钥和口令务必妥善备份：一旦丢失，已安装的用户将无法再收到更新。

1. 在 GitHub 仓库的 Settings → Secrets and variables → Actions 中添加：
   - `TAURI_SIGNING_PRIVATE_KEY`：`~/.tauri/sshtool.key` 文件的内容
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：生成密钥时设置的口令
2. （可选）macOS 签名与公证：添加 `APPLE_CERTIFICATE`（.p12 证书的 base64）、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_PASSWORD`（App 专用密码）、`APPLE_TEAM_ID`。不添加则发布未签名的版本。

如果缺少第 1 步的 Secret，发布工作流会报错并停止，不会发布一个无法更新的版本。

更换签名密钥时，用 `pnpm tauri signer generate -w <路径>` 生成新密钥，把新公钥填入 `plugins.updater.pubkey` 并更新上述 Secret。注意：已安装旧版本的用户只信任旧公钥，换钥后他们需要手动安装一次新版本。

### 每次发布

1. 平时把改动写进 [CHANGELOG.md](CHANGELOG.md) 的 `## [Unreleased]` 一节，随代码一起提交。这一节就是 GitHub Release 的说明和用户在应用里看到的更新内容，请写给用户看。
2. 在 main 分支上运行：

   ```bash
   pnpm release 0.4.0
   ```

   不带版本号时脚本会询问。它会依次：
   - 检查：在 main 分支、没有未提交的修改、不落后于远端、版本号比当前新、标签还不存在、`Unreleased` 一节不是空的。
   - 修改：`Cargo.toml` 与 `package.json` 的版本号，把 `## [Unreleased]` 改成 `## [0.4.0] - 今天的日期` 并在上面留一个新的空 `Unreleased`，更新 `Cargo.lock`。
   - 本地检查：类型检查、前端测试、Rust 格式、lint 和测试。任何一步失败都会还原所有修改。
   - 显示要改的文件和这个版本的更新说明，**确认后**提交 `Release v0.4.0`、打标签并推送。
3. 工作流开始构建，脚本最后给出进度和发布页面的链接。两个平台都成功后，工作流自动发布 Release；任何一步失败都会留下草稿、不发布，修好后删除标签和草稿重新来过。

选项：`--dry-run` 只显示会改什么；`--no-push` 只在本地提交和打标签；`--no-checks` 跳过本地检查；`--yes` 不再询问。版本号可以带预发布后缀（`0.4.0-beta.1`），发布为预发布版本，不推送给自动更新。

应用内的更新内容：发现新版本时，更新窗口列出新版本的改动（来自更新清单）；更新后首次打开，会显示一次「本次更新」（来自打包进应用的 `CHANGELOG.md`）。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
