/**
 * Run both builds in a real browser, from a real file:// URL.
 *
 *   node --experimental-strip-types standalone/scripts/browser-smoke.ts
 *
 * This is the check that matters: the artifacts exist to be double-clicked, and
 * only a browser can prove that a sandboxed srcdoc iframe runs Benchmark.js, that
 * ops/sec come back, and that localStorage survives a reload - from file://,
 * where a page has no origin to speak of.
 *
 * Needs Playwright's chromium (`npm ci` in standalone/, then
 * `npx playwright install chromium` unless PLAYWRIGHT_BROWSERS_PATH already has
 * one). The in-page callbacks below are typed against the DOM lib, which is why
 * standalone/ is a browser-target ts0 project - they do run in a browser.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Browser, Page } from 'playwright'

const standaloneDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP = join(standaloneDir, 'dist', 'jsperf.html')
const KIOSK = join(standaloneDir, 'dist', 'jsperf-kiosk.html')
const PACK = join(standaloneDir, 'dist', 'jsperf-pack.mjs')
const EXAMPLE = join(standaloneDir, 'examples', 'array-iteration')

const RESULT_TIMEOUT_MS = 120_000

interface ResultRow {
  hz: string
  fastest: boolean
  error: boolean
}

let failures = 0
let checks = 0

function check(condition: boolean, description: string, detail = ''): boolean {
  checks += 1
  if (condition) {
    process.stdout.write(`ok   ${description}\n`)
    return true
  }
  failures += 1
  process.stdout.write(`FAIL ${description}${detail ? `\n     ${detail}` : ''}\n`)
  return false
}

function attachConsole(page: Page, errors: string[]): void {
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
}

/** The result cells, as a person reads them off the table. */
async function readResults(page: Page): Promise<ResultRow[]> {
  return page.$$eval('td.jsperf-test-result', cells =>
    cells.map(cell => ({
      hz: cell.querySelector('.jsperf-hz')?.textContent ?? '',
      fastest: cell.classList.contains('jsperf-fastest'),
      error: cell.classList.contains('jsperf-error')
    }))
  )
}

async function runQuickAndWait(page: Page, expectedRows: number): Promise<ResultRow[]> {
  await page.getByRole('button', { name: 'Quick run', exact: true }).click()
  await page.waitForFunction(
    rows => {
      const cells = Array.from(document.querySelectorAll('td.jsperf-test-result'))
      if (cells.length !== rows) return false
      return cells.every(cell => cell.querySelector('.jsperf-hz') !== null || cell.classList.contains('jsperf-error'))
    },
    expectedRows,
    { timeout: RESULT_TIMEOUT_MS }
  )
  return readResults(page)
}

/** Every reported ops/sec is a formatted number, e.g. "12,345,678" or "9.87". */
function reportedOpsPerSecond(rows: ResultRow[]): boolean {
  return rows.every(row => /^[0-9][0-9,.]*$/.test(row.hz.trim()))
}

function hzList(rows: ResultRow[]): string {
  return JSON.stringify(rows.map(row => row.hz))
}

function pack(args: string[], cwd: string): void {
  const result = spawnSync(process.execPath, [PACK, ...args], { cwd, encoding: 'utf-8' })
  if (result.status !== 0) {
    throw new Error(`jsperf-pack ${args.join(' ')} failed: ${result.stderr}`)
  }
}

async function testKiosk(browser: Browser, work: string): Promise<void> {
  pack(['build', EXAMPLE, '-o', 'packaged.html'], work)
  const page = await browser.newPage()
  const errors: string[] = []
  attachConsole(page, errors)

  await page.goto(pathToFileURL(join(work, 'packaged.html')).href)

  check(
    (await page.locator('h1').textContent()) === 'Array iteration: forEach vs for-of vs indexed for',
    'kiosk: the packaged title is shown'
  )
  check((await page.locator('table.jsperf-results tbody tr').count()) === 4, 'kiosk: every packaged test has a row')
  check((await page.locator('[data-jsperf-editor]').count()) === 0, 'kiosk: there is no editor on the page')
  check((await page.getByRole('button', { name: 'Add test' }).count()) === 0, 'kiosk: there is no "Add test" control')
  check(
    !(await page.getByRole('button', { name: 'Copy results' }).isEnabled()),
    'kiosk: there is nothing to export before a run'
  )

  const results = await runQuickAndWait(page, 4)
  check(
    results.every(row => !row.error),
    'kiosk: no test errored',
    JSON.stringify(results)
  )
  check(reportedOpsPerSecond(results), 'kiosk: every test reported ops/sec', hzList(results))
  check(results.filter(row => row.fastest).length === 1, 'kiosk: exactly one test is marked fastest')

  const caption = await page.locator('table.jsperf-results caption').textContent()
  check((caption ?? '').includes('Testing in'), 'kiosk: the table names the browser under test')

  // Reporting a run back to whoever asked for it is part of the workflow.
  for (const name of ['Copy results', 'Copy JSON', 'Download JSON']) {
    check(await page.getByRole('button', { name }).isEnabled(), `kiosk: "${name}" is available once results exist`)
  }

  check(errors.length === 0, 'kiosk: no console errors or page errors', errors.join('\n     '))
  await page.close()
}

async function testKioskFragment(browser: Browser): Promise<void> {
  // The template with no case baked in: explains itself, and still accepts a
  // case from the URL fragment (the app's "Copy share link" output).
  const empty = await browser.newPage()
  const errors: string[] = []
  attachConsole(empty, errors)

  await empty.goto(pathToFileURL(KIOSK).href)
  check(await empty.locator('.jsperf-empty').isVisible(), 'kiosk template: an empty template says how to package a case')
  await empty.close()

  // Test bodies do real work and check their own result. A body an engine can
  // delete entirely measures as Infinity ops/sec, which the driver reports as
  // unmeasurable - correct behaviour, but it makes for a flaky test fixture.
  const testCase = {
    title: 'fragment case',
    info: '',
    initHTML: '',
    setup: 'const size = 200',
    teardown: '',
    autorun: false,
    tests: [
      {
        title: 'push',
        code: 'const out = []\nfor (let i = 0; i < size; i += 1) out.push(i * 2)\nif (out.length !== size) throw new Error("wrong length")',
        async: false
      },
      {
        title: 'preallocated',
        code: 'const out = new Array(size)\nfor (let i = 0; i < size; i += 1) out[i] = i * 2\nif (out[size - 1] !== (size - 1) * 2) throw new Error("wrong value")',
        async: false
      }
    ]
  }

  // A fresh page, because a goto that only changes the fragment is a
  // same-document navigation and would not re-run the page's script.
  const fragment = Buffer.from(JSON.stringify(testCase), 'utf-8').toString('base64url')
  const page = await browser.newPage()
  attachConsole(page, errors)
  await page.goto(`${pathToFileURL(KIOSK).href}#case=${fragment}`)

  check((await page.locator('h1').textContent()) === 'fragment case', 'kiosk template: a fragment case is loaded')
  const results = await runQuickAndWait(page, 2)
  check(reportedOpsPerSecond(results), 'kiosk template: a fragment case runs', hzList(results))
  check(errors.length === 0, 'kiosk template: no console errors', errors.join('\n     '))
  await page.close()
}

async function testApp(browser: Browser): Promise<void> {
  const page = await browser.newPage()
  const errors: string[] = []
  attachConsole(page, errors)

  await page.goto(pathToFileURL(APP).href)

  check((await page.locator('[data-jsperf-editor]').count()) === 1, 'app: the editor is present')

  const joinCode = 'const out = parts.join("")\nif (out.length !== 4) throw new Error("bad")'
  const concatCode = 'let out = ""\nfor (const part of parts) { out += part }\nif (out.length !== 4) throw new Error("bad")'

  await page.fill('[data-jsperf-field="title"]', 'smoke: string building')
  await page.fill('[data-jsperf-field="setup"]', 'const parts = ["a", "b", "c", "d"]')
  await page.fill('[data-jsperf-field="test-title-0"]', 'join')
  await page.fill('[data-jsperf-field="test-code-0"]', joinCode)
  await page.fill('[data-jsperf-field="test-title-1"]', 'concat in a loop')
  await page.fill('[data-jsperf-field="test-code-1"]', concatCode)

  const results = await runQuickAndWait(page, 2)
  check(reportedOpsPerSecond(results), 'app: both edited tests reported ops/sec', hzList(results))

  const storageAvailable = await page.evaluate(() => {
    try {
      window.localStorage.setItem('__probe__', '1')
      window.localStorage.removeItem('__probe__')
      return true
    } catch {
      return false
    }
  })
  check(storageAvailable, 'app: localStorage is usable from file://')

  // The whole point of the localStorage variant: reload and the work is there.
  await page.reload()
  check(
    (await page.inputValue('[data-jsperf-field="title"]')) === 'smoke: string building',
    'app: the edited case survived a reload'
  )
  check((await page.inputValue('[data-jsperf-field="test-code-0"]')) === joinCode, 'app: the edited test code survived a reload')
  check((await page.locator('table.jsperf-library tbody tr').count()) >= 1, 'app: the saved case is listed in the library')

  const stored = await page.evaluate(() => window.localStorage.getItem('jsperf.app:standalone:cases:v1'))
  check((stored ?? '').includes('smoke: string building'), 'app: the case is stored under the documented localStorage key')

  // A second run after the reload proves the reloaded case is runnable, not just
  // displayed.
  const rerun = await runQuickAndWait(page, 2)
  check(reportedOpsPerSecond(rerun), 'app: the reloaded case runs', hzList(rerun))

  // The no-CLI handoff: the app builds a link that carries the whole case in the
  // fragment, and the kiosk template opens it. A file:// page's origin is the
  // string "null", so this also guards against building the link from it.
  await page.getByRole('button', { name: 'Copy share link' }).click()
  const shareLink = await page.inputValue('[data-jsperf-field="share-link"]')
  check(
    shareLink.startsWith('file:///') && shareLink.includes('#case='),
    'app: the share link is a usable URL',
    shareLink.slice(0, 60)
  )

  check(errors.length === 0, 'app: no console errors or page errors', errors.join('\n     '))
  await page.close()

  const shared = await browser.newPage()
  const sharedErrors: string[] = []
  attachConsole(shared, sharedErrors)
  await shared.goto(`${pathToFileURL(KIOSK).href}${shareLink.slice(shareLink.indexOf('#'))}`)
  check((await shared.locator('h1').textContent()) === 'smoke: string building', 'kiosk: the app share link opens in the kiosk')
  const sharedResults = await runQuickAndWait(shared, 2)
  check(reportedOpsPerSecond(sharedResults), 'kiosk: the shared case runs', hzList(sharedResults))
  check(sharedErrors.length === 0, 'kiosk: no console errors for the shared case', sharedErrors.join('\n     '))
  await shared.close()
}

async function testSandboxIsolation(browser: Browser, work: string): Promise<void> {
  // The sandbox must not be able to touch the host page: allow-scripts without
  // allow-same-origin. A test body that tries is the check.
  const testCase = {
    title: 'isolation',
    tests: [
      {
        title: 'reach out',
        code: 'try { window.parent.document.title = "pwned" } catch (e) { void e }\nconst out = []\nfor (let i = 0; i < 50; i += 1) out.push(i)\nif (out.length !== 50) throw new Error("bad")',
        async: false
      },
      {
        title: 'work',
        code: 'const out = []\nfor (let i = 0; i < 50; i += 1) out.push(i * 3)\nif (out.length !== 50) throw new Error("bad")',
        async: false
      }
    ]
  }
  const casePath = join(work, 'hostile-case.json')
  writeFileSync(casePath, JSON.stringify(testCase))
  pack(['build', casePath, '-o', 'isolation.html'], work)

  const page = await browser.newPage()
  await page.goto(pathToFileURL(join(work, 'isolation.html')).href)
  const titleBefore = await page.title()
  await runQuickAndWait(page, 2)
  check((await page.title()) === titleBefore, 'sandbox: test code cannot reach the host document')
  await page.close()
}

async function main(): Promise<void> {
  for (const [label, path] of [
    ['app build', APP],
    ['kiosk build', KIOSK],
    ['pack CLI', PACK]
  ]) {
    if (!existsSync(path)) {
      process.stderr.write(`browser-smoke: ${label} missing at ${path}; run scripts/build.ts first\n`)
      process.exitCode = 1
      return
    }
  }

  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch (error) {
    process.stderr.write(
      `browser-smoke: playwright is not installed (${
        error instanceof Error ? error.message : String(error)
      }).\nRun "npm ci" in standalone/ and "npx playwright install chromium".\n`
    )
    process.exitCode = 1
    return
  }

  const work = mkdtempSync(join(tmpdir(), 'jsperf-smoke-'))
  // --no-sandbox: CI containers run as root, where Chromium's own sandbox
  // refuses to start. The page under test is still iframe-sandboxed.
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  process.stdout.write(`browser: chromium ${browser.version()}\n`)

  try {
    await testKiosk(browser, work)
    await testKioskFragment(browser)
    await testApp(browser)
    await testSandboxIsolation(browser, work)
  } finally {
    await browser.close()
  }

  process.stdout.write(`\n${checks - failures}/${checks} browser checks passed\n`)
  if (failures > 0) {
    process.stdout.write(`${failures} check(s) failed\n`)
    process.exitCode = 1
  }
}

await main()
