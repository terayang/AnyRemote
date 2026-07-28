# AnyRemote

[![CI](https://github.com/terayang/AnyRemote/actions/workflows/ci.yml/badge.svg)](https://github.com/terayang/AnyRemote/actions/workflows/ci.yml)

[English](#english) | [中文](#中文)

---

## 中文

AnyRemote 是一个跨平台（macOS / Windows）桌面远程会话管理器：输入目标 IP，自动探测其可用的远程协议（SSH / VNC / RDP / Telnet / FTP / SMB / HTTP(S)），多选后一键建立远程桌面、SSH 终端与 SFTP 文件管理会话。体验对标 1Remote / Tabby / Termius。

### 截图

| 协议自动探测 | 远程桌面（VNC） |
|:-:|:-:|
| ![协议卡片](docs/design/screenshots/02-cards.png) | ![远程桌面](docs/design/screenshots/03-desktop.png) |

| SSH 终端 | SFTP 文件管理 |
|:-:|:-:|
| ![SSH 终端](docs/design/screenshots/04-terminal.png) | ![SFTP 文件管理](docs/design/screenshots/05-files.png) |

### 功能

- **协议自动探测**：对目标 IP 并发探测常见端口 + 协议指纹识别，以卡片形式展示，每张卡片附一句通俗说明，支持多选
- **VNC 远程桌面**：noVNC 渲染 + Go 侧智能桥接，支持 macOS Screen Sharing（Apple DH 认证）与标准 VNC 密码认证；缩放、光标、编码 / 色深 / 画质 / 压缩均可调
- **SSH 终端**：xterm.js + Go SSH/SFTP 会话管理，支持密码与私钥认证
- **SFTP 文件管理**：远程文件浏览、上传 / 下载、新建 / 删除 / 重命名
- **连接管理**：保存主机配置并可一键重连；密码 / 私钥默认存系统钥匙串（macOS Keychain / Windows Credential Manager），可在设置中改为本机加密文件（AES-256-GCM，密钥由机器硬件 UUID 派生）
- **多标签会话**：同一 / 不同目标的多协议会话以标签页并存；会话内可直接新建连接
- **国际化**：界面默认简体中文，内置英文（en-US）

> RDP / Telnet / FTP / SMB / HTTP(S) 当前仅探测展示，实际连接见 Roadmap。

### 下载与安装

从 [GitHub Releases](https://github.com/terayang/AnyRemote/releases) 下载最新版本：

- **macOS**（Apple Silicon + Intel 单包）：`AnyRemote-<version>-mac-universal.dmg`
- **Windows**：`AnyRemote-amd64-installer.exe`（NSIS 安装包，当前用户安装）或 `AnyRemote.exe`（免安装便携版）

开发版（每次 push 到 main 或 PR 的 CI 构建）在对应 [workflow run 页面](https://github.com/terayang/AnyRemote/actions/workflows/ci.yml)底部 artifacts 下载。

**安装包未做代码签名**，首次启动会被系统安全机制拦截，属正常现象：

- **macOS**：右键（Control+点击）`AnyRemote.app` →「打开」→ 再次确认「打开」
- **Windows**：SmartScreen 蓝色提示中点「更多信息」→「仍要运行」

详细指引见 [docs/RELEASE.md](docs/RELEASE.md)。

### 本地构建安装包

```bash
npm install && npm --prefix frontend install
npm run dist       # macOS：universal dmg → dist/
npm run dist:win   # Windows NSIS 安装包 + 便携版 exe（wails 交叉构建，macOS 上同样可跑）
```

### 开发

前置：Go 1.26、Node.js 22+、wails CLI v2.13（`go install github.com/wailsapp/wails/v2/cmd/wails@v2.13.0`，确保 `~/go/bin` 在 PATH）。

```bash
npm install && npm --prefix frontend install   # 安装依赖
npm run dev        # wails dev（HMR；纯前端预览可 npm --prefix frontend run dev，bridge 自动切 mock）
npm test           # Go 测试（go test ./...，93 个）
npm run typecheck  # go vet ./... + 前端 tsc --noEmit
npm run build      # wails build → build/bin/（同时重新生成 frontend/wailsjs/ 绑定）
```

### 技术架构

Wails v2（Go 后端 + 系统 WebView 渲染），2026-07 由 Electron 迁移而来（动机与实测数据见 [docs/MIGRATION.md](docs/MIGRATION.md)：dmg 133MB→11MB、启动 340ms→241ms）。Go 单进程承载全部网络与协议层——协议指纹扫描器（`internal/scanner`）、SSH/SFTP 会话（`internal/sshx`）、RFB 握手与 Apple DH 认证（`internal/rfb`）、WS↔TCP VNC 桥接（`internal/vncbridge`）、连接存储与凭据保管（`internal/store`，系统钥匙串或本地加密文件可选）；前端 React 18 + antd v5 + zustand + i18next 原样复用，经 `frontend/src/bridge/` 的 `window.anyremote` 适配层调用 Wails 绑定，远程桌面用 noVNC、终端用 xterm.js。完整选型理由与模块结构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，打包发布见 [docs/RELEASE.md](docs/RELEASE.md)。

### Roadmap

- RDP / Telnet / FTP 实际连接（当前仅探测展示）
- SMB / HTTP(S) 的深度集成
- 更多界面语言（当前简体中文 + 英文，i18n 框架可扩展）

### 目录结构

```
anyremote/
├─ main.go / app.go / bindings.go   # Wails 入口、应用门面、绑定与桥接错误约定
├─ internal/                        # Go 服务层
│  ├─ scanner/                      # 协议探测（端口扫描 + 指纹识别）
│  ├─ sshx/                         # SSH/SFTP 会话管理
│  ├─ rfb/                          # RFB 握手、security type 2/30 认证
│  ├─ vncbridge/                    # WS↔TCP VNC 桥接
│  └─ store/                        # 连接存储、系统钥匙串 / 本地加密凭据保管
├─ frontend/
│  ├─ src/                          # React UI（pages / components / store / i18n / bridge）
│  └─ shared/                       # 前后端共享类型与协议常量
├─ scripts/                         # build-dmg.sh / measure-startup.sh
├─ build/                           # appicon.png、darwin/windows 模板、构建输出（build/bin/，不入库）
├─ docs/                            # 架构、迁移、发布与设计文档
└─ .github/                         # CI（macOS + Windows 双平台矩阵 + 打包产物）
```

### License

[MIT](LICENSE) © 2026 Silica Yang

---

## English

AnyRemote is a cross-platform (macOS / Windows) desktop remote session manager: enter a target IP, auto-detect its available remote protocols (SSH / VNC / RDP / Telnet / FTP / SMB / HTTP(S)), pick several, and connect in one click — remote desktop, SSH terminal, and SFTP file management in a single app, on par with 1Remote / Tabby / Termius.

### Screenshots

| Protocol auto-detection | Remote desktop (VNC) |
|:-:|:-:|
| ![Protocol cards](docs/design/screenshots/02-cards.png) | ![Remote desktop](docs/design/screenshots/03-desktop.png) |

| SSH terminal | SFTP file manager |
|:-:|:-:|
| ![SSH terminal](docs/design/screenshots/04-terminal.png) | ![SFTP file manager](docs/design/screenshots/05-files.png) |

### Features

- **Protocol auto-detection**: concurrent probing of common ports with protocol fingerprinting, shown as selectable cards with plain-language descriptions
- **VNC remote desktop**: noVNC rendering + smart Go-side bridge; supports macOS Screen Sharing (Apple DH auth) and standard VNC password auth; adjustable scaling, cursor, encoding / color depth / quality / compression
- **SSH terminal**: xterm.js + Go SSH/SFTP session management, password and private-key authentication
- **SFTP file manager**: browse, upload / download, create / delete / rename remote files
- **Connection management**: saved hosts with one-click reconnect; passwords / private keys go to the OS keychain by default (macOS Keychain / Windows Credential Manager), or to a local encrypted file (AES-256-GCM, key derived from the machine hardware UUID) via Settings
- **Multi-tab sessions**: concurrent sessions of different protocols and targets in tabs; new connections without leaving the workspace
- **i18n**: Simplified Chinese by default, English (en-US) built in

> RDP / Telnet / FTP / SMB / HTTP(S) are detection-only for now; see the roadmap.

### Download & install

Grab the latest version from [GitHub Releases](https://github.com/terayang/AnyRemote/releases):

- **macOS** (Apple Silicon + Intel, single package): `AnyRemote-<version>-mac-universal.dmg`
- **Windows**: `AnyRemote-amd64-installer.exe` (NSIS installer, per-user) or `AnyRemote.exe` (no-install portable)

Development builds (CI on every push to main or PR) are available as artifacts at the bottom of the corresponding [workflow run page](https://github.com/terayang/AnyRemote/actions/workflows/ci.yml).

**The installers are not code-signed**, so the OS will warn on first launch — this is expected:

- **macOS**: right-click (Control-click) `AnyRemote.app` → **Open** → confirm **Open** again
- **Windows**: on the blue SmartScreen prompt, click **More info** → **Run anyway**

See [docs/RELEASE.md](docs/RELEASE.md) for details.

### Build installers locally

```bash
npm install && npm --prefix frontend install
npm run dist       # macOS: universal dmg → dist/
npm run dist:win   # Windows NSIS installer + portable exe (wails cross-build; also works on macOS)
```

### Development

Prerequisites: Go 1.26, Node.js 22+, wails CLI v2.13 (`go install github.com/wailsapp/wails/v2/cmd/wails@v2.13.0`, with `~/go/bin` on your PATH).

```bash
npm install && npm --prefix frontend install   # install dependencies
npm run dev        # wails dev (HMR; pure-frontend preview: npm --prefix frontend run dev, bridge falls back to mock)
npm test           # Go tests (go test ./..., 93 tests)
npm run typecheck  # go vet ./... + frontend tsc --noEmit
npm run build      # wails build → build/bin/ (regenerates frontend/wailsjs/ bindings)
```

### Architecture

Wails v2 (Go backend + system webview), migrated from Electron in 2026-07 (rationale and measurements: [docs/MIGRATION.md](docs/MIGRATION.md) — dmg 133MB→11MB, first window 340ms→241ms). A single Go process carries the entire network & protocol layer — a protocol fingerprint scanner (`internal/scanner`), SSH/SFTP sessions (`internal/sshx`), RFB handshake with Apple DH auth (`internal/rfb`), a WS↔TCP VNC bridge (`internal/vncbridge`), and connection storage with configurable secrets backend (`internal/store`, OS keychain or local encrypted file). The React 18 + antd v5 + zustand + i18next frontend is reused as-is and calls Wails bindings through the `window.anyremote` adapter in `frontend/src/bridge/`; noVNC renders the remote desktop and xterm.js the terminal. Full rationale and module layout: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); packaging & release: [docs/RELEASE.md](docs/RELEASE.md).

### Roadmap

- Actual RDP / Telnet / FTP connections (detection-only today)
- Deeper SMB / HTTP(S) integration
- More UI languages (Simplified Chinese + English today; the i18n framework is extensible)

### Project layout

```
anyremote/
├─ main.go / app.go / bindings.go   # Wails entry, app facade, bindings & error convention
├─ internal/                        # Go service layer
│  ├─ scanner/                      # Protocol probing (port scan + fingerprinting)
│  ├─ sshx/                         # SSH/SFTP session management
│  ├─ rfb/                          # RFB handshake, security type 2/30 auth
│  ├─ vncbridge/                    # WS↔TCP VNC bridge
│  └─ store/                        # Connection store, keychain / local-file secrets
├─ frontend/
│  ├─ src/                          # React UI (pages / components / store / i18n / bridge)
│  └─ shared/                       # Types & protocol constants shared with the Go side
├─ scripts/                         # build-dmg.sh / measure-startup.sh
├─ build/                           # appicon.png, darwin/windows templates, build output (build/bin/, not committed)
├─ docs/                            # Architecture, migration, release & design docs
└─ .github/                         # CI (macOS + Windows matrix + packaged artifacts)
```

### License

[MIT](LICENSE) © 2026 Silica Yang
