/**
 * jsperf-pack: turn files into one self-contained benchmark page.
 *
 * The kiosk template is embedded in this file at build time, so packaging needs
 * nothing but Node: no npm install, no network, no checkout. That is the point -
 * an agent or a script can produce a single .html a person opens in whichever
 * browser they want to measure.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import type { TestCase } from '../../src/shared/case.ts'
import { emptyCase, normalizeCase, runnableCase } from '../../src/shared/case.ts'
import { embedCase, hasCaseSlot } from '../../src/shared/embed.ts'
import { KIOSK_TEMPLATE, KIOSK_TEMPLATE_VERSION } from './generated/kiosk-template.ts'
import { CASE_JSON, TESTS_DIR, loadCaseFromPath, loadTestFile, readTextFile } from './case-files.ts'

const USAGE = `jsperf-pack - package a JavaScript benchmark into one self-contained HTML file

Usage:
  jsperf-pack build [<path>] [options]   build a benchmark page
  jsperf-pack init [<dir>]               write an example test case to edit
  jsperf-pack json [<path>] [options]    print the normalised case JSON
  jsperf-pack help | --help              this text
  jsperf-pack version | --version        template build stamp

<path> is one of:
  a directory   ${CASE_JSON} (optional) plus ${TESTS_DIR}/*.js, info.md, init.html,
                setup.js, teardown.js - each part optional, tests ordered by filename
  a .json file  a case file, as written by the app build's "Export JSON"
  a .js file    a single test

Options:
  -o, --out <file>        output path (default: derived from the case title)
      --stdout            write the page to stdout instead of a file
  -t, --test <file>       add a test from a .js file (repeatable, appended in order)
      --title <text>      set the case title
      --info <file>       description file (markdown source is shown as plain text)
      --setup <file>      setup JS, runs before each sample
      --teardown <file>   teardown JS, runs after each sample
      --init-html <file>  preparation HTML, inserted into the sandbox body
      --autorun           start the benchmark when the page opens
      --no-autorun        do not start automatically (the default)
      --write-json <file> also write the normalised case JSON

A test file may open with directive comments:
  // @name Array.prototype.forEach
  // @async

Examples:
  jsperf-pack init my-case
  jsperf-pack build my-case -o my-benchmark.html
  jsperf-pack build --title "split vs slice" -t split.js -t slice.js --autorun
`

interface Flags {
  paths: string[]
  out: string
  stdout: boolean
  tests: string[]
  title: string
  info: string
  setup: string
  teardown: string
  initHtml: string
  autorun: boolean | undefined
  writeJson: string
}

class UsageError extends Error {}

function nextValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('-')) {
    throw new UsageError(`${flag} needs a value`)
  }
  return value
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {
    paths: [],
    out: '',
    stdout: false,
    tests: [],
    title: '',
    info: '',
    setup: '',
    teardown: '',
    initHtml: '',
    autorun: undefined,
    writeJson: ''
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    switch (arg) {
      case '-o':
      case '--out':
        flags.out = nextValue(args, i, arg)
        i += 1
        break
      case '--stdout':
        flags.stdout = true
        break
      case '-t':
      case '--test':
        flags.tests.push(nextValue(args, i, arg))
        i += 1
        break
      case '--title':
        flags.title = nextValue(args, i, arg)
        i += 1
        break
      case '--info':
        flags.info = nextValue(args, i, arg)
        i += 1
        break
      case '--setup':
        flags.setup = nextValue(args, i, arg)
        i += 1
        break
      case '--teardown':
        flags.teardown = nextValue(args, i, arg)
        i += 1
        break
      case '--init-html':
        flags.initHtml = nextValue(args, i, arg)
        i += 1
        break
      case '--autorun':
        flags.autorun = true
        break
      case '--no-autorun':
        flags.autorun = false
        break
      case '--write-json':
        flags.writeJson = nextValue(args, i, arg)
        i += 1
        break
      default:
        if (arg.startsWith('-')) {
          throw new UsageError(`unknown option ${arg}`)
        }
        flags.paths.push(arg)
        break
    }
  }

  if (flags.paths.length > 1) {
    throw new UsageError(`expected at most one path, got ${flags.paths.length}`)
  }

  return flags
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function buildCase(flags: Flags): TestCase {
  const base = flags.paths.length === 1 ? loadCaseFromPath(flags.paths[0]) : emptyCase()

  const testCase: TestCase = {
    ...base,
    tests: [...base.tests.filter(test => test.code.trim() !== ''), ...flags.tests.map(loadTestFile)]
  }

  if (flags.title !== '') testCase.title = flags.title
  if (flags.info !== '') testCase.info = readTextFile(flags.info)
  if (flags.setup !== '') testCase.setup = readTextFile(flags.setup)
  if (flags.teardown !== '') testCase.teardown = readTextFile(flags.teardown)
  if (flags.initHtml !== '') testCase.initHTML = readTextFile(flags.initHtml)
  if (flags.autorun !== undefined) testCase.autorun = flags.autorun

  const packaged = runnableCase(normalizeCase(testCase))

  if (packaged.tests.length === 0) {
    throw new UsageError(
      'the case has no tests. Point at a case directory or .json file, or pass one or more --test <file.js>'
    )
  }

  return packaged
}

function defaultOutName(testCase: TestCase, flags: Flags): string {
  const fromTitle = slug(testCase.title)
  if (fromTitle !== '') return `${fromTitle}.html`
  const fromPath = flags.paths.length === 1 ? slug(basename(flags.paths[0]).replace(/\.[^.]+$/, '')) : ''
  return `${fromPath === '' ? 'benchmark' : fromPath}.html`
}

function writeFile(path: string, contents: string): string {
  const absolute = resolve(process.cwd(), path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents)
  return absolute
}

function assertTemplateUsable(): void {
  if (KIOSK_TEMPLATE.length < 1000 || !hasCaseSlot(KIOSK_TEMPLATE)) {
    throw new Error(
      'this build of jsperf-pack has no usable kiosk template embedded (build standalone/ with scripts/build.mjs)'
    )
  }
}

function commandBuild(flags: Flags): void {
  assertTemplateUsable()
  const testCase = buildCase(flags)
  const html = embedCase(KIOSK_TEMPLATE, testCase)

  if (flags.writeJson !== '') {
    const jsonPath = writeFile(flags.writeJson, `${JSON.stringify(testCase, null, 2)}\n`)
    console.error(`wrote ${jsonPath}`)
  }

  if (flags.stdout) {
    process.stdout.write(html)
    return
  }

  const out = flags.out === '' ? defaultOutName(testCase, flags) : flags.out
  const path = writeFile(out, html)
  const tests = testCase.tests.length
  console.error(`wrote ${path} (${tests} test${tests === 1 ? '' : 's'}, ${Math.round(html.length / 1024)} KiB, opens offline)`)
}

function commandJson(flags: Flags): void {
  const testCase = buildCase(flags)
  const json = `${JSON.stringify(testCase, null, 2)}\n`
  if (flags.out === '' || flags.stdout) {
    process.stdout.write(json)
    return
  }
  console.error(`wrote ${writeFile(flags.out, json)}`)
}

const EXAMPLE_CASE_JSON = `{
  "title": "String concatenation",
  "autorun": false
}
`

const EXAMPLE_INFO = `Which way of joining strings in a loop is fastest in your browser?

Every part of this file is optional: delete what you do not need.
`

const EXAMPLE_SETUP = `const parts = []
for (let i = 0; i < 100; i += 1) {
  parts.push('item-' + i)
}
`

const EXAMPLE_TESTS: [string, string][] = [
  [
    '01-plus-equals.js',
    `// @name += in a loop
let out = ''
for (const part of parts) {
  out += part
}
`
  ],
  [
    '02-array-join.js',
    `// @name Array#join
const out = parts.join('')
`
  ]
]

function commandInit(flags: Flags): void {
  const dir = flags.paths.length === 1 ? flags.paths[0] : 'jsperf-case'
  const created: string[] = []

  created.push(writeFile(`${dir}/${CASE_JSON}`, EXAMPLE_CASE_JSON))
  created.push(writeFile(`${dir}/info.md`, EXAMPLE_INFO))
  created.push(writeFile(`${dir}/setup.js`, EXAMPLE_SETUP))
  for (const [name, source] of EXAMPLE_TESTS) {
    created.push(writeFile(`${dir}/${TESTS_DIR}/${name}`, source))
  }

  for (const path of created) {
    console.error(`created ${path}`)
  }
  console.error('')
  console.error(`Next: jsperf-pack build ${dir} -o benchmark.html`)
}

function main(argv: string[]): number {
  const [command, ...rest] = argv

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE)
    return 0
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`jsperf-pack (kiosk template ${KIOSK_TEMPLATE_VERSION})\n`)
    return 0
  }

  try {
    switch (command) {
      case 'build':
        commandBuild(parseFlags(rest))
        return 0
      case 'json':
        commandJson(parseFlags(rest))
        return 0
      case 'init':
        commandInit(parseFlags(rest))
        return 0
      default:
        throw new UsageError(`unknown command '${command}'`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`jsperf-pack: ${message}`)
    if (error instanceof UsageError) {
      console.error('')
      process.stderr.write(USAGE)
    }
    return 1
  }
}

// exitCode rather than process.exit(): exit() can truncate a piped stdout
// mid-write, and `jsperf-pack build --stdout | ...` is a supported form.
process.exitCode = main(process.argv.slice(2))
