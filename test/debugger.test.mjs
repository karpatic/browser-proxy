import test from 'node:test'
import assert from 'node:assert/strict'
import { createDebugger, CDP_LIMITS, bounded } from '../src/debugger.js'
import { validate, tools } from '../bridge/tools.mjs'

const event = () => { const listeners = []; return { addListener: f => listeners.push(f), emit: (...args) => listeners.forEach(f => f(...args)) } }
async function fixture(t) {
  const calls = [], owned = new Set()
  const chrome = {
    tabs: { get: async id => ({ id, url: 'https://fixture.test/', status: 'complete' }), onRemoved: event() },
    permissions: { contains: async () => true }, webNavigation: { onBeforeNavigate: event() }, runtime: { onSuspend: event() },
    debugger: {
      onEvent: event(), onDetach: event(), getTargets: async () => [],
      attach: async ({ tabId }) => { owned.add(tabId); calls.push(['attach', tabId]) },
      detach: async ({ tabId }) => { owned.delete(tabId); calls.push(['detach', tabId]) },
      sendCommand: async ({ tabId }, method, params) => {
        calls.push([method, tabId, params])
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'initial' } } }
        if (method === 'Runtime.evaluate') return { result: { value: 1, objectId: 'global' } }
        if (method === 'Runtime.callFunctionOn') return { result: { value: true } }
        if (method === 'Performance.getMetrics') return { metrics: [] }
        if (method === 'Tracing.end') queueMicrotask(() => chrome.debugger.onEvent.emit({ tabId }, 'Tracing.tracingComplete', {}))
        return {}
      },
    },
  }
  const api = createDebugger(chrome)
  t.after(() => api.detachAll())
  const call = (name, args = {}) => api.execute(name, validate(name, { tabId: 1, ...args }), Date.now() + 20000)
  const emit = (name, p, tabId = 1) => chrome.debugger.onEvent.emit({ tabId }, name, p)
  return { api, chrome, call, emit, calls, owned }
}

test('catalog preserves 15 legacy names and adds precisely 28 official names plus lifecycle controls', () => {
  assert.equal(tools.length, 45); assert.equal(new Set(tools.map(t => t.name)).size, 45)
  assert.throws(() => validate('evaluate_script', { function: '()=>1' }), /tabId/)
  assert.throws(() => validate('evaluate_script', { tabId: 1, function: '()=>1', filePath: '/tmp/x' }), /Unrecognized/)
  assert.throws(() => validate('wait_for', { tabId: 1, text: [] }), /Too small/)
  assert.throws(() => validate('upload_file', { tabId: 1, uid: 'u', filePaths: ['relative'] }), /absolute/)
  assert.equal(tools.find(t => t.name === 'evaluate_script').annotations.readOnlyHint, false)
  assert.equal(tools.find(t => t.name === 'get_css_styles').annotations.readOnlyHint, true)
})
test('attachment is lazy, limited, host-restricted and does not steal a target', async t => {
  const f = await fixture(t)
  assert.equal((await f.call('debugger_status')).attached, false); assert.equal(f.calls.length, 0)
  f.chrome.debugger.getTargets = async () => [{ tabId: 1, attached: true }]
  await assert.rejects(f.call('list_console_messages'), /DEBUGGER_CONFLICT/)
  assert.equal(f.owned.size, 0)
  f.chrome.debugger.getTargets = async () => []
  f.chrome.permissions.contains = async () => false
  await assert.rejects(f.call('list_console_messages'), /Host access denied/)
  f.chrome.permissions.contains = async () => true
  f.chrome.tabs.get = async id => ({ id, url: 'chrome://settings' })
  await assert.rejects(f.call('list_console_messages'), /Restricted/)
  f.chrome.tabs.get = async id => ({ id, url: 'https://fixture.test/' })
  for (let i = 1; i <= CDP_LIMITS.tabs; i++) await f.call('list_console_messages', { tabId: i })
  await assert.rejects(f.call('list_console_messages', { tabId: 99 }), /attachment limit/)
  await f.call('debugger_detach'); assert.equal(f.owned.size, CDP_LIMITS.tabs - 1)
})
test('console and network eviction, redirects, previous navigation filtering and tab isolation', async t => {
  const f = await fixture(t)
  await f.call('list_console_messages'); await f.call('list_network_requests', { tabId: 2 })
  for (let i = 0; i < 250; i++) f.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'x'.repeat(50000) }], timestamp: i })
  const status = await f.call('debugger_status')
  assert.ok(status.console.count <= 200); assert.ok(status.console.bytes <= CDP_LIMITS.consoleBytes); assert.ok(status.console.dropped > 0)
  assert.equal((await f.call('list_console_messages', { tabId: 2 })).items.length, 0)
  const list = await f.call('list_console_messages', { pageSize: 1 })
  assert.equal(list.items.length, 1); assert.equal(list.items[0].truncated, true); assert.equal(list.nextPageIdx, 1)
  const oldId = list.items[0].msgid
  f.emit('Network.requestWillBeSent', { requestId: 'r', request: { url: 'https://fixture.test/a', method: 'GET' }, type: 'Fetch', loaderId: 'initial' })
  f.emit('Network.requestWillBeSent', { requestId: 'r', request: { url: 'https://fixture.test/b', method: 'GET' }, type: 'Fetch', loaderId: 'initial', redirectResponse: { status: 302 } })
  const requests = await f.call('list_network_requests'); assert.equal(requests.items.length, 2); assert.equal(requests.items[0].status, 302)
  f.emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'next', url: 'https://fixture.test/next' } })
  assert.equal((await f.call('list_console_messages')).items.length, 0)
  assert.ok((await f.call('list_console_messages', { includePreservedMessages: true })).items.length > 0)
  for (let i = 0; i < 4; i++) f.emit('Page.frameNavigated', { frame: { id: 'main', loaderId: String(i), url: 'https://fixture.test/' } })
  await assert.rejects(f.call('get_console_message', { msgid: oldId }), /evicted/)
})
test('bounded copier marks data loss, handles prototype keys and preserves application objectId fields', () => {
  const safe = bounded(JSON.parse('{"__proto__":{"polluted":true},"objectId":"application-id","text":"' + 'x'.repeat(10000) + '"}'), 1000)
  assert.equal({}.polluted, undefined); assert.equal(safe.data.objectId, 'application-id'); assert.equal(safe.truncated, true)
  assert.ok(JSON.stringify(safe.data).length < 1200)
  const small = bounded({ nested: { objectId: 'nested-id' } })
  assert.equal(small.data.nested.objectId, 'nested-id'); assert.equal(small.truncated, false)
})
test('event ingestion strips protocol handles, preserves application IDs and releases every delivered object', async t => {
  const f = await fixture(t); await f.call('list_console_messages')
  const args = prefix => Array.from({ length: 103 }, (_, i) => ({ type: 'object', objectId: `${prefix}-${i}`, ...(i === 0 ? { value: { objectId: 'application-id', nested: { objectId: 'nested-id' } } } : {}), description: 'fixture' }))
  f.emit('Runtime.consoleAPICalled', { type: 'log', args: args('console') })
  f.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { objectId: 'exception', description: 'fixture-error' } } })
  f.emit('Log.entryAdded', { entry: { level: 'warning', text: 'fixture-log', args: args('log') } })
  const messages = (await f.call('list_console_messages')).items
  for (const message of [messages[0], messages[2]]) {
    assert.equal(message.args[0].objectId, undefined)
    assert.equal(message.args[0].value.objectId, 'application-id')
    assert.equal(message.args[0].value.nested.objectId, 'nested-id')
  }
  assert.equal(messages[1].exception, 'fixture-error'); assert.equal(messages[2].type, 'warn')
  const releases = f.calls.filter(c => c[0] === 'Runtime.releaseObject').map(c => c[2].objectId)
  assert.deepEqual(releases, [...args('console').map(a => a.objectId), 'exception', ...args('log').map(a => a.objectId)])
  f.emit('Network.requestWillBeSent', { requestId: 'ids', request: { url: 'https://fixture.test/', method: 'GET', headers: { objectId: 'request-id' } } })
  f.emit('Network.responseReceived', { requestId: 'ids', response: { status: 200, headers: { objectId: 'response-id' } } })
  const reqid = (await f.call('list_network_requests')).items[0].reqid
  const { request } = await f.call('get_network_request', { reqid, includeBody: false })
  assert.equal(request.requestHeaders.objectId, 'request-id'); assert.equal(request.response.headers.objectId, 'response-id')
})
test('snapshot scopes Accessibility to collection across success, failures and navigation races', async t => {
  for (const outcome of ['success', 'enable failure', 'tree failure', 'navigation during enable', 'navigation during tree', 'navigation during disable', 'deadline']) {
    await t.test(outcome, async t => {
      const f = await fixture(t), original = f.chrome.debugger.sendCommand, seen = []
      let deadline = false
      f.chrome.debugger.sendCommand = async (source, method, params) => {
        if (method.startsWith('Accessibility.')) seen.push(method)
        if ((method === 'Accessibility.enable' && outcome === 'enable failure') || (method === 'Accessibility.getFullAXTree' && outcome === 'tree failure')) throw Error(outcome)
        if ((method === 'Accessibility.enable' && outcome === 'navigation during enable') || (method === 'Accessibility.getFullAXTree' && outcome === 'navigation during tree') || (method === 'Accessibility.disable' && outcome === 'navigation during disable')) f.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 1, frameId: 0 })
        if (method === 'Accessibility.getFullAXTree') {
          deadline = outcome === 'deadline'
          return { nodes: [{ nodeId: 'a', backendDOMNodeId: 42, name: { value: 'Go' } }] }
        }
        return original(source, method, params)
      }
      const now = Date.now()
      t.mock.method(Date, 'now', () => deadline ? now + 30000 : now)
      if (outcome === 'success') assert.equal((await f.call('take_snapshot')).nodes[0].name, 'Go')
      else await assert.rejects(f.call('take_snapshot'), /failure|Navigation raced|deadline/)
      assert.equal(seen[0], 'Accessibility.enable'); assert.equal(seen.at(-1), 'Accessibility.disable')
      assert.equal(seen.filter(m => m === 'Accessibility.disable').length, 1)
    })
  }
})
test('snapshot cleanup cannot disable Accessibility on a replacement attachment', async t => {
  const f = await fixture(t), original = f.chrome.debugger.sendCommand
  f.chrome.debugger.sendCommand = async (source, method, params) => {
    if (method === 'Accessibility.getFullAXTree') {
      f.chrome.debugger.onDetach.emit({ tabId: 1 }, 'replaced')
      await f.call('list_console_messages')
      return { nodes: [] }
    }
    return original(source, method, params)
  }
  await assert.rejects(f.call('take_snapshot'), /DETACHED/)
  assert.equal((await f.call('debugger_status')).attached, true)
  assert.ok(!f.calls.some(c => c[0] === 'Accessibility.disable'))
})
test('navigation races and expired requests discard results; stale UIDs are never reused', async t => {
  const f = await fixture(t)
  await f.call('list_console_messages')
  const original = f.chrome.debugger.sendCommand
  f.chrome.debugger.sendCommand = async (source, method, params) => {
    if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: 'a', backendDOMNodeId: 42, role: { value: 'button' }, name: { value: 'Go' } }] }
    return original(source, method, params)
  }
  const snapshot = await f.call('take_snapshot'), uid = snapshot.nodes[0].uid
  f.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 1, frameId: 0 })
  await assert.rejects(f.call('click', { uid }), /Stale/)
  await assert.rejects(f.call('take_snapshot', { documentId: snapshot.documentId }), /Stale documentId/)
  f.chrome.debugger.sendCommand = async (source, method, params) => {
    if (method === 'Accessibility.getFullAXTree') { f.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 1, frameId: 0 }); return { nodes: [] } }
    return original(source, method, params)
  }
  await assert.rejects(f.call('take_snapshot'), /Navigation raced/)
  await assert.rejects(f.api.execute('list_console_messages', validate('list_console_messages', { tabId: 1 }), Date.now() - 1), /deadline/)
})
test('detach, tab closure and worker suspension discard state and permit fresh attachment', async t => {
  const f = await fixture(t)
  await f.call('list_console_messages')
  f.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'secret fixture' }] })
  f.chrome.debugger.onDetach.emit({ tabId: 1 }, 'canceled_by_user')
  assert.equal((await f.call('debugger_status')).attached, false)
  assert.equal((await f.call('list_console_messages')).items.length, 0)
  f.chrome.tabs.onRemoved.emit(1)
  assert.equal((await f.call('debugger_status')).attached, false)
  await f.call('list_console_messages'); f.chrome.runtime.onSuspend.emit()
  assert.equal((await f.call('debugger_status')).attached, false)
})
test('trace ownership is globally reserved and trace data and stop lifecycle are bounded', async t => {
  const f = await fixture(t)
  await f.call('performance_start_trace', { reload: false, autoStop: false })
  await assert.rejects(f.call('performance_start_trace', { tabId: 2, reload: false, autoStop: false }), /already running/)
  for (let i = 0; i < 3; i++) f.emit('Tracing.dataCollected', { value: Array.from({ length: 4000 }, () => ({ name: 'fixture', args: { text: 'x'.repeat(1000) } })) })
  const result = await f.call('performance_stop_trace')
  assert.equal(result.truncated, true); assert.ok(result.droppedEvents > 0); assert.ok(result.retainedBytes <= CDP_LIMITS.traceBytes)
  assert.equal((await f.call('debugger_status')).trace, null)
  await assert.rejects(f.call('performance_stop_trace'), /No retained trace/)
  await f.call('performance_start_trace', { tabId: 2, reload: false, autoStop: false })
  await f.call('debugger_detach', { tabId: 2 })
  await f.call('performance_start_trace', { reload: false, autoStop: false })
  await f.call('performance_stop_trace')
})
test('network oversized bodies are not fetched and Chrome eviction is truthful', async t => {
  const f = await fixture(t); await f.call('list_network_requests')
  f.emit('Network.requestWillBeSent', { requestId: 'big', request: { url: 'https://fixture.test/big', method: 'GET' }, type: 'Fetch' })
  f.emit('Network.loadingFinished', { requestId: 'big', encodedDataLength: 300000 })
  const reqid = (await f.call('list_network_requests')).items[0].reqid
  const large = await f.call('get_network_request', { reqid })
  assert.match(large.body.reason, /exceeds/); assert.ok(!f.calls.some(c => c[0] === 'Network.getResponseBody'))
})
test('trace count capacity drops entire remaining batches without inspecting events', async t => {
  const f = await fixture(t)
  await f.call('performance_start_trace', { reload: false, autoStop: false })
  f.emit('Tracing.dataCollected', { value: Array.from({ length: CDP_LIMITS.traceEvents - 1 }, () => ({ name: 'fixture' })) })
  let inspected = 0
  const discarded = { get name() { inspected++; return 'discarded' } }
  f.emit('Tracing.dataCollected', { value: [{ args: { objectId: 'trace-application-id' } }, discarded, discarded] })
  f.emit('Tracing.dataCollected', { value: Array(1000).fill(discarded) })
  const result = await f.call('performance_stop_trace')
  assert.equal(inspected, 0); assert.equal(result.traceEvents.length, CDP_LIMITS.traceEvents)
  assert.equal(result.droppedEvents, 1002); assert.equal(result.truncated, true)
  assert.equal(result.traceEvents.at(-1).args.objectId, 'trace-application-id')
  assert.equal(result.retainedBytes, result.traceEvents.reduce((bytes, event) => bytes + JSON.stringify(event).length * 2, 0))
})
test('drag defers release through dialog completion and cleans up other failures immediately', async t => {
  for (const outcome of ['success', 'press dialog', 'move dialog', 'release dialog', 'press failure', 'move failure', 'release failure']) {
    await t.test(outcome, async t => {
      const f = await fixture(t), original = f.chrome.debugger.sendCommand, seen = []
      let settle, closed, moves = 0
      f.chrome.debugger.sendCommand = async (source, method, params) => {
        seen.push([method, params])
        if (method === 'Accessibility.getFullAXTree') return { nodes: [1, 2].map(id => ({ nodeId: String(id), backendDOMNodeId: id })) }
        if (method === 'DOM.resolveNode') return { object: { objectId: String(params.backendNodeId) } }
        if (method === 'Runtime.callFunctionOn') return { result: { value: { x: Number(params.objectId) * 10, y: 20 } } }
        if (method === 'Input.dispatchMouseEvent') {
          if (params.type === 'mouseMoved' && params.buttons === 1) moves++
          const interrupt = (params.type === 'mousePressed' && outcome.startsWith('press')) || (params.type === 'mouseMoved' && params.buttons === 1 && moves === 3 && outcome.startsWith('move')) || (params.type === 'mouseReleased' && outcome.startsWith('release'))
          if (interrupt && outcome.endsWith('failure')) throw Error(outcome)
          if (interrupt && outcome.endsWith('dialog') && !settle) {
            queueMicrotask(() => f.emit('Page.javascriptDialogOpening', { type: 'alert', message: outcome }))
            return new Promise(resolve => { settle = resolve })
          }
        }
        if (method === 'Page.handleJavaScriptDialog') { f.emit('Page.javascriptDialogClosed', {}); closed(); return {} }
        return original(source, method, params)
      }
      const { nodes } = await f.call('take_snapshot'), releases = () => seen.filter(([method, p]) => method === 'Input.dispatchMouseEvent' && p.type === 'mouseReleased')
      const dragging = f.call('drag', { from_uid: nodes[0].uid, to_uid: nodes[1].uid })
      if (outcome.endsWith('failure')) await assert.rejects(dragging, /failure/)
      else if (outcome.endsWith('dialog')) {
        const result = await dragging
        assert.equal(result.interrupted, true); assert.equal(result.completed, false); assert.equal(releases().length, outcome === 'release dialog' ? 1 : 0)
        assert.ok(!seen.some(([method]) => method === 'Runtime.releaseObjectGroup'))
        await assert.rejects(f.call('press_key', { key: 'Enter' }), /dialog/)
        await f.call('list_console_messages')
        const dialogClosed = new Promise(resolve => { closed = resolve })
        const handling = f.call('handle_dialog', { action: 'accept' })
        await dialogClosed
        await assert.rejects(f.call('press_key', { key: 'Enter' }), /pending/)
        assert.equal(releases().length, outcome === 'release dialog' ? 1 : 0)
        settle({}); assert.equal((await handling).handled, true)
        assert.ok(seen.some(([method]) => method === 'Runtime.releaseObjectGroup'))
        await f.call('press_key', { key: 'Enter' })
      } else { assert.equal((await dragging).dragged, true); assert.equal(moves, 10) }
      assert.equal(releases().length, outcome === 'release failure' ? 2 : 1)
      for (const [, params] of releases()) assert.deepEqual(params, { type: 'mouseReleased', x: 20, y: 20, button: 'left', buttons: 0, clickCount: 1 })
    })
  }
})
test('dialog interruption retains a completion barrier without blocking explicit dialog handling', async t => {
  const f = await fixture(t), original = f.chrome.debugger.sendCommand
  let release
  f.chrome.debugger.sendCommand = async (source, method, params) => {
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
      queueMicrotask(() => f.emit('Page.javascriptDialogOpening', { type: 'prompt', message: 'fixture' }))
      return new Promise(resolve => { release = resolve })
    }
    if (method === 'Page.handleJavaScriptDialog') { release({}); f.emit('Page.javascriptDialogClosed', {}); return {} }
    return original(source, method, params)
  }
  const clicked = await f.call('click_at', { x: 1, y: 1 })
  assert.equal(clicked.interrupted, true); assert.equal(clicked.completed, false)
  await assert.rejects(f.call('press_key', { key: 'Enter' }), /dialog/)
  assert.equal((await f.call('handle_dialog', { action: 'accept', promptText: 'yes' })).handled, true)
  assert.equal((await f.call('debugger_status')).dialog, null)
  await f.call('press_key', { key: 'Enter' })
})
