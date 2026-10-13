import http from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { setup } from '../scripts/setup.mjs'
import { tools, validate, toolList } from './tools.mjs'
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
export async function createBridge({ config, port = 3217, timeoutMs = 25000, maxRequests = 128 } = {}) {
  config ??= await setup()
  let lastExtensionUpdate = 0
  let extension = null, ready = false, extensionState = { activeRequests: 0, queues: 0 }, activeHttp = 0, completed = 0, failed = 0
  const entries = new Map(), queues = new Map(), busy = new Set(), sockets = new Set()
  const origin = `chrome-extension://${config.extensionId}`
  function health() {
    return { extensionConnected: ready, extensionId: config.extensionId, activeRequests: [...entries.values()].filter(e => e.started).length, queuedRequests: [...entries.values()].filter(e => !e.started).length, tabQueues: queues.size, extensionState, extensionStateAgeMs: lastExtensionUpdate ? Date.now() - lastExtensionUpdate : null, activeHttp, mcpSessions: 0, retainedResponses: 0, completed, failed, rssBytes: process.memoryUsage().rss, uptimeSeconds: Math.round(process.uptime()) }
  }
  function remove(entry, error, data) {
    if (!entries.delete(entry.id)) return
    clearTimeout(entry.timer)
    entry.signal?.removeEventListener('abort', entry.abort)
    const queue = queues.get(entry.key)
    if (queue) { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1); if (!queue.length) queues.delete(entry.key) }
    if (entry.started) busy.delete(entry.key)
    if (error) { failed++; entry.reject(error) } else { completed++; entry.resolve(data) }
    pump(entry.key)
  }
  function pump(key) {
    if (busy.has(key)) return
    const entry = queues.get(key)?.[0]
    if (!entry) return
    if (!ready || extension?.readyState !== WebSocket.OPEN) { remove(entry, new Error('Extension disconnected. Start the bridge and load dist in Chrome.')); return }
    busy.add(key); entry.started = true
    extension.send(JSON.stringify({ type: 'request', id: entry.id, toSwAction: entry.name, data: entry.args, deadline: entry.deadline }), error => { if (error) remove(entry, new Error('Extension transport failed')) })
  }
  async function call(name, args, signal) {
    args = validate(name, args)
    if (name === 'health') return health()
    if (signal?.aborted) throw new Error('Client disconnected')
    if (!ready) throw new Error('Extension disconnected. Start the bridge and load dist in Chrome.')
    if (entries.size >= maxRequests) throw new Error('Bridge busy; retry after current requests finish')
    return new Promise((resolve, reject) => {
      const id = randomUUID(), key = args.tabId ?? `global-${id}`
      const entry = { id, key, name, args, resolve, reject, signal, started: false, deadline: Date.now() + timeoutMs }
      entry.abort = () => remove(entry, new Error('Client disconnected; an already dispatched browser action may have executed'))
      entry.timer = setTimeout(() => remove(entry, new Error('Browser request timed out; action may have executed. Read the explicit tab before retrying.')), timeoutMs)
      entries.set(id, entry)
      if (!queues.has(key)) queues.set(key, [])
      queues.get(key).push(entry)
      signal?.addEventListener('abort', entry.abort, { once: true })
      pump(key)
    })
  }
  const json = (res, status, data) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) } }
  function allowed(req) {
    const expectedHost = `127.0.0.1:${server.address()?.port}`
    return req.headers.host === expectedHost && (!req.headers.origin || req.headers.origin === origin)
  }
  async function body(req) {
    const chunks = []; let size = 0
    for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Request body exceeds 1 MiB'); chunks.push(chunk) }
    return JSON.parse(Buffer.concat(chunks).toString())
  }
  const server = http.createServer(async (req, res) => {
    if (!allowed(req)) { json(res, 403, { error: 'Host or Origin rejected' }); return }
    if (!equal(req.headers.authorization, `Bearer ${config.token}`)) { json(res, 401, { error: 'Local capability required' }); return }
    if (activeHttp >= maxRequests) { json(res, 503, { error: 'Bridge busy' }); return }
    activeHttp++
    const abort = new AbortController()
    let cleaned = false, mcp, transport
    const cleanup = () => {
      if (cleaned) return
      cleaned = true; activeHttp--; abort.abort()
      transport?.close().catch(() => {}); mcp?.close().catch(() => {})
    }
    res.once('close', cleanup)
    res.once('finish', cleanup)
    try {
      if (req.method === 'GET' && req.url === '/health') { json(res, 200, health()); return }
      if (req.method === 'GET' && req.url === '/tools') { json(res, 200, { tools: toolList() }); return }
      if (req.url === '/call' && req.method === 'POST') {
        const input = await body(req)
        try { json(res, 200, { ok: true, data: await call(input.name, input.arguments, abort.signal) }) }
        catch (error) { json(res, 200, { ok: false, error: error.message }) }
        return
      }
      if (req.url === '/mcp') {
        if (req.method !== 'POST') { json(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Stateless MCP accepts POST only' } }); return }
        const input = await body(req)
        mcp = new McpServer({ name: 'browser-proxy', version: '1.0.0' })
        for (const tool of tools) mcp.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema, annotations: tool.annotations }, async args => {
          try {
            const data = await call(tool.name, args, abort.signal)
            if (tool.name === 'page_screenshot' || tool.name === 'take_screenshot') {
              const image = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(data.dataUrl || '')
              if (!image || data.dataUrl.length > 8 * 1024 * 1024 + 100) throw new Error('Invalid or oversized screenshot response')
              return { content: [{ type: 'image', data: image[2], mimeType: image[1] }, { type: 'text', text: JSON.stringify({ tabId: data.tabId, scope: data.scope }) }] }
            }
            return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: Array.isArray(data) ? { items: data } : data }
          } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] } }
        })
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
        await mcp.connect(transport)
        await transport.handleRequest(req, res, input)
        return
      }
      json(res, 404, { error: 'Unknown endpoint' })
    } catch { json(res, 400, { error: 'Invalid request' }) }
  })
  server.maxConnections = 256
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false, handleProtocols: () => 'browser-proxy' })
  server.on('upgrade', (req, socket, head) => {
    const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim())
    if (!allowed(req) || req.url !== '/extension' || req.headers.origin !== origin || protocols.length !== 2 || protocols[0] !== 'browser-proxy' || !equal(protocols[1], config.token) || extension) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      extension = ws; ready = false
      const helloTimeout = setTimeout(() => ws.close(), 5000)
      ws.on('message', raw => {
        let response
        try { response = JSON.parse(raw.toString()) } catch { ws.close(1008); return }
        if (response.type === 'hello') {
          if (response.extensionId !== config.extensionId) { ws.close(1008); return }
          ready = true; lastExtensionUpdate = Date.now(); clearTimeout(helloTimeout); return
        }
        if (response.type === 'pong') { lastExtensionUpdate = Date.now(); extensionState = { activeRequests: Number(response.activeRequests) || 0, pendingRequests: Number(response.pendingRequests) || 0, queues: Number(response.queues) || 0, unsettled: Number(response.unsettled) || 0 }; return }
        if (response.type !== 'response' || !ready) return
        const entry = entries.get(response.id)
        if (!entry || !entry.started) return
        if (response.tabId !== entry.args.tabId || response.frameId !== (entry.args.frameId ?? 0)) { remove(entry, new Error('Extension response target identity mismatch')); return }
        remove(entry, response.ok ? null : new Error(response.error || 'Browser action failed'), response.data)
      })
      ws.on('error', () => ws.close())
      ws.on('close', () => {
        clearTimeout(helloTimeout)
        if (extension !== ws) return
        ready = false; extension = null; extensionState = { activeRequests: 0, queues: 0 }
        for (const entry of [...entries.values()]) remove(entry, new Error('Extension disconnected; action may have executed'))
      })
    })
  })
  const heartbeat = setInterval(() => { if (ready && Date.now() - lastExtensionUpdate > 60000) extension?.terminate(); else if (extension?.readyState === WebSocket.OPEN) extension.send(JSON.stringify({ type: 'ping' })) }, 20000)
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) }) }
  catch (error) { clearInterval(heartbeat); wss.close(); throw error }
  return { server, call, health, endpoint: `http://127.0.0.1:${server.address().port}`, async close() {
    clearInterval(heartbeat); ready = false
    for (const entry of [...entries.values()]) remove(entry, new Error('Bridge shutting down'))
    extension?.terminate(); wss.close()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  } }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bridge = await createBridge()
  console.log(`Browser Proxy listening on ${bridge.endpoint}; MCP: /mcp`)
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await bridge.close(); process.exit(0) })
}
