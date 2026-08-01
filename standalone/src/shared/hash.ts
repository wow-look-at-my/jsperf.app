/**
 * Sharing a test case through the URL fragment.
 *
 * A single-file build has no server to save to, so `#case=<base64url json>` is
 * how one copy of the file hands a benchmark to another. The fragment never
 * leaves the browser, which is what makes it work from a file:// URL.
 */

import type { TestCase } from './case.ts'
import { normalizeCase, runnableCase } from './case.ts'

export const HASH_PREFIX = '#case='

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function encodeCaseToFragment(testCase: TestCase): string {
  return HASH_PREFIX + toBase64Url(new TextEncoder().encode(JSON.stringify(testCase)))
}

/** Decode `#case=...`; null when the fragment is absent or not a valid case. */
export function decodeCaseFromFragment(hash: string): TestCase | null {
  if (!hash.startsWith(HASH_PREFIX)) return null
  try {
    const json = new TextDecoder().decode(fromBase64Url(hash.slice(HASH_PREFIX.length)))
    const testCase = normalizeCase(JSON.parse(json))
    return runnableCase(testCase).tests.length > 0 ? testCase : null
  } catch {
    return null
  }
}
