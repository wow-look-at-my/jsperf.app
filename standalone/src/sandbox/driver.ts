/**
 * The sandbox driver: runs a benchmark suite inside the sandboxed iframe and
 * reports progress to the host page over postMessage.
 *
 * This is a dependency-free port of the Next.js app's components/UI.js. The
 * compiled output is concatenated after app/lib/benchmark.mjs (see
 * standalone/scripts/build.mjs) to form the sandbox bundle that both the app and
 * the kiosk embed as a string and hand to an iframe via srcdoc.
 *
 * Everything here runs with the test's own globals: setup code, teardown code
 * and preparation HTML all pollute this document, which is exactly why the host
 * throws the whole document away and re-creates it for every run.
 */

import type { BenchTest } from '../shared/case.ts'
import type { SandboxMessage, TestResult, TestStatus } from '../shared/protocol.ts'
import { isRecord, messageName } from '../shared/protocol.ts'

const INIT_HTML_ID = 'jsperf-init-html'
const CYCLE_THROTTLE_MS = 200

function post(message: SandboxMessage): void {
  window.parent.postMessage(message, '*')
}

/** Leading + trailing throttle: the last event of a burst always lands. */
function throttle<T extends unknown[]>(fn: (...args: T) => void, waitMs: number): (...args: T) => void {
  let last = 0
  let timer: number | undefined
  let pending: T | undefined

  return (...args: T): void => {
    const now = Date.now()
    if (now - last >= waitMs) {
      last = now
      fn(...args)
      return
    }
    pending = args
    if (timer !== undefined) return
    timer = window.setTimeout(() => {
      timer = undefined
      last = Date.now()
      if (pending) {
        const next = pending
        pending = undefined
        fn(...next)
      }
    }, waitMs - (now - last))
  }
}

/**
 * Rank finished benchmarks fastest-first. Errored, unrun and Infinity-hz
 * benchmarks are excluded (ported from utils/Array.js getRankedByHz).
 */
function rankedByHz(benchmarks: BenchmarkInstance[]): BenchmarkInstance[] {
  return benchmarks
    .filter(bench => bench.cycles > 0 && Number.isFinite(bench.hz) && !bench.error)
    .sort((a, b) => (a.hz < b.hz ? 1 : -1))
}

const modulePromises = new Map<string, () => void>()

interface ModuleResolverWindow extends Window {
  resolveScriptModuleById?: (id: string) => void
}

;(window as ModuleResolverWindow).resolveScriptModuleById = (id: string): void => {
  const resolve = modulePromises.get(id)
  if (resolve) {
    modulePromises.delete(id)
    resolve()
  }
}

/**
 * Move a <script> from the injected preparation HTML into <head> and wait for it
 * to have run, so a library the tests depend on is loaded before the suite
 * starts. A module script has no load event once inlined, so a resolver call is
 * appended to its body instead.
 */
function injectScript(script: HTMLScriptElement): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const node = document.createElement('script')

    if (script.type === 'module') {
      const id = Math.random().toString(36).slice(2)
      modulePromises.set(id, resolve)
      node.type = 'module'
      node.text = `${script.text}\n;window.resolveScriptModuleById(${JSON.stringify(id)})`
      document.head.appendChild(node)
      script.remove()
      return
    }

    if (script.type) {
      node.type = script.type
    }

    if (script.src) {
      node.src = script.src
      node.onload = (): void => resolve()
      node.onerror = (): void => reject(new Error(`failed to load script ${script.src}`))
      document.head.appendChild(node)
      script.remove()
      return
    }

    node.text = script.text
    document.head.appendChild(node)
    script.remove()
    resolve()
  })
}

async function injectInitHTML(initHTML: string): Promise<void> {
  if (initHTML.trim() === '') return

  let container = document.getElementById(INIT_HTML_ID)
  if (!container) {
    container = document.createElement('div')
    container.id = INIT_HTML_ID
    document.body.appendChild(container)
  }

  container.innerHTML = initHTML

  // Scripts inserted via innerHTML never execute; re-create them in order.
  for (const script of Array.from(container.querySelectorAll('script'))) {
    await injectScript(script)
  }
}

function statusOf(bench: BenchmarkInstance, suiteRunning: boolean): TestStatus {
  if (bench.error) return 'error'
  if (bench.running) return 'running'
  if (bench.cycles > 0) return suiteRunning ? 'completed' : 'finished'
  return 'pending'
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (isRecord(error) && typeof error.message === 'string') return error.message
  return error === undefined || error === null ? '' : String(error)
}

function resultsFrom(benchmarks: BenchmarkInstance[]): TestResult[] {
  const ranked = rankedByHz(benchmarks)
  const fastest = ranked[0]
  const slowest = ranked.length > 0 ? ranked[ranked.length - 1] : undefined
  const fastestHz = fastest ? fastest.hz : 0

  return benchmarks.map((bench): TestResult => {
    const hasResult = bench.cycles > 0 && Number.isFinite(bench.hz) && !bench.error
    const relative = fastestHz > 0 && hasResult ? (1 - bench.hz / fastestHz) * 100 : 0
    const percent =
      hasResult && fastest && bench.id !== fastest.id
        ? Benchmark.formatNumber(relative < 1 ? relative.toFixed(2) : Math.round(relative))
        : ''

    // An unmeasurable test (an empty or entirely optimised-away body reports
    // hz === Infinity) is reported as an error rather than as a suspiciously
    // fast result: a silent Infinity is how a benchmark lies.
    const unmeasurable = !hasResult && !bench.error
    const error = bench.error
      ? errorText(bench.error)
      : unmeasurable
        ? 'no measurable result: the test body is empty or was optimised away'
        : ''

    return {
      id: bench.id,
      hz: hasResult ? Benchmark.formatNumber(bench.hz.toFixed(bench.hz < 100 ? 2 : 0)) : '',
      hzRaw: hasResult ? bench.hz : 0,
      rme: hasResult ? bench.stats.rme.toFixed(2) : '',
      samples: bench.stats.sample.length,
      fastest: fastest !== undefined && bench.id === fastest.id,
      slowest: slowest !== undefined && ranked.length > 1 && bench.id === slowest.id,
      status: hasResult ? 'finished' : 'error',
      error,
      percent
    }
  })
}

let suite: BenchmarkSuite | undefined

async function run(
  options: { maxTime: number },
  tests: BenchTest[],
  initHTML: string,
  setup: string,
  teardown: string
): Promise<void> {
  await injectInitHTML(initHTML)

  const benchmarks: BenchmarkInstance[] = []
  const current = new Benchmark.Suite()
  suite = current

  Benchmark.prototype.setup = setup
  Benchmark.prototype.teardown = teardown

  current.on('add', event => {
    const bench = event.target
    benchmarks.push(bench)

    bench.on(
      'start cycle complete',
      throttle(() => {
        post({
          message: 'cycle',
          id: bench.id,
          name: bench.name,
          count: Benchmark.formatNumber(bench.count),
          size: bench.stats.sample.length,
          status: statusOf(bench, current.running),
          running: current.running
        })
      }, CYCLE_THROTTLE_MS)
    )
  })

  tests.forEach((test, id) => {
    current.add(test.title, { defer: test.async, fn: test.code, id })
  })

  current.on('complete', () => {
    post({ message: 'complete', results: resultsFrom(benchmarks) })
  })

  for (const bench of benchmarks) {
    Object.assign(bench.options, options)
    bench.reset()
  }

  current.run({ async: true, queued: true })
}

window.addEventListener('message', event => {
  const data: unknown = event.data
  const name = messageName(data)

  if (name === 'stop') {
    if (suite) {
      suite.off()
      suite.abort()
      suite.length = 0
      suite = undefined
    }
    return
  }

  if (name !== 'run' || !isRecord(data)) return

  const options = isRecord(data.options) && typeof data.options.maxTime === 'number' ? { maxTime: data.options.maxTime } : { maxTime: 5 }
  const tests = Array.isArray(data.tests) ? (data.tests as BenchTest[]) : []
  const initHTML = typeof data.initHTML === 'string' ? data.initHTML : ''
  const setup = typeof data.setup === 'string' ? data.setup : ''
  const teardown = typeof data.teardown === 'string' ? data.teardown : ''

  run(options, tests, initHTML, setup, teardown).catch((error: unknown) => {
    post({ message: 'failure', error: errorText(error) })
  })
})

// Preparation HTML and setup code can leave the document in any state, so the
// host waits for this before sending a run: a fresh sandbox is always a fresh
// document.
post({ message: 'ready' })
