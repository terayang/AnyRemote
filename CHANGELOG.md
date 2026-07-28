# Changelog

本文件记录 AnyRemote 各版本的显著变更，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 简式与[语义化版本](https://semver.org/lang/zh-CN/)。

各版本完整的自动生成 release notes 见 [GitHub Releases](https://github.com/terayang/AnyRemote/releases)。

## [0.1.2] - 2026-07-28

### Changed

- 安装包产物统一为带版本号与平台的命名：`AnyRemote-<version>-mac-arm64.dmg` / `-mac-x64.dmg` / `-windows-x64-installer.exe` / `-windows-x64-portable.exe`

## [0.1.1] - 2026-07-28

### Added

- Windows NSIS 安装包与免安装便携版，由 CI macos runner 交叉构建（wails 内置 makensis）

## [0.1.0] - 2026-07-28

### Added

- 首个基于 Wails v2 的公开版本（自 Electron 迁移）：协议自动探测、VNC 远程桌面（含 macOS Screen Sharing Apple DH 认证）、SSH 终端、SFTP 文件管理、多标签会话、连接管理（系统钥匙串 / 本机加密凭据）、中英双语界面
- 打版本 tag 自动构建并发布 GitHub Release 的流水线（macOS + Windows）

[0.1.2]: https://github.com/terayang/AnyRemote/releases/tag/v0.1.2
[0.1.1]: https://github.com/terayang/AnyRemote/releases/tag/v0.1.1
[0.1.0]: https://github.com/terayang/AnyRemote/releases/tag/v0.1.0
