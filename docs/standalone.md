# The standalone builds

How `standalone/` produces three self-contained artifacts, and why it is shaped
the way it is. User-facing documentation is [`standalone/README.md`](../standalone/README.md).

## What is built

| Artifact | What it is |
| --- | --- |
| `dist/jsperf.html` | The whole app in one file: editor, saved-case library, runner. Persistence is `localStorage` where the Next.js app uses MongoDB. |
| `dist/jsperf-kiosk.html` | Runner only. Also the template `jsperf-pack` bakes a case into. |
| `dist/jsperf-pack.mjs` | The packaging CLI, with the kiosk template embedded. Node 22+, no dependencies, works offline. |

Plus two derived layouts: `dist-publish/` (buildhost's `<binary>_<os>_<arch>`
naming, consumed by the publish job) and `dist-site/` (`index.html` = the app, for
buildhost static-site hosting).

## Why a second implementation and not the Next.js app

The hosted app is a Next.js application with MongoDB, GitHub auth, a Tailwind
pipeline and a `/sandbox.html` route. None of that survives being reduced to one
file that opens from `file://`. What actually needed to be preserved is the
measurement path, and it is small: Benchmark.js, the sandbox that runs the tests,
and the results table.

So `standalone/src` is a dependency-free TypeScript port of `components/UI.js`,
`components/TestRunner/`, `components/Test.js` and `utils/Array.js`, built by
[ts0](https://github.com/wow-look-at-my/ts0) into a single inlined HTML file. The
one thing that is *not* re-implemented is Benchmark.js: `app/lib/benchmark.mjs` is
read verbatim by the build, so the repository has exactly one copy of the
measurement engine and the standalone builds cannot drift from the hosted app's
numbers.

## The sandbox

Tests run in an iframe, as they do in the hosted app, for two reasons: setup code,
teardown code and preparation HTML pollute globals (so every run needs a fresh
document), and test code must not be able to touch the page that started it.

In a single file there is no `/sandbox.html` to point an iframe at, so the sandbox
document is delivered as `srcdoc`:

- `src/sandbox/driver.ts` is the in-iframe runner: it injects the preparation
  HTML, executes its `<script>` tags in order (module scripts get a resolver call
  appended, since an inlined module has no load event), builds a
  `Benchmark.Suite`, and reports `cycle` / `complete` / `failure` over
  `postMessage`.
- The build concatenates lodash, `app/lib/benchmark.mjs` and the compiled driver
  into one script and codegens it as a string constant
  (`src/generated/sandbox-bundle.ts`), which both HTML builds embed.
- `src/shared/runner.ts` creates an `<iframe sandbox="allow-scripts">` per run,
  sets `srcdoc` to that script, waits for the driver's `ready` message and only
  then sends the run. `allow-scripts` without `allow-same-origin` means the test
  code has an opaque origin: it cannot read the host document, its storage or the
  saved test cases. The browser smoke test asserts exactly that with a test body
  that tries.

Messages are typed in `src/shared/protocol.ts`; the host ignores any message whose
`event.source` is not the current iframe, so a late message from a discarded run
cannot land in a new one.

### lodash is not optional

Benchmark.js 2.x is not standalone. `runInContext()` returns a stub carrying
nothing but `runInContext` unless it can acquire lodash - through a module system,
or as the global `_`. The Next.js app gets it from webpack's `require`; the
sandbox script has no module system, so `lodash.min.js` goes in front of
Benchmark.js as a plain script and its UMD tail assigns the global that
Benchmark.js then picks up. The global is deleted immediately afterwards
(Benchmark.js has captured its own reference by then) so benchmarked code sees the
globals a plain page has rather than the runner's dependencies.

This is why the build needs `npm ci`: lodash is a pinned dependency of
`standalone/`. The *artifacts* still depend on nothing.

## The case model

`src/shared/case.ts` is the one definition of a test case, imported by the app, the
kiosk and the CLI:

- `normalizeCase()` coerces arbitrary parsed JSON into a `TestCase`. It is
  deliberately tolerant (hand-written and generated case files omit fields, a
  jsperf.app page export carries extra ones) and deliberately lossless: a
  half-written test with no code yet is a valid editor draft, and dropping it
  would delete a row as the user typed.
- `runnableCase()` is the set that gets measured - tests with no code removed,
  missing titles filled in. The runner, the exporter and the CLI all package this,
  never the raw draft. An empty test body reports `hz === Infinity`, and a silent
  Infinity is how a benchmark lies.
- The driver reports an unmeasurable test (`Infinity` hz, no error) as an error
  with a message rather than as a suspiciously fast result.

## Packaging: how a case gets into a page

The kiosk template carries one placeholder:

```html
<script type="application/json" id="jsperf-case">null</script>
```

ts0 leaves non-module, non-`src` script elements untouched, so it survives the
build verbatim. `src/shared/embed.ts` owns both sides of the contract: the CLI
replaces the payload with the case JSON (with `<`, `>` and the line separators
escaped, so nothing in a test body can terminate the element or inject a tag), and
the kiosk parses it back out of the same element. `embedCase` throws rather than
returning the template unchanged - a page that silently kept the empty placeholder
would look like a successful build and open to nothing.

With no payload, the kiosk falls back to `#case=<base64url json>`
(`src/shared/hash.ts`), which is what the app's "Copy share link" produces. That is
the no-CLI route: the empty template plus a link is a working benchmark.

## The build pipeline

`scripts/build.ts` is four ts0 invocations with two codegen steps between them,
because two artifacts need another artifact as a string:

1. `ts0.sandbox.json` &rarr; `build/sandbox-driver.js` (browser, iife).
2. lodash + `app/lib/benchmark.mjs` + the driver &rarr;
   `src/generated/sandbox-bundle.ts`.
3. `ts0.kiosk.json` &rarr; `dist/jsperf-kiosk.html`.
4. That HTML &rarr; `pack/src/generated/kiosk-template.ts`.
5. `ts0.json` &rarr; `dist/jsperf.html`.
6. `pack/ts0.json` &rarr; `dist/jsperf-pack.mjs`.

Both generated modules are gitignored build inputs, written as stubs first so a
fresh clone type-checks before they exist. ts0's type-check gate covers every
source in the project on every build, which is why the order matters.

`pack/` is a nested ts0 project (its own `ts0.json`) rather than another config in
the parent: the CLI is a Node target with no DOM lib, and ts0 excludes nested
projects from the parent's gate, so the browser sources and the CLI are each
checked against the right globals.

### The harness is TypeScript too

`scripts/build.ts`, `scripts/verify.ts` and `scripts/browser-smoke.ts` are
TypeScript, run through Node's type stripping (`node
--experimental-strip-types`). Stripping only erases annotations, so the gate is
what makes the types load-bearing: they live in the parent project, whose
type-check covers **every** `.ts` under `standalone/` on every build regardless of
which entry is being built. `scripts/build.ts` runs that gate as its first ts0
invocation, so a type error (or an explicit `any`) anywhere in the harness fails
the build before a single artifact is written. Both halves of that are pinned by
having been made to fail on purpose.

`build.ts` cannot be checked before it starts - it is the thing that fetches the
compiler - which is the one honest bootstrap hole, and it closes on the very next
line of work it does.

Two consequences of the parent project being a **browser** target are worth
knowing: the harness type-checks with the DOM lib (which is what makes the
Playwright `page.evaluate` callbacks - code that really does run in a browser -
type-check properly, the same reason a normal Playwright tsconfig includes DOM),
and `@types/node` is a dev dependency rather than a hand-written shim, so the
Node APIs the harness and the CLI use have their real signatures.

ts0 itself is fetched as the prebuilt platform-neutral `ts0.cjs` from buildhost and
cached in `.cache/`; `TS0=/path/to/ts0` overrides it.

## Verification

`scripts/verify.ts` (no browser) asserts the claims:

- Every artifact exists and is a complete bundle.
- Neither HTML file references any local file (no `src`/`href` that is not an
  absolute URL or a fragment) and neither carries a sourcemap reference.
- **The kiosk is really a kiosk**: no editor markup, no "Add test", no
  `localStorage`, no storage key - and the app has all of them. This is the "no
  create-your-own UI in that variant" requirement as a check rather than a
  sentence in a README.
- The CLI embeds a real template rather than the stub, packages the example case,
  round-trips a test body containing `</script>` without adding a script element,
  scaffolds a buildable case, fails on a case with no tests (writing nothing), and
  supports the `--stdout` pipe form.
- `dist-publish/` names parse under buildhost's `<binary>_<os>_<arch>` convention -
  a name it cannot parse would be skipped silently and publish nothing while
  staying green.

`scripts/browser-smoke.ts` runs both builds in real chromium from a real `file://`
URL, which is the only place the interesting claims can be proven: a packaged kiosk
page runs its four tests and reports ops/sec with exactly one fastest; the empty
template explains itself and still runs a fragment case; the app is edited through
its own form, runs, **survives a reload with the case still in `localStorage`**, and
runs again; and test code cannot reach the host document. It needs Playwright's
chromium and is the only part of the pipeline that does.

## Publishing

`.github/workflows/ci.yml` builds, verifies and smokes on every push, then
publishes with the stock buildhost actions. File names map to projects by
buildhost's own convention:

| File | Project | URL |
| --- | --- | --- |
| `jsperf.app_cosmo_any` | `jsperf.app` | `dl.pazer.build/jsperf.app?os=..&arch=..` |
| `jsperf.app-kiosk_cosmo_any` | `jsperf.app/kiosk` | `dl.pazer.build/jsperf.app/kiosk?os=..&arch=..` |
| `jsperf.app-pack_cosmo_any` | `jsperf.app/pack` | `dl.pazer.build/jsperf.app/pack?os=..&arch=..` |

`cosmo`/`any` is buildhost's multi-platform alias: one stored body resolvable under
every `os`/`arch` pair, which is what a platform-neutral HTML file or Node script
wants. The app is additionally deployed as a static site
(`sites.pazer.build/jsperf.app/`, `index.html` = the app build).

Every branch publishes. buildhost treats the git branch as a first-class field and
the apex `latest` only ever resolves the repository's default branch, so a branch
release cannot hijack what stable consumers download - while publishing only from
the default branch would mean the one part of CI that talks to buildhost never runs
before it is merged.
