// Per-document selector references only; no DOM, page-output or screenshot cache.
if (!globalThis.__browserProxyInstalled) {
  globalThis.__browserProxyInstalled = true
  const documentId = [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('')
  const refs = new Map()
  window.addEventListener('pagehide', () => refs.clear())
  let sequence = 0
  const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none')
  const signature = el => JSON.stringify([el.tagName, el.id, el.getAttribute('name'), el.getAttribute('type'), el.getAttribute('aria-label'), /^(BUTTON|A)$/.test(el.tagName) ? el.innerText : null])
  function selectorFor(el) {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`
    const parts = []
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const index = [...node.parentElement?.children || []].filter(n => n.tagName === node.tagName).indexOf(node) + 1
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${index || 1})`)
      if (node === document.documentElement) break
    }
    return parts.join(' > ')
  }
  function resolve(args, required = true) {
    if (args.documentId && args.documentId !== documentId) throw new Error('Stale documentId: take a new snapshot after navigation')
    let selector = args.selector, expected
    if (args.ref) {
      const stored = refs.get(args.ref)
      if (!stored) throw new Error('Stale or evicted ref: take a new snapshot')
      selector = stored.selector; expected = stored.signature
    }
    if (!selector) { if (required) throw new Error('Provide ref or unique CSS selector'); return null }
    const nodes = document.querySelectorAll(selector)
    if (nodes.length !== 1) throw new Error(`Selector must resolve to exactly one element (found ${nodes.length}); snapshot again`)
    const el = nodes[0]
    if (expected && signature(el) !== expected) throw new Error('Ref target changed during rerender; take a new snapshot')
    return el
  }
  function editable(el) {
    if (!visible(el) || el.disabled || el.readOnly) throw new Error('Control is hidden, disabled or read-only')
    if (el.isContentEditable) return 'content'
    if (el instanceof HTMLTextAreaElement) return 'value'
    if (el instanceof HTMLInputElement && ['text', 'search', 'email', 'password', 'url', 'tel'].includes(el.type)) return 'value'
    throw new Error('Unsupported editable control; file/date/range/checkbox inputs require different or trusted interactions')
  }
  function events(el) { el.dispatchEvent(new Event('input', { bubbles: true, composed: true })); el.dispatchEvent(new Event('change', { bubbles: true })) }
  async function handle(action, args) {
    if (args.documentId && args.documentId !== documentId) throw new Error('Stale documentId: snapshot again')
    if (action === 'page_read') {
      const el = resolve(args, false) || document.body
      const text = el.innerText ?? el.textContent ?? ''
      const end = Math.min(text.length, args.offset + args.limit)
      return { documentId, title: document.title, url: location.href, text: text.slice(args.offset, end), offset: args.offset, total: text.length, nextOffset: end < text.length ? end : null }
    }
    if (action === 'page_snapshot') {
      const nodes = [...document.querySelectorAll('a[href],button,input,textarea,select,[contenteditable="true"],[role],summary')].filter(visible)
      const elements = nodes.slice(args.offset, args.offset + args.limit).map(el => {
        const selector = selectorFor(el), sig = signature(el)
        let ref = [...refs].find(([, v]) => v.selector === selector && v.signature === sig)?.[0]
        if (!ref && selector.length <= 4000 && sig.length <= 4096) { ref = `${documentId}:${++sequence}`; refs.set(ref, { selector, signature: sig }); if (refs.size > 2000) refs.delete(refs.keys().next().value) }
        return { ref: ref || null, refUnsupported: ref ? undefined : 'Target identity too large for a bounded reference; use a short unique selector', selector, tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), type: el.type, label: el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || '', value: el.type === 'password' ? '[redacted]' : el.value, disabled: !!el.disabled, options: el instanceof HTMLSelectElement ? [...el.options].map(o => ({ value: o.value, label: o.label, selected: o.selected })) : undefined }
      })
      const end = Math.min(nodes.length, args.offset + args.limit)
      return { documentId, title: document.title, url: location.href, elements, total: nodes.length, nextOffset: end < nodes.length ? end : null, referenceCount: refs.size, scope: 'visible light DOM controls; use page_read for text and page_frames for frames' }
    }
    if (action === 'page_scroll') {
      const el = resolve(args, false)
      ;(el || window).scrollBy({ left: args.x, top: args.y, behavior: 'instant' })
      return { documentId, x: el ? el.scrollLeft : window.scrollX, y: el ? el.scrollTop : window.scrollY }
    }
    const el = resolve(args)
    if (!visible(el) || el.disabled || el.closest('[inert]')) throw new Error('Control is hidden, disabled or inert')
    if (action === 'page_click') { el.scrollIntoView({ block: 'center' }); el.click(); return { documentId, clicked: true, trusted: false } }
    if (action === 'page_fill' || action === 'page_type') {
      const kind = editable(el)
      const text = (action === 'page_type' ? kind === 'content' ? el.textContent : el.value : '') + args.text
      el.focus()
      if (kind === 'content') el.textContent = text
      else {
        const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, text)
      }
      events(el)
      return { documentId, changed: true, trusted: false }
    }
    if (action === 'page_select') {
      if (!(el instanceof HTMLSelectElement)) throw new Error('Only native select controls are supported')
      if (!el.multiple && args.values.length !== 1) throw new Error('Single select requires exactly one value')
      if (args.values.some(v => ![...el.options].some(o => o.value === v && !o.disabled && !o.parentElement.disabled))) throw new Error('Unknown or disabled select option')
      for (const option of el.options) option.selected = args.values.includes(option.value)
      events(el); return { documentId, changed: true, trusted: false }
    }
    throw new Error(`Unsupported content action: ${action}`)
  }
  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !request.toContentAction) return
    const identity = { id: request.id, tabId: request.data.tabId, frameId: request.data.frameId ?? 0 }
    handle(request.toContentAction, request.data).then(data => respond({ ...identity, ok: true, data })).catch(error => respond({ ...identity, ok: false, error: error.message }))
    return true
  })
}
