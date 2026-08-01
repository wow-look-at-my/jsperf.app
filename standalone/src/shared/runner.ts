/**
 * Host-side benchmark controller, shared by every build.
 *
 * Every run gets a brand-new sandboxed iframe, from one of two sources:
 *
 * - `inline`: the embedded sandbox bundle delivered via srcdoc. That is what
 *   keeps the single-file builds honest - no separate sandbox.html to fetch.
 * - `url`: a runner page on another origin. srcdoc inherits the embedder's
 *   Content-Security-Policy, so a host that forbids `unsafe-eval` (MCP Apps
 *   hosts do) makes the inline form unable to compile a test body at all. A
 *   cross-origin document brings its own CSP, which is the only way to run a
 *   benchmark inside such a host. See docs/mcp-app.md.
 *
 * Either way the iframe is discarded after the run, so no state is carried from
 * one run into the next.
 */

import type { TestCase } from './case.ts'
import type { RunOptions, SandboxCycleMessage, TestResult } from './protocol.ts'
import { isRecord, messageName } from './protocol.ts'
import { sandboxDocument } from './sandbox-document.ts'

export type RunnerState = 'ready' | 'running' | 'complete'

export interface RunnerHandlers {
  onStateChange(state: RunnerState): void
  onStatus(text: string): void
  onCycle(cycle: SandboxCycleMessage): void
  onComplete(results: TestResult[]): void
  onFailure(error: string): void
}

/** Where the sandbox document comes from. */
export type SandboxSource = { kind: 'inline'; js: string } | { kind: 'url'; url: string }

export class BenchRunner {
  private readonly container: HTMLElement
  private readonly source: SandboxSource
  private readonly handlers: RunnerHandlers
  private iframe: HTMLIFrameElement | undefined
  private pending: { testCase: TestCase; options: RunOptions } | undefined
  private state: RunnerState = 'ready'

  constructor(container: HTMLElement, source: SandboxSource, handlers: RunnerHandlers) {
    this.container = container
    this.source = source
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
    if (this.source.kind === 'inline') {
      iframe.srcdoc = sandboxDocument(this.source.js)
    } else {
      iframe.src = this.source.url
    }
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

  /**
   * Always '*', even for a runner on a known origin: `sandbox="allow-scripts"`
   * without `allow-same-origin` gives the frame an OPAQUE origin, which reports
   * as "null" and matches no targetOrigin at all - naming the URL's origin makes
   * every postMessage silently fail. The sandbox attribute is the boundary here,
   * not the targetOrigin, and the message only carries the test case the user is
   * about to run anyway.
   */
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
