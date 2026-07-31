/**
 * Check the MCP App server over the wire.
 *
 *   node --experimental-strip-types standalone/scripts/mcp-check.ts
 *
 * Spawns the built server, connects a real MCP client to it and asserts the
 * contract an MCP Apps host depends on: the tool points at a `ui://` resource,
 * the resource is served with the app MIME type, and its `_meta.ui.csp` declares
 * the runner origin. Get any of those wrong and the view renders as text, or
 * renders and then cannot run anything - both of which look fine until a person
 * tries it in a conversation.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const standaloneDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(standaloneDir, 'dist', 'jsperf-mcp-server.mjs')
const PORT = 3399
const BASE = `http://127.0.0.1:${PORT}`

let failures = 0
let checks = 0

function check(condition: boolean, description: string, detail = ''): boolean {
  checks += 1
  if (condition) {
    process.stdout.write(`ok   ${description}\n`)
    return true
  }
  failures += 1
  process.stdout.write(`FAIL ${description}${detail ? `\n     ${detail}` : ''}\n`)
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Dig `_meta.ui` out of a tool or resource without trusting its shape. */
function uiMeta(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const meta = value._meta
  if (!isRecord(meta)) return undefined
  return isRecord(meta.ui) ? meta.ui : undefined
}

async function waitForServer(): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/healthz`)
      if (response.ok) return true
    } catch {
      // not up yet
    }
    await new Promise(done => setTimeout(done, 250))
  }
  return false
}

async function main(): Promise<void> {
  if (!existsSync(SERVER)) {
    process.stderr.write(`mcp-check: ${SERVER} missing; run the build first\n`)
    process.exitCode = 1
    return
  }

  const child: ChildProcess = spawn(process.execPath, [SERVER], {
    cwd: standaloneDir,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe']
  })

  try {
    if (!check(await waitForServer(), 'the server starts and answers /healthz')) return

    const client = new Client({ name: 'jsperf-check', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)))

    const { tools } = await client.listTools()
    const tool = tools.find(candidate => candidate.name === 'run_benchmark')
    if (!check(tool !== undefined, 'run_benchmark is advertised', tools.map(t => t.name).join(', '))) return

    const toolUi = uiMeta(tool)
    const resourceUri = toolUi?.resourceUri
    check(typeof resourceUri === 'string' && resourceUri.startsWith('ui://'), 'the tool points at a ui:// resource', String(resourceUri))
    check(
      typeof tool?.description === 'string' && tool.description.length > 200,
      'the tool description tells the model how to write test bodies'
    )

    const read = await client.readResource({ uri: String(resourceUri) })
    const contents = read.contents[0]
    check(contents?.mimeType === 'text/html;profile=mcp-app', 'the resource is served as an MCP App', String(contents?.mimeType))
    // A resource content item is text or blob; only the text form is an app.
    const html = contents && 'text' in contents && typeof contents.text === 'string' ? contents.text : ''
    check(html.startsWith('<!doctype html>'), 'the resource is a complete HTML document')
    check(html.length > 100 * 1024, `the view is the whole bundle (${Math.round(html.length / 1024)} KiB)`)
    check(!html.includes('src="'), 'the view fetches nothing: everything is inlined')

    // The load-bearing bit: without frameDomains the host sets frame-src 'none'
    // and the runner iframe never loads, so no benchmark can ever run.
    const csp = uiMeta(contents)?.csp
    const frameDomains = isRecord(csp) && Array.isArray(csp.frameDomains) ? csp.frameDomains : []
    check(frameDomains.length === 1, 'the resource declares exactly one frame domain', JSON.stringify(csp))
    check(String(frameDomains[0]).startsWith('http'), 'the frame domain is an origin', String(frameDomains[0]))

    const result = await client.callTool({
      name: 'run_benchmark',
      arguments: {
        title: 'join vs concat',
        setup: 'const parts = ["a", "b", "c"]',
        tests: [
          { title: 'join', code: 'const out = parts.join("")' },
          { title: 'concat', code: 'let out = ""; for (const p of parts) out += p' }
        ]
      }
    })

    const structured = result.structuredContent
    check(isRecord(structured), 'the tool returns structured content')
    if (isRecord(structured)) {
      const testCase = structured.case
      check(isRecord(testCase) && Array.isArray(testCase.tests) && testCase.tests.length === 2, 'the case round-trips both tests')
      const runnerUrl = String(structured.runnerUrl ?? '')
      check(runnerUrl.endsWith('/runner.html'), 'the tool tells the view where the runner is', runnerUrl)
      check(
        runnerUrl.startsWith(String(frameDomains[0])),
        'the runner URL is inside the declared frame domain',
        `${runnerUrl} vs ${String(frameDomains[0])}`
      )

      // The runner is the part that needs eval, so it must NOT ship a CSP that
      // forbids it - the iframe sandbox is what contains it instead.
      const runner = await fetch(runnerUrl)
      check(runner.ok, 'the runner page is served')
      check(runner.headers.get('content-security-policy') === null, 'the runner sends no CSP of its own')
      const runnerHtml = await runner.text()
      check(runnerHtml.includes('jsperf-init-html'), 'the runner is the sandbox document')
      check(runnerHtml.length > 100 * 1024, 'the runner carries Benchmark.js')
    }

    await client.close()
  } finally {
    child.kill()
  }

  process.stdout.write(`\n${checks - failures}/${checks} MCP checks passed\n`)
  if (failures > 0) {
    process.stdout.write(`${failures} check(s) failed\n`)
    process.exitCode = 1
  }
}

await main()
