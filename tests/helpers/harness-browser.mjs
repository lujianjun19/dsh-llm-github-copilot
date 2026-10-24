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

/** Real browser + shipped Harness services; only GitHub responses are fixtures. */
export async function checkHarnessBrowser(url, { ambient, artifacts }) {
  const browser = await chromium.launch({ headless: true })
  const errors = []
  let page
  try {
    page = await browser.newPage({ locale: 'en-US' })
    page.on('pageerror', error => errors.push(error.message))
    await openSettings(page, url)
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
