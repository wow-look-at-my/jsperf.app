#!/usr/bin/env node
/**
 * Assert the properties the standalone artifacts are supposed to have.
 *
 *   node standalone/scripts/verify.mjs
 *
 * These are requirements, so they are checks: each claim the README makes about
 * these files is asserted here, and CI runs this after every build. Nothing here
 * needs a browser (scripts/browser-smoke.mjs does that part) and nothing here
 * needs npm.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const standaloneDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(standaloneDir, 'dist')

const APP = join(dist, 'jsperf.html')
const KIOSK = join(dist, 'jsperf-kiosk.html')
const PACK = join(dist, 'jsperf-pack.mjs')
const EXAMPLE = join(standaloneDir, 'examples', 'array-iteration')

let failures = 0
let checks = 0

function check(condition, description, detail = '') {
  checks += 1
  if (condition) {
    process.stdout.write(`ok   ${description}\n`)
    return true
  }
  failures += 1
  process.stdout.write(`FAIL ${description}${detail ? `\n     ${detail}` : ''}\n`)
  return false
}

function read(path) {
  return readFileSync(path, 'utf-8')
}

function run(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf-8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Local references that survived the build. A single-file page must not fetch
 * anything: no <script src>, no <link href>, no <img src> pointing at a path.
 * External absolute URLs are fine - those are links, and a benchmark's own
 * preparation HTML is allowed to load a library from a CDN.
 */
function unresolvedLocalRefs(html) {
  const refs = []
  const pattern = /\b(?:src|href)\s*=\s*"([^"]*)"/gi
  for (const [, value] of html.matchAll(pattern)) {
    if (value === '' || value.startsWith('#')) continue
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) continue
    refs.push(value)
  }
  return refs
}

function verifyExists() {
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

function verifySingleFile() {
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
function verifyKioskIsKiosk() {
  const html = read(KIOSK)
  for (const marker of [
    ['data-jsperf-editor', 'the editor section'],
    ['Saved test cases', 'the saved-case library'],
    ['Add test', 'the editor controls'],
    ['localStorage', 'storage access'],
    ['jsperf.app:standalone:cases', 'the storage key']
  ]) {
    const [needle, what] = marker
    check(!html.includes(needle), `kiosk build contains no ${what} (${needle})`)
  }
  check(html.includes('id="jsperf-case"'), 'kiosk build has the case placeholder')
  check(/<script[^>]*id="jsperf-case"[^>]*>\s*null\s*<\/script>/.test(html), 'unpackaged kiosk template carries no case')

  const app = read(APP)
  check(app.includes('data-jsperf-editor'), 'app build does have the editor section')
  check(app.includes('localStorage'), 'app build does use localStorage')
}

function verifyPackCli() {
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
    const match = /<script[^>]*id="jsperf-case"[^>]*>([\s\S]*?)<\/script>/.exec(html)
    if (check(match !== null, 'packaged page carries the case payload')) {
      let parsed
      try {
        parsed = JSON.parse(match[1])
      } catch (error) {
        parsed = null
        check(false, 'packaged case payload is valid JSON', String(error))
      }
      if (parsed) {
        check(parsed.tests.length >= 2, `packaged case has the example's tests (${parsed.tests?.length ?? 0})`)
        check(
          parsed.tests.every(test => typeof test.code === 'string' && test.code.trim() !== ''),
          'every packaged test has code'
        )
        check(parsed.setup.includes('items'), 'packaged case carries setup.js')
        check(parsed.title !== '', 'packaged case carries a title')
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
    const match = /<script[^>]*id="jsperf-case"[^>]*>([\s\S]*?)<\/script>/.exec(html)
    if (check(match !== null, 'the hostile payload is still one script element')) {
      // No raw `<` survives in the payload, so no markup in a test body can
      // terminate the element or inject a tag; the JSON still decodes to the
      // exact source that was packaged.
      check(!match[1].includes('<'), 'the payload contains no raw < after escaping')
      const parsed = JSON.parse(match[1])
      check(parsed.tests[0].code.includes('</script>'), 'the escaped code round-trips back to the original')
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

function verifyPublishLayout() {
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
  verifyPublishLayout()
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
if (failures > 0) {
  process.stdout.write(`${failures} check(s) failed\n`)
  process.exitCode = 1
}
