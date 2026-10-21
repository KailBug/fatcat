# Browser: workspace page execution and evidence

English | [简体中文](../../zh-CN/ARCHITECTURE/BROWSER.md)

[Architecture](README.md) · [Operating guide](../GUIDES/CODING.md#local-page-checks)

browser is a model tool that executes local pages and produces evidence, distinct from user-opened single-file Preview. It reuses Loop, permissions and delegation without accessing arbitrary websites.

## Modules and flow

| Source | Responsibility |
| --- | --- |
| `packages/runtime/src/browser/protocol.ts` | Arguments, steps and record types |
| `packages/runtime/src/tools/browser.ts` | Policy snapshot, approval, call/concurrency limits, deadlines and journal |
| `packages/runtime/src/permissions/browser.ts` | Fixed Workspace, resource type/size/identity and hashes |
| `packages/runtime/src/browser/runtime.ts` | Playwright lifecycle, routing, interaction and fixed capture |
| `packages/runtime/src/browser/evidence.ts` | Exclusive JSON/PNG writes and controlled reads by ID |
| `packages/webui/src/client/browser-evidence.ts` | Authenticated presentation, cancellation and Blob URL release |

Validate paths/arguments → one-time approval → new headless browser/context → local routing/interaction → DOM/geometry/PNG capture → close → save evidence. Cookies, storage and pages do not persist between calls. Models cannot choose executables, startup arguments, remote debugging or arbitrary JS.

Programmatic createTools adds no browser without BrowserOptions. Supplying them still respects default read-only/shell-deny. Ordinary entries assemble it for model selection.

## Permissions and resource isolation

Manual/Accept edits approve the whole check, including page scripts and evidence writes, without authorizing source edits. Plan/read-only/shell-deny reject; explicit shell-allow/Free permit automatically. Execution holds the policy lock. Web deny is independent and is not browser deny.

Every mode stays in the workspace; Free does not expand it. Requests at a random .fatcat.invalid origin are fulfilled from controlled local files through context.route, never passed to the network. Only current-origin GET/HEAD is accepted. Each resource validates path, links/hard links, identity, extension and encoding; hidden/dependency/outside paths and the evidence directory are refused. First resource bytes are cached and hashed, not captured as an atomic workspace snapshot.

CSP allows local/inline scripts/styles and bounded assets while blocking external sites, dynamic evaluation, frames, objects, workers and form submissions. Service Workers/WebSockets are blocked, WebRTC/WebTransport disabled, popups closed, dialogs dismissed and downloads cancelled. Temporary processes inherit no provider keys or chat capabilities.

These are application routing/browser restrictions, not an OS network sandbox, hard CPU/memory quota or exploit-isolation guarantee.

## Protocol and resource limits

| Boundary | Current value |
| --- | --- |
| Entry | Workspace-relative HTML/HTM/SVG |
| Actions/selectors | At most 12 each; click/fill/press/select/wait, strict single-element interactions |
| wait | ≤2 seconds each, ≤5 seconds total |
| Viewport | Default 1000×700; width 320–1600, height 240–1200 |
| Execution deadline | 30 seconds excluding approval/evidence disk writes; launch 8 seconds, load 5, step 2, screenshot 4 |
| Instance records/concurrency | 40 calls per instance, one running at a time; retained with workspace Tools cache |
| Assets | 100 requests, 64 items; 2 MiB each, 8 MiB total |
| Diagnostics | 20 entries, 400 characters each; truncation explicit |
| DOM/elements | 4000 text characters, 30 matches |
| Evidence files | 8 MiB each |

Capture includes form values, visibility and viewport rects; SVG also includes getBBox/getScreenCTM. Password values are masked, but screenshots/ordinary text have no general redaction. DOM and PNG are sequential; animations may advance, so they are not same-frame or full-animation verification. Cancellation closes the browser; cancellation during launch waits for bounded startup to return.

## Evidence and status

Files live at fatcat-browser-evidence/<32-hex-id>.json/.png, created with wx after fixed-directory validation. PNG precedes JSON; this is not atomic. Failure may leave partial files and returns no complete-success links. There is no automatic rotation/deletion. Local evidence includes page data, arguments, source hashes and time, without tamper-proof guarantees.

Models receive text observations and paths, not pixels; visualVerification=not_performed. Tool ok means observations are available; internal status may be failed. completed means steps/capture finished, while diagnostics may still contain errors/warnings. errorCount counts non-blocked diagnostics, not unique exceptions.

Reports deduplicate by ID. laterWriteAttempt tracks only later writes in the current turn, not shell/editor changes. Web UI authenticates fixed-ID report/image reads, displays reports as plain text and images through temporary Blobs, keeping tokens out of URLs. Resume does not reconstruct journals; disk evidence remains.

## Dependencies, verification and unimplemented scope

Playwright supplies real browser lifecycle, interaction and PNG capture. Windows uses installed Edge without downloading; the Chromium route on other platforms lacks real-machine acceptance.

verify:browser uses real Edge, temporary pages and injected models to check interaction, geometry, evidence, network boundaries and cancellation. Ordinary tests inject a runner. There is no real-model image-inspection verification. External sites, development servers, login, persistent pages, model screenshot input and deterministic multi-frame sampling are unimplemented.
