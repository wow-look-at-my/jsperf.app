/**
 * The jsPerf MCP App server: a benchmark you can run inside a conversation.
 *
 *   node dist/jsperf-mcp-server.mjs          # then add http://localhost:3199/mcp
 *                                            # as a Claude custom connector
 *
 * It serves two things:
 *
 * - `ui://jsperf/benchmark.html` - the view the host renders inline, declaring
 *   the runner origin in `_meta.ui.csp.frameDomains`.
 * - `GET /runner.html` - the page that actually runs Benchmark.js.
 *
 * Both halves are embedded in this file at build time, so the server is one
 * file plus node_modules; there is nothing to deploy alongside it.
 *
 * Why two documents: MCP Apps hosts serve the view under a deny-by-default CSP
 * with no `unsafe-eval`, and Benchmark.js compiles every test body with
 * `new Function`. A srcdoc iframe inherits the host's policy, so the view cannot
 * measure anything itself. A cross-origin page carries its own CSP, and this
 * server is a different origin from the sandboxed view - so the runner it serves
 * can compile and run the tests. See docs/mcp-app.md.
 *
 * Transport is stateless (`sessionIdGenerator: undefined`): a benchmark's state
 * lives in the browser, not here, so there is nothing to keep between requests -
 * which also means this can sit behind any load balancer, or run serverless,
 * with no session affinity.
 */

import express from 'express'
import cors from 'cors'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { normalizeCase, runnableCase } from '../src/shared/case.ts'
import { APP_HTML, BUILD_STAMP, RUNNER_HTML } from './src/generated/assets.ts'

const RESOURCE_URI = 'ui://jsperf/benchmark.html'
const PORT = Number(process.env.PORT ?? 3199)

/**
 * The public origin of this server, which is also the runner origin the view is
 * allowed to frame. Derived from the request by default so a tunnel
 * (`cloudflared tunnel --url http://localhost:3199`) needs no configuration;
 * set JSPERF_MCP_PUBLIC_URL when the server sits behind something that rewrites
 * the Host header.
 */
function publicOrigin(req: express.Request): string {
  const configured = process.env.JSPERF_MCP_PUBLIC_URL
  if (configured) return new URL(configured).origin
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http').split(',')[0].trim()
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? `localhost:${PORT}`).split(',')[0].trim()
  return `${proto}://${host}`
}

const TEST_SCHEMA = z.object({
  title: z.string().describe('Short label for this variant, shown next to its result.'),
  code: z.string().describe('The measured body. A statement list, not a function - it is timed in a loop.'),
  async: z
    .boolean()
    .optional()
    .describe('True if the body is asynchronous; it must then call deferred.resolve() when finished.')
})

const TOOL_DESCRIPTION = `Render an interactive JavaScript benchmark in the conversation and let the person run it in their own browser.

Use this when someone asks which of several JavaScript implementations is faster, or wants a claim about JS performance checked rather than guessed. Nothing runs until they press Run; the results are then added to the conversation automatically.

Writing the tests:
- Each test's "code" is a statement body that is timed in a loop, not a function definition.
- Shared data goes in "setup" (it runs before each sample, outside the measurement), not in the test bodies.
- Make each body check its own result (e.g. throw if a sum is wrong). A body whose result is never observed can be optimised away entirely, which measures as an unusable Infinity ops/sec.
- Two to five variants reads best.`

function createServer(origin: string): McpServer {
  const server = new McpServer({ name: 'jsPerf', version: BUILD_STAMP })
  const runnerUrl = `${origin}/runner.html`

  registerAppTool(
    server,
    'run_benchmark',
    {
      title: 'Run a JavaScript benchmark',
      description: TOOL_DESCRIPTION,
      inputSchema: {
        title: z.string().optional().describe('What is being compared, e.g. "Array#join vs += in a loop".'),
        info: z.string().optional().describe('One line of context shown under the title.'),
        setup: z.string().optional().describe('Runs before each sample, outside the measured body.'),
        teardown: z.string().optional().describe('Runs after each sample.'),
        initHTML: z
          .string()
          .optional()
          .describe('HTML inserted into the sandbox before the run; script tags execute in order.'),
        tests: z.array(TEST_SCHEMA).min(1).describe('The variants to compare.')
      },
      _meta: { ui: { resourceUri: RESOURCE_URI } }
    },
    async args => {
      const testCase = runnableCase(normalizeCase(args))
      const names = testCase.tests.map(test => test.title).join(', ')
      return {
        content: [
          {
            type: 'text',
            text:
              testCase.tests.length === 0
                ? 'No test had any code in it, so there is nothing to measure.'
                : `Prepared a benchmark of ${testCase.tests.length} variants (${names}). It is on screen; the results arrive once the person presses Run.`
          }
        ],
        structuredContent: { case: testCase, runnerUrl }
      }
    }
  )

  const ui = { csp: { frameDomains: [origin] } }

  registerAppResource(
    server,
    'jsPerf benchmark',
    RESOURCE_URI,
    { description: 'Interactive JavaScript benchmark runner', _meta: { ui } },
    async () => ({
      contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: APP_HTML, _meta: { ui } }]
    })
  )

  return server
}

const app = express()
app.use(cors({ exposedHeaders: ['mcp-session-id', 'mcp-protocol-version'] }))
app.use(express.json({ limit: '4mb' }))

/**
 * The runner. No CSP header on purpose: this document exists to compile and run
 * the benchmark, which needs `unsafe-eval`, and a benchmark's own preparation
 * HTML may pull a library from anywhere. What keeps that safe is the embedder -
 * the view frames it with `sandbox="allow-scripts"`, so it runs in an opaque
 * origin with no storage, no credentials and no access to the page that framed
 * it. It holds nothing worth stealing and can do nothing but burn CPU.
 */
app.get('/runner.html', (_req, res) => {
  res.type('html').set('cache-control', 'public, max-age=300').send(RUNNER_HTML)
})

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, build: BUILD_STAMP })
})

app.post('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  })
  res.on('close', () => void transport.close())
  await createServer(publicOrigin(req)).connect(transport)
  await transport.handleRequest(req, res, req.body)
})

app.listen(PORT, () => {
  process.stderr.write(`jsperf-mcp: listening on http://localhost:${PORT}/mcp (build ${BUILD_STAMP})\n`)
  process.stderr.write(`jsperf-mcp: runner at http://localhost:${PORT}/runner.html\n`)
})
