/**
 * The sandbox document: lodash, Benchmark.js and the driver, and nothing else.
 *
 * Free of DOM and Node APIs on purpose - it is used three ways: as srcdoc by the
 * single-file builds, written to disk as the standalone runner page, and served
 * by the MCP server as the cross-origin runner an MCP Apps host can actually
 * execute benchmarks in.
 */

/**
 * `</script` inside the bundle would end the sandbox document's script element.
 * Escaping the slash is inert in JavaScript string and regexp literals - the
 * only places the sequence can legally appear - and the build verifier asserts
 * the bundle never contains it, so this is belt and braces.
 */
function escapeForScriptElement(js: string): string {
  return js.replace(/<\/script/gi, '<\\/script')
}

/**
 * The sandbox document: Benchmark.js and the driver, and nothing else. Used as
 * srcdoc by the inline runner and written to disk as the standalone runner page
 * the cross-origin form loads.
 */
export function sandboxDocument(sandboxJs: string): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>jsperf sandbox</title></head>',
    '<body><div id="jsperf-init-html"></div>',
    `<script>${escapeForScriptElement(sandboxJs)}</script>`,
    '</body></html>'
  ].join('')
}

