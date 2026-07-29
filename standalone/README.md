# jsPerf standalone

Single-file builds of jsPerf. No server, no database, no network: one HTML file
you open in whichever browser you want to measure.

Three artifacts come out of `standalone/`:

- **`jsperf.html`** &mdash; the whole app in one file. Create and edit test cases,
  run them, and everything is saved in the browser's `localStorage` instead of
  MongoDB.
- **`jsperf-kiosk.html`** &mdash; runner only, no editor. This is the template a
  packaged benchmark is made from.
- **`jsperf-pack.mjs`** &mdash; a CLI that bakes a test case into a copy of the
  kiosk template. One `.html` per benchmark, ready to hand to someone.

## Download

Published to [buildhost](https://pazer.build) on every push:

```sh
curl -fL "https://dl.pazer.build/jsperf.app?os=linux&arch=amd64"       -o jsperf.html
curl -fL "https://dl.pazer.build/jsperf.app/kiosk?os=linux&arch=amd64" -o jsperf-kiosk.html
curl -fL "https://dl.pazer.build/jsperf.app/pack?os=linux&arch=amd64"  -o jsperf-pack.mjs
```

The files are platform-neutral, so any `os`/`arch` pair returns the same bytes;
add `&branch=<branch>` for a specific branch's build. The app is also deployed as
a site at `https://sites.pazer.build/jsperf.app/` if you would rather just click.

## Package a benchmark from the command line

```sh
node jsperf-pack.mjs init my-case          # writes an example case to edit
node jsperf-pack.mjs build my-case         # -> my-case's title, as one .html
```

Or assemble one straight from `.js` files:

```sh
node jsperf-pack.mjs build --title "split vs slice" -t split.js -t slice.js -o bench.html
```

Needs Node 22+ and nothing else &mdash; no npm install, no checkout, works
offline. `node jsperf-pack.mjs --help` lists every option.

## A case directory

Every part is optional except the tests, which are ordered by filename:

```
my-case/
  case.json     title and options, e.g. {"title": "...", "autorun": true}
  info.md       description shown above the results
  init.html     preparation HTML, inserted into the sandbox body
  setup.js      runs before each sample, outside the measured body
  teardown.js   runs after each sample
  tests/
    01-forEach.js
    02-for-of.js
```

A test file may open with `// @name <title>` and `// @async` directive comments;
otherwise the title comes from the filename. `--autorun` (or `"autorun": true`)
starts the benchmark as soon as the page is opened.

A single `case.json` holding everything works too &mdash; that is what the app
build's **Export JSON** button writes, so the browser and the CLI are two ways
into the same format.

## Build from source

```sh
cd standalone
npm ci                # lodash (Benchmark.js needs it) + playwright (smoke only)
npm run build         # -> dist/
npm run verify        # assert what the artifacts claim to be
npm run smoke         # run both builds in real chromium, from file://
```

`npm run build` downloads the prebuilt [ts0](https://github.com/wow-look-at-my/ts0)
compiler to `.cache/` on first use; set `TS0=/path/to/ts0` to use your own.

Design notes, the build pipeline and the postMessage protocol are in
[`docs/standalone.md`](../docs/standalone.md).
