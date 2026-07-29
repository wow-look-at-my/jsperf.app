/**
 * The results table, shared by the app and the kiosk.
 *
 * Code is rendered with textContent rather than a syntax highlighter: it keeps
 * the single-file bundle dependency-free, and a test case is untrusted input in
 * the kiosk (someone else packaged it), so never HTML.
 */

import type { BenchTest } from './case.ts'
import type { SandboxCycleMessage, TestResult, TestStatus } from './protocol.ts'

const STATUS_LABEL: Record<TestStatus, string> = {
  default: 'ready',
  pending: 'pending...',
  running: 'running...',
  completed: 'completed',
  finished: 'finished',
  error: 'ERROR'
}

export function browserLabel(): string {
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[] } }).userAgentData?.brands
  if (brands && brands.length > 0) {
    const named = brands.filter(entry => !/not.?a.?brand/i.test(entry.brand))
    const pick = named.length > 0 ? named : brands
    return pick.map(entry => `${entry.brand} ${entry.version}`).join(' / ')
  }
  return navigator.userAgent
}

interface Row {
  status: HTMLTableCellElement
  test: BenchTest
  result: TestResult | undefined
  status_: TestStatus
}

export class ResultsTable {
  private readonly root: HTMLElement
  private rows: Row[] = []
  private tests: BenchTest[] = []

  constructor(root: HTMLElement) {
    this.root = root
  }

  /** Rebuild the table for a set of tests, clearing any previous results. */
  setTests(tests: BenchTest[]): void {
    this.tests = tests
    this.rows = []
    this.root.textContent = ''

    const table = document.createElement('table')
    table.className = 'jsperf-results'

    const caption = document.createElement('caption')
    caption.textContent = `Testing in ${browserLabel()}`
    table.appendChild(caption)

    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    for (const [label, title] of [
      ['Test', ''],
      ['Code', ''],
      ['Ops/sec', 'Operations per second (higher is better)']
    ] as const) {
      const th = document.createElement('th')
      th.textContent = label
      if (title) th.title = title
      headRow.appendChild(th)
    }
    thead.appendChild(headRow)
    table.appendChild(thead)

    const tbody = document.createElement('tbody')
    for (const test of tests) {
      const tr = document.createElement('tr')

      const titleCell = document.createElement('td')
      titleCell.className = 'jsperf-test-title'
      titleCell.textContent = test.title
      tr.appendChild(titleCell)

      const codeCell = document.createElement('td')
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      code.textContent = test.code
      pre.appendChild(code)
      codeCell.appendChild(pre)
      tr.appendChild(codeCell)

      const statusCell = document.createElement('td')
      statusCell.className = 'jsperf-test-result'
      statusCell.textContent = STATUS_LABEL.default
      tr.appendChild(statusCell)

      tbody.appendChild(tr)
      this.rows.push({ status: statusCell, test, result: undefined, status_: 'default' })
    }
    table.appendChild(tbody)
    this.root.appendChild(table)
  }

  markAllPending(): void {
    for (const row of this.rows) {
      row.result = undefined
      row.status_ = 'pending'
      row.status.className = 'jsperf-test-result'
      row.status.textContent = STATUS_LABEL.pending
    }
  }

  applyCycle(cycle: SandboxCycleMessage): void {
    const row = this.rows[cycle.id]
    if (!row) return
    row.status_ = cycle.status
    if (cycle.status !== 'finished') {
      row.status.textContent = STATUS_LABEL[cycle.status] ?? cycle.status
    }
  }

  applyResults(results: TestResult[]): void {
    for (const result of results) {
      const row = this.rows[result.id]
      if (!row) continue
      row.result = result
      row.status_ = result.status
      row.status.textContent = ''
      row.status.className = `jsperf-test-result${result.fastest ? ' jsperf-fastest' : ''}${result.slowest ? ' jsperf-slowest' : ''}${
        result.status === 'error' ? ' jsperf-error' : ''
      }`

      if (result.status === 'error') {
        const label = document.createElement('p')
        label.textContent = STATUS_LABEL.error
        row.status.appendChild(label)
        if (result.error) {
          const detail = document.createElement('small')
          detail.textContent = result.error
          row.status.appendChild(detail)
        }
        continue
      }

      const hz = document.createElement('p')
      hz.className = 'jsperf-hz'
      hz.textContent = result.hz
      row.status.appendChild(hz)

      const rme = document.createElement('small')
      rme.textContent = `\u00b1${result.rme}%`
      row.status.appendChild(rme)

      const relative = document.createElement('p')
      relative.className = 'jsperf-relative'
      relative.textContent = result.fastest ? 'fastest' : `${result.percent}% slower`
      row.status.appendChild(relative)
    }
  }

  hasResults(): boolean {
    return this.rows.some(row => row.result !== undefined)
  }

  /** Results as a markdown table - the shape to paste back into a chat or issue. */
  toMarkdown(title: string): string {
    const lines: string[] = []
    if (title.trim() !== '') lines.push(`### ${title.trim()}`, '')
    lines.push(`Browser: ${browserLabel()}`, '')
    lines.push('| Test | Ops/sec | \u00b1% | Samples | Relative |', '| --- | --- | --- | --- | --- |')
    for (const row of this.rows) {
      const result = row.result
      const cells = result
        ? [
            row.test.title,
            result.status === 'error' ? 'ERROR' : result.hz,
            result.status === 'error' ? '' : `\u00b1${result.rme}%`,
            String(result.samples),
            result.status === 'error' ? result.error : result.fastest ? 'fastest' : `${result.percent}% slower`
          ]
        : [row.test.title, 'not run', '', '', '']
      lines.push(`| ${cells.map(cell => cell.replace(/\|/g, '\\|')).join(' | ')} |`)
    }
    return `${lines.join('\n')}\n`
  }

  toJSON(title: string): string {
    return `${JSON.stringify(
      {
        title,
        browser: browserLabel(),
        userAgent: navigator.userAgent,
        results: this.rows.map(row => ({
          title: row.test.title,
          status: row.status_,
          opsPerSecond: row.result ? row.result.hzRaw : null,
          rme: row.result && row.result.rme !== '' ? Number(row.result.rme) : null,
          samples: row.result ? row.result.samples : 0,
          fastest: row.result ? row.result.fastest : false,
          error: row.result ? row.result.error : ''
        }))
      },
      null,
      2
    )}\n`
  }

  getTests(): BenchTest[] {
    return this.tests
  }
}
