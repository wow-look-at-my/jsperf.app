# jsPerf as an MCP App

Running a benchmark inside a Claude conversation: the model proposes the
variants, the person presses Run, and their own browser produces the numbers.

`standalone/mcp/` is the server, `standalone/src/mcpapp/` is the view it serves.
Everything else is shared with the single-file builds.

## What this is (and what it is not)

Three different Claude features get confused with each other:

| | What it is | Authorable? |
| --- | --- | --- |
| **Custom visuals** | Claude builds HTML inline in a response; ephemeral, "not saved separately" | No - you ask for one, then optionally save it as an artifact |
| **Artifacts** | A page you author and publish, with its own URL | Yes, but it is a page, not part of the conversation |
| **Interactive connectors / MCP Apps** | Live UI rendered inside the conversation, in a host-sandboxed iframe, wired to your MCP server | **Yes - this is what this directory builds** |

A connector needs no review for your own use (Pro/Max/Team/Enterprise:
**Customize -> Connectors -> Add custom connector**). Review applies to listing
one in the directory.

## The constraint that shapes everything

MCP Apps hosts serve the view under a deny-by-default CSP. From the
specification, the policy when a server declares nothing:

```
default-src 'none';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
media-src 'self' data:;
object-src 'none';
connect-src 'none';
```

There is no `'unsafe-eval'`, and a server can only declare **domains**
(`connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains`) - there
is no field for script directives. Benchmark.js compiles every test body with
`new Function`. Measured under exactly that policy in Chromium:

```
=== strict CSP, no frame-src (the single-file builds' architecture)
  newFunction:          BLOCKED: EvalError
  eval:                 BLOCKED: EvalError
  srcdocLoaded:         true                  <- the iframe loads...
  srcdocNewFunction:    BLOCKED: EvalError    <- ...but srcdoc INHERITS the CSP

=== strict CSP + frame-src to a permissive origin
  crossOriginSandboxLoaded: true
  benchmarkRan:         [ "115,496,319", "99,445,715" ]
```

So the `srcdoc` trick the app and kiosk builds rely on cannot work here: a
srcdoc document inherits the embedder's policy. A **cross-origin** document
brings its own, which is the entire reason this design has two halves.

## The architecture

```
+- MCP App view (host CSP, no eval) ------------------------+
|  controls, result rows, "results -> conversation"         |
|  +- iframe -> <server origin>/runner.html --------------+ |   frameDomains: [origin]
|  |  its own CSP, sandbox="allow-scripts"                | |
|  |  lodash + Benchmark.js + src/sandbox/driver.ts       | |
|  +------------------------------------------------------+ |
+-----------------------------------------------------------+
```

- **The view** (`src/mcpapp/`) never measures anything. It renders the case,
  drives the runner over the same postMessage protocol the single-file builds
  use (`src/shared/protocol.ts`), and reports results back with
  `app.updateModelContext()` so the conversation can use the numbers.
- **The runner** (`dist/runner.html`) is the same sandbox document the other
  builds inline as srcdoc - `sandboxDocument()` in `src/shared/sandbox-document.ts`,
  one definition, three uses.
- **The server** (`mcp/server.ts`) registers the tool, serves the view as a
  `ui://` resource with `_meta.ui.csp.frameDomains`, and serves the runner page
  itself. Because Claude sandboxes the view on its own origin, the server's
  origin is already cross-origin to it - so no second deployment is needed.

### Two subtleties that cost real debugging time

- **A sandboxed frame has an opaque origin.** `sandbox="allow-scripts"` without
  `allow-same-origin` makes the frame's origin report as `"null"`, which matches
  no `targetOrigin`. Naming the runner's real origin in `postMessage` makes every
  message silently fail with *"The target origin provided ... does not match the
  recipient window's origin ('null')"*. The sandbox attribute is the boundary
  here, not the target origin.
- **Playwright's `page.evaluate` bypasses CSP.** It runs through CDP, which is
  not subject to the page's policy, so `new Function` succeeds there even when
  the page cannot use it. A CSP probe has to run as page script or it silently
  passes.

## Running it

```sh
cd standalone
npm ci && npm run build
npm run mcp-serve            # http://localhost:3199/mcp
npx cloudflared tunnel --url http://localhost:3199
```

Add the tunnel's `https://…/mcp` URL in Claude under **Customize -> Connectors
-> Add custom connector**, then ask for a benchmark:

> which is faster in my browser, `Array#join` or `+=` in a loop?

The server derives its public origin from the request, so a tunnel needs no
configuration; set `JSPERF_MCP_PUBLIC_URL` when something rewrites the Host
header, and `PORT` to move off 3199.

**Transport is stateless** (`sessionIdGenerator: undefined`,
`enableJsonResponse: true`): a benchmark's state lives in the browser, so there
is nothing to keep between requests. The server can therefore sit behind any
load balancer, or run serverless, with no session affinity - and a fresh
`McpServer` is built per request, which is what lets the runner origin be
derived from that request.

## The tool

`run_benchmark` takes `{ title?, info?, setup?, teardown?, initHTML?, tests[] }` -
the same case model as everything else (`src/shared/case.ts`). Its description
tells the model the two things it otherwise gets wrong: shared data belongs in
`setup`, not in the test bodies, and each body must observe its own result or an
engine may delete it entirely and report an unusable `Infinity` ops/sec.

The tool result carries `{ case, runnerUrl }`. The view renders from
`ontoolinput` (the model's arguments, which arrive before the server responds)
so the tests appear immediately, then reconciles with the result.

## What is verified, and what is not

`npm run mcp-check` connects a real MCP client to the built server and asserts
the contract a host depends on: the tool points at a `ui://` resource, the
resource is served as `text/html;profile=mcp-app`, `_meta.ui.csp.frameDomains`
declares exactly one origin, the runner URL is inside it, and the runner is
served without a CSP of its own.

`npm run smoke` serves the view under the specification's default host CSP plus
that `frame-src`, and runs a benchmark end to end - including a page-script probe
proving `new Function` really is blocked in the view, so the test cannot pass by
accident against a relaxed policy.

Not covered here: the `ui/*` handshake against a real host. That is exercised by
the official `App` class and by connecting to Claude or to the `basic-host`
example in the `modelcontextprotocol/ext-apps` repository.
