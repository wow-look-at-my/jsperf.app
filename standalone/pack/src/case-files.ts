/**
 * Reading a test case off disk.
 *
 * Two input shapes, because two kinds of author use this: a single `case.json`
 * (what the app's "Export JSON" writes, and what a program generates), or a
 * directory of ordinary files (what a human or an LLM writes by hand, where each
 * test is its own readable .js file).
 *
 * Directory layout - every part optional except the tests:
 *
 *   my-case/
 *     case.json     title/info/autorun (and tests, if you prefer them inline)
 *     info.md       description shown above the results
 *     init.html     preparation HTML, inserted into the sandbox body
 *     setup.js      runs before each sample
 *     teardown.js   runs after each sample
 *     tests/
 *       01-forEach.js
 *       02-for-of.js
 *
 * Tests are ordered by filename, which is why the examples number them. A test
 * file may start with directive comments:
 *
 *   // @name Array.prototype.forEach
 *   // @async
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { BenchTest, TestCase } from '../../src/shared/case.ts'
import { emptyCase, normalizeCase } from '../../src/shared/case.ts'

const TEST_EXTENSIONS = ['.js', '.mjs', '.cjs']

export const CASE_JSON = 'case.json'
export const TESTS_DIR = 'tests'

function read(path: string): string {
  return readFileSync(path, 'utf-8')
}

function readIfPresent(path: string): string {
  return existsSync(path) ? read(path) : ''
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory()
}

/** "01-for-of.js" -> "for of"; a name a reader recognises without editing it. */
export function titleFromFilename(filename: string): string {
  return basename(filename, extname(filename))
    .replace(/^[0-9]+[-_. ]*/, '')
    .replace(/[-_]+/g, ' ')
    .trim()
}

/**
 * Parse one test file. Leading `// @name` / `// @async` directives are consumed;
 * everything else is the measured body, verbatim, so line numbers in a browser
 * error still point at what you wrote.
 */
export function parseTestFile(filename: string, source: string): BenchTest {
  const lines = source.split('\n')
  let title = ''
  let isAsync = false
  let consumed = 0

  for (const line of lines) {
    const directive = /^\s*\/\/\s*@(name|title|async)\b[ \t]*(.*)$/.exec(line)
    if (!directive) break
    const [, key, value] = directive
    if (key === 'async') {
      isAsync = value.trim() === '' || value.trim() === 'true'
    } else {
      title = value.trim()
    }
    consumed += 1
  }

  const code = lines.slice(consumed).join('\n').replace(/^\n+/, '').replace(/\s+$/, '')

  return {
    title: title === '' ? titleFromFilename(filename) : title,
    code,
    async: isAsync
  }
}

function testsFromDirectory(dir: string): BenchTest[] {
  if (!isDirectory(dir)) return []
  return readdirSync(dir)
    .filter(name => TEST_EXTENSIONS.includes(extname(name).toLowerCase()))
    .sort()
    .map(name => parseTestFile(name, read(join(dir, name))))
}

function caseFromDirectory(dir: string): TestCase {
  const meta = existsSync(join(dir, CASE_JSON)) ? parseCaseJson(read(join(dir, CASE_JSON))) : emptyCase()

  const fileTests = testsFromDirectory(join(dir, TESTS_DIR))
  const inlineTests = meta.tests.filter(test => test.code.trim() !== '')

  // A file wins over the same field in case.json: it is the more specific, more
  // editable place to put prose or code.
  const info = readIfPresent(join(dir, 'info.md'))
  const initHTML = readIfPresent(join(dir, 'init.html'))
  const setup = readIfPresent(join(dir, 'setup.js'))
  const teardown = readIfPresent(join(dir, 'teardown.js'))

  return {
    title: meta.title,
    info: info.trim() === '' ? meta.info : info,
    initHTML: initHTML.trim() === '' ? meta.initHTML : initHTML,
    setup: setup.trim() === '' ? meta.setup : setup,
    teardown: teardown.trim() === '' ? meta.teardown : teardown,
    autorun: meta.autorun,
    tests: [...inlineTests, ...fileTests]
  }
}

export function parseCaseJson(text: string): TestCase {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return normalizeCase(parsed)
}

/**
 * Load a case from a path: a directory (the layout above), a .json case file, or
 * a single .js file treated as a one-test case.
 */
export function loadCaseFromPath(path: string): TestCase {
  if (!existsSync(path)) {
    throw new Error(`no such file or directory: ${path}`)
  }
  if (isDirectory(path)) {
    return caseFromDirectory(path)
  }
  const ext = extname(path).toLowerCase()
  if (ext === '.json') {
    try {
      return parseCaseJson(read(path))
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (TEST_EXTENSIONS.includes(ext)) {
    const test = parseTestFile(basename(path), read(path))
    return { ...emptyCase(), tests: [test] }
  }
  throw new Error(`${path}: expected a case directory, a .json case file, or a .js test file`)
}

export function loadTestFile(path: string): BenchTest {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`no such test file: ${path}`)
  }
  return parseTestFile(basename(path), read(path))
}

export function readTextFile(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`no such file: ${path}`)
  }
  return read(path)
}
