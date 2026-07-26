// Stage-5b smoke: drives the built app through the real VNC auth-failure
// path — scan the LAN host, select VNC, submit wrong credentials, and wait
// for the desktop panel to show the classified AUTH_FAILED error state. This
// exercises the full chain: UI -> IPC -> vncBridge -> real Apple DH against
// this machine's Screen Sharing (5900) -> WS close code 4001 -> UI mapping.
// Run `npm run build` first (the script checks).

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

const TARGET = '192.168.50.43'
const WAIT = 30_000

if (!existsSync(path.join(root, 'out', 'main', 'index.js'))) {
  console.error('out/main/index.js not found — run `npm run build` first.')
  process.exit(1)
}

await mkdir(shotsDir, { recursive: true })

const app = await electron.launch({ args: ['.'], cwd: root })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 })
  page.on('pageerror', (err) => console.error(`[renderer] ${err.message}`))

  const step = (msg) => console.log(`• ${msg}`)

  // 1 — scan the LAN target (this machine's Screen Sharing listens on 5900).
  await page.locator('#target-address-input').fill(TARGET)
  await page.getByRole('button', { name: '开始扫描' }).click()
  await page.locator('[data-protocol="vnc"]').waitFor({ timeout: WAIT })
  step(`scanned ${TARGET}`)

  // 2 — select VNC and connect.
  await page.locator('[data-protocol="vnc"] .ant-checkbox-wrapper').click()
  await page.locator('.scan-footer button.ant-btn-primary').click()

  // 3 — submit deliberately wrong credentials in the connect modal.
  await page.locator('#cred-username').fill('nobody', { timeout: WAIT })
  await page.locator('#cred-password').fill('wrongpass')
  await page.locator('#connect-submit').click()
  step('submitted credentials nobody/wrongpass')

  // 4 — the remote desktop tab opens and must reach the AUTH_FAILED error
  // state (WS close code 4001 from the bridge, mapped in the renderer).
  await page.getByRole('tab', { name: '远程桌面' }).waitFor({ timeout: WAIT })
  const errorOverlay = page.locator('[data-testid="vnc-error"][data-error-kind="auth"]')
  await errorOverlay.waitFor({ timeout: WAIT })
  const text = (await errorOverlay.textContent()) ?? ''
  if (!text.includes('认证失败')) {
    throw new Error(`error overlay text mismatch: ${JSON.stringify(text)}`)
  }
  step('AUTH_FAILED error state reached: ' + text.trim())

  await page.waitForTimeout(300) // let the overlay finish rendering
  const file = path.join(shotsDir, 'wip-vnc.png')
  await page.screenshot({ path: file })
  const { size } = await stat(file)
  console.log(`wip-vnc.png  ${size} bytes`)
  console.log('SMOKE VNC PASS')
} catch (err) {
  console.error('SMOKE VNC FAIL:', err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  await app.close()
}
