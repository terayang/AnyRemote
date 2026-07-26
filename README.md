# AnyRemote

[![CI](https://github.com/terayang/AnyRemote/actions/workflows/ci.yml/badge.svg)](https://github.com/terayang/AnyRemote/actions/workflows/ci.yml)

[English](#english) | [中文](#中文)

---

## 中文

AnyRemote 是一个跨平台（macOS / Windows）桌面远程会话管理器：输入目标 IP，自动探测其可用的远程协议（SSH / VNC / RDP / Telnet / FTP / SMB / HTTP(S)），多选后一键建立远程桌面、SSH 终端与 SFTP 文件管理会话。体验对标 1Remote / Tabby / Termius。

### 规划功能

- **协议自动探测**：对目标 IP 并发探测常见端口 + 协议指纹识别，以卡片形式展示，每张卡片附一句通俗说明，支持多选
- **VNC 远程桌面**：noVNC 渲染 + 主进程智能桥接，支持 macOS Screen Sharing（Apple DH 认证）与标准 VNC 密码认证
- **SSH 终端**：xterm.js + ssh2，支持密码与私钥认证
- **SFTP 文件管理**：远程文件浏览、上传 / 下载、新建 / 删除 / 重命名
- **连接管理**：保存主机配置，凭据经 Electron safeStorage（系统钥匙串 / DPAPI）加密存储
- **多标签会话**：同一 / 不同目标的多协议会话以标签页并存
- **国际化**：界面默认简体中文，预留英文等多语言

> RDP / Telnet / FTP / SMB / HTTP(S) 在 MVP 阶段仅探测展示，实际连接规划中。

### 技术栈

Electron + electron-vite + TypeScript (strict) + React 18 + antd v5 + zustand + i18next

### 开发

```bash
npm install        # 安装依赖
npm run dev        # 启动开发模式（electron-vite dev，HMR）
npm test           # 运行单元测试（vitest）
npm run typecheck  # TypeScript 类型检查（tsc --noEmit）
npm run build      # 构建产物到 out/（electron-vite build）
```

安装包打包（electron-builder → dmg / NSIS）将在后续阶段接入；Windows 安装包由 CI 的 windows runner 构建。

### 目录结构

```
anyremote/
├─ src/
│  ├─ main/        # Electron 主进程（网络与协议层）
│  ├─ preload/     # contextBridge 安全暴露 API
│  ├─ renderer/    # React UI（pages / components / store / i18n）
│  └─ shared/      # 主/渲染共享类型与协议常量（protocols.ts）
├─ tests/          # vitest 单元 / 集成测试
├─ docs/           # 架构与决策文档
└─ .github/        # CI（macOS + Windows 双平台矩阵）
```

### License

[MIT](LICENSE) © 2026 Silica Yang

---

## English

AnyRemote is a cross-platform (macOS / Windows) desktop remote session manager: enter a target IP, auto-detect its available remote protocols (SSH / VNC / RDP / Telnet / FTP / SMB / HTTP(S)), pick several, and connect in one click — remote desktop, SSH terminal, and SFTP file management in a single app, on par with 1Remote / Tabby / Termius.

### Planned features

- **Protocol auto-detection**: concurrent probing of common ports with protocol fingerprinting, shown as selectable cards with plain-language descriptions
- **VNC remote desktop**: noVNC rendering + smart main-process bridge; supports macOS Screen Sharing (Apple DH auth) and standard VNC password auth
- **SSH terminal**: xterm.js + ssh2, password and private-key authentication
- **SFTP file manager**: browse, upload / download, create / delete / rename remote files
- **Connection management**: saved host configurations with credentials encrypted via Electron safeStorage (Keychain / DPAPI)
- **Multi-tab sessions**: concurrent sessions of different protocols and targets in tabs
- **i18n**: Simplified Chinese by default, English and more languages reserved

> RDP / Telnet / FTP / SMB / HTTP(S) are detection-only in the MVP; actual connections are planned.

### Tech stack

Electron + electron-vite + TypeScript (strict) + React 18 + antd v5 + zustand + i18next

### Development

```bash
npm install        # install dependencies
npm run dev        # start dev mode (electron-vite dev, HMR)
npm test           # run unit tests (vitest)
npm run typecheck  # TypeScript type check (tsc --noEmit)
npm run build      # build to out/ (electron-vite build)
```

Installer packaging (electron-builder → dmg / NSIS) will be wired up in a later phase; the Windows installer is built by the CI windows runner.

### Project layout

```
anyremote/
├─ src/
│  ├─ main/        # Electron main process (network & protocol layer)
│  ├─ preload/     # contextBridge-safe API exposure
│  ├─ renderer/    # React UI (pages / components / store / i18n)
│  └─ shared/      # Types & protocol constants shared by main/renderer
├─ tests/          # vitest unit / integration tests
├─ docs/           # Architecture & decision documents
└─ .github/        # CI (macOS + Windows matrix)
```

### License

[MIT](LICENSE) © 2026 Silica Yang
