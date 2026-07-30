/**
 * The run panel: controls, live status, results table and result export.
 *
 * Both builds mount this. The kiosk is this panel and nothing else; the app puts
 * an editor above it.
 */

import type { TestCase } from './case.ts'
import { caseProblems, runnableCase } from './case.ts'
import { button, copyText, download, el } from './dom.ts'
import { ResultsTable } from './results.ts'
import { BenchRunner } from './runner.ts'
import type { RunnerState } from './runner.ts'

/** Benchmark.js maxTime per test, in seconds. */
const FULL_RUN_MAX_TIME = 5
const QUICK_RUN_MAX_TIME = 0.5

export class BenchPanel {
  private readonly runner: BenchRunner
  private readonly table: ResultsTable
  private readonly statusEl: HTMLParagraphElement
  private readonly runButton: HTMLButtonElement
  private readonly quickButton: HTMLButtonElement
  private readonly stopButton: HTMLButtonElement
  private readonly copyMarkdownButton: HTMLButtonElement
  private readonly copyJsonButton: HTMLButtonElement
  private readonly downloadButton: HTMLButtonElement
  private readonly getCase: () => TestCase

  constructor(root: HTMLElement, sandboxJs: string, getCase: () => TestCase) {
    this.getCase = getCase
    this.statusEl = el('p', { class: 'jsperf-status', text: 'Ready to run.' })
    this.runButton = button('Run', () => this.runFull())
    this.quickButton = button('Quick run', () => this.runQuick(), 'jsperf-secondary')
    this.stopButton = button('Stop', () => this.runner.stop())
    this.copyMarkdownButton = button('Copy results', () => this.copy('markdown'), 'jsperf-secondary')
    this.copyJsonButton = button('Copy JSON', () => this.copy('json'), 'jsperf-secondary')
    this.downloadButton = button('Download JSON', () => this.saveJson(), 'jsperf-secondary')

    const controls = el('div', { class: 'jsperf-controls' }, [
      this.statusEl,
      this.runButton,
      this.quickButton,
      this.stopButton
    ])

    const sandboxHost = el('div', { class: 'jsperf-sandbox-host' })
    const tableHost = el('div')
    const exportRow = el('div', { class: 'jsperf-controls' }, [
      this.copyMarkdownButton,
      this.copyJsonButton,
      this.downloadButton
    ])

    root.append(controls, sandboxHost, tableHost, exportRow)

    this.table = new ResultsTable(tableHost)
    this.runner = new BenchRunner(sandboxHost, sandboxJs, {
      onStateChange: state => this.applyState(state),
      onStatus: text => {
        this.statusEl.textContent = text
      },
      onCycle: cycle => this.table.applyCycle(cycle),
      onComplete: results => {
        this.table.applyResults(results)
        this.applyState('complete')
      },
      onFailure: () => this.applyState('ready')
    })

    this.applyState('ready')
  }

  /**
   * Rebuild the table from the current case. Callers do this when the set of
   * tests changes; a run always re-reads the case itself, so the numbers can
   * never come from a stale snapshot of the editor.
   */
  syncTests(): void {
    this.table.setTests(runnableCase(this.getCase()).tests)
    this.applyState(this.runner.getState())
  }

  /**
   * Re-evaluate what the controls should look like. The app calls this as the
   * editor changes: a case becomes runnable the moment a test has code in it,
   * and a Run button that stays disabled until a reload is a dead end.
   */
  refresh(): void {
    this.applyState(this.runner.getState())
  }

  /** A full run: Benchmark.js samples each test for up to 5s. */
  runFull(): void {
    this.run(FULL_RUN_MAX_TIME)
  }

  /** A quick run: same machinery, 0.5s per test, noisier numbers. */
  runQuick(): void {
    this.run(QUICK_RUN_MAX_TIME)
  }

  private run(maxTime: number): void {
    const problems = caseProblems(this.getCase())
    if (problems.length > 0) {
      this.statusEl.textContent = `Cannot run: ${problems.join('; ')}.`
      return
    }
    const testCase = runnableCase(this.getCase())
    this.table.setTests(testCase.tests)
    this.table.markAllPending()
    this.runner.run(testCase, { maxTime })
  }

  private applyState(state: RunnerState): void {
    const runnable = caseProblems(this.getCase()).length === 0
    const idle = state !== 'running'
    this.runButton.hidden = !idle
    this.quickButton.hidden = !idle
    this.stopButton.hidden = idle
    this.runButton.disabled = !runnable
    this.quickButton.disabled = !runnable
    this.runButton.textContent = state === 'complete' ? 'Run again' : 'Run'

    const hasResults = this.table.hasResults()
    for (const node of [this.copyMarkdownButton, this.copyJsonButton, this.downloadButton]) {
      node.disabled = !hasResults
    }
  }

  private async copy(format: 'markdown' | 'json'): Promise<void> {
    const title = this.getCase().title
    const text = format === 'markdown' ? this.table.toMarkdown(title) : this.table.toJSON(title)
    const ok = await copyText(text)
    this.statusEl.textContent = ok
      ? `Copied results as ${format}.`
      : 'Could not reach the clipboard; use Download JSON instead.'
  }

  private saveJson(): void {
    const title = this.getCase().title
    const slug = (title.trim() === '' ? 'benchmark' : title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
    download(`${slug || 'benchmark'}-results.json`, this.table.toJSON(title), 'application/json')
  }
}
