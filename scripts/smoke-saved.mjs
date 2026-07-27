// Stage-6 smoke test for saved connections (F5): drives the built app through
// saving a connection (credentials encrypted via safeStorage), verifies the
// on-disk store never contains the plaintext secret, then deletes the entry
// through the UI. Captures wip-saved.png into docs/design/screenshots/.
// Run `npm run build` first (the script checks).
//
// Exit code is 0 only when every assertion below holds.

// Keep the Playwright browser cache inside the project (node_modules), never
// in the global user cache. Set before playwright is (dynamically) imported,
// because static ESM imports are hoisted above module-body statements.
process.env.PLAYWRIGHT_BROWSERS_PATH = '0'

const { _electron: electron } = await import('playwright')

import { existsSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shotsDir = path.join(root, 'docs', 'design', 'screenshots')

// Local LAN address of this dev machine: SSH (22) is known to listen on it
// (see AGENTS.md "环境事实").
const TARGET = '192.168.50.43'
// Deliberately wrong credentials: the connect attempt fails with AUTH_FAILED,
// but the save must already have succeeded (saving never blocks connecting).
const USERNAME = 'nobody'
const PASSWORD = 'wrongpass'
// Unique entry name so the test is robust against pre-existing saved entries.
const ENTRY_NAME = `smoke-saved-${Date.now()}`

if (!existsSync(path.join(root, 'out', 'main', 'index.js'))) {
  console.error('out/main/index.js not found — run `npm run build` first.')
  process.exit(1)
}

// The store file lives at app.getPath('userData'), which for the unpackaged
// app is <os userData dir>/<productName ?? name from package.json>.
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const userDataDir =
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', pkg.productName ?? pkg.name)
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), pkg.productName ?? pkg.name)
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), pkg.productName ?? pkg.name)
const storeFile = path.join(userDataDir, 'connections.json')

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

  const savedItems = page.locator('.saved-conn-item')

  // Wait until the saved-connections block has loaded its initial list.
  await page.waitForFunction(
    () => {
      const block = document.querySelector('.saved-connections')
      if (!block) return false
      return (
        block.querySelectorAll('.saved-conn-item').length > 0 ||
        (block.textContent ?? '').includes('暂无已保存连接')
      )
    },
    { timeout: 15000 }
  )
  const initialCount = await savedItems.count()
  console.log(`initial saved connections: ${initialCount}`)

  // Scan the local machine and select SSH only.
  const input = page.locator('#target-address-input')
  await input.fill(TARGET)
  await page.getByRole('button', { name: '开始扫描' }).click()
  const sshCard = page.locator('[data-protocol="ssh"]')
  await sshCard.getByText('已检测到').waitFor({ timeout: 20000 })
  await sshCard.locator('.ant-checkbox-wrapper').click()
  await page.waitForTimeout(300) // let the checkbox transition finish

  // Open the credentials modal, fill wrong credentials, tick "save this
  // connection", and give the entry its unique name.
  await page.locator('.scan-footer button').click()
  await page.locator('#cred-username').fill(USERNAME)
  await page.locator('#cred-password').fill(PASSWORD)
  await page.locator('#cred-save-connection').click()
  if (!(await page.locator('#cred-save-connection').isChecked())) {
    throw new Error('save-connection checkbox did not toggle on')
  }
  await page.locator('#cred-save-name').fill(ENTRY_NAME)
  await page.locator('#connect-submit').click()

  // The connect attempt fails (wrong password) but the session workspace
  // still opens; closing every tab returns to the scan page.
  await page.locator('.ant-tabs-tab').first().waitFor({ timeout: 15000 })
  while ((await page.locator('.ant-tabs-tab-remove').count()) > 0) {
    await page.locator('.ant-tabs-tab-remove').first().click()
    await page.waitForTimeout(250)
  }

  // The saved entry must now be listed on the scan page.
  const entry = page.locator('.saved-conn-item', { hasText: ENTRY_NAME })
  await entry.waitFor({ timeout: 10000 })
  const entryText = (await entry.textContent()) ?? ''
  if (!entryText.includes(TARGET) || !entryText.includes(USERNAME)) {
    throw new Error(`saved entry misses host/username: ${entryText}`)
  }
  if (!entryText.includes('SSH')) {
    throw new Error(`saved entry misses the SSH protocol tag: ${entryText}`)
  }
  await page.waitForTimeout(300) // settle before the screenshot
  await shot('wip-saved.png')

  // The on-disk store must exist, list the host, and NEVER contain the
  // plaintext secret (safeStorage-encrypted base64 only).
  if (!existsSync(storeFile)) {
    throw new Error(`connections.json not found at ${storeFile}`)
  }
  const raw = await readFile(storeFile, 'utf8')
  if (raw.includes(PASSWORD)) {
    throw new Error('connections.json contains the plaintext secret')
  }
  if (!raw.includes(TARGET) || !raw.includes(ENTRY_NAME)) {
    throw new Error('connections.json misses the saved host/name')
  }
  console.log(`connections.json OK at ${storeFile} (no plaintext secret)`)

  // Delete the entry through the UI (hover -> delete icon -> Popconfirm).
  await entry.hover()
  await entry.locator('.saved-conn-delete').click()
  await page.locator('.ant-popconfirm .ant-btn-primary').click()
  await page.waitForFunction(
    (name) =>
      ![...document.querySelectorAll('.saved-conn-item')].some((el) =>
        (el.textContent ?? '').includes(name)
      ),
    ENTRY_NAME,
    { timeout: 10000 }
  )
  const finalCount = await savedItems.count()
  if (finalCount !== initialCount) {
    throw new Error(`saved count after delete: ${finalCount}, expected ${initialCount}`)
  }
  console.log('entry deleted via UI; list back to initial state')
} finally {
  await app.close()
}

console.log('smoke-saved OK')
