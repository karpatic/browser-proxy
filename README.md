# Browser Proxy

<img src="src/icons/icon-128.png" alt="Browser Proxy icon" width="64" height="64" align="right">

Browser Proxy lets AI agents and command-line tools use the Chrome browser you already have open. They can open and close tabs, read pages, click, type, fill forms, navigate, take screenshots, and inspect console and network activity. It works with sites where you are already signed in because it uses the Chrome profile you choose instead of launching a separate browser.

Browser Proxy has two local parts: a Chrome extension and a small Node.js server. The server listens only on your computer and requires a private token. AI agents connect through Model Context Protocol (MCP); people and scripts can use the included command-line interface. Browser actions target a specific tab.

It provides **45 tools** for tab management, page interaction, screenshots, console and network inspection, emulation, and performance tracing. It supports many Chrome DevTools MCP tool names but is not a complete replacement. See the [compatibility reference](docs/REFERENCE.md#chrome-devtools-mcp-compatibility).

## Quick start

Requires **Node.js 22+**, npm and **Chrome/Chromium 120+** with unpacked extension support. Run commands from the repository root.

**1. Install and build**

```bash
npm ci
npm run build
```

The build creates `dist/` and private local configuration in `.runtime/`.

**2. Load the extension**

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked** and select this repository's `dist/` directory. Use the Chrome profile whose tabs you want to share.

**3. Start the local server**

```bash
npm start
```

Keep it running at `http://127.0.0.1:3217`. Run only one instance. Ctrl+C stops a foreground server. An optional [user-service template](scripts/browser-proxy.service) is available; see [operation notes](docs/REFERENCE.md#operation).

**4. Check the connection**

In another terminal at the repository root:

```bash
npm run cli -- health
npm run cli -- tabs_list
```

Health should report `extensionConnected: true`. Open an ordinary HTTP/HTTPS page and take its `tabId` from `tabs_list`. If disconnected, confirm the extension is enabled and loaded from this build's `dist/`; it retries automatically. The extension's side panel also shows connection status and tabs.

## CLI examples

Replace `123` with a real tab ID. Adapt selectors to the page.

```bash
npm run cli -- tools
npm run cli -- tabs_create '{"url":"https://example.com","active":true}'
npm run cli -- page_snapshot '{"tabId":123}'
npm run cli -- page_read '{"tabId":123,"selector":"main"}'
npm run cli -- page_fill '{"tabId":123,"selector":"#search","text":"hello"}'
npm run cli -- page_click '{"tabId":123,"selector":"button[type=submit]"}'
npm run cli -- tabs_select '{"tabId":123}'
npm run cli -- page_screenshot '{"tabId":123}' --output .runtime/viewport.png
```

`tabs_create` and `new_page` create ordinary tabs in the shared Chrome profile; they do not start a separate browser or isolated profile. Operations on a tab require an explicit `tabId`. Selecting a tab never sets a target for later calls. `page_screenshot` requires an active tab; CDP `take_screenshot` also supports inactive tabs. `tools` returns argument schemas. See [DOM references and pagination](docs/REFERENCE.md#original-tools-and-dom-references) for reliable targeting.

## MCP and Hermes

The MCP endpoint is **`http://127.0.0.1:3217/mcp`**, using authenticated Streamable HTTP.

Build/setup generates **`.runtime/hermes-mcp.json`** with the `mcp_servers.browser_proxy` entry and its private bearer header. Merge that entry locally into your active Hermes configuration, preserving other servers, then run `/reload-mcp` in Hermes. Setup does not edit your Hermes configuration.

The fragment selects `protocol: legacy`, `trust: full`, `skip_preflight: true` and parallel tool calls. It allows tool execution without Hermes's untrusted-server approval workflow. Other MCP clients use the same URL and private header in their own configuration format. Keep this file and its credential out of logs, chat and source control. See [MCP configuration details](docs/REFERENCE.md#mcp-and-http-clients).

## Security boundary

- The local server listens only on `127.0.0.1` and requires a private token. It checks Host and Origin headers and accepts one authenticated extension connection.
- Authorized clients share your existing Chrome profile and can access authenticated page data or change pages. There is no per-call approval screen in the extension. Treat page content and tool output as untrusted data.
- CDP tools attach through Chrome's `debugger` permission. Chrome may show a debugging indicator. Restricted pages and unsupported operations return errors; see [limits and lifecycle](docs/REFERENCE.md#debugger-lifecycle-and-bounds).
- The local server does not log page bodies, typed data, credentials or screenshots. CLI results and saved outputs may contain private data. Never publish `dist/`, local configuration or runtime data.

## Development and source handoff

For runtime changes:

```bash
npm run build
npm test
npm run test:browser
```

The browser fixture uses a disposable profile, a fresh test capability and an ephemeral port. It requires compatible Chromium; see [verification details](docs/REFERENCE.md#development-and-verification). Building does not reload the installed extension. Coding agents must get explicit user approval before restarting an installed service or reloading an installed extension.

To share source only, with `tar` installed:

```bash
npm run export
```

Share **`.runtime/browser-proxy-source.tgz`**. It includes source, docs and agent instructions, and excludes private configuration and build artifacts. Recipients build locally to create their own credentials. See [source handoffs](docs/REFERENCE.md#source-handoffs).

[Full reference](docs/REFERENCE.md) · [Coding agent guide](AGENTS.md) · [GPL-3.0-or-later license](LICENSE) · [Notices](NOTICE)
