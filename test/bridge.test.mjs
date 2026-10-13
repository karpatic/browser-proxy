import test from 'node:test'
import http from 'node:http'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import vm from 'node:vm'
import path from 'node:path'
import { WebSocket } from 'ws'
import { createBridge } from '../bridge/server.mjs'
import { tools } from '../bridge/tools.mjs'
import { extensionPeer, reply, mcpClient, sleep } from './helpers.mjs'
const config = { token: randomBytes(32).toString('base64url'), extensionId: 'abcdefghijklmnopabcdefghijklmnop' }
async function fixture(t, options = {}) {
  const bridge = await createBridge({ config, port: 0, timeoutMs: 150, ...options })
  t.after(() => bridge.close())
  return bridge
}
test('correlates out of order replies and frame identity, serializes one tab, runs unrelated tabs', async t => {
  const bridge = await fixture(t, { timeoutMs: 2000 })
  const seen = []
  const ws = await extensionPeer(bridge, config, (r, socket) => { seen.push(r); setTimeout(() => reply(socket, r, { marker: r.data.selector }), r.data.tabId === 1 ? 70 : 5) })
  const a = bridge.call('page_read', { tabId: 1, selector: '#a' })
  const b = bridge.call('page_read', { tabId: 1, selector: '#b' })
  const c = bridge.call('page_read', { tabId: 2, frameId: 7, selector: '#c' })
  assert.equal((await c).marker, '#c'); assert.equal(seen.length, 2)
  assert.equal((await a).marker, '#a'); assert.equal((await b).marker, '#b')
  reply(ws, seen[0], { ignored: true })
  await sleep(10)
  assert.equal(bridge.health().activeRequests, 0); assert.equal(bridge.health().queuedRequests, 0); assert.equal(bridge.health().tabQueues, 0)
})
test('timeouts, late replies, errors, mismatched targets and aborts release state', async t => {
  const bridge = await fixture(t)
  let pending
  const ws = await extensionPeer(bridge, config, r => { pending = r })
  await assert.rejects(bridge.call('page_read', { tabId: 1 }), /timed out/)
  reply(ws, pending, { late: true })
  const bad = bridge.call('page_read', { tabId: 2, frameId: 4 })
  await sleep(15); reply(ws, pending, {}, { frameId: 5 })
  await assert.rejects(bad, /identity mismatch/)
  const error = bridge.call('tabs_close', { tabId: 9 })
  await sleep(15); reply(ws, pending, null, { ok: false, error: 'No such tab' })
  await assert.rejects(error, /No such tab/)
  const abort = new AbortController()
  const gone = bridge.call('page_read', { tabId: 3 }, abort.signal)
  abort.abort(); await assert.rejects(gone, /Client disconnected/)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(bridge.call('page_read', { tabId: 3 }, aborted.signal), /Client disconnected/)
  await assert.rejects(bridge.call('page_click', { tabId: 'wrong' }), /number/)
  assert.equal(bridge.health().activeRequests + bridge.health().queuedRequests + bridge.health().tabQueues, 0)
})
test('extension disconnect rejects active and queued calls, reconnect remains available', async t => {
  const bridge = await fixture(t, { timeoutMs: 2000 })
  const ws = await extensionPeer(bridge, config, () => {})
  const promises = [bridge.call('page_read', { tabId: 1 }), bridge.call('page_read', { tabId: 1 }), bridge.call('page_read', { tabId: 2 })]
  const settled = Promise.allSettled(promises)
  ws.close(); const results = await settled
  assert.ok(results.every(r => r.status === 'rejected' && /disconnected/.test(r.reason.message)))
  assert.equal(bridge.health().activeRequests + bridge.health().queuedRequests + bridge.health().tabQueues, 0)
  await extensionPeer(bridge, config, (r, ws) => reply(ws, r, { restored: true }))
  assert.deepEqual(await bridge.call('tabs_list', {}), { restored: true })
})
test('rejects website Origins, rebinding Hosts, missing capabilities and wrong extension identities', async t => {
  const bridge = await fixture(t)
  const headers = { Authorization: `Bearer ${config.token}` }
  assert.equal((await fetch(`${bridge.endpoint}/health`)).status, 401)
  assert.equal((await fetch(`${bridge.endpoint}/health`, { headers: { ...headers, Origin: 'https://hostile.example' } })).status, 403)
  assert.equal(await new Promise((resolve, reject) => { const request = http.get(`${bridge.endpoint}/health`, { headers: { ...headers, Host: 'evil.example:3217' } }, res => { res.resume(); resolve(res.statusCode) }); request.on('error', reject) }), 403)
  assert.equal((await fetch(`${bridge.endpoint}/health`, { headers })).status, 200)
  async function rejectSocket(origin, token = config.token) {
    const ws = new WebSocket(`${bridge.endpoint.replace('http:', 'ws:')}/extension`, ['browser-proxy', token], { origin })
    const rejected = await new Promise(resolve => { ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode) }); ws.on('error', () => {}) })
    assert.equal(rejected, 403)
  }
  await rejectSocket('https://hostile.example')
  await rejectSocket('chrome-extension://wrong')
  await rejectSocket(`chrome-extension://${config.extensionId}`, 'invalid')
  const ws = await extensionPeer(bridge, config, () => {})
  await rejectSocket(`chrome-extension://${config.extensionId}`)
  ws.close(); await sleep(20)
  const bad = new WebSocket(`${bridge.endpoint.replace('http:', 'ws:')}/extension`, ['browser-proxy', config.token], { origin: `chrome-extension://${config.extensionId}` })
  await new Promise(resolve => bad.once('open', resolve))
  bad.send(JSON.stringify({ type: 'hello', extensionId: 'wrong' }))
  await new Promise(resolve => bad.once('close', resolve))
  assert.equal(bridge.health().extensionConnected, false)
})
test('two independently initialized real MCP clients list/call tools; all client closes preserve extension', async t => {
  const bridge = await fixture(t, { timeoutMs: 2000 })
  await extensionPeer(bridge, config, (r, ws) => reply(ws, r, [{ tabId: 42 }]))
  const first = await mcpClient(bridge.endpoint, config.token, 'first'), second = await mcpClient(bridge.endpoint, config.token, 'second')
  t.after(() => Promise.allSettled([first.close(), second.close()]))
  const [a, b] = await Promise.all([first.listTools(), second.listTools()])
  assert.equal(a.tools.length, 45); assert.equal(a.tools.length, tools.length); assert.deepEqual(a.tools.map(t => t.name), b.tools.map(t => t.name))
  assert.deepEqual((await first.callTool({ name: 'tabs_list', arguments: {} })).structuredContent.items, [{ tabId: 42 }])
  await first.close()
  assert.equal(bridge.health().extensionConnected, true)
  assert.equal((await second.callTool({ name: 'health', arguments: {} })).structuredContent.extensionConnected, true)
  await second.close()
  assert.equal(bridge.health().extensionConnected, true)
  assert.deepEqual(await bridge.call('tabs_list', {}), [{ tabId: 42 }])
  await sleep(30)
  assert.equal(bridge.health().mcpSessions, 0); assert.equal(bridge.health().activeHttp, 0); assert.equal(bridge.health().retainedResponses, 0)
})
test('bounds in-flight and queued state', async t => {
  const bridge = await fixture(t, { maxRequests: 3 })
  await extensionPeer(bridge, config, () => {})
  const settled = Promise.allSettled([bridge.call('page_read', { tabId: 1 }), bridge.call('page_read', { tabId: 1 }), bridge.call('page_read', { tabId: 2 })])
  await assert.rejects(bridge.call('tabs_list', {}), /busy/)
  assert.equal(bridge.health().activeRequests + bridge.health().queuedRequests, 3)
  await settled
  assert.equal(bridge.health().activeRequests + bridge.health().queuedRequests, 0)
})
test('production declares debugger upfront, has no runtime prompts/browser harness/extension reload hooks; package excludes secrets', async () => {
  const manifest = JSON.parse(await readFile(new URL('../dist/manifest.json', import.meta.url), 'utf8'))
  assert.deepEqual(manifest.host_permissions, ['<all_urls>'])
  assert.equal(manifest.optional_permissions, undefined)
  assert.ok(manifest.permissions.includes('debugger'))
  const production = await Promise.all(['dist/service-worker.js', 'dist/content.js', 'dist/panel.js', 'bridge/server.mjs', 'bridge/tools.mjs', 'bridge/cli.mjs'].map(p => readFile(new URL(`../${p}`, import.meta.url), 'utf8')))
  for (const source of production) assert.doesNotMatch(source, /permissions\.request|playwright|puppeteer|runtime\.reload|tabs\.reload|3012|demoProfile|showProfileBadge/)
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dependencies['playwright-core'], undefined)
  assert.ok(!pkg.files.includes('dist/') && !pkg.files.includes('.runtime/'))
})
test('second bridge bind fails instead of starting another shared process', async t => {
  const bridge = await fixture(t)
  await assert.rejects(createBridge({ config, port: bridge.server.address().port }), error => error.code === 'EADDRINUSE')
})
test('browser fixture evidence failures cannot skip teardown or replace the original test error', async () => {
  const source = await readFile(new URL('./browser.mjs', import.meta.url), 'utf8')
  const start = source.lastIndexOf('\nfinally {')
  assert.ok(start > 0)
  for (const failed of [false, true]) {
    const seen = [], original = failed ? Error('original test failure') : null, reporting = Error('evidence write failed')
    const context = {
      original, evidence: { passed: !failed }, path, runtime: 'fixture-runtime', timer: 1, work: 'fixture-work',
      clearTimeout: () => seen.push('timer'),
      writeFile: async () => { seen.push('evidence'); throw reporting },
      first: { close: async () => { seen.push('first') } }, second: { close: async () => { seen.push('second') } },
      sleep: async () => {}, browser: { pid: 42, once: (_event, resolve) => resolve() },
      process: { kill: (pid, signal) => { assert.equal(pid, -42); seen.push(signal) } },
      bridge: { close: async () => { seen.push('bridge') } },
      fixture: { closeAllConnections: () => seen.push('connections'), close: resolve => { seen.push('server'); resolve() } },
      rm: async (dir, options) => { assert.equal(dir, 'fixture-work'); assert.equal(options.recursive, true); seen.push('work') },
      console: { error: () => seen.push('reporting error') },
    }
    const operation = vm.runInNewContext(`(async () => { try { if (original) throw original } ${source.slice(start)} })()`, context)
    await assert.rejects(operation, error => error === (original || reporting))
    assert.deepEqual(seen.filter(value => value !== 'reporting error'), ['timer', 'evidence', 'first', 'second', 'SIGTERM', 'SIGKILL', 'bridge', 'connections', 'server', 'work'])
  }
})
