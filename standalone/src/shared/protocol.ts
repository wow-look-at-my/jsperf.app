/**
 * postMessage protocol between the host page and the sandbox iframe.
 *
 * The sandbox is an opaque-origin (`sandbox="allow-scripts"`) srcdoc document,
 * so messages are the only channel: the host cannot reach into it and the test
 * code cannot reach back out into the UI.
 */

import type { BenchTest } from './case.ts'

export type TestStatus = 'default' | 'pending' | 'running' | 'completed' | 'finished' | 'error'

export interface RunOptions {
  /** Benchmark.js maxTime, in seconds, per test. */
  maxTime: number
}

export interface TestResult {
  id: number
  /** Formatted ops/sec, e.g. "12,345,678". */
  hz: string
  /** Raw ops/sec, for sorting and machine-readable export. */
  hzRaw: number
  /** Relative margin of error, percent, formatted to 2dp. */
  rme: string
  samples: number
  fastest: boolean
  slowest: boolean
  status: TestStatus
  error: string
  /** Formatted "% slower than the fastest"; empty for the fastest test. */
  percent: string
}

export interface HostRunMessage {
  message: 'run'
  options: RunOptions
  tests: BenchTest[]
  initHTML: string
  setup: string
  teardown: string
}

export interface HostStopMessage {
  message: 'stop'
}

export type HostMessage = HostRunMessage | HostStopMessage

export interface SandboxReadyMessage {
  message: 'ready'
}

export interface SandboxCycleMessage {
  message: 'cycle'
  id: number
  name: string
  count: string
  size: number
  status: TestStatus
  running: boolean
}

export interface SandboxCompleteMessage {
  message: 'complete'
  results: TestResult[]
}

export interface SandboxFailureMessage {
  message: 'failure'
  error: string
}

export type SandboxMessage =
  | SandboxReadyMessage
  | SandboxCycleMessage
  | SandboxCompleteMessage
  | SandboxFailureMessage

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow an incoming `event.data` to a message name without trusting its shape. */
export function messageName(data: unknown): string {
  return isRecord(data) && typeof data.message === 'string' ? data.message : ''
}
