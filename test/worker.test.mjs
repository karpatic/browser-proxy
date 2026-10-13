// Simulated Chrome API regressions; these are separate from the real Chromium smoke.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { sleep } from './helpers.mjs'
async function worker(t) {
  const sent = [], pending = []; let socket, statusListener
  class Socket {
    static OPEN = 1; static CONNECTING = 0
    readyState = 1
    constructor() { socket = this }
    send(raw) { sent.push(JSON.parse(raw)) }
    close() { this.readyState = 3 }
  }
  const stub = { addListener() {} }
  const chrome = {
    sidePanel: { setPanelBehavior: async () => {} },
    alarms: { create() {}, onAlarm: stub },
    runtime: { id: 'test-extension', getURL: s => s, onMessage: { addListener: listener => { statusListener = listener } }, onStartup: stub, onInstalled: stub, onSuspend: stub },
    tabs: { get: () => new Promise(resolve => pending.push(resolve)), query: () => new Promise(resolve => pending.push(resolve)), remove: async () => {}, onRemoved: stub },
    webNavigation: { onBeforeNavigate: stub },
    debugger: { onEvent: stub, onDetach: stub },
  }
  const context = vm.createContext({ chrome, WebSocket: Socket, fetch: async () => ({ json: async () => ({ token: 'not-a-real-token', url: 'ws://test' }) }), setTimeout, clearTimeout, console })
  const debuggerSource = (await readFile(new URL('../src/debugger.js', import.meta.url), 'utf8')).replace(/^export /gm, '')
  const workerSource = (await readFile(new URL('../src/service-worker.js', import.meta.url), 'utf8')).replace(/^import .*$/gm, '')
  vm.runInContext(`${debuggerSource}\n${workerSource}`, context)
  await sleep(5); socket.onopen()
  const status = () => { let value; statusListener({ toSwAction: 'status' }, { id: chrome.runtime.id }, v => { value = v }); return value }
  const request = (id, name, data, duration = 40) => socket.onmessage({ data: JSON.stringify({ type: 'request', id, toSwAction: name, data, deadline: Date.now() + duration }) })
  t.after(() => { for (const resolve of pending) resolve({ id: 1, url: 'http://fixture/', status: 'complete' }) })
  return { sent, pending, status, request, chrome }
}
test('worker timeouts clear request queues; unsettled Chrome calls block same-tab overlap and clear on settlement', async t => {
  const w = await worker(t)
  w.request('one', 'tabs_close', { tabId: 1 })
  await sleep(70)
  assert.match(w.sent.find(r => r.id === 'one').error, /timed out/)
  assert.equal(w.status().pendingRequests, 0); assert.equal(w.status().queues, 0); assert.equal(w.status().unsettled, 1)
  w.request('two', 'tabs_close', { tabId: 1 })
  await sleep(10)
  assert.match(w.sent.find(r => r.id === 'two').error, /has not settled/)
  assert.equal(w.pending.length, 1)
  w.pending[0]({ id: 1 }); await sleep(10)
  assert.equal(w.status().unsettled, 0)
})
test('worker independently bounds pending Chrome operations and rejects expired commands without execution', async t => {
  const w = await worker(t)
  w.request('expired', 'tabs_list', {}, -1); await sleep(5)
  assert.match(w.sent.find(r => r.id === 'expired').error, /expired/)
  assert.equal(w.pending.length, 0)
  for (let i = 0; i < 129; i++) w.request(String(i), 'tabs_list', {}, 100)
  await sleep(10)
  assert.equal(w.status().pendingRequests, 128)
  assert.match(w.sent.find(r => r.id === '128').error, /busy/)
  await sleep(130)
  assert.equal(w.status().pendingRequests, 0); assert.equal(w.status().queues, 0); assert.equal(w.status().unsettled, 128)
  w.request('overflow', 'tabs_list', {}); await sleep(5)
  assert.match(w.sent.find(r => r.id === 'overflow').error, /busy/)
  for (const resolve of w.pending) resolve([])
  await sleep(10); assert.equal(w.status().unsettled, 0)
})
test('screenshot discards transient activation changes even when original tab is active again', async t => {
  const w = await worker(t)
  let activation, capture
  w.chrome.tabs.get = async () => ({ id: 1, windowId: 2, url: 'http://fixture/' })
  w.chrome.tabs.query = async () => [{ id: 1 }]
  w.chrome.tabs.onActivated = { addListener: f => { activation = f }, removeListener: () => { activation = null } }
  w.chrome.tabs.captureVisibleTab = () => new Promise(resolve => { capture = resolve })
  w.request('capture', 'page_screenshot', { tabId: 1 }, 500)
  await sleep(10)
  activation({ windowId: 2, tabId: 9 }); activation({ windowId: 2, tabId: 1 })
  capture('not-real-image-data'); await sleep(10)
  assert.match(w.sent.find(r => r.id === 'capture').error, /changed during capture/)
  assert.equal(activation, null); assert.equal(w.status().pendingRequests, 0)
})
test('official close_page serializes its last-tab guard across concurrent targets', async t => {
  const w = await worker(t), tabs = new Set([1, 2])
  w.chrome.tabs.get = async id => ({ id, url: 'https://fixture/' })
  w.chrome.tabs.query = async () => [...tabs].map(id => ({ id }))
  w.chrome.tabs.remove = async id => { await sleep(15); tabs.delete(id) }
  w.request('close-one', 'close_page', { tabId: 1 }, 500)
  w.request('close-two', 'close_page', { tabId: 2 }, 500)
  await sleep(70)
  assert.equal(tabs.size, 1)
  assert.equal(w.sent.filter(r => r.ok === true).length, 1)
  assert.match(w.sent.find(r => r.ok === false).error, /last remaining tab/)
})
