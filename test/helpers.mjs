import { WebSocket } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export async function extensionPeer(bridge, config, handle) {
  const socket = new WebSocket(`${bridge.endpoint.replace('http:', 'ws:')}/extension`, ['browser-proxy', config.token], { origin: `chrome-extension://${config.extensionId}` })
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  socket.send(JSON.stringify({ type: 'hello', extensionId: config.extensionId }))
  socket.on('message', raw => { const request = JSON.parse(raw); if (request.type === 'request') handle(request, socket) })
  for (let i = 0; i < 50 && !bridge.health().extensionConnected; i++) await sleep(5)
  return socket
}
export const reply = (ws, request, data, extra = {}) => ws.send(JSON.stringify({ type: 'response', id: request.id, tabId: request.data.tabId, frameId: request.data.frameId ?? 0, ok: true, data, ...extra }))
export async function mcpClient(endpoint, token, name = 'test') {
  const client = new Client({ name, version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  await client.connect(transport)
  return client
}
