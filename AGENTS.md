# AGENTS.md — AnyRemote 协作与工作规范

## 项目概述

AnyRemote：跨平台桌面远程会话管理器（对标 1Remote）。任务契约见 [MISSION.md](MISSION.md)，架构决策见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 环境事实（开发机实测，2026-07-26）

- macOS 26.3（silicamacbook-pro）；Node.js v25.9 / npm 11.12 / git 2.50；无 Go / Rust；sudo 需密码（不可用）。
- Tailscale 组网：本机 `100.115.254.53`；可用测试目标：`100.103.82.44`（Mac Studio）、`100.110.128.32`（Linux relay）。
- 内网：本机 `192.168.50.43`（SSH/VNC 已确认在该接口监听）；Windows UAT 机 `192.168.50.114`（未接入 Tailscale，经内网直连本机；其防火墙默认禁 ping，ping 不通不代表不可达）。
- Git：origin = `git@github.com:terayang/AnyRemote.git`；仓库本地提交身份 Silica Yang \<silicayang@gmail.com\>（repo-local，未动全局配置）；push 认证走项目专用 SSH key（`~/.ssh/id_ed25519_anyremote`，经 repo-local `core.sshCommand` 配置，不影响其他项目；对应 GitHub 账号 silicayang，需对仓库有写权限）。
- 本机服务：SSH(22) 开放；Screen Sharing(5900) 开放，RFB 003.889，仅提供 Apple 专有认证（security type 30/33/35/36）。
- 系统防火墙关闭。
- 目标平台：macOS（开发与自验）+ Windows（用户 UAT；Windows 包可经 `npm run dist:win` 在本机交叉构建，CI windows runner 亦构建）。

## 目录约定

- Wails 布局（M4 起）：Go 后端在根包（`main.go` / `app.go` / `bindings.go`）与 `internal/`（scanner / sshx / rfb / vncbridge，服务层）；React UI 在 `frontend/src/`，主/渲染共享类型在 `frontend/shared/`，`window.anyremote` 适配层在 `frontend/src/bridge/`；`frontend/wailsjs/` 为 `wails build` 生成的绑定（不入库）。
- Electron 遗留（M6 清理，勿新增依赖）：`src/main/`（TS 旧主进程，仅作参考）、`tests/`（vitest 旧测试）、`scripts/smoke-*.mjs`（Playwright Electron 冒烟）。
- `docs/` 文档；`build/` 应用图标与 wails 构建输出（`build/bin/`，不入库）；`_ref/` 第三方参考源码（仅供阅读，不入库，不修改）。

## 工作流约定

1. 以 MISSION.md 为任务契约；方向性变更先与用户确认。
2. 按 docs/ARCHITECTURE.md 的阶段计划推进；每个阶段完成后运行对应测试，全绿再进入下一阶段。
3. 全部验收标准通过后，向用户提交验收报告（含测试输出、验证证据、已知限制）。
4. **禁止**未经用户明确批准执行 `git commit` / `git push` 及任何改写历史的操作。
5. **禁止**在项目目录外安装 / 修改内容；确需全局工具时先询问。
6. 需要 sudo 的系统变更一律不自行执行，改为输出命令请用户运行。

## 代码规范

- TypeScript strict；代码注释、提交信息用英文；界面文案默认简体中文并走 i18n 字典（`frontend/src/i18n/`）。
- **优先采用成熟开源方案**（star 高、维护活跃）；任何自研模块须在验收报告中附调研结论与理由；禁止引入无人维护的依赖。
- 最小改动原则；新代码风格与周边文件保持一致。
- 凭据、密钥永不入库、不写入日志；加密存储随 Wails 迁移在 M5 落地（Electron 时代走 safeStorage）。
- 不留空壳实现（不用 `// TODO: implement` 式占位应付验收）。

## 文档维护

- 修改本文件所述约定、目录结构、命令时，必须同步更新本文件。
- 常用命令（Wails 版，M4 起）：
  - 安装：`npm install && npm --prefix frontend install`
  - 开发：`npm run dev`（wails dev；纯前端预览可 `npm --prefix frontend run dev`，bridge 自动切 mock）
  - 测试：`npm test`（go test ./...）；类型检查 `npm run typecheck`（go vet + frontend tsc）
  - 打包：`npm run build`（wails build → `build/bin/`；同时重新生成 `frontend/wailsjs/` 绑定）
  - 冒烟 / 安装包：Electron 时代的 smoke / dist 脚本已随迁移移除，M6 以 Wails 版重建
