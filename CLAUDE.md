# CLAUDE.md

Notes for Claude working in this repository. This file is an index: it says what
exists and where the depth lives.

## What this project is

[jsPerf.app](https://jsperf.app) &mdash; an online JavaScript benchmark runner and
jsperf.com mirror. Two things live here:

- **The hosted app** &mdash; Next.js (app router) + MongoDB, deployed on Vercel.
  `app/`, `components/`, `utils/`. See `README.md` for local development.
- **`standalone/`** &mdash; single-file builds of the same idea with no server: a
  `localStorage`-backed app, a runner-only "kiosk" page, and a CLI that packages a
  test case into one HTML file. Built with [ts0](https://github.com/wow-look-at-my/ts0),
  published to buildhost by `.github/workflows/ci.yml`.
  Depth: `docs/standalone.md`. User docs: `standalone/README.md`.

## Invariants

- `app/lib/benchmark.mjs` is the repository's only copy of Benchmark.js. The
  standalone build reads it verbatim; never fork it.
- Benchmark.js 2.x needs lodash to be more than a stub &mdash; the hosted app gets
  it from webpack, the standalone sandbox concatenates `lodash.min.js` in front of
  it. See `docs/standalone.md`.
- Benchmarks always run in a sandboxed iframe (`allow-scripts`, no
  `allow-same-origin`), never in the page that starts them.
- The kiosk build must contain no editor and no storage access. `standalone/scripts/verify.mjs`
  enforces this; do not weaken those checks.
- `standalone/src/generated/` and `standalone/pack/src/generated/` are generated
  build inputs: gitignored, rebuilt by `standalone/scripts/build.mjs`.

## Working on the standalone builds

```sh
cd standalone
npm ci && npm run build   # -> dist/jsperf.html, dist/jsperf-kiosk.html, dist/jsperf-pack.mjs
npm run verify            # artifact assertions (no browser needed)
npm run smoke             # both builds in real chromium, from file://
```

The standalone sources are dependency-free TypeScript (no React, no Tailwind, no
syntax highlighter); ts0's type-check gate also bans explicit `any`, with no
escape hatch.

## Documentation

When project structure, commands, config or tooling change, update `README.md`,
this file and the relevant `docs/*.md` in the same commit. Prose longer than a few
lines belongs in `docs/`, with a one-line pointer here.
