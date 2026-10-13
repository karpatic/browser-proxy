async function refresh() {
  const status = await chrome.runtime.sendMessage({ toSwAction: 'status' })
  document.querySelector('#status').textContent = status?.connected ? 'Bridge connected' : 'Bridge offline — start npm start'
  const list = document.querySelector('#tabs'); list.replaceChildren()
  const windows = new Map()
  for (const tab of await chrome.tabs.query({})) {
    if (!windows.has(tab.windowId)) {
      const section = document.createElement('section'), heading = document.createElement('h2'), tabs = document.createElement('ul')
      heading.textContent = `Window ${windows.size + 1}`
      section.append(heading, tabs); list.append(section); windows.set(tab.windowId, tabs)
    }
    const item = document.createElement('li'), button = document.createElement('button')
    button.type = 'button'
    button.textContent = tab.title || '(untitled)'
    button.setAttribute('aria-pressed', String(!!tab.active))
    button.onclick = async () => { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); await refresh() }
    item.append(button); windows.get(tab.windowId).append(item)
  }
}
document.querySelector('#refresh').onclick = () => refresh().catch(() => {})
refresh().catch(() => {})
setInterval(() => refresh().catch(() => {}), 5000)
