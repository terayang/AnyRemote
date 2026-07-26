// Stage-3b terminal smoke: drives the built app against the LAN target with
// deliberately wrong credentials and waits for the terminal panel's
// AUTH_FAILED overlay — proving the full loop UI -> IPC -> real sshd ->
// error classification -> UI. Run `npm run build` first (the script checks).

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
const USERNAME = 'nobody'
const PASSWORD = 'wrongpass'
const WAIT_MS = 30_000

if (!existsSync(path.join(root, 'out', 'main', 'index.js'))) {
  console.error('out/main/index.js not found — run `npm run build` first.')
  process.exit(1)
}

await mkdir(shotsDir, { recursive: true })

const app = await electron.launch({ args: ['.'], cwd: root })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(WAIT_MS)
  await page.setViewportSize({ width: 1280, height: 800 })

  // Scan the LAN target and select SSH.
  const input = page.locator('#target-address-input')
  await input.waitFor()
  await input.fill(TARGET)
  await page.getByRole('button', { name: '开始扫描' }).click()
  const sshCard = page.locator('[data-protocol="ssh"]')
  await sshCard.waitFor()
  await sshCard.locator('.ant-checkbox-wrapper').click()
  // antd inserts a space into two-CJK-char buttons, so the footer connect
  // button is matched structurally.
  await page.locator('.scan-footer button').click()

  // Credentials modal: a wrong password must surface as AUTH_FAILED.
  await page.locator('#cred-username').fill(USERNAME)
  await page.locator('#cred-password').fill(PASSWORD)
  await page.locator('#connect-submit').click()

  // The terminal tab shows the classified auth-failure overlay with retry.
  await page.getByRole('tab', { name: '终端' }).click()
  const overlay = page.locator('.terminal-overlay[data-terminal-status="error"]')
  await overlay.waitFor({ timeout: WAIT_MS })
  await overlay.getByText('认证失败，请检查用户名或密码').waitFor()
  // antd auto-inserts a space into two-CJK-char buttons ("重 试").
  await overlay.getByRole('button', { name: /重\s*试/ }).waitFor()

  const file = path.join(shotsDir, 'wip-terminal.png')
  await page.screenshot({ path: file })
  const { size } = await stat(file)
  console.log(`wip-terminal.png  ${size} bytes`)
} finally {
  await app.close()
}

console.log('terminal smoke OK')
