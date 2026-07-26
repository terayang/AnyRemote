// Phase-2b smoke test: drives the built app through a REAL scan of the local
// machine, asserts SSH/VNC are detected with their real banners, then selects
// both and opens the credentials modal. Captures wip-scan.png / wip-creds.png
// into docs/design/screenshots/. Run `npm run build` first (the script checks).
//
// Exit code is 0 only when every assertion below holds.

// Keep the Playwright browser cache inside the project (node_modules), never
// in the global user cache. Set before playwright is (dynamically) imported,
// because static ESM imports are hoisted above module-body statements.
process.env.PLAYWRIGHT_BROWSERS_PATH = '0'

const { _electron: electron } = await import('playwright')

import { existsSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shotsDir = path.join(root, 'docs', 'design', 'screenshots')

// Local LAN address of this dev machine: SSH (22) and Screen Sharing (5900)
// are known to listen on it (see AGENTS.md "环境事实").
const TARGET = '192.168.50.43'

if (!existsSync(path.join(root, 'out', 'main', 'index.js'))) {
  console.error('out/main/index.js not found — run `npm run build` first.')
  process.exit(1)
}

await mkdir(shotsDir, { recursive: true })

const app = await electron.launch({ args: ['.'], cwd: root })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 })

  const shot = async (name) => {
    const file = path.join(shotsDir, name)
    await page.screenshot({ path: file })
    const { size } = await stat(file)
    console.log(`${name}  ${size} bytes`)
  }

  // Type the target and start a real scan.
  const input = page.locator('#target-address-input')
  await input.waitFor()
  await input.fill(TARGET)
  await page.getByRole('button', { name: '开始扫描' }).click()

  // Wait for the real report: cards render only after the scan resolves, and
  // SSH + VNC must come back "已检测到" (detected) on this machine.
  const sshCard = page.locator('[data-protocol="ssh"]')
  const vncCard = page.locator('[data-protocol="vnc"]')
  await sshCard.getByText('已检测到').waitFor({ timeout: 20000 })
  await vncCard.getByText('已检测到').waitFor({ timeout: 20000 })

  // Both cards must display the real server banners.
  const sshText = await sshCard.textContent()
  const vncText = await vncCard.textContent()
  const sshBanner = sshText?.match(/SSH-\d+\.\d+-[A-Za-z0-9_.-]*/)?.[0]
  const vncBanner = vncText?.match(/RFB \d{3}\.\d{3}/)?.[0]
  if (!sshBanner) throw new Error(`SSH banner missing in card text: ${sshText}`)
  if (!vncBanner) throw new Error(`VNC banner missing in card text: ${vncText}`)
  console.log(`ssh banner: ${sshBanner}`)
  console.log(`vnc banner: ${vncBanner}`)
  await shot('wip-scan.png')

  // Select SSH + VNC, then connect — the credentials modal must appear with
  // the contract DOM ids.
  await sshCard.locator('.ant-checkbox-wrapper').click()
  await vncCard.locator('.ant-checkbox-wrapper').click()
  await page.waitForTimeout(300) // let the checkbox transition finish
  // (antd auto-inserts a space into two-CJK-char buttons — "连 接" — so match
  // the footer button structurally instead of by accessible name.)
  await page.locator('.scan-footer button').click()

  await page.locator('#cred-username').waitFor()
  await page.locator('#cred-password').waitFor()
  await page.locator('#connect-submit').waitFor()
  await page.waitForTimeout(300) // let the modal open animation settle
  await shot('wip-creds.png')
} finally {
  await app.close()
}

console.log('smoke-scan OK')
