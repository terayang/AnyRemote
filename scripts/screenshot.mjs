// Phase-1 design-review screenshots: drives the built app through the full
// mock flow (scan -> select -> connect -> switch tabs) and captures PNGs into
// docs/design/screenshots/. Run `npm run build` first (the script checks).

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

  // 01 — scan page with the prefilled mock target.
  await page.getByRole('button', { name: '开始扫描' }).waitFor()
  await shot('01-scan.png')

  // 02 — run the mock scan, wait for cards, select SSH + VNC.
  await page.getByRole('button', { name: '开始扫描' }).click()
  await page.locator('[data-protocol="ssh"]').waitFor({ timeout: 10000 })
  await page.locator('[data-protocol="ssh"] .ant-checkbox-wrapper').click()
  await page.locator('[data-protocol="vnc"] .ant-checkbox-wrapper').click()
  await page.waitForTimeout(400) // let the checkbox check transition finish
  await shot('02-cards.png')

  // 03 — connect; the session workspace opens on the remote desktop tab.
  // (antd auto-inserts a space into two-CJK-char buttons — "连 接" — so match
  // the footer button structurally instead of by accessible name.)
  await page.locator('.scan-footer button').click()
  await page.getByRole('tab', { name: '远程桌面' }).waitFor()
  await page.locator('.desktop-viewport').waitFor()
  await page.waitForTimeout(300) // let the tab ink-bar animation settle
  await shot('03-desktop.png')

  // 04 — terminal tab.
  await page.getByRole('tab', { name: '终端' }).click()
  await page.locator('.terminal-panel').waitFor()
  await page.waitForTimeout(300)
  await shot('04-terminal.png')

  // 05 — file manager tab.
  await page.getByRole('tab', { name: '文件管理' }).click()
  await page.locator('.files-panel').waitFor()
  await page.waitForTimeout(300)
  await shot('05-files.png')
} finally {
  await app.close()
}

console.log(`Screenshots saved to ${shotsDir}`)
