/**
 * Assert the properties the standalone artifacts are supposed to have.
 *
 *   node --experimental-strip-types standalone/scripts/verify.ts
 *
 * These are requirements, so they are checks: each claim the README makes about
 * these files is asserted here, and CI runs this after every build. Nothing here
 * needs a browser (scripts/browser-smoke.ts does that part).
 *
 * This file is type-checked by the project's gate, which every ts0 build in
 * scripts/build.ts runs - so `npm run build` before `npm run verify` (what CI and
 * `npm run check` do) means it is always checked before it runs.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const standaloneDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(standaloneDir, 'dist')

const APP = join(dist, 'jsperf.html')
const KIOSK = join(dist, 'jsperf-kiosk.html')
const PACK = join(dist, 'jsperf-pack.mjs')
const EXAMPLE = join(standaloneDir, 'examples', 'array-iteration')
const RUNNER = join(dist, 'runner.html')
const MCP_APP = join(dist, 'jsperf-mcp-app.html')
const MCP_SERVER = join(dist, 'jsperf-mcp-server.mjs')

/** The shape the CLI writes into a packaged page. */
interface PackagedTest {
  title: string
  code: string
  async: boolean
}

interface PackagedCase {
  title: string
  info: string
  initHTML: string
  setup: string
  teardown: string
  autorun: boolean
  tests: PackagedTest[]
}

interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
}

let failures = 0
let checks = 0

function check(condition: boolean, description: string, detail = ''): boolean {
  checks += 1
  if (condition) {
    process.stdout.write(`ok   ${description}\n`)
    return true
  }
  failures += 1
  process.stdout.write(`FAIL ${description}${detail ? `\n     ${detail}` : ''}\n`)
  return false
}

function read(path: string): string {
  return readFileSync(path, 'utf-8')
}

function run(args: string[], cwd?: string): CommandResult {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf-8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** The JSON payload of a packaged page, or null when there is no such element. */
function casePayload(html: string): string | null {
  const match = /<script[^>]*id="jsperf-case"[^>]*>([\s\S]*?)<\/script>/.exec(html)
  return match ? match[1] : null
}

function parseCase(payload: string): PackagedCase | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const candidate = parsed as Partial<PackagedCase>
  if (!Array.isArray(candidate.tests)) return null
  return candidate as PackagedCase
}

/**
 * Local references that survived the build. A single-file page must not fetch
 * anything: no <script src>, no <link href>, no <img src> pointing at a path.
 * External absolute URLs are fine - those are links, and a benchmark's own
 * preparation HTML is allowed to load a library from a CDN.
 */
function unresolvedLocalRefs(html: string): string[] {
  const refs: string[] = []
  const pattern = /\b(?:src|href)\s*=\s*"([^"]*)"/gi
  for (const [, value] of html.matchAll(pattern)) {
    if (value === '' || value.startsWith('#')) continue
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) continue
    refs.push(value)
  }
  return refs
}

function verifyExists(): void {
  for (const [label, path] of [
    ['app build exists', APP],
    ['kiosk build exists', KIOSK],
    ['pack CLI exists', PACK]
  ]) {
    if (check(existsSync(path), label, path)) {
      check(statSync(path).size > 50 * 1024, `${label.replace(' exists', '')} is a complete bundle (> 50 KiB)`)
    }
  }
}

function verifySingleFile(): void {
  for (const [label, path] of [
    ['app', APP],
    ['kiosk', KIOSK]
  ]) {
    const html = read(path)
    const refs = unresolvedLocalRefs(html)
    check(refs.length === 0, `${label} build references no local files`, refs.join(', '))
    check(!html.includes('sourceMappingURL'), `${label} build carries no sourcemap reference`)
    check(html.includes('window.Benchmark') || html.includes('root.Benchmark'), `${label} build embeds Benchmark.js`)
    check(html.includes('jsperf-init-html'), `${label} build embeds the sandbox document`)
  }
}

/**
 * The kiosk is the variant handed to someone else: runner only. If editor code
 * ever leaks into it the "no create-your-own UI" claim silently stops being true,
 * so it is checked rather than asserted in prose.
 */
function verifyKioskIsKiosk(): void {
  const html = read(KIOSK)
  for (const [needle, what] of [
    ['data-jsperf-editor', 'the editor section'],
    ['Saved test cases', 'the saved-case library'],
    ['Add test', 'the editor controls'],
    ['localStorage', 'storage access'],
    ['jsperf.app:standalone:cases', 'the storage key']
  ]) {
    check(!html.includes(needle), `kiosk build contains no ${what} (${needle})`)
  }
  check(html.includes('id="jsperf-case"'), 'kiosk build has the case placeholder')
  check(/<script[^>]*id="jsperf-case"[^>]*>\s*null\s*<\/script>/.test(html), 'unpackaged kiosk template carries no case')

  const app = read(APP)
  check(app.includes('data-jsperf-editor'), 'app build does have the editor section')
  check(app.includes('localStorage'), 'app build does use localStorage')
}

function verifyPackCli(): void {
  const help = run([PACK, '--help'])
  check(help.status === 0 && help.stdout.includes('jsperf-pack'), 'pack --help works', help.stderr.trim())

  const version = run([PACK, '--version'])
  check(version.status === 0, 'pack --version works', version.stderr.trim())
  check(!version.stdout.includes('stub'), 'pack CLI embeds a real kiosk template, not the stub', version.stdout.trim())

  const work = mkdtempSync(join(tmpdir(), 'jsperf-verify-'))

  // The documented flow: package the example case into one HTML file.
  const built = run([PACK, 'build', EXAMPLE, '-o', 'out.html'], work)
  check(built.status === 0, 'pack build packages the example case', built.stderr.trim())

  const outPath = join(work, 'out.html')
  if (check(existsSync(outPath), 'pack build wrote the page')) {
    const html = read(outPath)
    const payload = casePayload(html)
    if (check(payload !== null, 'packaged page carries the case payload')) {
      const parsed = parseCase(payload ?? '')
      if (check(parsed !== null, 'packaged case payload is valid JSON')) {
        const testCase = parsed as PackagedCase
        check(testCase.tests.length >= 2, `packaged case has the example's tests (${testCase.tests.length})`)
        check(
          testCase.tests.every(test => typeof test.code === 'string' && test.code.trim() !== ''),
          'every packaged test has code'
        )
        check(testCase.setup.includes('items'), 'packaged case carries setup.js')
        check(testCase.title !== '', 'packaged case carries a title')
      }
    }
    check(unresolvedLocalRefs(html).length === 0, 'packaged page references no local files')
    check(!html.includes('</script></script>'), 'packaged page is not malformed by the substitution')
  }

  // A case whose code contains a script terminator must not break the page: the
  // payload is JSON with < escaped, so this is the regression guard for it.
  const hostile = join(work, 'hostile.js')
  writeFileSync(hostile, '// @name closing tag\nconst html = "</script><script>window.__escaped = true</script>"\nvoid html\n')
  const hostileBuild = run([PACK, 'build', '--title', 'hostile', '-t', hostile, '-o', 'hostile.html'], work)
  check(hostileBuild.status === 0, 'pack build accepts test code containing </script>', hostileBuild.stderr.trim())
  if (existsSync(join(work, 'hostile.html'))) {
    const html = read(join(work, 'hostile.html'))
    const payload = casePayload(html)
    if (check(payload !== null, 'the hostile payload is still one script element')) {
      // No raw `<` survives in the payload, so no markup in a test body can
      // terminate the element or inject a tag; the JSON still decodes to the
      // exact source that was packaged.
      check(!(payload ?? '').includes('<'), 'the payload contains no raw < after escaping')
      const parsed = parseCase(payload ?? '')
      check(parsed !== null && parsed.tests[0].code.includes('</script>'), 'the escaped code round-trips back to the original')
    }
    const scriptTags = (html.match(/<script\b/gi) ?? []).length
    const templateTags = (read(KIOSK).match(/<script\b/gi) ?? []).length
    check(scriptTags === templateTags, `packaging adds no script elements (${scriptTags} vs ${templateTags})`)
  }

  // init writes a case a person can immediately build.
  const initted = run([PACK, 'init', 'fresh-case'], work)
  check(initted.status === 0, 'pack init scaffolds a case', initted.stderr.trim())
  const initBuild = run([PACK, 'build', 'fresh-case', '-o', 'fresh.html'], work)
  check(initBuild.status === 0, 'the scaffolded case builds', initBuild.stderr.trim())

  // No tests is a failure, not an empty page that looks fine until it is opened.
  mkdirSync(join(work, 'empty-case'), { recursive: true })
  const emptyBuild = run([PACK, 'build', 'empty-case', '-o', 'empty.html'], work)
  check(emptyBuild.status !== 0, 'pack build fails on a case with no tests')
  check(!existsSync(join(work, 'empty.html')), 'a failed pack build writes nothing')

  // --stdout is the pipe form; it must emit the page and nothing else.
  const piped = run([PACK, 'build', EXAMPLE, '--stdout'], work)
  check(piped.status === 0 && piped.stdout.startsWith('<!doctype html>'), 'pack build --stdout writes the page to stdout')
  check(piped.stdout.length > 50 * 1024, 'the piped page is the whole file')
}

/**
 * The MCP App halves. The view must be inert (no eval, nothing fetched) because
 * its host forbids both; the runner must carry the engine, because it is the one
 * document allowed to compile a test body. The browser smoke proves they work
 * together under the real policy; these are the cheap structural checks.
 */
function verifyMcpApp(): void {
  for (const [label, path] of [
    ['runner page', RUNNER],
    ['MCP App view', MCP_APP],
    ['MCP server', MCP_SERVER]
  ]) {
    if (!check(existsSync(path), `${label} exists`, path)) continue
    check(statSync(path).size > 50 * 1024, `${label} is a complete bundle`)
  }
  if (!existsSync(RUNNER) || !existsSync(MCP_APP)) return

  const runner = read(RUNNER)
  check(runner.startsWith('<!doctype html>'), 'the runner is a complete document')
  check(runner.includes('jsperf-init-html'), 'the runner is the sandbox document')
  check(runner.includes('window.Benchmark') || runner.includes('root.Benchmark'), 'the runner carries Benchmark.js')
  check(unresolvedLocalRefs(runner).length === 0, 'the runner references no local files')

  const view = read(MCP_APP)
  check(unresolvedLocalRefs(view).length === 0, 'the MCP App view references no local files')
  // The view cannot compile anything, so it must not contain the engine either:
  // if Benchmark.js ever leaks into it, someone has tried to run in the wrong
  // half and it will fail only at the point a person presses Run.
  check(!view.includes('Benchmark.Suite'), 'the MCP App view does not embed the benchmark engine')
  check(!view.includes('localStorage'), 'the MCP App view touches no storage')

  const site = join(standaloneDir, 'dist-site', 'runner.html')
  check(existsSync(site), 'the site layout publishes the runner page')
  if (existsSync(site)) check(read(site) === runner, 'the published runner is the built runner')
}

function verifyPublishLayout(): void {
  for (const name of ['jsperf.app_cosmo_any', 'jsperf.app-kiosk_cosmo_any', 'jsperf.app-pack_cosmo_any']) {
    const path = join(standaloneDir, 'dist-publish', name)
    check(existsSync(path), `publish layout has ${name}`)
    // buildhost's publish action parses <binary>_<os>_<arch>; a name it cannot
    // parse is skipped silently, which would publish nothing and stay green.
    check(/^(.+)_([a-z]+)_([a-z0-9]+)$/.test(name), `${name} matches the publish naming convention`)
  }
  const site = join(standaloneDir, 'dist-site', 'index.html')
  check(existsSync(site), 'site layout has index.html')
  if (existsSync(site)) {
    check(read(site) === read(APP), 'the site index is the app build')
  }
}

verifyExists()
if (failures === 0) {
  verifySingleFile()
  verifyKioskIsKiosk()
  verifyPackCli()
  verifyMcpApp()
  verifyPublishLayout()
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
if (failures > 0) {
  process.stdout.write(`${failures} check(s) failed\n`)
  process.exitCode = 1
}
