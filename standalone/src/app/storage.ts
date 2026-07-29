/**
 * localStorage persistence for the app build.
 *
 * The whole library lives under one key as a JSON array: a single-file app has
 * no server, a handful of test cases is kilobytes, and one key cannot desync
 * from an index the way a key-per-case layout can.
 *
 * Storage is treated as optional throughout. A file:// page in a private window,
 * or a browser with site data disabled, throws on the first access; the app then
 * runs entirely in memory and says so rather than silently losing work.
 */

import type { TestCase } from '../shared/case.ts'
import { normalizeCase } from '../shared/case.ts'

const STORAGE_KEY = 'jsperf.app:standalone:cases:v1'

export interface CaseRecord {
  id: string
  updated: number
  testCase: TestCase
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function newCaseId(): string {
  const random = new Uint8Array(8)
  crypto.getRandomValues(random)
  return Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('')
}

export class CaseStore {
  /** False when the browser refuses localStorage: edits stay in memory only. */
  readonly available: boolean
  private records: CaseRecord[] = []
  private error = ''

  constructor() {
    this.available = probeStorage()
    this.records = this.read()
  }

  lastError(): string {
    return this.error
  }

  /** Newest first. */
  list(): CaseRecord[] {
    return [...this.records].sort((a, b) => b.updated - a.updated)
  }

  get(id: string): CaseRecord | undefined {
    return this.records.find(record => record.id === id)
  }

  put(id: string, testCase: TestCase): void {
    const existing = this.records.findIndex(record => record.id === id)
    const record: CaseRecord = { id, updated: Date.now(), testCase }
    if (existing === -1) {
      this.records.push(record)
    } else {
      this.records[existing] = record
    }
    this.write()
  }

  remove(id: string): void {
    this.records = this.records.filter(record => record.id !== id)
    this.write()
  }

  private read(): CaseRecord[] {
    if (!this.available) return []
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return []
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(isRecord).map((entry, index) => ({
        id: typeof entry.id === 'string' ? entry.id : `recovered-${index}`,
        updated: typeof entry.updated === 'number' ? entry.updated : 0,
        testCase: normalizeCase(entry.testCase)
      }))
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      return []
    }
  }

  private write(): void {
    if (!this.available) return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.records))
      this.error = ''
    } catch (error) {
      // Quota exceeded is the realistic case: a huge preparation HTML block.
      this.error = error instanceof Error ? error.message : String(error)
    }
  }
}

function probeStorage(): boolean {
  try {
    const probe = '__jsperf_probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}
