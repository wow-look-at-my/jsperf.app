/**
 * Host-side benchmark controller, shared by the app and the kiosk.
 *
 * Every run gets a brand-new sandboxed iframe whose document is the embedded
 * sandbox bundle (Benchmark.js + the driver) delivered via srcdoc. That is what
 * keeps the single-file build honest: no separate sandbox.html to fetch, and no
 * state carried from one run into the next.
 */

import type { TestCase } from './case.ts'
import type { RunOptions, SandboxCycleMessage, TestResult } from './protocol.ts'
import { isRecord, messageName } from './protocol.ts'

export type RunnerState = 'ready' | 'running' | 'complete'

export interface RunnerHandlers {
  onStateChange(state: RunnerState): void
  onStatus(text: string): void
  onCycle(cycle: SandboxCycleMessage): void
  onComplete(results: TestResult[]): void
  onFailure(error: string): void
}

/**
 * `</script` inside the bundle would end the sandbox document's script element.
 * Escaping the slash is inert in JavaScript string and regexp literals - the
 * only places the sequence can legally appear - and the build verifier asserts
 * the bundle never contains it, so this is belt and braces.
 */
function escapeForScriptElement(js: string): string {
  return js.replace(/<\/script/gi, '<\\/script')
}

function sandboxDocument(sandboxJs: string): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>jsperf sandbox</title></head>',
    '<body><div id="jsperf-init-html"></div>',
    `<script>${escapeForScriptElement(sandboxJs)}</script>`,
    '</body></html>'
  ].join('')
}

export class BenchRunner {
  private readonly container: HTMLElement
  private readonly sandboxJs: string
  private readonly handlers: RunnerHandlers
  private iframe: HTMLIFrameElement | undefined
  private pending: { testCase: TestCase; options: RunOptions } | undefined
  private state: RunnerState = 'ready'

  constructor(container: HTMLElement, sandboxJs: string, handlers: RunnerHandlers) {
    this.container = container
    this.sandboxJs = sandboxJs
    this.handlers = handlers
    window.addEventListener('message', this.onMessage)
  }

  getState(): RunnerState {
    return this.state
  }

  run(testCase: TestCase, options: RunOptions): void {
    this.teardown()
    this.setState('running')
    this.handlers.onStatus('Starting...')

    const iframe = document.createElement('iframe')
    // allow-scripts without allow-same-origin: the test code runs in an opaque
    // origin and cannot touch this page, its storage, or the saved test cases.
    iframe.setAttribute('sandbox', 'allow-scripts')
    iframe.setAttribute('title', 'benchmark sandbox')
    iframe.className = 'jsperf-sandbox'
    iframe.srcdoc = sandboxDocument(this.sandboxJs)
    this.iframe = iframe
    this.pending = { testCase, options }
    this.container.appendChild(iframe)
  }

  stop(): void {
    this.post({ message: 'stop' })
    this.teardown()
    this.setState('ready')
    this.handlers.onStatus('Stopped.')
  }

  private setState(state: RunnerState): void {
    this.state = state
    this.handlers.onStateChange(state)
  }

  private teardown(): void {
    if (this.iframe) {
      this.iframe.remove()
      this.iframe = undefined
    }
    this.pending = undefined
  }

  private post(message: object): void {
    const target = this.iframe?.contentWindow
    if (target) {
      target.postMessage(message, '*')
    }
  }

  private readonly onMessage = (event: MessageEvent): void => {
    // Ignore anything that is not the current sandbox, including late messages
    // from an iframe that a stop or a new run already discarded.
    if (!this.iframe || event.source !== this.iframe.contentWindow) return

    const data: unknown = event.data
    if (!isRecord(data)) return

    switch (messageName(data)) {
      case 'ready': {
        const pending = this.pending
        if (!pending) return
        this.pending = undefined
        this.post({
          message: 'run',
          options: pending.options,
          tests: pending.testCase.tests,
          initHTML: pending.testCase.initHTML,
          setup: pending.testCase.setup,
          teardown: pending.testCase.teardown
        })
        return
      }
      case 'cycle': {
        const cycle = data as unknown as SandboxCycleMessage
        this.handlers.onCycle(cycle)
        if (cycle.status !== 'finished' && cycle.status !== 'completed') {
          const samples = `${cycle.size} sample${cycle.size === 1 ? '' : 's'}`
          this.handlers.onStatus(`${cycle.name} \u00d7 ${cycle.count} (${samples})`)
        }
        return
      }
      case 'complete': {
        const results = Array.isArray(data.results) ? (data.results as TestResult[]) : []
        this.teardown()
        this.setState('complete')
        this.handlers.onStatus('Done. Ready to run again.')
        this.handlers.onComplete(results)
        return
      }
      case 'failure': {
        const error = typeof data.error === 'string' ? data.error : 'unknown sandbox failure'
        this.teardown()
        this.setState('ready')
        this.handlers.onStatus(`Failed: ${error}`)
        this.handlers.onFailure(error)
        return
      }
      default:
        return
    }
  }
}
