import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

async function api(page, action, method = 'GET') {
  return page.evaluate(async ({ action, method }) => {
    const response = await fetch(`/api/github-copilot-auth/${action}`, { method })
    if (!response.ok) throw new Error(`Copilot ${action}: HTTP ${response.status}`)
    const payload = await response.json()
    if (!payload.ok) throw new Error(payload.error)
    return payload.value
  }, { action, method })
}

async function openSettings(page, url) {
  await page.goto(url)
  // Fresh Harness homes show the preview notice and optional DeepSeek onboarding.
  await page.getByRole('button', { name: 'Continue', exact: true }).waitFor({ timeout: 15000 })
    .then(() => page.getByRole('button', { name: 'Continue', exact: true }).click(), () => {})
  const onboarding = page.getByRole('dialog').filter({ hasText: 'Get started' })
  await onboarding.waitFor({ timeout: 3000 }).then(
    () => onboarding.getByRole('button', { name: 'Close', exact: true }).click(), () => {},
  )
  const launcher = page.getByRole('button', { name: /^(Account menu|Settings)$/ }).first()
  await launcher.waitFor()
  const menu = await launcher.getAttribute('aria-label') === 'Account menu'
  await launcher.click()
  if (menu) await page.getByText('Settings', { exact: true }).click()
  await page.getByRole('button', { name: 'GitHub Copilot', exact: true }).click()
}

/**
 * The navigation row shows exactly one Copilot glyph. Shells that declare
 * settings.section.icon render it inside the slot; older shells get the DOM
 * fallback. Selecting the row re-renders it, so this also covers that path.
 */
async function checkNavIcon(page, iconSlot) {
  const row = page.getByRole('button', { name: 'GitHub Copilot', exact: true })
  await row.locator('svg[data-github-copilot-icon="true"]').waitFor()
  assert.equal(await row.locator('svg').count(), 1, 'one navigation glyph')
  const slotted = await row.locator('[data-slot="settings.section.icon"] svg[data-github-copilot-icon="true"]').count()
  assert.equal(slotted, iconSlot ? 1 : 0, iconSlot ? 'glyph rendered by the icon slot' : 'DOM fallback without an icon slot')
}

async function signOut(page) {
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Sign out of GitHub Copilot?', exact: true })
  await dialog.waitFor()
  assert.equal(await dialog.getByRole('button', { name: 'Close', exact: true }).count(), 1)
  const confirm = dialog.getByRole('button', { name: 'Sign out', exact: true })
  assert.equal(await confirm.isDisabled(), true)
  await dialog.getByRole('checkbox').check()
  await confirm.click()
  await dialog.waitFor({ state: 'hidden' })
}

async function checkCommands(page, workspace, frames) {
  // Reopen the ordinary conversation surface rather than calling Host commands
  // through an RPC: the overlay and logout confirmation are Client features.
  await page.reload()
  let input = page.locator('[data-composer-input][contenteditable="true"]').first()
  if (!await input.isVisible()) {
    await page.getByRole('button', { name: 'Add workspace', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await picker.getByRole('button', { name: 'Edit path' }).click()
    const path = picker.getByRole('textbox', { name: 'Edit path' })
    await path.fill(workspace)
    await path.press('Enter')
    await picker.getByRole('button', { name: 'Open', exact: true }).click()
    input = page.locator('[data-composer-input][contenteditable="true"]').first()
  }
  await input.waitFor()
  const command = async value => {
    await input.fill(value)
    await input.press('Enter')
  }
  const waitForResult = async expected => {
    const deadline = Date.now() + 15000
    while (!frames.some(result => result.kind === 'success' && result.text?.includes(expected))) {
      if (Date.now() >= deadline) throw new Error(`Missing command result: ${expected}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  await command('/copilot-status')
  // An empty session can keep its hero visible even after a command result.
  // Observe the public session-event stream instead of assuming a chat row.
  await waitForResult('GitHub Copilot is NOT signed in.')
  await command('/copilot-login')
  const dialog = page.getByRole('dialog', { name: 'Sign in to GitHub Copilot' })
  await dialog.getByRole('textbox', { name: 'Device code' }).waitFor()
  assert.equal(await dialog.getByRole('textbox', { name: 'Device code' }).inputValue(), 'TEST-CODE')
  await dialog.waitFor({ state: 'hidden' })
  assert.equal((await api(page, 'status')).authenticated, true)
  await command('/copilot-status')
  await waitForResult('GitHub Copilot: authenticated.')
  await command('/copilot-logout')
  await page.getByText('Sign out of GitHub Copilot', { exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: 'Sign out of GitHub Copilot?' })
  await confirmation.getByRole('checkbox').check()
  await confirmation.getByRole('button', { name: 'Sign out', exact: true }).click()
  await confirmation.waitFor({ state: 'hidden' })
  await page.waitForFunction(async () => {
    const response = await fetch('/api/github-copilot-auth/status')
    return response.ok && !(await response.json()).value.authenticated
  })
}

/** Real browser + shipped Harness services; only GitHub responses are fixtures. */
export async function checkHarnessBrowser(url, { ambient, artifacts, workspace, iconSlot }) {
  const browser = await chromium.launch({ headless: true })
  const errors = []
  const frames = []
  let page
  try {
    page = await browser.newPage({ locale: 'en-US' })
    page.on('pageerror', error => errors.push(error.message))
    page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
      try {
        const event = JSON.parse(String(payload)).value?.event
        if (event?.type === 'command/done' && event.data?.text?.startsWith('GitHub Copilot')) frames.push(event.data)
      } catch { /* Other WebSocket frames are not session events. */ }
    }))
    await openSettings(page, url)
    await checkNavIcon(page, iconSlot)
    if (ambient) {
      await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor()
      assert.equal((await api(page, 'status')).authenticated, true)
      await signOut(page)
      await page.getByText('External token still present', { exact: true }).waitFor()
      assert.match(await page.getByRole('status').innerText(), /GITHUB_COPILOT_OAUTH_TOKEN.*still supplies a token/)
      const status = await api(page, 'status')
      assert.equal(status.credentialRemaining, true)
      assert.equal(status.authenticated, true)
      await page.getByRole('button', { name: 'Refresh status', exact: true }).click()
      await page.getByText('External token still present', { exact: true }).waitFor()
    } else {
      const login = page.getByRole('button', { name: 'Sign in to GitHub Copilot', exact: true })
      await login.waitFor()
      assert.equal((await api(page, 'status')).authenticated, false)
      await login.click()
      await page.getByRole('textbox', { name: 'Device code', exact: true }).waitFor()
      assert.equal(await page.getByRole('textbox', { name: 'Device code', exact: true }).inputValue(), 'TEST-CODE')
      await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor()
      const status = await api(page, 'status')
      assert.equal(status.authenticated, true)
      assert.equal(status.credentialRemaining, undefined)
      await signOut(page)
      await login.waitFor()
      assert.equal((await api(page, 'status')).authenticated, false)
      await checkCommands(page, workspace, frames)
    }
    assert.deepEqual(errors, [], 'client modules must load and render without uncaught errors')
  } catch (error) {
    if (page && artifacts) {
      await writeFile(join(artifacts, 'page.txt'), await page.locator('body').innerText())
      await page.screenshot({ path: join(artifacts, 'page.png') })
    }
    throw error
  } finally {
    await browser.close()
  }
}
