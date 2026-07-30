/**
 * Ambient types for the vendored Benchmark.js (app/lib/benchmark.mjs).
 *
 * The sandbox bundle is `benchmark.mjs` concatenated with the compiled driver,
 * so Benchmark.js is a plain global here rather than a module import - one
 * source of truth for the library, shared with the Next.js app, with no copy to
 * drift. Only the surface the driver uses is declared.
 */

interface BenchmarkStats {
  sample: number[]
  rme: number
  mean: number
  moe: number
}

interface BenchmarkInstance {
  id: number
  name: string
  count: number
  cycles: number
  hz: number
  running: boolean
  error?: unknown
  stats: BenchmarkStats
  options: Record<string, unknown>
  reset(): BenchmarkInstance
  on(events: string, listener: (event: BenchmarkEvent) => void): BenchmarkInstance
}

interface BenchmarkEvent {
  type: string
  target: BenchmarkInstance
}

interface BenchmarkAddOptions {
  /** Deferred (async) test: the body must call deferred.resolve(). */
  defer: boolean
  /** Test body source. Benchmark.js compiles a string fn into the test loop. */
  fn: string
  id: number
}

interface BenchmarkSuite {
  running: boolean
  length: number
  add(name: string, options: BenchmarkAddOptions): BenchmarkSuite
  on(events: string, listener: (event: BenchmarkEvent) => void): BenchmarkSuite
  off(events?: string): BenchmarkSuite
  abort(): BenchmarkSuite
  run(options: { async: boolean; queued: boolean }): BenchmarkSuite
}

interface BenchmarkStatic {
  Suite: new () => BenchmarkSuite
  /** setup/teardown are compiled into every test body; strings, not functions. */
  prototype: { setup: string; teardown: string }
  formatNumber(value: number | string): string
}

declare const Benchmark: BenchmarkStatic
