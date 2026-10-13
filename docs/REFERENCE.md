# Browser Proxy reference

[Quick start](../README.md) · [Coding agent guide](../AGENTS.md)

Implementation details and supported behavior. For current argument schemas, run `npm run cli -- tools` with the bridge running. All shell commands below run from the repository root.

- [Operation](#operation)
- [Original tools and DOM references](#original-tools-and-dom-references)
- [MCP and HTTP clients](#mcp-and-http-clients)
- [Transport and execution limits](#transport-and-execution-limits)
- [Chrome DevTools MCP compatibility](#chrome-devtools-mcp-compatibility)
- [Debugger lifecycle and bounds](#debugger-lifecycle-and-bounds)
- [Development and verification](#development-and-verification)
- [Icons](#icons)
- [Source handoffs](#source-handoffs)

## Operation

One Node process owns the extension connection. CLI and MCP clients share the existing Chrome profile and authenticated tabs. Disconnecting clients leaves the extension and tabs alone. Tabs are created, closed or navigated only by tools that request those actions; `performance_start_trace` reloads by default.

The side panel shows connection status and tab titles grouped by window, with active tabs highlighted. Clicking a title activates the tab and focuses its window.

`npm run build` provisions private configuration and builds `dist/`. `npm start` starts the bridge without rebuilding. `npm run up` combines build and start. Keep one bridge instance running; a second fails if port 3217 is occupied. Ctrl+C stops a foreground bridge cleanly. The optional [user-service template](../scripts/browser-proxy.service) runs the same process; replace `PROJECT_PATH` and `NODE_PATH` with the installation and Node executable paths before installing it.

Load `dist/` through Chrome's **Extensions → Developer mode → Load unpacked**. The extension is **Browser Proxy**, with stable ID `dpbhbfpeakcabbiaikgdhiaiobncceom` derived from the public manifest key. Keep `dist/` as its unpacked root. Building does not install or reload the extension. After rebuilding extension code, use Chrome's Reload button; coding agents must obtain explicit user approval first.

Ordinary web access is declared upfront. There is no per-site setup, permission-request call, browser-link tab or per-command approval screen. Chrome can apply enterprise policies or user-changed extension site-access settings. Legacy screenshot capture uses upfront `<all_urls>` access; see [Chrome's captureVisibleTab API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab). File URLs are unsupported.

The worker connects automatically and retries after bridge restarts. The bridge's 20-second ping and worker's reply keep WebSocket activity alive; an alarm also retries after worker suspension. Existing ordinary pages can be reached through on-demand script injection. Operation uses no development server or reload hook.

## Original tools and DOM references

Page operations use an explicit `tabId` from `tabs_list`. Selecting a tab never establishes an implicit target. `frameId` defaults to `0`; `page_frames` lists other frame IDs. CLI errors exit nonzero.

| Tools | Behavior |
|---|---|
| `health` | Connection, active/queued requests, observed worker state, stateless MCP count and process RSS |
| `tabs_list`, `tabs_select` | List tabs; activate/focus an explicit ID |
| `tabs_create`, `tabs_close` | Create/close only when explicitly called |
| `page_frames` | Frame IDs, URLs and document identifiers from Chrome |
| `page_snapshot` | Visible light-DOM controls, labels, values, selectors and document-scoped refs |
| `page_read` | Rendered page/selector text with explicit pagination |
| `page_click` | Synthetic DOM click |
| `page_fill`, `page_type` | Replace/append editable text; dispatch input/change events |
| `page_select` | Set native select values; dispatch input/change |
| `page_scroll` | Scroll window or unique CSS target by pixels |
| `page_navigate` | HTTP/HTTPS navigation; wait up to 15 seconds for completion |
| `page_screenshot` | PNG of the visible viewport of an already active explicit tab |

`tools` returns complete argument schemas. Ref or unique CSS selector is required for control operations. Prefer the snapshot's `ref` and optional `documentId` when acting on an observed document. References re-resolve selectors and verify target identity after a rerender. Navigation, page hiding, eviction or a changed target requires a fresh snapshot. Closed shadow roots, canvas controls and browser UI have no DOM selectors here. Open shadow roots are also outside this implementation's light-DOM snapshots.

Reads default to 20,000 characters; snapshots default to 100 controls. Responses explicitly include `total` and `nextOffset`; request that offset for more, or narrow a read with `selector`. Text limits can be raised to 200,000 and control pages to 500. These are output pages, not silent whole-page truncation. Native select options are included with their control. Password values are redacted in snapshots. Current-document reference maps hold at most 2,000 bounded selector/identity records, with no node objects or page-output history. Exceptionally large identities return `ref: null` with an explicit reason; use a short unique selector.

## MCP and HTTP clients

The Streamable HTTP endpoint is `http://127.0.0.1:3217/mcp`. The locked TypeScript SDK supports the `2025-11-25` initialize/list/call protocol. HTTP is stateless: no MCP session IDs, reconnect leases or per-client browser connection. Initialization and tool calls use POST; GET and DELETE return 405. Requests run in the shared Node process.

Setup generates `.runtime/hermes-mcp.json`, a private JSON fragment containing `mcp_servers.browser_proxy` and its bearer header. Merge that entry locally into the active Hermes configuration, preserving existing settings and keeping the credential private. JSON is valid YAML, but an existing YAML document still needs a mapping-level merge. Setup never reads or modifies a Hermes config or `.env`.

The generated settings are:

| Setting | Purpose |
|---|---|
| `url` and `headers` | Connect to the local MCP endpoint with bearer authentication |
| `protocol: legacy` | Use the initialize handshake without modern-only discovery |
| `trust: full` | Allow tool execution without Hermes's untrusted-server approval workflow |
| `skip_preflight: true` | Skip the GET/HEAD content-type probe on the POST-only endpoint |
| `supports_parallel_tool_calls: true` | Allow parallel client calls; tab serialization still applies |
| `timeout: 30`, `connect_timeout: 10` | Tool and connection timeouts in seconds |
| `tools.resources: false`, `tools.prompts: false` | Disable utility wrappers this server does not provide |

The fragment uses a bearer header, not OAuth. After merging it, use `/reload-mcp` in Hermes. Other MCP clients need the same endpoint and private header in their own configuration format. See the [Hermes MCP configuration reference](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference/). The browser fixture exercises independent SDK clients; it does not verify a user's Hermes installation.

Thin HTTP clients can load the bearer value privately from `.runtime/capability.json`. Authenticated `GET /health`, `GET /tools` and `POST /call` use the same header. A call body is `{"name":"page_read","arguments":{"tabId":123}}`. Never put the capability in a URL, log, public document or source export. The CLI handles authentication automatically and writes screenshots only when `--output` is supplied.

## Transport and execution limits

The bridge binds only `127.0.0.1`; it rejects other Host headers, website Origins, unauthenticated HTTP, and extension WebSockets without this extension's Origin, ID and private capability. Only one extension connection is accepted. Extension config is not web-accessible. Capability files have owner-only access; the runtime directory is private. The server logs its endpoint only, never page bodies, typed data, credentials or screenshots. CLI output is the explicitly requested result.

Same-tab calls are serialized in both bridge and worker; other tabs can progress independently. Responses match request ID, tab ID and frame ID. Browser calls expire after 25 seconds, finished entries/timers are removed, and late responses are ignored. Queues and pending Chrome work are independently bounded at 128 requests. A Chrome operation that remains unresolved after timeout blocks further operations on that tab until it settles, preventing accidental overlap. A timeout/disconnect may follow an already executed mutation: read the tab before retrying. Health's `activeHttp` includes the health request itself; worker counters are last-observed heartbeat values with `extensionStateAgeMs`.

Chrome-internal pages, the Web Store, extension pages, file/data URLs and inaccessible frames fail honestly. The legacy `page_screenshot` requires an active tab and detects activation races; `take_screenshot` adds target-specific CDP capture. Legacy DOM input remains synthetic (`isTrusted: false`). The CDP input tools provide trusted CDP input where stated, including real file-input assignment and checkbox/radio clicks, without promising browser permission dialogs or user-activation bypasses. Number/date/range controls, custom toggle semantics and native HTML drag-and-drop DataTransfer are outside the implemented input subset.

Removing `.runtime/capability.json` causes the next setup to generate a new capability. Rotation requires rebuilding, restarting the bridge, reloading the extension and updating private client configuration. Agents need explicit user approval before an installed-service restart or extension reload. Local outputs are bounded by 1 MiB input bodies and 32 MiB extension responses; oversized requests fail instead of being retained. There is no DOM/screenshot/history cache per client. CDP observers keep the bounded shared per-tab buffers described below.

## Chrome DevTools MCP compatibility

The baseline was this project's original 15 extension/content-script tools. The comparison is pinned to the official [v1.10.1 tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.10.1/docs/tool-reference.md) and its [tool implementations](https://github.com/ChromeDevTools/chrome-devtools-mcp/tree/chrome-devtools-mcp-v1.10.1/src/tools), rather than an unpinned main branch. That reference lists **58 tools**, including experimental/disabled-by-default categories. This project exposes **45 tools: 15 compatible original tools + 28 official names with the limits below + `debugger_status` and `debugger_detach`**. It does **not** claim full parity.

Operations on an existing tab require the actual Chrome `tabId`, replacing upstream `pageId`. Selection never establishes a shared implicit target. CDP tools address the main frame/target; legacy `frameId` routing remains available for content tools. CDP `uid`/`documentId` values come from `take_snapshot` and are deliberately separate from legacy `page_snapshot` references. Uids store backend node identifiers, not arbitrary selectors or DOM handles; removed/replaced nodes require another snapshot. There is no DevTools selected-element/request state. Unknown upstream options are rejected by strict schemas, including unsupported file-output, isolated-context and service-worker options.

| Official names added | Implemented behavior and intentional differences | Test coverage |
|---|---|---|
| `evaluate_script` | Async main-frame function, string uid arguments, JSON output, exceptions and automatic dialog handling. JSON limited to 200,000 characters with explicit truncation; undefined is marked. No `filePath`, `waitForStableDom`, service-worker evaluation or Puppeteer post-action settling. Five-second execution budget, then termination and up to one second of detach recovery for a stuck Promise. | Real async/uid evaluation, error, large-output and pending-Promise checks |
| `list_console_messages`, `get_console_message` | Runtime console/exception and Log events; type filters, pagination, optional stacks and previous three navigations. Starts at attachment, with possible Chrome console backlog. Descriptions/values only; no live object expansion, source maps, Audits issue integration or worker targets. | Real console warning and ID lookup; simulated eviction/navigation isolation |
| `list_network_requests`, `get_network_request` | Request/response metadata, redirect records, resource-type filtering, pagination, optional preserved history and bounded on-demand response bodies. Required reqid; no selected DevTools request or output paths. Headers are best effort (extra-info can arrive out of order); bodies can be missing/evicted. | Real fetch/status/headers/body and oversized-body denial; simulated redirects/bounds |
| `get_css_styles` | CDP matched/inherited rules and inline/attribute/computed style data; rule pagination, field truncation flags. Exposes CDP cascade metadata rather than upstream's formatted cascade analysis. | Real matched rule lookup |
| `take_snapshot` | Accessibility tree (including exposed shadow DOM), depth 6, at most 2,000 inspected nodes, output pagination and document-scoped uids. No child-target auto-attach or selected DevTools node. Names/values/properties are untrusted; verbose includes properties, including data the page exposes through accessibility. | Real shadow button/uid checks; simulated stale UID and navigation races |
| `take_screenshot` | Inactive-tab viewport, element and full-page PNG/JPEG/WebP, bounded pixels and encoded size. `uid` conflicts with `fullPage`. No `filePath`; MCP returns correctly typed image content, HTTP returns dataUrl, CLI supports `--output`. | Real PNG signature, JPEG element, WebP full page, inactive tab and oversize failure |
| `click`, `click_at`, `hover` | Trusted pointer input, optional double click and snapshot. Element actions check visibility, enabled state and hit testing. Coordinates are CSS viewport pixels. No general Puppeteer locator retries/navigation-stability waits. | Real `isTrusted`, coordinate click, hover CSS |
| `press_key`, `type_text` | Common navigation/function/printable keys and modifier chords. Text uses trusted Unicode `Input.insertText`; it does not reproduce a per-character keydown/keyup sequence. | Real Control+A, insertion and Tab |
| `drag` | Trusted pointer down/move/up between visible uids, with release cleanup. Destination must already be in the viewport. **Native HTML drag/drop DataTransfer payloads are not implemented.** | Real pointer-drag move counter |
| `fill`, `fill_form` | Trusted text replacement, checkbox/radio clicks; native select by label/value uses synthetic input/change. Ordered form filling, with partial-progress errors; completed changes are not undone. Other control types fail. | Real text/select/checkbox form and value assertions |
| `handle_dialog` | JS alert/confirm/prompt/beforeunload accept/dismiss. An action interrupted by a dialog returns `completed:false`; only dialog completion and buffer reads may proceed while its pending CDP reply is held. Browser permission/file-picker UI is not a JS dialog. | Real prompt plus automatic evaluation dialog; simulated pending-input barrier |
| `upload_file` | `DOM.setFileInputFiles` on a real file-input uid, using absolute paths on the browser host. No bridge filesystem reads. Chooser-trigger buttons unsupported. Chrome may represent a nonexistent path as an empty File; returned file metadata makes that visible. | Real fixture file contents read back from the page |
| `wait_for` | Any requested text in rendered main-frame body; timeout 0 means 10 seconds, maximum 15 seconds; navigation aborts. No shadow/iframe text aggregation. | Real delayed text and timeout |
| `resize_page`, `emulate` | Tab device-metrics viewport rather than shared OS-window resize; CPU/network/geo/color/UA/headers/viewport overrides. Omitted CPU/network/geo reset, other omissions preserve. Geo does not grant permission. Fixed network profiles approximate upstream presets. Multi-command emulation is not atomic. | Real viewport, color/UA; other commands accepted by real Chrome |
| `performance_start_trace`, `performance_stop_trace` | Single shared Chrome tracing session, raw trace events and Performance counters. Default reload and 5-second auto-stop; hard 30-second/2-MiB/10,000-event bounds and explicit loss flags. No `filePath`, screenshots, source-map processing, Core Web Vitals or insight analysis. Chrome tracing may include shared renderer/browser metadata beyond the initiating tab. | Real raw trace capture; simulated ownership, data caps, stop and detach |
| `list_pages`, `new_page`, `select_page`, `close_page`, `navigate_page` | Actual Chrome tab IDs/window identity, shared authenticated profile, no isolated browser contexts. `select_page` only focuses when `bringToFront:true`, never changes future routing. URL/back/forward/reload, bounded load wait, one-navigation initScript and beforeunload handling. `close_page` protects the last tab (legacy `tabs_close` stays compatible). | Real creation/list/select/close, URL/history/reload and initScript removal |

The following **30 upstream names are intentionally not registered**, so a client cannot mistake a placeholder for a working tool. The table distinguishes Chrome restrictions from missing implementation dependencies.

| Remaining official tools/category | Concrete blocker |
|---|---|
| `performance_analyze_insight` | Requires DevTools trace processor/insight models, complete recording and insight-set identifiers. This MV3 layer returns a bounded raw trace and has no such analyzer or datasets; raw Performance counters cannot honestly substitute for insights. |
| `lighthouse_audit` | Upstream runs its bundled Lighthouse runner against a Puppeteer page, generates reports and manages audit state. No Lighthouse runner/Puppeteer page adapter or bounded audit artifact pipeline exists here. Not fundamentally forbidden by MV3, but not implemented or tested. |
| `screencast_start`, `screencast_stop` | Upstream video encoding uses Puppeteer and ffmpeg. MV3 can receive CDP frames but cannot run an ffmpeg process; a bounded encoder/offscreen or bridge media pipeline would be needed. Returning screenshots would not implement video recording. |
| `take_heapsnapshot`, `close_heapsnapshot`, `compare_heapsnapshots`, `get_heapsnapshot_class_nodes`, `get_heapsnapshot_details`, `get_heapsnapshot_dominators`, `get_heapsnapshot_duplicate_strings`, `get_heapsnapshot_edges`, `get_heapsnapshot_object_details`, `get_heapsnapshot_retainers`, `get_heapsnapshot_retaining_paths`, `get_heapsnapshot_summary`, `query_heapsnapshot_objects` | `HeapProfiler` is absent from Chrome's debugger-domain allowlist. The remaining tools also need large snapshot files, a heap graph loader/index and retained analysis state. Neither the capture transport nor an independently bounded analysis service exists here. |
| `install_extension`, `reload_extension`, `trigger_extension_action` | The CDP `Extensions` domain is outside the debugger allowlist. MV3 has no API to install arbitrary unpacked extensions or trigger another extension's action, and `runtime.reload()` reloads only itself. No remote-debugging launch flag or native host is added. |
| `list_extensions`, `uninstall_extension` | The upstream browser-level extension API is unavailable through this debugger transport. Chrome management APIs could support parts with an additional `management` permission (and uninstall UI/consent constraints), but this proxy does not request it or control other installed extensions. |
| `execute_3p_developer_tool`, `list_3p_developer_tools` | Upstream's experimental `window.__dtmcp` discovery/injection protocol is not installed or tested here; no third-party panel/registry integration. Explicit `evaluate_script` can call a page's own existing API, but that does not establish upstream discovery parity. This is an implementation gap, not a claim that Runtime cannot call page APIs. |
| `execute_webmcp_tool`, `list_webmcp_tools` | Upstream depends on Puppeteer's experimental `page.webmcp` discovery/execution support. This proxy has no tested protocol adapter or capability negotiation for Chrome's experimental WebMCP facilities. Ordinary script evaluation is not advertised as WebMCP parity. |
| `get_os_app_state`, `install_pwa`, `launch_pwa`, `uninstall_pwa` | Upstream uses the browser-level `PWA` CDP domain, which Chrome's extension debugger does not allow. An ordinary MV3 tab attachment cannot provide OS integration state or those install/launch/uninstall commands. |

Domain restrictions are documented in [Chrome's debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger#restricted-domains). The table follows the pinned upstream implementations for performance, memory, extensions, PWA, Lighthouse, screencast and WebMCP.

## Debugger lifecycle and bounds

The manifest declares `debugger`. Chrome lists the permission warnings “Access the page debugger backend” and “Read and change all your data on all websites”. Chrome can show an active debugging indicator; canceling it detaches the target. The extension adds no runtime permission prompts. Chrome may require permission acknowledgment after an extension update. See [Chrome's permission list](https://developer.chrome.com/docs/extensions/reference/permissions-list#debugger).

`debugger_status` is a read-only local state query and does not attach. A CDP tool lazily attaches to an ordinary HTTP/HTTPS tab only after checking current tab/host access. `debugger_detach` releases only this proxy's own attachment, buffers, uids, emulation and trace. Detach also occurs on bridge disconnect, tab close, restricted navigation, debugger cancellation and five minutes without a tool request on that tab. Attachments are capped at eight. An already attached target yields `DEBUGGER_CONFLICT`; attach races and policy failures produce explicit attach errors. The proxy never detaches another owner to gain access. Opening DevTools can cause Chrome to detach the extension; subsequent calls must attach afresh and old uids remain invalid.

Both bridge and worker serialize by explicit tab and correlate request/tab/frame IDs. A pending Chrome operation keeps the existing timeout barrier. A dialog-interrupted CDP action has its own completion barrier: no ordinary page mutation runs until the dialog is closed and the pending reply settles. Document changes invalidate CDP uids before navigation and after context/frame changes; multi-step operations check revision and deadline before and after each CDP command. Runtime object groups are released after each request (or after interrupted dialog completion), so console history contains bounded values/descriptions, not remote object handles.

`onSuspend` requests best-effort teardown; it cannot guarantee asynchronous work during a forced worker termination. Chrome owns final debugger teardown when an extension is unloaded/reloaded. This implementation deliberately persists no page buffers, uids or trace contents across worker restarts. Modern Chrome keeps active debugger sessions alive; it also keeps the existing heartbeat connection active. Unit tests simulate suspension/reload recovery; the browser fixture checks real bridge-disconnect cleanup. See [Chrome's worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle#chrome-118).

| Resource | Bound and behavior |
|---|---|
| Attached tabs | 8; explicit detach or 5-minute inactivity cleanup |
| Console per tab | 200 records and 512 KiB estimated retained JSON memory; 8,000-character copy budget per record; eviction count returned |
| Network per tab | 200 records and 1 MiB estimated retained metadata; 16,000-character copy budget per record; request-ID map follows eviction |
| Chrome network body buffer | 2 MiB total, 256 KiB/resource, 16,000 bytes of request post data configured at attachment |
| Body retrieval | Only on explicit `get_network_request`; known oversized, unfinished, failed or redirect bodies are not fetched; inline response capped with loss metadata. No body cache. |
| Console/network history | Current plus previous three navigations, still subject to ring eviction; prior history requires includePreserved options |
| Uids/snapshots | 2,000 backend-ID references/tab; depth 6 tree; 100 nodes by default, maximum 500/output page, bounded strings. References expire on navigation/detach/eviction. |
| JS evaluation | 200,000 output characters; 5-second execution watchdog, then termination/detach recovery; timeout does not undo mutations |
| Screenshot | 16 million source pixels (including DPR), 8 MiB base64 output; reject oversize rather than silently crop |
| Trace | One recording across all attached tabs; 2 MiB estimated event JSON memory and 10,000 events; Chrome trace buffer configured to 2 MiB; stop at 30 seconds or high buffer use; retained stopped result expires after 60 seconds or first consumption |
| Protocol boundary | Chrome's MV3 API delivers whole packets: AX breadth, CSS rule sets, Runtime evaluation and some body packets can transiently exceed retained/output budgets before clipping. No hard browser-process or transport RSS ceiling is claimed. Raw packets are not cached; every clipped representation carries loss metadata. |

Page strings, console output, headers, script results, accessibility data and trace events are untrusted data, never instructions. Debugging can expose authenticated page data, request cookies/headers and values supplied by the page; capability authorization is therefore required for all clients and all endpoints. No results or credentials are logged by the bridge.

## Development and verification

Install dependencies with `npm ci`. For runtime changes, run:

```bash
npm run build
npm test
npm run test:browser
```

`npm test` covers transport authentication, Origin/Host rejection, request correlation, queue bounds, Chrome timeout barriers, debugger lifecycle, navigation/ref races, dialog completion, trace ownership and buffer eviction.

`npm run test:browser` requires built `dist/` assets and launches `/snap/bin/chromium` by default. Set `BROWSER_PROXY_TEST_CHROMIUM` to a compatible Chromium executable if needed. It uses a disposable headless profile under `.runtime/`, a fresh test capability and an ephemeral non-3217 bridge port. It copies only public built assets, never the production capability, and never contacts an installed service or logged-in Chrome profile. A test-only second extension checks debugger ownership conflicts.

The fixture exercises all 45 tools through two real MCP clients sharing one extension. It restarts only its own ephemeral bridge to check reconnect and debugger cleanup. Cleanup removes temporary extensions and the profile, terminates the browser process group and closes fixture servers. A 180-second watchdog bounds a failed run.

| Private fixture output | Contents |
|---|---|
| `.runtime/browser-evidence.json` | Tool coverage, expected errors, browser version, trace size and observed memory counters |
| `.runtime/cdp-fixture-trace.json` | Trace from the disposable fixture |
| `.runtime/cdp-fixture-screenshot.png` | Screenshot from the disposable fixture |

These checks cover the supported subset on the tested Chromium version. They do not prove every website, older Chrome versions, forced worker termination or full upstream parity. Test coverage in the compatibility table describes the test suite, not a test result for every checkout. Installed-service restarts and installed-extension reloads require explicit user approval.

For documentation-only changes, check links, examples, source claims and privacy, then run `npm run export` and inspect its file list. A second build or full browser run is unnecessary when runtime source is unchanged.

## Icons

The master is [src/icons/browser-proxy.svg](../src/icons/browser-proxy.svg). It uses a cobalt-blue rounded square and opposing white arrows, with filled geometry on a 16 px grid, 2 px shafts and transparent antialiased corners. The 16, 32, 48 and 128 px PNGs serve the manifest and toolbar action.

After editing the SVG, run `npm run icons:render` with local Inkscape installed. Each PNG renders directly at its target size. Normal builds copy `src/icons/` to `dist/icons/` without Inkscape. The browser fixture copies only PNGs referenced by the manifest.

## Source handoffs

`dist/bridge-config.json` contains the local capability. **Do not share `dist/` or `.runtime/` as directories.** Build and runtime files are private; recipients must generate their own configuration.

```bash
npm run export
```

The command requires `tar` and produces `.runtime/browser-proxy-source.tgz`. This source-only archive is the shareable exception inside `.runtime/`. Its staging directory is `.runtime/export/browser-proxy/`. [scripts/export.mjs](../scripts/export.mjs) uses an explicit allowlist; [package.json](../package.json) also limits packaged source files. Both include `AGENTS.md` and `docs/`, and exclude credentials, local integration files and generated build/runtime artifacts.

Recipients extract the source, run `npm ci` and `npm run build`, then load their own `dist/` in Chrome. Source export does not initialize Git or publish anything.

GPL-3.0-or-later. See [LICENSE](../LICENSE) for attribution and license details.
