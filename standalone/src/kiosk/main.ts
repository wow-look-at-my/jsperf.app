/**
 * The kiosk build: one packaged benchmark, a Run button, results.
 *
 * Deliberately has no editor, no saved-case list and no storage access - it is
 * the variant you hand to someone else to open in their browser. The case is
 * baked into the file by `jsperf-pack build`; an unpackaged template accepts a
 * case from the URL fragment so the same file can be shared as a link.
 */

import type { TestCase } from '../shared/case.ts'
import { normalizeCase, runnableCase } from '../shared/case.ts'
import { SANDBOX_BUNDLE } from '../generated/sandbox-bundle.ts'
import { el, paragraphs } from '../shared/dom.ts'
import { CASE_SCRIPT_ID } from '../shared/embed.ts'
import { decodeCaseFromFragment } from '../shared/hash.ts'
import { BenchPanel } from '../shared/panel.ts'

function embeddedCase(): TestCase | null {
  const node = document.getElementById(CASE_SCRIPT_ID)
  const text = node?.textContent ?? ''
  if (text.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null) return null
    const testCase = runnableCase(normalizeCase(parsed))
    return testCase.tests.length > 0 ? testCase : null
  } catch {
    return null
  }
}

function preparationDetails(testCase: TestCase): HTMLElement[] {
  const sections: [string, string][] = [
    ['Preparation HTML', testCase.initHTML],
    ['Setup JS', testCase.setup],
    ['Teardown JS', testCase.teardown]
  ]
  return sections
    .filter(([, body]) => body.trim() !== '')
    .map(([label, body]) =>
      el('details', { class: 'jsperf-prep' }, [
        el('summary', { text: label }),
        el('pre', {}, [el('code', { text: body })])
      ])
    )
}

function renderEmptyState(main: HTMLElement): void {
  main.append(
    el('div', { class: 'jsperf-empty' }, [
      el('p', { text: 'This kiosk page carries no benchmark yet.' }),
      el('p', {
        text: 'It is the empty template. Package a test case into it with the jsperf-pack CLI:'
      }),
      el('pre', {}, [el('code', { text: 'node jsperf-pack.mjs build ./my-case -o my-benchmark.html' })]),
      el('p', {
        text: 'Alternatively, append a case to the URL as #case=<base64url JSON> - the app build produces that link for you.'
      })
    ])
  )
}

function main(): void {
  const titleEl = document.getElementById('jsperf-title')
  const mainEl = document.getElementById('jsperf-main')
  if (!titleEl || !mainEl) return

  const testCase = embeddedCase() ?? decodeCaseFromFragment(window.location.hash)

  if (!testCase) {
    renderEmptyState(mainEl)
    return
  }

  const title = testCase.title.trim() === '' ? 'Benchmark' : testCase.title
  titleEl.textContent = title
  document.title = `${title} - jsPerf`

  if (testCase.info.trim() !== '') {
    mainEl.append(el('div', { class: 'jsperf-info' }, paragraphs(testCase.info)))
  }

  const prep = preparationDetails(testCase)
  if (prep.length > 0) {
    mainEl.append(el('h2', { text: 'Preparation' }), ...prep)
  }

  mainEl.append(el('h2', { text: 'Test runner' }))
  const panelHost = el('div')
  mainEl.append(panelHost)

  const panel = new BenchPanel(panelHost, SANDBOX_BUNDLE, () => testCase)
  panel.syncTests()

  if (testCase.autorun) {
    panel.runFull()
  }
}

// A `#case=` link pasted into an already-open kiosk tab is a different
// benchmark, but a fragment change is a same-document navigation: reload so the
// new case is actually loaded instead of silently ignored.
window.addEventListener('hashchange', () => {
  window.location.reload()
})

main()
