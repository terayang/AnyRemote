# 打包与发布说明 / Packaging & Release Notes

[English](#packaging--release-notes) | [中文](#打包与发布说明-1)

---

## 打包与发布说明

### 产物

| 平台 | 产物 | 构建方式 |
|------|------|----------|
| macOS (Apple Silicon) | `AnyRemote-<version>-mac-arm64.dmg` | CI macos runner / 本机 `npm run dist` |
| macOS (Intel) | `AnyRemote-<version>-mac-x64.dmg` | CI macos runner / 本机 `npm run dist` |
| Windows (x64) | `AnyRemote-<version>-win-x64.exe`（NSIS 安装包） | CI windows runner（`npm run dist:win`） |
| Windows (x64) | `AnyRemote-<version>-win-portable-x64.exe`（免安装便携版） | CI windows runner（`npm run dist:win`） |

CI 每次构建（push 到 main 或 PR）都会把上述产物上传为 Actions artifacts：`anyremote-macos-arm64`、`anyremote-macos-x64`、`anyremote-windows-installer`（NSIS 安装包）与 `anyremote-windows-portable`（便携版 exe），在对应 workflow run 页面底部下载。

### 本地打包

```bash
npm install
npm run dist       # macOS：arm64 + x64 两个 dmg → dist/
npm run dist:win   # Windows 安装包（需在 Windows 上运行；macOS 上不交叉构建）
npm run dist:all   # 一次构建全部（在当前平台可行的目标）
```

打包配置在 `electron-builder.yml`（appId `com.anyremote.app`，asar 开启，publish 关闭）；图标在 `build/`（`icon.png` 1024x1024 源图，`icon.icns` 由 iconutil 生成；Windows 的 .ico 由 electron-builder 从 PNG 自动转换）。

macOS 本地快速验证单架构包：`npm run build && npx electron-builder --mac --arm64 --publish never`。

### 未签名安装包的安全提示（重要）

当前产物**未做代码签名与公证**（没有 Apple Developer ID / 代码签名证书）。这是开源项目的常见状态，应用本身功能不受影响，但首次安装/启动时系统会给出安全警告，需要手动确认一次：

#### macOS（Gatekeeper）

1. 打开 dmg，把 `AnyRemote.app` 拖入「应用程序」。
2. 首次启动**不要双击**（可能提示"已损坏"或"无法验证开发者"）。
3. 在「应用程序」中**右键（或 Control+点击）`AnyRemote.app` → 打开**。
4. 在弹出的对话框中再次点击**打开**。此后可正常双击启动。

如仍被拦截：系统设置 → 隐私与安全性 → 安全性一节会出现"仍要打开 AnyRemote"按钮，点击即可。
也可在终端执行一次性移除隔离属性：`xattr -dr com.apple.quarantine /Applications/AnyRemote.app`。

#### Windows（SmartScreen）

1. 运行 `AnyRemote-<version>-win-x64.exe`。
2. 出现蓝色「Windows 已保护你的电脑」提示时，点击**更多信息** → **仍要运行**。
3. 安装为当前用户安装（无需管理员权限），可选择安装目录，默认创建桌面快捷方式。

### 发布流程

本项目目前**不发布 GitHub Release**：electron-builder 的 publish 已关闭（`publish: null` + CLI `--publish never`），CI 只上传 artifacts。若将来接入正式发布，需在 CI 配置 `GH_TOKEN` 并将 publish 改为 `release`，同时建议引入代码签名（`CSC_LINK` / `CSC_KEY_PASSWORD` secrets + 公证）。

---

## Packaging & Release Notes

### Artifacts

| Platform | Artifact | Built by |
|----------|----------|----------|
| macOS (Apple Silicon) | `AnyRemote-<version>-mac-arm64.dmg` | CI macos runner / local `npm run dist` |
| macOS (Intel) | `AnyRemote-<version>-mac-x64.dmg` | CI macos runner / local `npm run dist` |
| Windows (x64) | `AnyRemote-<version>-win-x64.exe` (NSIS installer) | CI windows runner (`npm run dist:win`) |
| Windows (x64) | `AnyRemote-<version>-win-portable-x64.exe` (no-install portable) | CI windows runner (`npm run dist:win`) |

Every CI build (push to main or PR) uploads these as Actions artifacts: `anyremote-macos-arm64`, `anyremote-macos-x64`, `anyremote-windows-installer` (NSIS installer) and `anyremote-windows-portable` (portable exe). Download them at the bottom of the workflow run page.

### Local packaging

```bash
npm install
npm run dist       # macOS: arm64 + x64 dmgs → dist/
npm run dist:win   # Windows installer (must run on Windows; no cross-build from macOS)
npm run dist:all   # everything buildable on the current platform
```

Packaging config lives in `electron-builder.yml` (appId `com.anyremote.app`, asar on, publish off); icons live in `build/` (`icon.png` 1024x1024 source, `icon.icns` generated via iconutil; the Windows .ico is converted from the PNG automatically by electron-builder).

Quick single-arch local check on macOS: `npm run build && npx electron-builder --mac --arm64 --publish never`.

### Security warnings for unsigned installers (important)

Current artifacts are **not code-signed or notarized** (no Apple Developer ID / signing certificate). This is normal for open-source builds and does not affect functionality, but the OS will warn on first install/launch — confirm it manually once:

#### macOS (Gatekeeper)

1. Open the dmg and drag `AnyRemote.app` into Applications.
2. Do **not** double-click it the first time (it may report "damaged" or "unidentified developer").
3. In Applications, **right-click (or Control-click) `AnyRemote.app` → Open**.
4. Click **Open** again in the dialog. It launches normally from then on.

If still blocked: System Settings → Privacy & Security → an "Open Anyway" button for AnyRemote appears — click it.
Alternatively, remove the quarantine attribute once in Terminal: `xattr -dr com.apple.quarantine /Applications/AnyRemote.app`.

#### Windows (SmartScreen)

1. Run `AnyRemote-<version>-win-x64.exe`.
2. On the blue "Windows protected your PC" prompt, click **More info** → **Run anyway**.
3. The installer installs per-user (no admin rights), lets you pick the install directory, and creates a desktop shortcut by default.

### Release process

We currently **do not publish GitHub Releases**: electron-builder publishing is disabled (`publish: null` + CLI `--publish never`); CI only uploads artifacts. To enable real releases later, configure `GH_TOKEN` in CI, switch publish to `release`, and ideally add code signing (`CSC_LINK` / `CSC_KEY_PASSWORD` secrets + notarization).
