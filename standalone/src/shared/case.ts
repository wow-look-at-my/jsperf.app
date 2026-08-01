/**
 * The test case model, shared by the app, the kiosk and the pack CLI.
 *
 * Kept free of DOM and Node APIs on purpose: the pack CLI type-checks against
 * the ESNext lib only (no DOM), the browser bundles against DOM (no Node), and
 * this file is the one thing both import.
 */

export interface BenchTest {
  title: string
  code: string
  async: boolean
}

export interface TestCase {
  title: string
  info: string
  initHTML: string
  setup: string
  teardown: string
  /** Kiosk only: start the benchmark as soon as the page loads. */
  autorun: boolean
  tests: BenchTest[]
}

export function emptyCase(): TestCase {
  return {
    title: '',
    info: '',
    initHTML: '',
    setup: '',
    teardown: '',
    autorun: false,
    tests: [
      { title: '', code: '', async: false },
      { title: '', code: '', async: false }
    ]
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asBool(value: unknown): boolean {
  return value === true
}

/**
 * Coerce arbitrary parsed JSON into a TestCase. Tolerant by design: hand-written
 * and LLM-written case files omit fields, and a jsperf.app page export carries
 * extra ones (slug, revision, authorName, ...). Unknown fields are dropped,
 * missing ones default, and the result is always a usable TestCase.
 *
 * Nothing is filtered out here - a half-written test with no code yet is a valid
 * editor draft, and dropping it would delete the user's row as they typed. Use
 * runnableCase() to get the set that will actually be measured.
 */
export function normalizeCase(input: unknown): TestCase {
  const source = isRecord(input) ? input : {}
  const rawTests = Array.isArray(source.tests) ? source.tests : []

  const tests: BenchTest[] = rawTests.map((raw, index): BenchTest => {
    const test = isRecord(raw) ? raw : {}
    return {
      title: asString(test.title) || `Test #${index + 1}`,
      code: asString(test.code),
      async: asBool(test.async)
    }
  })

  return {
    title: asString(source.title),
    info: asString(source.info),
    initHTML: asString(source.initHTML),
    setup: asString(source.setup),
    teardown: asString(source.teardown),
    autorun: asBool(source.autorun),
    tests
  }
}

/** A deep copy, so duplicating or importing a case never aliases another one. */
export function cloneCase(testCase: TestCase): TestCase {
  return { ...testCase, tests: testCase.tests.map(test => ({ ...test })) }
}

/**
 * The case as it will be measured: tests with no code are editor placeholders,
 * not benchmarks, and Benchmark.js reports an empty body as an infinitely fast
 * result. Titles are filled in so a row is never anonymous.
 */
export function runnableCase(testCase: TestCase): TestCase {
  return {
    ...testCase,
    tests: testCase.tests
      .filter(test => test.code.trim() !== '')
      .map((test, index) => ({ ...test, title: test.title.trim() === '' ? `Test #${index + 1}` : test.title }))
  }
}

/** Human-readable reasons a case cannot be run, empty when it is runnable. */
export function caseProblems(testCase: TestCase): string[] {
  const problems: string[] = []
  if (runnableCase(testCase).tests.length === 0) {
    problems.push('no test has any code in it')
  }
  return problems
}
