// UX-review v1 smoke test (plans A + B): drives the built app through
//   1. saving a connection via the UI (scan -> credentials -> save),
//   1b. B7: saving the same host+username again updates the entry (count
//       unchanged, on-disk secret re-encrypted, checkbox switches to the
//       "update" wording) instead of creating a duplicate,
//   1c. B3: a second identity on the same host turns the banner into an
//       identity picker (default: first entry; selection switchable),
//   2. B: the quick-connect banner on an exact saved-address match (direct
//      connect + rescan both work),
//   3. A: the in-workspace new-connection modal (opens without touching the
//      live session; saved-entry switch asks for confirmation and cancel is
//      a no-op; the full in-modal scan -> credentials -> submit flow hits the
//      replace-session confirm, whose cancel keeps everything as it was) and
//      the wired-up disconnect button,
//   4. cleanup: deletes the saved entry through the UI.
// Captures wip-ux-banner.png / wip-ux-newconn.png into
// docs/design/screenshots/. Run `npm run build` first (the script checks).
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
// but saving and entering the workspace still work (saving never blocks).
const USERNAME = 'nobody'
const PASSWORD = 'wrongpass'
// Unique entry name so the test is robust against pre-existing saved entries.
const ENTRY_NAME = `smoke-ux-${Date.now()}`
// A host that does not exist: typed into the modal's input to prove typing
// there does not disturb the live session (no scan is started for it).
const MISSING = '192.168.50.44'

if (!existsSync(path.join(root, 'out', 'main', 'index.js'))) {
  console.error('out/main/index.js not found — run `npm run build` first.')
  process.exit(1)
}

await mkdir(shotsDir, { recursive: true })

const app = await electron.launch({ args: ['.'], cwd: root })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 })
  page.setDefaultTimeout(30000) // 30s per step, per the task contract

  const shot = async (name) => {
    const file = path.join(shotsDir, name)
    await page.screenshot({ path: file })
    const { size } = await stat(file)
    console.log(`${name}  ${size} bytes`)
  }

  // ---------- Step 1: save a connection through the UI ----------
  const input = page.locator('#target-address-input')
  await input.waitFor()
  // Wait until the saved-connections block has loaded its initial list.
  await page.waitForFunction(() => {
    const block = document.querySelector('.saved-connections')
    if (!block) return false
    const text = block.textContent ?? ''
    return (
      block.querySelectorAll('.saved-conn-item').length > 0 ||
      text.includes('暂无已保存连接') ||
      text.includes('没有匹配的已保存连接')
    )
  })

  await input.fill(TARGET)
  await page.getByRole('button', { name: '开始扫描' }).click()
  const sshCard = page.locator('[data-protocol="ssh"]')
  await sshCard.getByText('已检测到').waitFor()
  await sshCard.locator('.ant-checkbox-wrapper').click()
  await page.waitForTimeout(300) // let the checkbox transition finish
  await page.locator('.scan-footer button').click()
  await page.locator('#cred-username').fill(USERNAME)
  await page.locator('#cred-password').fill(PASSWORD)
  await page.locator('#cred-save-connection').click()
  if (!(await page.locator('#cred-save-connection').isChecked())) {
    throw new Error('save-connection checkbox did not toggle on')
  }
  await page.locator('#cred-save-name').fill(ENTRY_NAME)
  await page.locator('#connect-submit').click()

  // Wrong credentials, but the workspace still opens; close all tabs to get
  // back to the scan page.
  await page.locator('.ant-tabs-tab').first().waitFor()
  while ((await page.locator('.ant-tabs-tab-remove').count()) > 0) {
    await page.locator('.ant-tabs-tab-remove').first().click()
    await page.waitForTimeout(250)
  }
  await input.waitFor()
  const entry = page.locator('.saved-conn-item', { hasText: ENTRY_NAME })
  await entry.waitFor()
  console.log('step 1: connection saved via UI and listed')

  // ---------- Step 1b (B7): same host+username updates, never duplicates ----------
  // The on-disk store lives at app.getPath('userData') (same resolution as
  // smoke-saved): re-saving must re-encrypt the secret in place.
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const storeFile = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    pkg.productName ?? pkg.name,
    'connections.json'
  )
  const secretOfEntry = async () => {
    const all = JSON.parse(await readFile(storeFile, 'utf8'))
    return all.find((c) => c.name === ENTRY_NAME)?.secret?.data
  }
  const secretBefore = await secretOfEntry()
  if (!secretBefore) throw new Error('saved entry missing from connections.json')

  const savedItems = page.locator('.saved-conn-item')
  const countBefore = await savedItems.count()
  await page.getByRole('button', { name: '开始扫描' }).click()
  await sshCard.getByText('已检测到').waitFor()
  await sshCard.locator('.ant-checkbox-wrapper').click()
  await page.waitForTimeout(300) // let the checkbox transition finish
  await page.locator('.scan-footer button').click()
  await page.locator('#cred-username').fill(USERNAME)
  await page.locator('#cred-password').fill(`${PASSWORD}-updated`)
  // Same host + username as the saved entry: the checkbox must switch to the
  // "update" wording once the username matches.
  await page
    .locator('label', { has: page.locator('#cred-save-connection') })
    .filter({ hasText: '更新已保存的连接与凭据' })
    .waitFor()
  await page.locator('#cred-save-connection').click()
  await page.locator('#cred-save-name').fill(ENTRY_NAME) // keep the entry name
  await page.locator('#connect-submit').click()
  await page.locator('.ant-tabs-tab').first().waitFor()
  while ((await page.locator('.ant-tabs-tab-remove').count()) > 0) {
    await page.locator('.ant-tabs-tab-remove').first().click()
    await page.waitForTimeout(250)
  }
  await input.waitFor()
  await entry.waitFor()
  if ((await savedItems.count()) !== countBefore) {
    throw new Error(`B7: saved count changed (${countBefore} -> ${await savedItems.count()})`)
  }
  const allAfter = JSON.parse(await readFile(storeFile, 'utf8'))
  const dupes = allAfter.filter((c) => c.host === TARGET && c.username === USERNAME)
  if (dupes.length !== 1) {
    throw new Error(`B7: expected exactly 1 entry for host+username, found ${dupes.length}`)
  }
  const secretAfter = await secretOfEntry()
  if (!secretAfter || secretAfter === secretBefore) {
    throw new Error('B7: on-disk secret was not updated (re-encrypted) after the re-save')
  }
  console.log('step 1b: re-save updated the entry in place (count stable, secret changed)')

  // ---------- Step 1c (B3): two identities on one host -> identity picker ----------
  const ENTRY_NAME_2 = `${ENTRY_NAME}-b`
  const USERNAME_2 = 'nobody2'
  await page.getByRole('button', { name: '开始扫描' }).click()
  await sshCard.getByText('已检测到').waitFor()
  await sshCard.locator('.ant-checkbox-wrapper').click()
  await page.waitForTimeout(300) // let the checkbox transition finish
  await page.locator('.scan-footer button').click()
  await page.locator('#cred-username').fill(USERNAME_2)
  await page.locator('#cred-password').fill(PASSWORD)
  // A different username on the same host keeps the plain "save" wording.
  await page
    .locator('label', { has: page.locator('#cred-save-connection') })
    .filter({ hasText: '保存此连接与凭据' })
    .waitFor()
  await page.locator('#cred-save-connection').click()
  await page.locator('#cred-save-name').fill(ENTRY_NAME_2)
  await page.locator('#connect-submit').click()
  await page.locator('.ant-tabs-tab').first().waitFor()
  while ((await page.locator('.ant-tabs-tab-remove').count()) > 0) {
    await page.locator('.ant-tabs-tab-remove').first().click()
    await page.waitForTimeout(250)
  }
  await input.waitFor()

  // Two identities on one host: the banner offers a picker (default: first).
  const multiBanner = page.locator('#quick-connect-banner')
  await multiBanner.waitFor()
  const multiText = (await multiBanner.textContent()) ?? ''
  if (!multiText.includes('该地址有 2 个已保存身份')) {
    throw new Error(`B3: multi-identity banner text missing: ${multiText}`)
  }
  const radios = multiBanner.locator('.ant-radio-wrapper')
  if ((await radios.count()) !== 2) {
    throw new Error(`B3: expected 2 identity options, found ${await radios.count()}`)
  }
  const checkedRadio = multiBanner.locator('.ant-radio-wrapper-checked')
  if (!((await checkedRadio.textContent()) ?? '').includes(USERNAME)) {
    throw new Error('B3: the first identity is not selected by default')
  }
  await radios.nth(1).click()
  if (!((await checkedRadio.textContent()) ?? '').includes(USERNAME_2)) {
    throw new Error('B3: selecting the second identity did not take effect')
  }
  // Remove the second identity again; the banner drops back to single-match.
  const entry2 = page.locator('.saved-conn-item', { hasText: ENTRY_NAME_2 })
  await entry2.hover()
  await entry2.locator('.saved-conn-delete').click()
  await page.locator('.ant-popconfirm .ant-btn-primary').click()
  await page.waitForFunction(
    (name) =>
      ![...document.querySelectorAll('.saved-conn-item')].some((el) =>
        (el.textContent ?? '').includes(name)
      ),
    ENTRY_NAME_2
  )
  console.log('step 1c: two identities -> picker (default first, switchable); second removed')

  // ---------- Step 2 (B): banner on exact match, rescan still works ----------
  await input.fill(TARGET)
  const banner = page.locator('#quick-connect-banner')
  await banner.waitFor()
  const bannerText = (await banner.textContent()) ?? ''
  if (!bannerText.includes(ENTRY_NAME) || !bannerText.includes(`${USERNAME}@${TARGET}`)) {
    throw new Error(`banner misses name or username@host: ${bannerText}`)
  }
  await page.waitForTimeout(300) // settle before the screenshot
  await shot('wip-ux-banner.png')

  await banner.getByRole('button', { name: '重新扫描' }).click()
  await sshCard.getByText('已检测到').waitFor()
  console.log('step 2: banner shown (name + username@host); rescan renders cards')

  // ---------- Step 3 (A): direct connect, new-connection modal, disconnect ----------
  await banner.getByRole('button', { name: '直接连接' }).click()
  await page.locator('.ant-tabs-tab').first().waitFor()
  const tabsBefore = await page.locator('.ant-tabs-tab').count()

  // A1/A4: the sider's "+ 新建连接" opens the modal; the live session is
  // untouched (tabs unchanged, no switch).
  await page.locator('#new-connection-button').click()
  await page.locator('#quick-target-input').waitFor()
  if ((await page.locator('.ant-tabs-tab').count()) !== tabsBefore) {
    throw new Error('opening the new-connection modal changed the session tabs')
  }
  await page.waitForTimeout(400) // let the modal animation settle
  await shot('wip-ux-newconn.png')

  // A3: picking a saved entry inside the modal asks for confirmation first;
  // cancelling leaves the current session exactly as it was.
  await page.locator('.ant-modal .saved-item').first().click()
  const confirmBox = page.locator('.ant-modal-confirm')
  await confirmBox.waitFor()
  const confirmText = (await confirmBox.textContent()) ?? ''
  if (!confirmText.includes(TARGET)) {
    throw new Error(`switch confirm does not name the current target: ${confirmText}`)
  }
  await confirmBox.locator('.ant-btn').first().click() // cancel (auto-spaced CJK name)
  await page.locator('#quick-target-input').waitFor() // modal still open
  if ((await page.locator('.ant-tabs-tab').count()) !== tabsBefore) {
    throw new Error('cancelling the switch confirm changed the session')
  }
  console.log('step 3a: modal opened, session untouched; switch confirm cancels cleanly')

  // Typing another (nonexistent) address must not disturb the session either.
  await page.locator('#quick-target-input').fill(MISSING)
  if ((await page.locator('.ant-tabs-tab').count()) !== tabsBefore) {
    throw new Error('typing in the modal changed the session')
  }

  // A2 full in-modal flow: scan the real target, pick SSH, open the
  // credentials modal and submit — the replace-session confirm must appear;
  // cancelling keeps the credentials modal open and the session unchanged.
  const modalRoot = page.locator('.ant-modal:has(#quick-target-input)')
  await page.locator('#quick-target-input').fill(TARGET)
  await page.getByRole('button', { name: '开始扫描' }).click()
  await modalRoot.locator('[data-protocol="ssh"]').getByText('已检测到').waitFor()
  await modalRoot.locator('[data-protocol="ssh"] .ant-checkbox-wrapper').click()
  await page.waitForTimeout(300) // let the checkbox transition finish
  // (antd auto-inserts a space into two-CJK-char buttons — "连 接" — so match
  // the modal's connect button by regex instead of the literal text.)
  await modalRoot.locator('button.ant-btn-primary').filter({ hasText: /连\s*接/ }).click()
  await page.locator('#cred-username').fill(USERNAME)
  await page.locator('#cred-password').fill(PASSWORD)
  await page.locator('#connect-submit').click()
  const credsConfirm = page.locator('.ant-modal-confirm')
  await credsConfirm.waitFor()
  if (!((await credsConfirm.textContent()) ?? '').includes(TARGET)) {
    throw new Error('A2: submit-confirm does not name the current target')
  }
  await credsConfirm.locator('.ant-btn').first().click() // cancel
  await page.locator('#cred-username').waitFor() // credentials modal stays open
  if ((await page.locator('.ant-tabs-tab').count()) !== tabsBefore) {
    throw new Error('cancelling the submit confirm changed the session')
  }
  // Close the credentials modal, then the new-connection modal.
  await page.locator('.ant-modal:has(#cred-username) .ant-modal-close').click()
  await page.locator('#cred-username').waitFor({ state: 'detached' })
  await modalRoot.locator('.ant-modal-close').click()
  await page.locator('#quick-target-input').waitFor({ state: 'detached' })
  if ((await page.locator('.ant-tabs-tab').count()) !== tabsBefore) {
    throw new Error('closing the modal changed the session')
  }
  console.log('step 3b: in-modal scan -> credentials -> submit confirm cancels cleanly')

  // A4(action): the disconnect button (Popconfirm) returns to the scan page.
  await page.locator('#disconnect-button').click()
  await page.locator('.ant-popconfirm .ant-btn-primary').click()
  await input.waitFor()
  if ((await page.locator('.ant-tabs-tab').count()) !== 0) {
    throw new Error('disconnect did not leave the session workspace')
  }
  console.log('step 3c: modal closed; disconnect via Popconfirm returned to scan page')

  // ---------- Step 4: cleanup — delete the saved entry through the UI ----------
  await input.fill(TARGET) // restore the filter so the entry is listed again
  await entry.hover()
  await entry.locator('.saved-conn-delete').click()
  await page.locator('.ant-popconfirm .ant-btn-primary').click()
  await page.waitForFunction(
    (name) =>
      ![...document.querySelectorAll('.saved-conn-item')].some((el) =>
        (el.textContent ?? '').includes(name)
      ),
    ENTRY_NAME
  )
  console.log('step 4: saved entry deleted via UI')
} finally {
  await app.close()
}

console.log('smoke-ux OK')
