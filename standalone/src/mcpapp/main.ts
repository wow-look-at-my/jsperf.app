/**
 * The MCP App view: a jsPerf benchmark rendered inside a Claude conversation.
 *
 * The case arrives from the model as tool arguments, the person clicks Run, and
 * the numbers go back into the conversation - so "which of these is faster?" is
 * answered by their actual browser rather than by a guess.
 *
 * Why this view does not run the benchmark itself: MCP Apps hosts serve the view
 * under a deny-by-default CSP with no `unsafe-eval`, and Benchmark.js compiles
 * every test body with `new Function`. A srcdoc iframe inherits that policy, so
 * the trick the single-file builds use cannot work here. A cross-origin runner
 * page brings its own CSP, which is why the server declares that origin in
 * `_meta.ui.csp.frameDomains` and the view drives it over the same postMessage
 * protocol the standalone builds use. See docs/mcp-app.md.
 */

import { App } from '@modelcontextprotocol/ext-apps'
import type { BenchTest, TestCase } from '../shared/case.ts'
import { normalizeCase, runnableCase } from '../shared/case.ts'
import { decodeCaseFromFragment } from '../shared/hash.ts'
import { browserLabel } from '../shared/results.ts'
import { BenchRunner } from '../shared/runner.ts'
import type { TestResult } from '../shared/protocol.ts'

/**
 * Only used when there is no host: opening the view directly with `#case=` for
 * development. In a conversation the server always sends its own runner URL, and
 * it must - the host's `frame-src` allows exactly the origin the server declared
 * in `_meta.ui.csp.frameDomains`, so no other runner could load anyway.
 *
 * The bare project path is buildhost's canonical URL for a site file: it serves
 * the default branch's deployment. `/branch/<branch>/` is the older spelling and
 * still resolves, but only as a 302 to this one, so naming it here would cost a
 * cross-origin redirect for nothing. verify.ts holds the URL to the canonical
 * form rather than trusting it to stay right.
 */
const DEV_RUNNER_URL = 'https://sites.pazer.build/jsperf.app/runner.html'

const FULL_RUN_MAX_TIME = 5
const QUICK_RUN_MAX_TIME = 0.5

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing #${id}`)
  return node as T
}

const titleEl = must('jp-title')
const subEl = must('jp-sub')
const statusEl = must('jp-status')
const rowsEl = must<HTMLOListElement>('jp-rows')
const browserEl = must('jp-browser')
const runBtn = must<HTMLButtonElement>('jp-run')
const fullBtn = must<HTMLButtonElement>('jp-full')
const stopBtn = must<HTMLButtonElement>('jp-stop')
const sendBtn = must<HTMLButtonElement>('jp-send')
const copyBtn = must<HTMLButtonElement>('jp-copy')
const sandboxHost = must('jp-sandbox')

let testCase: TestCase | undefined
let runnerUrl = DEV_RUNNER_URL
let lastResults: TestResult[] = []
let rowNodes: { fill: HTMLElement; figure: HTMLElement; delta: HTMLElement; row: HTMLElement }[] = []

const app = new App({ name: 'jsPerf', version: '1.0.0' })

let runner: BenchRunner | undefined

/**
 * Built on first use, not at load: the server tells the view which origin runs
 * the benchmark, and that arrives with the tool result.
 */
function ensureRunner(): BenchRunner {
  if (runner) return runner
  runner = new BenchRunner(sandboxHost, { kind: 'url', url: runnerUrl }, {
    onStateChange: state => {
      const running = state === 'running'
      runBtn.hidden = running
      fullBtn.hidden = running
      stopBtn.hidden = !running
      runBtn.textContent = state === 'complete' ? 'Run again' : 'Run'
    },
    onStatus: text => {
      statusEl.textContent = text
    },
    onCycle: cycle => {
      const node = rowNodes[cycle.id]
      if (node && cycle.status === 'running') node.delta.textContent = 'measuring...'
    },
    onComplete: results => {
      lastResults = results
      paintResults(results)
      sendBtn.disabled = false
      copyBtn.disabled = false
      void publishToConversation(results)
    },
    onFailure: error => {
      statusEl.textContent = `The runner could not start: ${error}`
    }
  })
  return runner
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

function paintTests(tests: BenchTest[]): void {
  rowsEl.textContent = ''
  rowNodes = []

  for (const test of tests) {
    const row = el('li', 'jp-row')

    row.append(el('div', 'jp-row-name', test.title))

    const figure = el('div', 'jp-row-figure')
    figure.append(el('span', 'jp-unit', 'not run'))
    row.append(figure)

    const track = el('div', 'jp-track')
    const fill = el('div', 'jp-fill')
    track.append(fill)
    row.append(track)

    const delta = el('div', 'jp-delta')
    row.append(delta)

    const code = el('details', 'jp-code')
    code.append(el('summary', '', 'code'))
    const pre = el('pre')
    pre.append(el('code', '', test.code))
    code.append(pre)
    row.append(code)

    rowsEl.append(row)
    rowNodes.push({ fill, figure, delta, row })
  }
}

function paintResults(results: TestResult[]): void {
  const fastestHz = Math.max(0, ...results.map(result => result.hzRaw))

  for (const result of results) {
    const node = rowNodes[result.id]
    if (!node) continue

    node.figure.textContent = ''
    node.delta.textContent = ''
    node.row.classList.toggle('jp-row-fastest', result.fastest)
    node.row.classList.toggle('jp-row-error', result.status === 'error')

    if (result.status === 'error') {
      node.figure.append(el('span', 'jp-unit', 'failed'))
      node.delta.append(el('span', 'jp-chip', 'error'), el('span', '', result.error))
      node.fill.style.width = '100%'
      continue
    }

    node.figure.append(el('span', 'jp-hz', result.hz), el('span', 'jp-unit', ' ops/sec'))
    node.fill.style.width = `${fastestHz > 0 ? Math.max(2, (result.hzRaw / fastestHz) * 100) : 0}%`

    if (result.fastest) {
      node.delta.append(el('span', 'jp-chip', 'fastest'))
    } else if (fastestHz > 0 && result.hzRaw > 0) {
      node.delta.append(el('span', '', `${(fastestHz / result.hzRaw).toFixed(2)}× slower`))
    }
    node.delta.append(el('span', 'jp-rme', `±${result.rme}% over ${result.samples} samples`))
  }
}

function resultsPayload(results: TestResult[]): Record<string, unknown> {
  const tests = testCase ? testCase.tests : []
  return {
    title: testCase?.title ?? '',
    browser: browserLabel(),
    userAgent: navigator.userAgent,
    results: results.map(result => ({
      test: tests[result.id]?.title ?? `Test #${result.id + 1}`,
      opsPerSecond: result.hzRaw,
      relativeMarginOfError: result.rme === '' ? null : Number(result.rme),
      samples: result.samples,
      fastest: result.fastest,
      error: result.error
    }))
  }
}

function resultsText(results: TestResult[]): string {
  const tests = testCase ? testCase.tests : []
  const lines = results.map(result => {
    const name = tests[result.id]?.title ?? `Test #${result.id + 1}`
    if (result.status === 'error') return `- ${name}: ERROR (${result.error})`
    return `- ${name}: ${result.hz} ops/sec ±${result.rme}%${result.fastest ? ' (fastest)' : ''}`
  })
  return [`Benchmark results from ${browserLabel()}:`, ...lines].join('\n')
}

/**
 * Put the numbers where the conversation can use them. This is silent context,
 * not a message: the person asked for a benchmark, not for a wall of text.
 */
async function publishToConversation(results: TestResult[]): Promise<void> {
  try {
    await app.updateModelContext({
      content: [{ type: 'text', text: resultsText(results) }],
      structuredContent: resultsPayload(results)
    })
  } catch {
    // A host that does not accept context updates is not a reason to lose the
    // numbers: they are on screen, and Copy still works.
  }
}

function setCase(next: TestCase): void {
  const runnable = runnableCase(next)
  testCase = runnable
  titleEl.textContent = runnable.title.trim() === '' ? 'Benchmark' : runnable.title
  subEl.textContent =
    runnable.info.trim() === '' ? 'Runs in your browser, on your machine.' : runnable.info.split('\n')[0]
  paintTests(runnable.tests)
  lastResults = []
  sendBtn.disabled = true
  copyBtn.disabled = true
  const count = runnable.tests.length
  const hasTests = count > 0
  runBtn.disabled = !hasTests
  fullBtn.disabled = !hasTests
  statusEl.textContent = hasTests
    ? `${count} test${count === 1 ? '' : 's'} ready. Nothing is measured until you press Run.`
    : 'This benchmark has no test code in it.'
}

function start(maxTime: number): void {
  if (!testCase || testCase.tests.length === 0) return
  for (const node of rowNodes) {
    node.figure.textContent = ''
    node.figure.append(el('span', 'jp-unit', 'queued'))
    node.delta.textContent = ''
    node.fill.style.width = '0'
    node.row.classList.remove('jp-row-fastest', 'jp-row-error')
  }
  ensureRunner().run(testCase, { maxTime })
}

runBtn.addEventListener('click', () => start(QUICK_RUN_MAX_TIME))
fullBtn.addEventListener('click', () => start(FULL_RUN_MAX_TIME))
stopBtn.addEventListener('click', () => runner?.stop())

copyBtn.addEventListener('click', () => {
  void navigator.clipboard.writeText(resultsText(lastResults)).then(
    () => {
      statusEl.textContent = 'Results copied.'
    },
    () => {
      statusEl.textContent = 'The clipboard is not available here; the numbers are above.'
    }
  )
})

sendBtn.addEventListener('click', () => {
  void app
    .sendMessage({
      role: 'user',
      content: [{ type: 'text', text: `${resultsText(lastResults)}\n\nWhat do you make of these?` }]
    })
    .catch(() => {
      statusEl.textContent = 'This host does not accept messages from the view.'
    })
})

browserEl.textContent = browserLabel()

// The model's arguments arrive before the tool returns, so the tests are on
// screen while the server is still being called.
app.ontoolinput = params => {
  if (params.arguments) setCase(normalizeCase(params.arguments))
}

app.ontoolresult = result => {
  const structured = result.structuredContent
  if (!structured) return
  const url = structured.runnerUrl
  if (typeof url === 'string' && url !== '') runnerUrl = url
  if (structured.case) setCase(normalizeCase(structured.case))
}

/**
 * Opening the view outside a conversation (with `#case=<base64url json>`) renders
 * it against a runner without a host attached. That is how you look at the view
 * in a plain browser while developing it, and it is what the browser smoke test
 * drives - the same affordance the kiosk build has.
 */
function loadDevelopmentCase(): boolean {
  const fromFragment = decodeCaseFromFragment(window.location.hash)
  if (!fromFragment) return false
  const override = new URLSearchParams(window.location.search).get('runner')
  if (override) runnerUrl = override
  setCase(fromFragment)
  return true
}

async function connect(): Promise<void> {
  await app.connect()
  const theme = app.getHostContext()?.theme
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
  app.onhostcontextchanged = context => {
    const next = context.theme
    if (next === 'light' || next === 'dark') document.documentElement.dataset.theme = next
  }
  // Grow the frame to fit the rows instead of scrolling inside the conversation.
  app.setupSizeChangedNotifications()
}

const standalone = loadDevelopmentCase()

void connect().catch(() => {
  if (!standalone) {
    statusEl.textContent = 'Not connected to a host: open this view from a Claude conversation.'
  }
})
