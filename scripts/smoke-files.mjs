// Stage-4b smoke evidence: drives the built app through scan -> select SSH ->
// connect with wrong credentials -> open the file manager tab, and waits for
// the AUTH_FAILED error placeholder before capturing wip-files.png.
// Run `npm run build` first (the script checks). Exit code 0 on success.

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

const TIMEOUT_MS = 30000

if (!existsSync(path.join(root, 'out', 'main', 'index.js'))) {
  console.error('out/main/index.js not found — run `npm run build` first.')
  process.exit(1)
}

await mkdir(shotsDir, { recursive: true })

const app = await electron.launch({ args: ['.'], cwd: root })
let ok = false
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(TIMEOUT_MS)
  await page.setViewportSize({ width: 1280, height: 800 })

  // Scan the LAN address of this machine (SSH is known to be listening).
  await page.locator('#target-address-input').fill('192.168.50.43')
  await page.getByRole('button', { name: /开始扫描/ }).click()

  // Wait for the real scan to report SSH open, then select it.
  const sshCard = page.locator('[data-protocol="ssh"]')
  await sshCard.waitFor()
  const sshCheckbox = sshCard.locator('.ant-checkbox-wrapper')
  await sshCheckbox.waitFor()
  const cls = (await sshCheckbox.getAttribute('class')) ?? ''
  if (cls.includes('disabled')) {
    throw new Error('SSH checkbox is disabled — 192.168.50.43 did not report ssh open')
  }
  await sshCheckbox.click()

  // Connect; the credentials dialog uses the fixed contract ids.
  const connectBtn = page.locator('.scan-footer button.ant-btn-primary')
  if ((await connectBtn.count()) > 0) {
    await connectBtn.first().click()
  } else {
    await page.getByRole('button', { name: /连\s*接/ }).last().click()
  }
  await page.locator('#cred-username').fill('nobody')
  await page.locator('#cred-password').fill('wrongpass')
  await page.locator('#connect-submit').click()

  // Switch to the file manager tab (mounting the panel triggers its own SSH
  // connect, which must fail with AUTH_FAILED).
  await page.getByRole('tab', { name: '文件管理' }).click()
  await page.locator('.files-error').waitFor()
  await page.getByText('认证失败，请检查用户名或密码').waitFor()

  const file = path.join(shotsDir, 'wip-files.png')
  await page.screenshot({ path: file })
  const { size } = await stat(file)
  console.log(`wip-files.png  ${size} bytes`)
  ok = true
} finally {
  await app.close()
}

if (!ok) process.exit(1)
console.log('smoke-files: PASS')
