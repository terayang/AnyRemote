# Electron → Wails 迁移报告（M6，2026-07-28）

本文档总结 AnyRemote 从 Electron 迁移到 Wails v2 的动机、架构变化、实测数据与已知限制。阶段性架构决策仍见 [ARCHITECTURE.md](ARCHITECTURE.md)（其早期章节记录的是 Electron 时代的选型，顶部有迁移说明）。

## 1. 迁移动机

Electron 版本功能完整，但代价明显：

- **体积**：arm64 dmg 133 MB，安装后 .app 360 MB —— 一个远程会话工具背着整个 Chromium + Node.js。
- **启动**：Chromium 冷/热启动都偏重（实测数据见 §5）。
- **资源占用**：主进程 Node + 每窗口 Chromium 渲染进程，常驻内存高。

Wails v2 用系统 WebView（macOS WKWebView / Windows WebView2）替代打包的 Chromium，后端换成 Go 单进程，前端代码几乎原样保留。

## 2. 架构对比

迁移前（Electron）：

```
┌───────────────────────────────────────┐
│ Chromium 渲染进程：React 18 + antd v5  │
├───────────────────────────────────────┤
│ preload：contextBridge 暴露            │
│         window.anyremote               │
├───────────────────────────────────────┤
│ Electron 主进程 (Node.js / TS)：       │
│   scanner · ssh2(SSH/SFTP) · rfb ·     │
│   vncBridge · store(safeStorage)       │
└───────────────────────────────────────┘
```

迁移后（Wails v2）：

```
┌───────────────────────────────────────┐
│ 系统 WebView：同一份 React 18 + antd   │
│   （macOS WKWebView / Win WebView2）   │
├───────────────────────────────────────┤
│ bridge：window.anyremote 适配层        │
│   → window.go.main.App.*（Wails 绑定） │
├───────────────────────────────────────┤
│ Go 进程（单进程）：                    │
│   internal/scanner · sshx · rfb ·      │
│   vncbridge · store(go-keyring)        │
│   前端产物经 go:embed 打进二进制        │
└───────────────────────────────────────┘
```

Go 服务层清单（`internal/`，`go test ./...` 共 **77** 个测试全绿）：

| 包 | 职责 | 主要依赖 |
|----|------|----------|
| `scanner` | 端口并发探测 + 协议指纹识别（SSH/VNC/RDP/HTTP 等） | 标准库 `net` |
| `sshx` | SSH shell 与 SFTP 会话管理 | `golang.org/x/crypto/ssh`、`pkg/sftp` |
| `rfb` | RFB 握手、security type 2（VNC 密码）/ type 30（Apple DH）认证 | 标准库 `crypto` |
| `vncbridge` | WS↔TCP 桥接，向 noVNC 呈现 None 安全类型 | `gorilla/websocket` |
| `store` | 连接书签持久化 + 系统钥匙串密钥保管 | `zalando/go-keyring` |

## 3. 前端复用策略

`frontend/src/` 的 React 组件、页面、zustand store、i18n **零改动**。唯一新增的是 `frontend/src/bridge/` 适配层：实现与 Electron preload 完全同形的 `window.anyremote` API——

- 请求/响应 → `window.go.main.App.*`（Wails 绑定的 Go 方法，`bindings.go`）；
- 流式事件 → `window.runtime.EventsOn`，沿用 Electron 时代的通道名（`ssh:data:<id>`、`ssh:close:<id>`、`sftp:progress:<id>`）；
- 纯 `vite dev`（无 Wails 运行时）时自动切换静态 mock，UI 仍可独立预览。

共享类型（`frontend/shared/`）同时被 TS 与 Go 结构体镜像，Wails 绑定跨桥不传任何变形数据。

## 4. 错误约定与密钥存储

- **错误约定**：Go 侧失败统一以 `[CODE] message` 前缀经 Wails 拒绝（reject）传给前端（见 `bindings.go` 的 `bindError`），前端 `ipcErrorCode()/ipcErrorMessage()` 解析逻辑不变。错误码：`sshx` 的 `AUTH_FAILED / TIMEOUT / UNREACHABLE / SESSION_NOT_FOUND / CONNECTION_LOST / REMOTE_ERROR`，`store` 的 `NOT_FOUND / ENCRYPTION_UNAVAILABLE`，`rfb` 的认证错误码同风格。
- **密钥存储变化**：Electron 时代用 safeStorage 加密后整体落盘 `connections.json`；Wails 版改为 `connections.json` 只存书签元数据（主机/端口/用户名等），**密钥（密码/私钥）单独写入系统钥匙串**（macOS Keychain / Windows Credential Manager / Linux Secret Service，经 `zalando/go-keyring`），任何形态下密钥都不落盘。保存时省略密钥 = 保留已有钥匙串项；显式置空 = 删除。钥匙串写入失败会整体中止保存（`ENCRYPTION_UNAVAILABLE`），绝不降级为明文。

## 5. 实测数据（开发机：MacBook Pro Apple Silicon，macOS 26.3，2026-07-28）

启动延迟（`scripts/measure-startup.sh`，口径与局限见脚本注释：进程 spawn → CGWindowList 出现首个 layer-0 窗口，1 次预热 + 3 次取中位；**不等于** UI 可交互时刻）：

| 版本 | 3 次实测 | 中位 |
|------|----------|------|
| Wails（universal） | 241 / 244 / 233 ms | **241 ms** |
| Electron（arm64 旧版） | 342 / 340 / 309 ms | **340 ms** |

体积：

| 产物 | Electron | Wails | 缩减 |
|------|----------|-------|------|
| macOS 安装包 | dmg(arm64) 133 MB | dmg(**universal**) 11 MB | ~92% |
| .app bundle | 360 MB (arm64) | 25 MB (universal，二进制 24 MB) | ~93% |
| Windows | exe 安装包 / portable 各 108 MB | NSIS 安装包 7.6 MB（裸 exe 14 MB） | ~93% |

注：Wails 的 mac 包是 universal（x86_64+arm64 单文件双架构），对比的 Electron dmg 仅 arm64，Wails 在覆盖更多架构的前提下仍小一个数量级。

## 6. 已删除的 Electron 遗物（M6 清理）

- `src/main/`（TS 旧主进程，14 个文件：scanner / sshService / sftpService / vncBridge / rfb×5 / store / ipc / localFs / index）
- `tests/`（vitest 旧测试，8 个文件）与 `scripts/smoke-*.mjs`（Playwright Electron 冒烟，6 个）
- `electron.vite.config.ts`、`electron-builder.yml`
- `build/icon.png` / `build/icon.icns`（Electron 时代图标；源图已转用为 `build/appicon.png`，见下）
- 根 `package.json` 的全部 npm 依赖（electron / electron-builder / electron-vite / vitest / playwright / ssh2 / ws 等，`npm install` 移除 463 个包；根包现仅保留 name/version/private/scripts，前端依赖全在 `frontend/package.json`）

图标复用：Electron 时代自建图标（深色圆角 + 终端意象，1024×1024）已覆盖 wails 默认的 `build/appicon.png`，重建后 app bundle 的 `iconfile.icns` 与 dmg 内图标均已更新（挂载验证，2026-07-28）。

## 7. 打包与 CI

- macOS：`npm run dist` = `wails build -platform darwin/universal -clean` + `scripts/build-dmg.sh`（hdiutil UDZO，含 Applications 链接）→ `dist/AnyRemote-<version>-mac-universal.dmg`。
- Windows：`npm run dist:win` = `wails build -platform windows/amd64 -nsis`。实测 wails v2.13 **在 macOS 上即可交叉产出** `AnyRemote-amd64-installer.exe`（内置 makensis，无需 Windows/无需 cgo），CI 的 windows runner 同样构建。
- CI（`.github/workflows/ci.yml`）：push 到 main + PR 触发，macos-latest 与 windows-latest 矩阵；步骤为 setup-go 1.26 → setup-node 22 → 安装 wails v2.13.0 → `npm --prefix frontend ci` → typecheck → go test → 各自打包 → 上传 artifacts `anyremote-wails-macos`（dmg）/ `anyremote-wails-windows`（NSIS exe）。产物未签名，安装指引见 [RELEASE.md](RELEASE.md)。

## 8. 已知限制

- **窗口级冒烟未自动化**：`wails dev` / 产物的完整 GUI 冒烟靠人工验证（旧 Playwright Electron 冒烟随删除退役，尚无 Wails 等价物）。
- **渲染差异**：WKWebView（macOS）/ WebView2（Windows）与 Chromium 存在细微渲染差异；noVNC/xterm.js 在两个系统 WebView 下均已人工验证可用，但 CSS 边角可能有出入。
- **macOS 钥匙串授权弹窗**：首次向钥匙串写入密钥时系统可能弹"AnyRemote 想要使用钥匙串"授权，属正常现象（UAT 时确认可点"始终允许"）。
- **包内版本号**：app bundle 的 `CFBundleShortVersionString` 为 wails 默认 `1.0.0`（`wails.json` 未配置 `info` 段）；dmg 文件名取根 `package.json` 的 `0.0.1`。后续可在 `wails.json` 配齐 `info.productVersion` 对齐。
- **启动指标口径**：§5 的启动时间是"首个窗口出现"，不含前端 JS 初始化与首帧绘制；Electron 版的体感差距（首屏白屏→可交互）比此数字更大，未量化。

## 9. 用户 UAT 指引（Windows）

1. 从 CI workflow run 页面底部下载 `anyremote-wails-windows` artifact（`AnyRemote-amd64-installer.exe`）。
2. 安装包未签名：SmartScreen 蓝色提示点「更多信息」→「仍要运行」；安装为当前用户级，可选目录，创建桌面快捷方式。
3. 首次启动后输入 Mac 的 Tailscale IP（如 `100.115.254.53`）扫描，应出现 SSH / VNC 卡片。
4. 建立 VNC 会话：输入 macOS 用户名 + 密码（Apple DH 认证），确认远程桌面可操作；macOS 侧弹出的 Screen Sharing 授权确认可点击。
5. 建立 SSH 终端与 SFTP 会话，验证回显、文件上传下载。
6. 保存连接并输密码：确认 Windows 凭据管理器出现 AnyRemote 条目；重启应用后免密重连成功。
