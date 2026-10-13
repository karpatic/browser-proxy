// CDP is only reachable through authenticated, explicitly tab-routed worker requests.
// No general sendCommand tool, disk cache, client-owned target or implicit active tab.
export const CDP_LIMITS = Object.freeze({ tabs: 8, consoleEntries: 200, consoleBytes: 512 * 1024, networkEntries: 200, networkBytes: 1024 * 1024, bodyBytes: 256 * 1024, refs: 2000, outputChars: 200000, imageChars: 8 * 1024 * 1024, pixels: 16000000, traceBytes: 2 * 1024 * 1024, traceEvents: 10000, traceMs: 30000, idleMs: 300000 })
const names = new Set(['debugger_status', 'debugger_detach', 'evaluate_script', 'list_console_messages', 'get_console_message', 'list_network_requests', 'get_network_request', 'get_css_styles', 'take_snapshot', 'take_screenshot', 'click', 'click_at', 'hover', 'drag', 'press_key', 'type_text', 'fill', 'fill_form', 'handle_dialog', 'upload_file', 'wait_for', 'resize_page', 'emulate', 'performance_start_trace', 'performance_stop_trace', 'navigate_page'])
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const clipped = (value, limit = 4000) => String(value ?? '').slice(0, limit)
const ordinaryUrl = value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.hostname !== 'chromewebstore.google.com' && !(url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore')) } catch { return false }
}

// Bound copied data without allocating a string for an arbitrarily large packet.
// Event ingestion removes Runtime handles; application property names are preserved.
export function bounded(value, budget = 16000) {
  let remaining = budget, truncated = false
  function copy(v, depth) {
    if (remaining <= 0 || depth > 8) { truncated = true; return '[truncated]' }
    if (typeof v === 'string') { const n = Math.min(v.length, remaining, 8000); remaining -= n; if (n < v.length) truncated = true; return v.slice(0, n) }
    if (v === null || typeof v !== 'object') { remaining -= 16; return v }
    const out = Array.isArray(v) ? [] : Object.create(null)
    let count = 0
    for (const key in v) {
      if (!Object.hasOwn(v, key)) continue
      if (remaining <= 0 || count++ >= 100) { truncated = true; break }
      remaining -= key.length + 8
      out[key] = copy(v[key], depth + 1)
    }
    return out
  }
  return { data: copy(value, 0), truncated }
}

class Ring {
  constructor(count, bytes) { this.count = count; this.maxBytes = bytes; this.items = new Map(); this.bytes = 0; this.dropped = 0 }
  put(id, value) {
    this.delete(id)
    const size = JSON.stringify(value).length * 2
    if (size > this.maxBytes) { this.dropped++; return }
    this.items.set(id, { value, size }); this.bytes += size
    while (this.items.size > this.count || this.bytes > this.maxBytes) { this.delete(this.items.keys().next().value); this.dropped++ }
  }
  delete(id) { const old = this.items.get(id); if (old) { this.bytes -= old.size; this.items.delete(id) } }
  get(id) { return this.items.get(id)?.value }
  values() { return [...this.items.values()].map(x => x.value) }
  prune(nav) { for (const [id, x] of this.items) if (x.value.navigation < nav - 3) this.delete(id) }
}

export function createDebugger(chrome) {
  const states = new Map()
  let sequence = Date.now() * 1000, traceOwner = null
  const raw = (s, method, params = {}) => chrome.debugger.sendCommand({ tabId: s.tabId }, method, params)
  function status(tabId) {
    const s = states.get(tabId)
    return s ? { tabId, attached: s.attached, documentId: doc(s), console: { count: s.console.items.size, bytes: s.console.bytes, dropped: s.console.dropped }, network: { count: s.network.items.size, bytes: s.network.bytes, dropped: s.network.dropped }, refs: s.refs.size, dialog: s.dialog, trace: s.trace ? { running: !s.trace.done, events: s.trace.events.length, bytes: s.trace.bytes, truncated: s.trace.truncated } : null, idleDetachMs: CDP_LIMITS.idleMs } : { tabId, attached: false }
  }
  function doc(s) { return `${s.nonce}:${s.revision}` }
  function invalidate(s) { s.revision++; s.refs.clear() }
  function lost(s, reason) {
    if (states.get(s.tabId) !== s) return
    states.delete(s.tabId); s.attached = false; s.reason = reason; invalidate(s)
    clearTimeout(s.idleTimer)
    if (s.trace) { clearTimeout(s.trace.timer); clearTimeout(s.trace.expiry); clearTimeout(s.trace.endTimer); s.trace.resolve?.(); s.trace.events.length = 0 }
    if (traceOwner === s) traceOwner = null
    s.console.items.clear(); s.network.items.clear(); s.requestIds.clear()
  }
  async function detach(tabId, reason = 'explicit detach') {
    const s = states.get(tabId)
    if (!s) return { tabId, detached: false }
    const recording = s.trace && !s.trace.done
    // Mark unavailable before awaiting Chrome so concurrent event callbacks cannot refill it.
    lost(s, reason)
    if (recording) void raw(s, 'Tracing.end').catch(() => {})
    try { await chrome.debugger.detach({ tabId }) } catch (error) {
      if (!/not attached|No tab|No target|closed/i.test(error.message)) throw new Error(`Debugger detach failed: ${clipped(error.message)}`)
    }
    return { tabId, detached: true, discarded: true }
  }
  const detachAll = () => Promise.allSettled([...states.keys()].map(id => detach(id, 'bridge disconnected or worker suspended')))
  async function releaseDeferred(s) {
    const groups = [...s.deferredGroups]; s.deferredGroups.clear()
    if (states.get(s.tabId) !== s) return
    for (const group of groups) await raw(s, 'Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {})
  }
  function finishDialogBarrier(s) {
    const pending = s.dialogPending
    pending?.then(() => {
      if (s.dialogPending === pending && !s.dialog) { s.dialogPending = null; void releaseDeferred(s) }
    })
  }
  function touch(s) {
    clearTimeout(s.idleTimer)
    if (states.get(s.tabId) !== s) return
    s.idleTimer = setTimeout(() => { if (s.busy) touch(s); else detach(s.tabId, 'idle timeout').catch(() => {}) }, CDP_LIMITS.idleMs)
  }
  async function permitted(tabId) {
    const tab = await chrome.tabs.get(tabId)
    const url = new URL(tab.url || 'about:blank')
    if (!ordinaryUrl(tab.url) || (tab.pendingUrl && !ordinaryUrl(tab.pendingUrl))) throw new Error('Restricted page: debugger tools require ordinary http/https tabs')
    if (chrome.permissions && !await chrome.permissions.contains({ origins: [`${url.origin}/*`] })) throw new Error('Host access denied: debugger does not override extension site-access restrictions')
    return tab
  }
  async function ensure(tabId) {
    await permitted(tabId)
    const current = states.get(tabId)
    if (current) { await current.ready; touch(current); return current }
    if (states.size >= CDP_LIMITS.tabs) throw new Error(`Debugger attachment limit (${CDP_LIMITS.tabs}); call debugger_detach on another tab`)
    const s = { tabId, nonce: crypto.randomUUID(), revision: 0, navigation: 0, refs: new Map(), console: new Ring(CDP_LIMITS.consoleEntries, CDP_LIMITS.consoleBytes), network: new Ring(CDP_LIMITS.networkEntries, CDP_LIMITS.networkBytes), requestIds: new Map(), attached: false, dialog: null, dialogWaiters: new Set(), dialogPending: null, dialogAction: undefined, deferredInput: null, deferredGroups: new Set(), busy: 0 }
    states.set(tabId, s)
    s.ready = (async () => {
      let owned = false
      try {
        const targets = await chrome.debugger.getTargets()
        if (targets.some(t => t.tabId === tabId && t.attached)) throw new Error('DEBUGGER_CONFLICT: DevTools or another debugger owns this tab; release it before retrying')
        try { await chrome.debugger.attach({ tabId }, '1.3'); owned = true }
        catch (error) { throw new Error(`DEBUGGER_ATTACH_FAILED: target unavailable, policy denied, or debugger conflict: ${clipped(error.message)}`) }
        if (states.get(tabId) !== s) throw new Error('Debugger attachment canceled during cleanup')
        s.attached = true
        await raw(s, 'Page.enable')
        const { frameTree } = await raw(s, 'Page.getFrameTree')
        s.frameId = frameTree.frame.id; s.loaderId = frameTree.frame.loaderId
        await raw(s, 'Runtime.enable')
        await raw(s, 'Log.enable')
        await raw(s, 'Network.enable', { maxTotalBufferSize: 2 * 1024 * 1024, maxResourceBufferSize: CDP_LIMITS.bodyBytes, maxPostDataSize: 16000 })
        await raw(s, 'Performance.enable')
        if (states.get(tabId) !== s) throw new Error('Debugger detached during initialization')
        await permitted(tabId); touch(s)
        return s
      } catch (error) {
        lost(s, 'attach failed')
        if (owned) await chrome.debugger.detach({ tabId }).catch(() => {})
        throw error
      }
    })()
    return await s.ready
  }
  function saveConsole(s, value) {
    const item = bounded(value, 8000)
    const msgid = ++sequence
    s.console.put(msgid, { ...item.data, truncated: item.truncated, msgid, navigation: s.navigation })
  }
  function releaseEventObjects(s, objects = []) {
    // Output limits must not limit cleanup of the objects delivered by Chrome.
    for (const object of objects) if (object?.objectId) raw(s, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => {})
  }
  function saveNetwork(s, item) {
    const value = bounded(item, 16000)
    s.network.put(item.reqid, { ...value.data, truncated: item.truncated || value.truncated })
    // Protocol IDs are bounded by the same eviction horizon as metadata.
    for (const [key, id] of s.requestIds) if (!s.network.get(id)) s.requestIds.delete(key)
  }
  chrome.debugger.onEvent.addListener((source, method, p = {}) => {
    const s = states.get(source.tabId)
    if (!s || source.sessionId) return // Child targets are deliberately not auto-attached.
    if (method === 'Runtime.executionContextCreated' && p.context.auxData?.isDefault && p.context.auxData?.frameId === s.frameId) s.contextId = p.context.id
    if (method === 'Runtime.executionContextsCleared') { s.contextId = null; invalidate(s) }
    if (method === 'Runtime.executionContextDestroyed' && p.executionContextId === s.contextId) { s.contextId = null; invalidate(s) }
    if (method === 'Page.frameNavigated' && !p.frame.parentId) {
      if (p.frame.loaderId !== s.loaderId) { invalidate(s); s.navigation++; s.console.prune(s.navigation); s.network.prune(s.navigation) }
      s.loaderId = p.frame.loaderId; s.frameId = p.frame.id
      for (const item of s.network.values()) if (item.loaderId === s.loaderId && item.navigation !== s.navigation) saveNetwork(s, { ...item, navigation: s.navigation })
      if (!ordinaryUrl(p.frame.url)) detach(s.tabId, 'restricted navigation').catch(() => {})
      else permitted(s.tabId).catch(() => detach(s.tabId, 'host access lost').catch(() => {}))
    }
    if (method === 'Page.javascriptDialogOpening') {
      s.dialog = { type: clipped(p.type, 40), message: clipped(p.message), defaultPrompt: clipped(p.defaultPrompt) }
      for (const notify of s.dialogWaiters) notify()
      if (s.dialogAction !== undefined) raw(s, 'Page.handleJavaScriptDialog', { accept: s.dialogAction !== 'dismiss', ...(s.dialogAction !== 'accept' && s.dialogAction !== 'dismiss' ? { promptText: s.dialogAction } : {}) }).catch(() => {})
    }
    if (method === 'Page.javascriptDialogClosed') { s.dialog = null; finishDialogBarrier(s) }
    if (method === 'Runtime.consoleAPICalled') {
      saveConsole(s, { type: p.type === 'warning' ? 'warn' : p.type, timestamp: p.timestamp, args: (p.args || []).slice(0, 30).map(a => ({ type: a.type, value: a.value, description: a.description, unserializableValue: a.unserializableValue })), stackTrace: p.stackTrace })
      releaseEventObjects(s, p.args)
    }
    if (method === 'Runtime.exceptionThrown') {
      saveConsole(s, { type: 'error', timestamp: p.timestamp, text: p.exceptionDetails?.text, exception: p.exceptionDetails?.exception?.description, stackTrace: p.exceptionDetails?.stackTrace })
      releaseEventObjects(s, [p.exceptionDetails?.exception])
    }
    if (method === 'Log.entryAdded') {
      // Include one over the copier's count cap so truncation remains explicit.
      saveConsole(s, { ...p.entry, args: p.entry.args?.slice(0, 101).map(({ objectId, ...value }) => value), type: p.entry.level === 'warning' ? 'warn' : p.entry.level })
      releaseEventObjects(s, p.entry.args)
    }
    if (method === 'Network.requestWillBeSent') {
      const previous = s.network.get(s.requestIds.get(p.requestId))
      if (previous && p.redirectResponse) saveNetwork(s, { ...previous, response: p.redirectResponse, finished: true, redirected: true })
      const reqid = ++sequence
      s.requestIds.set(p.requestId, reqid)
      saveNetwork(s, { reqid, cdpId: p.requestId, navigation: s.navigation, loaderId: p.loaderId, url: p.request.url, method: p.request.method, resourceType: String(p.type || 'other').toLowerCase(), requestHeaders: p.request.headers, postData: p.request.postData, hasPostData: p.request.hasPostData, timestamp: p.timestamp, finished: false })
    }
    const item = s.network.get(s.requestIds.get(p.requestId))
    if (item) {
      if (method === 'Network.responseReceived') saveNetwork(s, { ...item, response: { status: p.response.status, statusText: p.response.statusText, headers: p.response.headers, mimeType: p.response.mimeType, protocol: p.response.protocol, fromDiskCache: p.response.fromDiskCache, fromServiceWorker: p.response.fromServiceWorker, timing: p.response.timing } })
      if (method === 'Network.requestWillBeSentExtraInfo') saveNetwork(s, { ...item, requestHeaders: p.headers })
      if (method === 'Network.responseReceivedExtraInfo') saveNetwork(s, { ...item, responseHeaders: p.headers })
      if (method === 'Network.loadingFinished') saveNetwork(s, { ...item, finished: true, encodedDataLength: p.encodedDataLength })
      if (method === 'Network.loadingFailed') saveNetwork(s, { ...item, finished: true, failure: clipped(p.errorText), canceled: p.canceled })
    }
    const tr = s.trace
    if (tr && method === 'Tracing.dataCollected') {
      const events = p.value || []
      for (let i = 0; i < events.length; i++) {
        if (tr.events.length >= CDP_LIMITS.traceEvents) { tr.truncated = true; tr.dropped += events.length - i; break }
        const safe = bounded(events[i], 16000), encoded = JSON.stringify(safe.data), size = encoded.length * 2
        if (tr.bytes + size > CDP_LIMITS.traceBytes) { tr.truncated = true; tr.dropped++; continue }
        tr.events.push(safe.data); tr.bytes += size; tr.truncated ||= safe.truncated
      }
    }
    if (tr && method === 'Tracing.bufferUsage' && p.percentFull >= 0.9) { tr.truncated = true; endTrace(s).catch(() => {}) }
    if (tr && method === 'Tracing.tracingComplete') { tr.truncated ||= !!p.dataLossOccurred; completeTrace(s) }
  })
  chrome.debugger.onDetach.addListener((source, reason) => { const s = states.get(source.tabId); if (s) lost(s, `DEBUGGER_DETACHED: ${reason}`) })
  chrome.tabs.onRemoved.addListener(tabId => { const s = states.get(tabId); if (s) lost(s, 'tab closed') })
  chrome.webNavigation.onBeforeNavigate.addListener(details => { const s = states.get(details.tabId); if (s && details.frameId === 0) invalidate(s) })
  chrome.runtime.onSuspend.addListener(() => { void detachAll() }) // Best effort: Chrome owns final teardown when an extension is unloaded.
  chrome.permissions?.onRemoved?.addListener(() => { void detachAll() })

  function check(ctx) {
    if (states.get(ctx.s.tabId) !== ctx.s || !ctx.s.attached) throw new Error(ctx.s.reason || 'DEBUGGER_DETACHED: snapshot again after reattaching')
    if (Date.now() >= ctx.deadline) throw new Error('CDP request deadline exceeded; an earlier action may have executed')
    if (!ctx.navigation && ctx.revision !== ctx.s.revision) throw new Error('Navigation raced this CDP operation; result discarded. Take a new snapshot before retrying')
  }
  async function command(ctx, method, params = {}) {
    check(ctx)
    const operation = raw(ctx.s, method, params)
    // Chrome can defer an input/runtime reply until a JS dialog is closed. Keep
    // that operation as a barrier: only the dialog-completion command may pass.
    const interruptible = /^(Input\.|Runtime\.(evaluate|callFunctionOn))/.test(method) && ctx.s.dialogAction === undefined
    let notify
    const opened = interruptible ? new Promise(resolve => { notify = () => resolve({ dialogInterruption: true }); ctx.s.dialogWaiters.add(notify) }) : null
    try {
      const result = await (opened ? Promise.race([operation, opened]) : operation)
      if (result?.dialogInterruption) {
        ctx.s.dialogPending = operation.then(() => {}, () => {})
        finishDialogBarrier(ctx.s)
        const error = new Error('Action dispatched and interrupted by a JavaScript dialog; handle_dialog must complete it')
        error.dialogInterrupted = true
        throw error
      }
      check(ctx)
      return result
    } finally { if (notify) ctx.s.dialogWaiters.delete(notify) }
  }
  async function runtime(ctx, method, params) {
    ctx.usedObjects = true
    let expired = false, recovery
    const timer = setTimeout(() => {
      expired = true; raw(ctx.s, 'Runtime.terminateExecution').catch(() => {})
      // A never-settling async Promise may have no executing stack to terminate.
      // Detachment releases that pending CDP reply and every retained remote handle.
      recovery = setTimeout(() => { detach(ctx.s.tabId, 'JavaScript timeout recovery').catch(() => {}) }, 1000)
    }, Math.max(1, Math.min(5000, ctx.deadline - Date.now() - 1100)))
    try {
      const result = await command(ctx, method, { ...params, objectGroup: ctx.group })
      if (expired) throw new Error('JavaScript execution exceeded its 5-second bound and was terminated; effects may have occurred')
      if (result.exceptionDetails) throw new Error(`Page JavaScript failed: ${clipped(result.exceptionDetails.exception?.description || result.exceptionDetails.text)}`)
      return result.result
    } catch (error) {
      if (expired) throw new Error('JavaScript execution timed out; execution was terminated or debugger detached for recovery. Effects may have occurred; inspect debugger_status before retrying.')
      throw error
    } finally { clearTimeout(timer); clearTimeout(recovery) }
  }
  const evaluate = (ctx, expression) => runtime(ctx, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 5000, ...(ctx.s.contextId ? { contextId: ctx.s.contextId } : {}) }).then(r => r.value)
  async function object(ctx, uid) {
    ctx.usedObjects = true
    const backendNodeId = ctx.s.refs.get(uid)
    if (!backendNodeId) throw new Error('Stale, unknown or evicted uid: take a new snapshot')
    const result = await command(ctx, 'DOM.resolveNode', { backendNodeId, objectGroup: ctx.group, ...(ctx.s.contextId ? { executionContextId: ctx.s.contextId } : {}) })
    if (!result.object?.objectId) throw new Error('UID no longer resolves to a DOM element')
    const obj = result.object.objectId
    await runtime(ctx, 'Runtime.callFunctionOn', { objectId: obj, functionDeclaration: 'function(){if(!this.isConnected || this.ownerDocument!==document)throw Error("UID is detached or outside the supported main frame");return true}', returnByValue: true })
    return obj
  }
  const onObject = (ctx, objectId, fn, args = []) => runtime(ctx, 'Runtime.callFunctionOn', { objectId, functionDeclaration: fn.toString(), arguments: args.map(value => ({ value })), returnByValue: true, awaitPromise: true }).then(r => r.value)
  function list(ring, s, args, kind) {
    const preserve = kind === 'console' ? args.includePreservedMessages : args.includePreservedRequests
    const filters = kind === 'console' ? args.types : args.resourceTypes
    const items = ring.values().filter(x => (preserve || x.navigation === s.navigation) && (!filters.length || filters.includes(kind === 'console' ? x.type : x.resourceType)))
    const start = args.pageIdx * args.pageSize
    const output = items.slice(start, start + args.pageSize).map(x => {
      if (kind === 'console') { const { stackTrace, ...rest } = x; return args.includeStackTraces ? x : rest }
      return { reqid: x.reqid, url: x.url, method: x.method, resourceType: x.resourceType, status: x.response?.status, finished: x.finished, failure: x.failure, navigation: x.navigation, truncated: x.truncated }
    })
    return { documentId: doc(s), items: output, totalRetainedMatching: items.length, pageIdx: args.pageIdx, nextPageIdx: start + args.pageSize < items.length ? args.pageIdx + 1 : null, dropped: ring.dropped, scope: 'Observed since lazy attachment; bounded current plus previous three navigations', untrusted: true }
  }
  async function snapshot(ctx, args) {
    let tree
    try {
      await command(ctx, 'Accessibility.enable')
      // The transport can transiently deliver a larger packet; we never retain that
      // packet or a full page tree. Chrome supports a depth bound, not a breadth cap.
      tree = await command(ctx, 'Accessibility.getFullAXTree', { depth: 6 })
    } finally {
      if (states.get(ctx.s.tabId) === ctx.s) await raw(ctx.s, 'Accessibility.disable').catch(() => {})
    }
    check(ctx)
    const nodes = tree.nodes.slice(0, CDP_LIMITS.refs)
    const chosen = nodes.filter(n => args.verbose || !n.ignored)
    const offset = args.offset ?? 0, limit = args.limit ?? 100
    const items = chosen.slice(offset, offset + limit).map(n => {
      let uid = null
      if (n.backendDOMNodeId) {
        uid = `${doc(ctx.s)}:${n.backendDOMNodeId}`
        ctx.s.refs.set(uid, n.backendDOMNodeId)
        if (ctx.s.refs.size > CDP_LIMITS.refs) ctx.s.refs.delete(ctx.s.refs.keys().next().value)
      }
      const safe = bounded({ uid, nodeId: n.nodeId, parentId: n.parentId, role: n.role?.value, name: n.name?.value, value: n.value?.value, description: n.description?.value, ...(args.verbose ? { properties: n.properties, ignored: n.ignored } : {}) }, 2000)
      return { ...safe.data, truncated: safe.truncated }
    })
    return { documentId: doc(ctx.s), nodes: items, total: chosen.length, nextOffset: offset + limit < chosen.length ? offset + limit : null, truncated: tree.nodes.length > CDP_LIMITS.refs, depthLimit: 6, scope: 'Accessibility tree of main CDP target; child targets not attached', untrusted: true }
  }
  async function point(ctx, obj, scroll = true) {
    return onObject(ctx, obj, function(scroll) {
      if (!this.isConnected || this.ownerDocument !== document) throw Error('Stale element or unsupported frame')
      if (this.disabled || this.closest('[inert]')) throw Error('Control is disabled or inert')
      if (scroll) this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      const r = this.getBoundingClientRect(), st = getComputedStyle(this)
      if (!r.width || !r.height || st.visibility !== 'visible' || st.display === 'none') throw Error('Element is hidden')
      const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right), top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom)
      if (right <= left || bottom <= top) throw Error('Element is outside the viewport')
      const x = (left + right) / 2, y = (top + bottom) / 2
      const root = this.getRootNode(), hit = root.elementFromPoint?.(x, y) || document.elementFromPoint(x, y)
      if (hit !== this && !this.contains(hit)) throw Error('Element is obstructed at its click point')
      return { x, y }
    }, [scroll])
  }
  async function mouseClick(ctx, p, double = false) {
    await command(ctx, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
    for (let i = 1; i <= (double ? 2 : 1); i++) {
      try { await command(ctx, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', buttons: 1, clickCount: i }) }
      catch (error) { if (error.dialogInterrupted) ctx.s.deferredInput = ['Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', buttons: 0, clickCount: i }]; throw error }
      try { await command(ctx, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', buttons: 0, clickCount: i }) }
      catch (error) { if (!error.dialogInterrupted) await raw(ctx.s, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', buttons: 0, clickCount: i }).catch(() => {}); throw error }
    }
  }
  async function key(ctx, input) {
    const modifiers = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
    let rest = input, mask = 0
    for (;;) { const match = /^(Alt|Control|Meta|Shift)\+/.exec(rest); if (!match) break; mask |= modifiers[match[1]]; rest = rest.slice(match[0].length) }
    const specials = { Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46], ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40], Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], Space: ['Space', 32, ' '], Insert: ['Insert', 45] }
    let code, keyCode, text, value = rest
    if (specials[rest]) { [code, keyCode, text] = specials[rest]; if (rest === 'Space') value = ' ' }
    else if (/^F([1-9]|1[0-2])$/.test(rest)) { code = rest; keyCode = 111 + Number(rest.slice(1)) }
    else if (rest.length === 1) { value = mask & 8 ? rest.toUpperCase() : rest; code = /^[a-z]$/i.test(rest) ? `Key${rest.toUpperCase()}` : /^[0-9]$/.test(rest) ? `Digit${rest}` : ''; keyCode = value.toUpperCase().charCodeAt(0); text = value }
    else throw new Error('Unsupported key; use printable characters, common navigation keys or F1-F12')
    const params = { key: value, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: mask }
    if (!(mask & 7) && text) params.text = text
    // Modifier state travels with the event; no key is left pressed after a failure.
    try { await command(ctx, 'Input.dispatchKeyEvent', { ...params, type: params.text ? 'keyDown' : 'rawKeyDown' }) }
    catch (error) { if (error.dialogInterrupted) ctx.s.deferredInput = ['Input.dispatchKeyEvent', { ...params, text: undefined, type: 'keyUp' }]; throw error }
    try { await command(ctx, 'Input.dispatchKeyEvent', { ...params, text: undefined, type: 'keyUp' }) }
    catch (error) { if (!error.dialogInterrupted) await raw(ctx.s, 'Input.dispatchKeyEvent', { ...params, text: undefined, type: 'keyUp' }).catch(() => {}); throw error }
  }
  async function releaseInput(ctx) {
    const input = ctx.s.deferredInput; ctx.s.deferredInput = null
    if (input) await command(ctx, input[0], input[1])
  }
  async function fill(ctx, element) {
    const obj = await object(ctx, element.uid)
    await point(ctx, obj)
    const info = await onObject(ctx, obj, function(value) {
      if (this.readOnly) throw Error('Control is read-only')
      if (this instanceof HTMLSelectElement) {
        const options = [...this.options], option = options.find(o => o.label === value) || options.find(o => o.value === value)
        if (!option || option.disabled || option.parentElement.disabled) throw Error('Unknown or disabled select option')
        for (const o of options) o.selected = o === option
        this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true }))
        return { kind: 'select', trusted: false }
      }
      if (this instanceof HTMLInputElement && ['checkbox', 'radio'].includes(this.type)) {
        if (!['true', 'false'].includes(value) || (this.type === 'radio' && value === 'false')) throw Error('Checkbox requires true/false; radio requires true')
        return { kind: 'toggle', click: this.checked !== (value === 'true') }
      }
      if (!(this instanceof HTMLTextAreaElement || this.isContentEditable || (this instanceof HTMLInputElement && ['text', 'search', 'email', 'password', 'url', 'tel'].includes(this.type)))) throw Error('Unsupported fill control type')
      this.focus()
      if (this.isContentEditable) { const range = document.createRange(); range.selectNodeContents(this); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range) }
      else this.select()
      return { kind: 'text' }
    }, [element.value])
    if (info.kind === 'toggle' && info.click) await mouseClick(ctx, await point(ctx, obj))
    if (info.kind === 'text') {
      if (element.value) await command(ctx, 'Input.insertText', { text: element.value })
      else await key(ctx, 'Backspace')
      await onObject(ctx, obj, function() { this.blur(); return true })
    }
    return { uid: element.uid, changed: true, trusted: info.kind !== 'select' }
  }
  function completeTrace(s) {
    const tr = s.trace
    if (!tr || tr.done) return
    tr.done = true; clearTimeout(tr.timer); clearTimeout(tr.endTimer)
    if (traceOwner === s) traceOwner = null
    tr.expiry = setTimeout(() => { if (s.trace === tr) { tr.events.length = 0; s.trace = null } }, 60000)
    tr.resolve?.()
  }
  async function endTrace(s) {
    const tr = s.trace
    if (!tr || tr.done) return
    if (!tr.ending) {
      tr.ending = true
      tr.endTimer = setTimeout(() => { tr.error = 'Tracing completion timed out; target detached to release recording'; detach(s.tabId, tr.error).catch(() => {}) }, 5000)
      try { await raw(s, 'Tracing.end') } catch (error) { tr.error = clipped(error.message); await detach(s.tabId, 'Trace stop failed') }
    }
    await tr.completion
  }
  async function consumeTrace(ctx) {
    const s = ctx.s, tr = s.trace
    if (!tr) throw new Error('No retained trace for this tab (not started, consumed, detached or expired)')
    await endTrace(s)
    if (tr.error) throw new Error(tr.error)
    check(ctx)
    clearTimeout(tr.expiry); s.trace = null
    const metrics = await command(ctx, 'Performance.getMetrics')
    return { tabId: s.tabId, traceEvents: tr.events, recordedMs: Date.now() - tr.started, truncated: tr.truncated, droppedEvents: tr.dropped, retainedBytes: tr.bytes, limits: { milliseconds: CDP_LIMITS.traceMs, bytes: CDP_LIMITS.traceBytes, events: CDP_LIMITS.traceEvents }, metrics: metrics.metrics, scope: 'Chrome shared tracing facility initiated by this tab; may include browser/shared-renderer metadata', analysis: 'Raw bounded trace only; no Core Web Vitals or Lighthouse insight analysis', untrusted: true }
  }
  async function navigate(ctx, args) {
    ctx.navigation = true
    const s = ctx.s, previous = s.revision
    let script
    s.dialogAction = args.handleBeforeUnload
    try {
      if (args.initScript) script = (await command(ctx, 'Page.addScriptToEvaluateOnNewDocument', { source: args.initScript })).identifier
      if (args.type === 'url') {
        if (!args.url) throw new Error('url is required for type=url')
        const result = await command(ctx, 'Page.navigate', { url: args.url })
        if (result.errorText) throw new Error(`Navigation failed: ${clipped(result.errorText)}`)
      } else if (args.type === 'reload') await command(ctx, 'Page.reload', { ignoreCache: args.ignoreCache })
      else {
        const history = await command(ctx, 'Page.getNavigationHistory')
        const entry = history.entries[history.currentIndex + (args.type === 'back' ? -1 : 1)]
        if (!entry || !/^https?:\/\//.test(entry.url)) throw new Error('No ordinary HTTP/HTTPS history entry in that direction')
        await command(ctx, 'Page.navigateToHistoryEntry', { entryId: entry.id })
      }
      const end = Math.min(ctx.deadline - 100, Date.now() + (args.timeout || 10000))
      while (Date.now() < end) {
        await pause(50); check(ctx)
        const tab = await permitted(s.tabId)
        if (tab.status === 'complete' && (s.revision !== previous || (args.type === 'url' && tab.url === args.url))) return { tabId: s.tabId, url: tab.url, status: tab.status }
      }
      throw new Error('Navigation load wait timed out; navigation may still complete or beforeunload may have canceled it')
    } finally { s.dialogAction = undefined; if (script) await raw(s, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: script }).catch(() => {}) }
  }
  async function execute(action, args, deadline) {
    if (action === 'debugger_status') return status(args.tabId)
    if (action === 'debugger_detach') return detach(args.tabId)
    const s = await ensure(args.tabId)
    const ctx = { s, revision: s.revision, deadline, group: `browser-proxy-${crypto.randomUUID()}`, navigation: ['navigate_page', 'performance_start_trace', 'performance_stop_trace'].includes(action) }
    s.busy++; touch(s)
    try {
      check(ctx)
      if (args.documentId && args.documentId !== doc(s)) throw new Error('Stale documentId: take a new CDP snapshot')
      if ((s.dialog || s.dialogPending) && !['handle_dialog', 'list_console_messages', 'get_console_message', 'list_network_requests'].includes(action)) throw new Error('JavaScript dialog is open or an interrupted action is pending; call handle_dialog first')
      if (!s.dialog && !s.dialogPending) await releaseInput(ctx)
      let result = await run(ctx, action, args)
      if (args.includeSnapshot && !s.dialog) result = { ...result, snapshot: await snapshot(ctx, { offset: 0, limit: 100 }) }
      if (s.dialog) result = { ...result, dialog: s.dialog }
      return result
    } catch (error) {
      if (error.dialogInterrupted) return { tabId: s.tabId, actionDispatched: true, interrupted: true, completed: false, completedElements: error.completedElements, dialog: s.dialog, nextAction: 'handle_dialog' }
      throw error
    } finally {
      s.dialogAction = undefined; s.busy--; touch(s)
      if (ctx.usedObjects && states.get(s.tabId) === s) {
        if (s.dialog || s.dialogPending) s.deferredGroups.add(ctx.group)
        else await raw(s, 'Runtime.releaseObjectGroup', { objectGroup: ctx.group }).catch(() => {})
      }
    }
  }
  async function run(ctx, action, a) {
    const s = ctx.s
    if (action === 'list_console_messages') return list(s.console, s, a, 'console')
    if (action === 'list_network_requests') return list(s.network, s, a, 'network')
    if (action === 'get_console_message') {
      const message = s.console.get(a.msgid)
      if (!message) throw new Error('Unknown or evicted msgid; list console messages again')
      return { message, untrusted: true }
    }
    if (action === 'get_network_request') {
      const item = s.network.get(a.reqid)
      if (!item) throw new Error('Unknown or evicted reqid; list network requests again')
      const { cdpId, ...request } = item
      let body = { available: false, reason: 'Body not requested' }
      if (a.includeBody) {
        if (!item.finished || item.failure || item.redirected) body.reason = 'Request unfinished, failed or redirected'
        else if (item.encodedDataLength > CDP_LIMITS.bodyBytes) body.reason = 'Response exceeds 256 KiB body retrieval limit'
        else {
          try {
            const value = await command(ctx, 'Network.getResponseBody', { requestId: cdpId })
            const max = value.base64Encoded ? Math.floor(CDP_LIMITS.bodyBytes * 4 / 3) : CDP_LIMITS.bodyBytes
            body = { available: true, data: value.body.slice(0, max), base64Encoded: value.base64Encoded, truncated: value.body.length > max, totalChars: value.body.length }
          } catch (error) { check(ctx); body.reason = `Chrome body unavailable or evicted: ${clipped(error.message)}` }
        }
      }
      return { request, body, untrusted: true }
    }
    if (action === 'take_snapshot') return snapshot(ctx, a)
    if (action === 'evaluate_script') {
      const args = []
      for (const uid of a.args) args.push({ objectId: await object(ctx, uid) })
      const global = await runtime(ctx, 'Runtime.evaluate', { expression: 'globalThis', ...(s.contextId ? { contextId: s.contextId } : {}) })
      s.dialogAction = a.dialogAction
      const fn = `async function(...args){const value=await (${a.function})(...args);const json=JSON.stringify(value);return {json:json===undefined?null:json.slice(0,${CDP_LIMITS.outputChars}),undefined:json===undefined,truncated:json!==undefined&&json.length>${CDP_LIMITS.outputChars},totalChars:json?.length||0}}`
      const value = await runtime(ctx, 'Runtime.callFunctionOn', { objectId: global.objectId, functionDeclaration: fn, arguments: args, returnByValue: true, awaitPromise: true })
      // Treat page-created envelopes as untrusted too; never trust a claimed length.
      const output = value.value
      if (!output || (typeof output.json !== 'string' && output.json !== null)) throw new Error('Page returned an invalid evaluation envelope')
      return { json: output.json?.slice(0, CDP_LIMITS.outputChars) ?? null, undefined: output.undefined === true, totalChars: Number.isSafeInteger(output.totalChars) ? output.totalChars : null, truncated: output.truncated === true || (output.json?.length || 0) > CDP_LIMITS.outputChars, untrusted: true }
    }
    if (action === 'get_css_styles') {
      const obj = await object(ctx, a.uid)
      await command(ctx, 'DOM.enable'); await command(ctx, 'DOM.getDocument', { depth: 0 }); await command(ctx, 'CSS.enable')
      const { nodeId } = await command(ctx, 'DOM.requestNode', { objectId: obj })
      const matched = await command(ctx, 'CSS.getMatchedStylesForNode', { nodeId })
      const computed = await command(ctx, 'CSS.getComputedStyleForNode', { nodeId })
      const rules = [...(matched.matchedCSSRules || []).map(rule => ({ source: 'matched', ...rule })), ...(matched.inherited || []).flatMap((x, i) => [{ source: 'inherited-inline', ancestor: i, style: x.inlineStyle }, ...(x.matchedCSSRules || []).map(rule => ({ source: 'inherited', ancestor: i, ...rule }))])]
      const start = a.pageIdx * a.pageSize
      const safe = bounded({ inlineStyle: matched.inlineStyle, attributesStyle: matched.attributesStyle, rules: rules.slice(start, start + a.pageSize), computedStyle: computed.computedStyle }, 150000)
      return { ...safe.data, truncated: safe.truncated, totalRules: rules.length, nextPageIdx: start + a.pageSize < rules.length ? a.pageIdx + 1 : null, untrusted: true }
    }
    if (action === 'take_screenshot') {
      if (a.uid && a.fullPage) throw new Error('uid and fullPage are incompatible')
      const metrics = await command(ctx, 'Page.getLayoutMetrics')
      const viewport = metrics.cssVisualViewport || metrics.visualViewport
      let box = a.fullPage ? (metrics.cssContentSize || metrics.contentSize) : { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight }
      if (a.uid) box = await onObject(ctx, await object(ctx, a.uid), function() { const r = this.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height } })
      const ratio = await evaluate(ctx, 'devicePixelRatio')
      if (![box.x, box.y, box.width, box.height, ratio].every(Number.isFinite) || box.width <= 0 || box.height <= 0 || box.width * box.height * ratio * ratio > CDP_LIMITS.pixels) throw new Error('Screenshot exceeds the 16-million-pixel bound or has empty dimensions; resize or capture a smaller element')
      const capture = await command(ctx, 'Page.captureScreenshot', { format: a.format, ...(a.format === 'png' ? {} : { quality: a.quality }), clip: { ...box, scale: 1 }, captureBeyondViewport: !!(a.fullPage || a.uid), fromSurface: true })
      if (capture.data.length > CDP_LIMITS.imageChars) throw new Error('Screenshot exceeds 8 MiB encoded output; reduce dimensions or JPEG/WebP quality')
      return { tabId: s.tabId, format: a.format, mimeType: `image/${a.format}`, dataUrl: `data:image/${a.format};base64,${capture.data}`, scope: a.uid ? 'element' : a.fullPage ? 'full page' : 'viewport' }
    }
    if (action === 'click' || action === 'hover') {
      const p = await point(ctx, await object(ctx, a.uid))
      if (action === 'hover') await command(ctx, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
      else await mouseClick(ctx, p, a.dblClick)
      return { tabId: s.tabId, [action === 'click' ? 'clicked' : 'hovered']: true, trusted: true }
    }
    if (action === 'click_at') {
      const metrics = await command(ctx, 'Page.getLayoutMetrics'), v = metrics.cssVisualViewport || metrics.visualViewport
      if (a.x >= v.clientWidth || a.y >= v.clientHeight) throw new Error('Click coordinates are outside the viewport')
      await mouseClick(ctx, { x: a.x, y: a.y }, a.dblClick)
      return { clicked: true, trusted: true }
    }
    if (action === 'drag') {
      const from = await object(ctx, a.from_uid), to = await object(ctx, a.to_uid)
      const start = await point(ctx, from), end = await point(ctx, to, false)
      await command(ctx, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...start })
      const release = ['Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', buttons: 0, clickCount: 1 }]
      let releasing = false
      try {
        await command(ctx, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 })
        for (let i = 1; i <= 10; i++) await command(ctx, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + (end.x - start.x) * i / 10, y: start.y + (end.y - start.y) * i / 10, button: 'left', buttons: 1 })
        releasing = true
        await command(ctx, ...release)
      } catch (error) {
        if (error.dialogInterrupted) { if (!releasing) s.deferredInput = release }
        else await raw(s, ...release).catch(() => {})
        throw error
      }
      check(ctx); return { dragged: true, trusted: true, scope: 'Pointer drag; no HTML DataTransfer synthesis' }
    }
    if (action === 'press_key') { await key(ctx, a.key); return { pressed: true, trusted: true } }
    if (action === 'type_text') { await command(ctx, 'Input.insertText', { text: a.text }); if (a.submitKey) await key(ctx, a.submitKey); return { inserted: true, trusted: true } }
    if (action === 'fill' || action === 'fill_form') {
      const completed = []
      for (const el of action === 'fill' ? [{ uid: a.uid, value: a.value }] : a.elements) {
        try { completed.push(await fill(ctx, el)) }
        catch (error) {
          if (error.dialogInterrupted) { error.completedElements = completed.length; throw error }
          throw new Error(`Fill failed after ${completed.length} completed element(s): ${clipped(error.message)}. Earlier fields may have changed.`)
        }
      }
      return { completed }
    }
    if (action === 'handle_dialog') {
      if (!s.dialog) throw new Error('No observed JavaScript dialog on this tab; dialogs opened before attachment may be unavailable')
      await command(ctx, 'Page.handleJavaScriptDialog', { accept: a.action === 'accept', ...(a.promptText === undefined ? {} : { promptText: a.promptText }) })
      await s.dialogPending; s.dialogPending = null
      await releaseInput(ctx)
      await releaseDeferred(s)
      s.dialog = null; return { handled: true }
    }
    if (action === 'upload_file') {
      const obj = await object(ctx, a.uid)
      await onObject(ctx, obj, function(count) { if (!(this instanceof HTMLInputElement) || this.type !== 'file' || this.disabled) throw Error('UID must be an enabled file input'); if (count > 1 && !this.multiple) throw Error('File input does not allow multiple files'); return true }, [a.filePaths.length])
      await command(ctx, 'DOM.setFileInputFiles', { objectId: obj, files: a.filePaths })
      const files = await onObject(ctx, obj, function() { return [...this.files].slice(0, 20).map(f => ({ name: f.name.slice(0, 1000), size: f.size, type: f.type.slice(0, 100) })) })
      return { set: true, files, scope: 'Browser-host paths; Chrome may represent a nonexistent path as an empty File' }
    }
    if (action === 'wait_for') {
      const end = Math.min(ctx.deadline - 100, Date.now() + (a.timeout || 10000))
      while (Date.now() < end) {
        const matched = await evaluate(ctx, `(()=>{const text=document.body?.innerText||'';return ${JSON.stringify(a.text)}.find(value=>text.includes(value))??null})()`)
        if (matched !== null) return { matched, documentId: doc(s) }
        await pause(100)
      }
      throw new Error('wait_for timed out before any supplied text appeared')
    }
    if (action === 'resize_page') { await command(ctx, 'Emulation.setDeviceMetricsOverride', { width: a.width, height: a.height, deviceScaleFactor: 1, mobile: false }); return { width: a.width, height: a.height, scope: 'Tab viewport override, not OS window' } }
    if (action === 'emulate') return emulate(ctx, a)
    if (action === 'navigate_page') return navigate(ctx, a)
    if (action === 'performance_start_trace') {
      if (traceOwner || s.trace) throw new Error('Trace already running or retained; stop/consume it before starting another')
      traceOwner = s // Reserve globally before the first await; other tabs still serialize independently.
      const tr = { events: [], bytes: 0, dropped: 0, truncated: false, started: Date.now(), done: false }
      tr.completion = new Promise(resolve => { tr.resolve = resolve }); s.trace = tr
      try {
        await command(ctx, 'Tracing.start', { transferMode: 'ReportEvents', bufferUsageReportingInterval: 500, traceConfig: { recordMode: 'recordUntilFull', traceBufferSizeInKb: 2048, includedCategories: ['devtools.timeline', 'blink.user_timing', 'loading', 'v8.execute'], excludedCategories: ['*'] } })
        tr.timer = setTimeout(() => { tr.truncated = true; endTrace(s).catch(() => {}) }, CDP_LIMITS.traceMs)
        if (a.reload) await navigate(ctx, { type: 'reload', ignoreCache: false, handleBeforeUnload: 'accept', timeout: 10000 })
        if (a.autoStop) { await pause(5000); return consumeTrace(ctx) }
        return { recording: true, tabId: s.tabId, hardStopMs: CDP_LIMITS.traceMs, scope: 'Chrome shared tracing facility; one trace across all tabs' }
      } catch (error) { await detach(s.tabId, 'Trace start failed').catch(() => {}); throw error }
    }
    if (action === 'performance_stop_trace') return consumeTrace(ctx)
    throw new Error(`Unsupported debugger action: ${action}`)
  }
  async function emulate(ctx, a) {
    // Validate all compound inputs before changing any emulation setting.
    let geo, viewport, headers
    if (a.geolocation !== undefined) {
      const parts = a.geolocation.split(',').map(Number)
      if (parts.length !== 2 || !parts.every(Number.isFinite) || Math.abs(parts[0]) > 90 || Math.abs(parts[1]) > 180) throw new Error('Invalid geolocation; use latitude,longitude')
      geo = { latitude: parts[0], longitude: parts[1], accuracy: 1 }
    }
    if (a.viewport !== undefined) {
      const match = /^(\d+)x(\d+)x(\d+(?:\.\d+)?)(.*)$/.exec(a.viewport)
      const flags = match?.[4].split(',').filter(Boolean) || []
      if (!match || flags.some(f => !['mobile', 'touch', 'landscape'].includes(f))) throw new Error('Invalid viewport; use widthxheightxDPR[,mobile][,touch][,landscape]')
      const width = +match[1], height = +match[2], deviceScaleFactor = +match[3]
      if (width < 1 || height < 1 || width > 4096 || height > 4096 || deviceScaleFactor < 0.1 || deviceScaleFactor > 4 || width * height * deviceScaleFactor ** 2 > CDP_LIMITS.pixels) throw new Error('Viewport exceeds dimension/DPR/pixel bounds')
      viewport = { width, height, deviceScaleFactor, mobile: flags.includes('mobile'), screenOrientation: { type: flags.includes('landscape') ? 'landscapePrimary' : 'portraitPrimary', angle: flags.includes('landscape') ? 90 : 0 } }
      viewport.touch = flags.includes('touch')
    }
    if (a.extraHttpHeaders !== undefined) {
      try { headers = a.extraHttpHeaders ? JSON.parse(a.extraHttpHeaders) : {} } catch { throw new Error('extraHttpHeaders must be a JSON object') }
      if (!headers || Array.isArray(headers) || typeof headers !== 'object' || Object.keys(headers).length > 50 || Object.entries(headers).some(([k, v]) => !/^[!#$%&'*+.^_`|~\w-]+$/.test(k) || typeof v !== 'string' || /[\r\n\0]/.test(v))) throw new Error('Invalid HTTP headers')
    }
    const profiles = { 'Offline': [true, 0, 0, 0], 'Slow 3G': [false, 400, 500000 / 8, 500000 / 8], 'Fast 3G': [false, 150, 1600000 / 8, 750000 / 8], 'Slow 4G': [false, 150, 1600000 / 8, 750000 / 8], 'Fast 4G': [false, 60, 9000000 / 8, 1500000 / 8] }
    const [offline, latency, downloadThroughput, uploadThroughput] = profiles[a.networkConditions] || [false, 0, -1, -1]
    await command(ctx, 'Network.emulateNetworkConditions', { offline, latency, downloadThroughput, uploadThroughput })
    await command(ctx, 'Emulation.setCPUThrottlingRate', { rate: a.cpuThrottlingRate ?? 1 })
    await command(ctx, geo ? 'Emulation.setGeolocationOverride' : 'Emulation.clearGeolocationOverride', geo || {})
    if (a.colorScheme !== undefined) await command(ctx, 'Emulation.setEmulatedMedia', { features: a.colorScheme === 'auto' ? [] : [{ name: 'prefers-color-scheme', value: a.colorScheme }] })
    if (a.userAgent !== undefined) await command(ctx, 'Emulation.setUserAgentOverride', { userAgent: a.userAgent })
    if (headers) await command(ctx, 'Network.setExtraHTTPHeaders', { headers })
    if (viewport) { const { touch, ...metrics } = viewport; await command(ctx, 'Emulation.setDeviceMetricsOverride', metrics); await command(ctx, 'Emulation.setTouchEmulationEnabled', { enabled: touch }) }
    return { emulated: true, geolocationPermissionGranted: false, scope: 'Explicit tab until detach; Chrome can reject individual settings, leaving earlier settings applied' }
  }
  return { handles: name => names.has(name), execute, status, detachAll }
}
