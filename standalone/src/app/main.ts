/**
 * The app build: the full jsPerf workflow in one file, with localStorage where
 * the Next.js app has MongoDB.
 *
 * Everything the hosted app does through an API happens locally here: cases are
 * created and edited in the browser, saved to localStorage as you type, exported
 * as JSON, shared as a URL fragment, and run in the same sandboxed iframe the
 * hosted app uses.
 */

import type { BenchTest, TestCase } from '../shared/case.ts'
import { cloneCase, emptyCase, normalizeCase, runnableCase } from '../shared/case.ts'
import { SANDBOX_BUNDLE } from '../generated/sandbox-bundle.ts'
import { button, copyText, download, el } from '../shared/dom.ts'
import { decodeCaseFromFragment, encodeCaseToFragment } from '../shared/hash.ts'
import { BenchPanel } from '../shared/panel.ts'
import { CaseStore, newCaseId } from './storage.ts'

const AUTOSAVE_MS = 400

const store = new CaseStore()

let currentId = ''
let currentCase: TestCase = emptyCase()
let autosaveTimer: number | undefined

const libraryEl = mustFind('jsperf-library')
const editorEl = mustFind('jsperf-editor')
const runnerEl = mustFind('jsperf-runner')
const storageNoteEl = mustFind('jsperf-storage-note')

const panel = new BenchPanel(runnerEl, SANDBOX_BUNDLE, () => currentCase)

const shareLinkInput = el('input')
shareLinkInput.type = 'text'
shareLinkInput.readOnly = true
shareLinkInput.dataset.jsperfField = 'share-link'
shareLinkInput.addEventListener('focus', () => shareLinkInput.select())

const shareLinkRow = el('div', { class: 'jsperf-field jsperf-share' }, [
  el('label', { text: 'Share link' }, [
    el('span', { class: 'jsperf-hint', text: 'the whole case, in the URL fragment' })
  ]),
  el('div', { class: 'jsperf-control' }, [shareLinkInput])
])
shareLinkRow.hidden = true

function mustFind(id: string): HTMLElement {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing element #${id}`)
  return node
}

function caseTitle(testCase: TestCase): string {
  return testCase.title.trim() === '' ? '(untitled)' : testCase.title
}

function scheduleSave(): void {
  // The controls track the model immediately; only the write to storage waits.
  panel.refresh()
  if (autosaveTimer !== undefined) window.clearTimeout(autosaveTimer)
  autosaveTimer = window.setTimeout(saveNow, AUTOSAVE_MS)
}

function saveNow(): void {
  if (autosaveTimer !== undefined) {
    window.clearTimeout(autosaveTimer)
    autosaveTimer = undefined
  }
  store.put(currentId, currentCase)
  renderLibrary()
  renderStorageNote()
}

function renderStorageNote(): void {
  if (!store.available) {
    storageNoteEl.textContent = 'This browser blocks storage: edits are kept in memory only.'
    return
  }
  const error = store.lastError()
  storageNoteEl.textContent = error === '' ? 'Saved in this browser (localStorage)' : `Could not save: ${error}`
}

function openCase(id: string): void {
  const record = store.get(id)
  if (!record) return
  currentId = record.id
  currentCase = record.testCase
  renderAll()
}

function adoptCase(testCase: TestCase): void {
  currentId = newCaseId()
  currentCase = testCase
  saveNow()
  renderAll()
}

function deleteCase(id: string): void {
  const record = store.get(id)
  const title = record ? caseTitle(record.testCase) : 'this test case'
  if (!window.confirm(`Delete ${title}? This cannot be undone.`)) return
  store.remove(id)
  if (id === currentId) {
    const next = store.list()[0]
    if (next) {
      openCase(next.id)
      return
    }
    adoptCase(emptyCase())
    return
  }
  renderLibrary()
}

function importJsonText(text: string): void {
  try {
    adoptCase(normalizeCase(JSON.parse(text)))
  } catch (error) {
    window.alert(`Could not read that file as a test case: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function exportJson(): void {
  const slug =
    caseTitle(currentCase)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'test-case'
  download(`${slug}.json`, `${JSON.stringify(runnableCase(currentCase), null, 2)}\n`, 'application/json')
}

async function copyShareLink(): Promise<void> {
  // href minus the fragment, NOT origin + pathname: a file:// page's origin is
  // the string "null", and these builds are usually opened from a file.
  const base = window.location.href.split('#')[0]
  const link = `${base}${encodeCaseToFragment(runnableCase(currentCase))}`

  // Always shown, not only copied: the clipboard is not reliably available from
  // a file:// page, and a link the user can select is never a dead end.
  shareLinkRow.hidden = false
  shareLinkInput.value = link
  shareLinkInput.select()

  const ok = await copyText(link)
  storageNoteEl.textContent = ok
    ? 'Share link copied (the whole test case travels in the URL fragment).'
    : 'Share link ready below; the clipboard is not available here.'
}

function field(label: string, hint: string, control: HTMLElement): HTMLElement {
  const labelEl = el('label', { text: label })
  if (hint !== '') labelEl.append(el('span', { class: 'jsperf-hint', text: hint }))
  return el('div', { class: 'jsperf-field' }, [labelEl, el('div', { class: 'jsperf-control' }, [control])])
}

// `name` becomes data-jsperf-field, the stable hook the browser smoke test
// drives the editor through.
function textInput(value: string, onInput: (value: string) => void, name: string): HTMLInputElement {
  const input = el('input')
  input.type = 'text'
  input.value = value
  input.dataset.jsperfField = name
  input.addEventListener('input', () => onInput(input.value))
  return input
}

function codeArea(value: string, onInput: (value: string) => void, name: string, rows = 6): HTMLTextAreaElement {
  const area = el('textarea', { class: 'jsperf-code' })
  area.rows = rows
  area.spellcheck = false
  area.value = value
  area.dataset.jsperfField = name
  area.addEventListener('input', () => onInput(area.value))
  return area
}

function checkbox(checked: boolean, onChange: (checked: boolean) => void, name: string): HTMLInputElement {
  const box = el('input')
  box.type = 'checkbox'
  box.checked = checked
  box.dataset.jsperfField = name
  box.addEventListener('change', () => onChange(box.checked))
  return box
}

function testFieldset(test: BenchTest, index: number): HTMLElement {
  const legend = el('legend', { text: `Test #${index + 1}` })
  const fieldset = el('fieldset', { class: 'jsperf-test' }, [legend])

  fieldset.append(
    field(
      'Title',
      '',
      textInput(
        test.title,
        value => {
          test.title = value
          scheduleSave()
        },
        `test-title-${index}`
      )
    )
  )

  const asyncBox = checkbox(
    test.async,
    checked => {
      test.async = checked
      scheduleSave()
    },
    `test-async-${index}`
  )
  fieldset.append(
    field(
      'Async',
      'the test body must call deferred.resolve()',
      el('label', { class: 'jsperf-async' }, [asyncBox, 'deferred'])
    )
  )

  fieldset.append(
    field(
      'Code',
      'the body that is measured',
      codeArea(
        test.code,
        value => {
          test.code = value
          scheduleSave()
        },
        `test-code-${index}`
      )
    )
  )

  if (currentCase.tests.length > 1) {
    fieldset.append(
      el('div', { class: 'jsperf-toolbar' }, [
        button(
          `Remove test #${index + 1}`,
          () => {
            currentCase.tests.splice(index, 1)
            saveNow()
            renderEditor()
            panel.syncTests()
          },
          'jsperf-secondary'
        )
      ])
    )
  }

  return fieldset
}

function renderToolbar(): HTMLElement {
  const fileInput = el('input')
  fileInput.type = 'file'
  fileInput.accept = '.json,application/json'
  fileInput.hidden = true
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    if (!file) return
    file
      .text()
      .then(importJsonText)
      .catch((error: unknown) => window.alert(`Could not read the file: ${String(error)}`))
    fileInput.value = ''
  })

  return el('div', { class: 'jsperf-toolbar' }, [
    button('New test case', () => adoptCase(emptyCase())),
    button('Duplicate', () => adoptCase({ ...cloneCase(currentCase), title: `${caseTitle(currentCase)} (copy)` }), 'jsperf-secondary'),
    button('Import JSON', () => fileInput.click(), 'jsperf-secondary'),
    button('Export JSON', () => exportJson(), 'jsperf-secondary'),
    button(
      'Copy share link',
      () => {
        void copyShareLink()
      },
      'jsperf-secondary'
    ),
    fileInput
  ])
}

function renderLibrary(): void {
  libraryEl.textContent = ''
  libraryEl.append(el('h2', { text: 'Saved test cases' }))

  const records = store.list()
  if (records.length === 0) {
    libraryEl.append(el('p', { class: 'jsperf-note', text: 'Nothing saved yet. Edit the case below and it is saved as you type.' }))
    return
  }

  const table = el('table', { class: 'jsperf-library' })
  const head = el('tr', {}, [
    el('th', { text: 'Title' }),
    el('th', { text: 'Tests' }),
    el('th', { text: 'Last edited' }),
    el('th', { text: '' })
  ])
  table.append(el('thead', {}, [head]))

  const body = el('tbody')
  for (const record of records) {
    const row = el('tr', { class: record.id === currentId ? 'jsperf-current' : '' }, [
      el('td', { text: caseTitle(record.testCase) }),
      el('td', { text: String(runnableCase(record.testCase).tests.length) }),
      el('td', { text: record.updated > 0 ? new Date(record.updated).toLocaleString() : 'unknown' })
    ])
    const actions = el('td', { class: 'jsperf-actions' }, [
      button('Open', () => openCase(record.id), 'jsperf-secondary'),
      button('Delete', () => deleteCase(record.id), 'jsperf-link')
    ])
    row.append(actions)
    body.append(row)
  }
  table.append(body)
  libraryEl.append(table)
}

function renderEditor(): void {
  editorEl.textContent = ''
  editorEl.append(el('h2', { text: 'Test case' }), renderToolbar(), shareLinkRow)

  editorEl.append(
    field(
      'Title',
      '',
      textInput(
        currentCase.title,
        value => {
          currentCase.title = value
          scheduleSave()
        },
        'title'
      )
    ),
    field(
      'Description',
      'plain text, shown above the results',
      codeArea(
        currentCase.info,
        value => {
          currentCase.info = value
          scheduleSave()
        },
        'info',
        4
      )
    ),
    field(
      'Preparation HTML',
      'inserted into the sandbox body before the run; <script> tags are executed in order',
      codeArea(
        currentCase.initHTML,
        value => {
          currentCase.initHTML = value
          scheduleSave()
        },
        'init-html'
      )
    ),
    field(
      'Setup JS',
      'runs before each sample, outside the measured body',
      codeArea(
        currentCase.setup,
        value => {
          currentCase.setup = value
          scheduleSave()
        },
        'setup'
      )
    ),
    field(
      'Teardown JS',
      'runs after each sample',
      codeArea(
        currentCase.teardown,
        value => {
          currentCase.teardown = value
          scheduleSave()
        },
        'teardown'
      )
    )
  )

  const autorunBox = checkbox(
    currentCase.autorun,
    checked => {
      currentCase.autorun = checked
      scheduleSave()
    },
    'autorun'
  )
  editorEl.append(
    field(
      'Autorun',
      'packaged kiosk pages start the benchmark on load',
      el('label', { class: 'jsperf-async' }, [autorunBox, 'run on load'])
    )
  )

  editorEl.append(el('h2', { text: 'Tests' }))
  currentCase.tests.forEach((test, index) => {
    editorEl.append(testFieldset(test, index))
  })

  editorEl.append(
    el('div', { class: 'jsperf-toolbar' }, [
      button('Add test', () => {
        currentCase.tests.push({ title: '', code: '', async: false })
        saveNow()
        renderEditor()
        panel.syncTests()
      })
    ])
  )

  const packaging = el('div', { class: 'jsperf-packaging' }, [
    el('p', { text: 'Package this case as a standalone kiosk page (runner only, no editor):' }),
    el('pre', {}, [
      el('code', { text: 'node jsperf-pack.mjs build ./my-case.json -o my-benchmark.html' })
    ]),
    el('p', {
      class: 'jsperf-note',
      text: 'Export JSON above writes the case file the CLI reads. "Copy share link" is the no-CLI route: it puts the whole case in the URL fragment.'
    })
  ])
  editorEl.append(packaging)
}

function renderAll(): void {
  renderLibrary()
  renderEditor()
  renderStorageNote()
  panel.syncTests()
}

function start(): void {
  const shared = decodeCaseFromFragment(window.location.hash)
  if (shared) {
    // A shared link is imported as a new local case, so opening one never
    // overwrites what is already saved in this browser. The fragment is dropped
    // once it has been adopted, so a reload opens the saved copy instead of
    // importing a second one.
    adoptCase(shared)
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    return
  }

  const existing = store.list()[0]
  if (existing) {
    currentId = existing.id
    currentCase = existing.testCase
    renderAll()
    return
  }

  currentId = newCaseId()
  currentCase = emptyCase()
  renderAll()
}

// Pasting a share link into an open tab changes only the fragment, which is a
// same-document navigation; reload so it is imported.
window.addEventListener('hashchange', () => {
  if (window.location.hash !== '') window.location.reload()
})

start()
