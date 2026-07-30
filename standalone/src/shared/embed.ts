/**
 * Baking a test case into the kiosk HTML template.
 *
 * Both sides of the contract live here: the pack CLI writes the payload, the
 * kiosk reads it back out of the same script element. Pure string handling, so
 * the CLI (no DOM) and the browser (no Node) can share it.
 */

import type { TestCase } from './case.ts'

export const CASE_SCRIPT_ID = 'jsperf-case'

/**
 * JSON, with every character that could terminate the script element escaped.
 * `<` is enough on its own (it is the only way to reach `</script>`), but `>` and
 * the line separators are escaped too so the payload is safe to inline anywhere
 * and cannot break a JSON parser that pre-dates ES2019.
 */
export function encodeCasePayload(testCase: TestCase): string {
  return JSON.stringify(testCase, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

const CASE_SCRIPT_RE = new RegExp(`<script([^>]*\\bid="${CASE_SCRIPT_ID}"[^>]*)>[\\s\\S]*?</script>`, 'i')

/** True when `html` carries the placeholder the kiosk template is built with. */
export function hasCaseSlot(html: string): boolean {
  return CASE_SCRIPT_RE.test(html)
}

/**
 * Replace the template's case placeholder with `testCase`. Throws rather than
 * returning the template unchanged: a kiosk page that silently kept the empty
 * placeholder would look like a successful build and open to nothing.
 */
export function embedCase(templateHtml: string, testCase: TestCase): string {
  if (!hasCaseSlot(templateHtml)) {
    throw new Error(`the kiosk template has no <script id="${CASE_SCRIPT_ID}"> placeholder to embed the test case into`)
  }
  const payload = encodeCasePayload(testCase)
  return templateHtml.replace(CASE_SCRIPT_RE, (_match, attrs: string) => `<script${attrs}>\n${payload}\n</script>`)
}
