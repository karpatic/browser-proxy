// SPDX-License-Identifier: GPL-3.0-or-later
// Starter toSwAction/toContentAction protocol, now request-correlated and ephemeral.
import { createDebugger } from './debugger.js'
const debuggerTools = createDebugger(chrome)
let socket, connecting = false, retry
let closePageQueue = Promise.resolve()
const queues = new Map()
const unsettled = new Set()
let activeRequests = 0, pendingRequests = 0
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (sender.id !== chrome.runtime.id || request.toSwAction !== 'status') return
  respond({ connected: socket?.readyState === WebSocket.OPEN, activeRequests, pendingRequests, queues: queues.size, unsettled: unsettled.size })
})
chrome.alarms.create('bridge-connect', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(() => connect())
chrome.runtime.onStartup.addListener(() => connect())
chrome.runtime.onInstalled.addListener(() => connect())
async function connect() {
  if (connecting || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return
  connecting = true
  try {
    const config = await (await fetch(chrome.runtime.getURL('bridge-config.json'))).json()
    const ws = new WebSocket(config.url, ['browser-proxy', config.token])
    socket = ws
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', extensionId: chrome.runtime.id }))
    ws.onmessage = ({ data }) => {
      let request
      try { request = JSON.parse(data) } catch { return }
      if (request.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', activeRequests, pendingRequests, queues: queues.size, unsettled: unsettled.size })); return }
      if (request.type !== 'request') return
      const key = request.data?.tabId ?? `global-${request.id}`
      if (pendingRequests + unsettled.size >= 128) {
        ws.send(JSON.stringify({ type: 'response', id: request.id, tabId: request.data?.tabId, frameId: request.data?.frameId ?? 0, ok: false, error: 'Extension busy; retry after current Chrome operations settle' }))
        return
      }
      pendingRequests++
      const previous = queues.get(key) || Promise.resolve()
      const task = previous.catch(() => {}).then(async () => {
        activeRequests++
        let result
        try {
          if (Date.now() > request.deadline) throw new Error('Request expired before execution')
          if (unsettled.has(key)) throw new Error('Previous Chrome operation on this tab has not settled; the page may be hung')
          let timer
          const operation = execute(request)
          const settled = operation.then(value => { unsettled.delete(key); return value }, error => { unsettled.delete(key); throw error })
          try {
            result = { ok: true, data: await Promise.race([settled, new Promise((_, reject) => {
              timer = setTimeout(() => { unsettled.add(key); reject(new Error('Chrome operation timed out; it may still execute. Read again after it settles.')) }, Math.max(1, request.deadline - Date.now()))
            })]) }
          } finally { clearTimeout(timer) }
        } catch (error) { result = { ok: false, error: error.message } }
        finally { activeRequests--; pendingRequests-- }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'response', id: request.id, tabId: request.data?.tabId, frameId: request.data?.frameId ?? 0, ...result }))
      }).finally(() => { if (queues.get(key) === task) queues.delete(key) })
      queues.set(key, task)
    }
    ws.onerror = () => ws.close()
    ws.onclose = () => { if (socket === ws) { socket = null; void debuggerTools.detachAll(); clearTimeout(retry); retry = setTimeout(connect, 2000) } }
  } catch { clearTimeout(retry); retry = setTimeout(connect, 2000) }
  finally { connecting = false }
}
function ordinary(tab) {
  if (!/^https?:\/\//.test(tab.url || '')) throw new Error('Restricted page: only ordinary http/https tabs are supported')
}
async function execute(request) {
  const { toSwAction: action, data: args, id } = request
  if (action === 'tabs_list' || action === 'list_pages') return (await chrome.tabs.query({})).map(t => ({ tabId: t.id, windowId: t.windowId, title: t.title, url: t.url, active: t.active, status: t.status }))
  if (action === 'tabs_create') { const t = await chrome.tabs.create({ url: args.url, active: args.active }); return { tabId: t.id, windowId: t.windowId } }
  if (action === 'new_page') {
    const t = await chrome.tabs.create({ url: args.url, active: !args.background })
    const end = Math.min(request.deadline - 100, Date.now() + (args.timeout || 10000))
    while (Date.now() < end) {
      await new Promise(resolve => setTimeout(resolve, 50))
      const current = await chrome.tabs.get(t.id)
      if (current.status === 'complete') return { tabId: t.id, windowId: t.windowId, url: current.url }
    }
    throw new Error(`New tab ${t.id} was created but load wait timed out; inspect it before retrying`)
  }
  const tab = await chrome.tabs.get(args.tabId)
  if (action === 'tabs_select') { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); return { tabId: tab.id } }
  if (action === 'select_page') { if (args.bringToFront) { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }) } return { tabId: tab.id, implicitTarget: false } }
  if (action === 'tabs_close') { await chrome.tabs.remove(tab.id); return { tabId: tab.id, closed: true } }
  if (action === 'close_page') {
    // Different explicit tabs normally run concurrently. Serialize this narrow
    // count-and-close operation so two clients cannot both close the last pair.
    const closing = closePageQueue.then(async () => {
      if ((await chrome.tabs.query({})).length <= 1) throw new Error('Cannot close the last remaining tab')
      if (Date.now() >= request.deadline) throw new Error('Request expired before tab closure')
      await chrome.tabs.remove(tab.id)
      return { tabId: tab.id, closed: true }
    })
    closePageQueue = closing.catch(() => {})
    return closing
  }
  if (debuggerTools.handles(action)) return debuggerTools.execute(action, args, request.deadline)
  if (action === 'page_navigate') {
    await chrome.tabs.update(tab.id, { url: args.url })
    const end = Date.now() + 15000
    while (Date.now() < end) {
      await new Promise(resolve => setTimeout(resolve, 100))
      const current = await chrome.tabs.get(tab.id)
      if (current.status === 'complete' && (current.url !== tab.url || current.url === args.url)) return { tabId: tab.id, url: current.url, status: current.status }
    }
    throw new Error('Navigation load timed out; navigation may still complete. Read this tab again.')
  }
  ordinary(tab)
  if (action === 'page_frames') return await chrome.webNavigation.getAllFrames({ tabId: tab.id })
  if (action === 'page_screenshot') {
    let changed = false
    const activated = info => { if (info.windowId === tab.windowId && info.tabId !== tab.id) changed = true }
    chrome.tabs.onActivated.addListener(activated)
    try {
      const [before] = await chrome.tabs.query({ windowId: tab.windowId, active: true })
      if (before?.id !== tab.id) throw new Error('Screenshot requires this explicit tab to be active; call tabs_select first')
      const png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
      if (png.length > 8 * 1024 * 1024) throw new Error('Screenshot exceeds 8 MiB encoded output; reduce viewport size')
      const [after] = await chrome.tabs.query({ windowId: tab.windowId, active: true })
      if (changed || after?.id !== tab.id) throw new Error('Active tab changed during capture; screenshot discarded')
      return { tabId: tab.id, format: 'png', dataUrl: png, scope: 'visible viewport' }
    } finally { chrome.tabs.onActivated.removeListener(activated) }
  }
  const message = { toContentAction: action, id, data: args }
  const route = { frameId: args.frameId ?? 0 }
  let response
  try { response = await chrome.tabs.sendMessage(tab.id, message, route) } catch (error) {
    if (!/Receiving end does not exist/.test(error.message)) throw new Error(`Page/frame unavailable: ${error.message}. Read again before retrying a mutation.`)
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [route.frameId] }, files: ['content.js'] }) }
    catch { throw new Error('Restricted page/frame: Chrome denied content script access') }
    response = await chrome.tabs.sendMessage(tab.id, message, route)
  }
  if (response?.id !== id || response?.tabId !== tab.id || response?.frameId !== route.frameId) throw new Error('Content response identity mismatch')
  if (!response.ok) throw new Error(response.error)
  return response.data
}
connect()
