// Real extension fixture: ephemeral port, independent capability/profile, no production browser.
import http from 'node:http'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, rm, readFile, writeFile, copyFile } from 'node:fs/promises'
import { createBridge } from '../bridge/server.mjs'
import { root, runtime } from '../scripts/setup.mjs'
import { mcpClient, sleep } from './helpers.mjs'

const evidence = { kind: 'real disposable Chromium MV3 extension, no logged-in profile, ephemeral bridge port', operations: [], expectedFailures: [] }
const fixture = http.createServer((req, res) => {
  if (req.url === '/data') { res.setHeader('Content-Type', 'application/json'); res.setHeader('X-Fixture', 'cdp'); res.end(JSON.stringify({ fixture: 'network-body' })); return }
  if (req.url === '/large') { res.end('x'.repeat(350000)); return }
  if (req.url === '/next') { res.end('<!doctype html><title>Next document</title><p>Navigation complete</p><label>Name <input id="name"></label>'); return }
  if (req.url === '/frame') { res.end('<!doctype html><title>Fixture frame</title><label>Frame input <input id="frameInput"></label>'); return }
  res.setHeader('Content-Type', 'text/html')
  res.end(`<!doctype html><title>Browser Proxy CDP fixture</title>
  <style>body {font:16px sans-serif} #click {color:rgb(255, 0, 0)} #drag,#drop {display:inline-block;width:100px;height:35px;background:#ddd} #hover:hover {background:rgb(0,255,0)}</style>
  <label>Name <input id="name"></label><button id="click" onclick="window.count++;window.lastTrusted=event.isTrusted;document.querySelector('#count').textContent=window.count">Click</button>
  <button id="rerender" onclick="document.querySelector('#name').replaceWith(document.querySelector('#name').cloneNode(true))">Rerender</button>
  <p id="count">0</p><label>Choice <select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
  <label>Check <input id="check" type="checkbox"></label><label>File <input id="file" type="file"></label>
  <button id="hover">Hover</button><button id="prompt" onclick="window.promptValue=prompt('Fixture prompt','default')">Prompt</button>
  <div id="drag" role="button" tabindex="0" aria-label="Drag">Drag</div><div id="drop" role="button" tabindex="0" aria-label="Drop">Drop</div>
  <div id="editor" contenteditable="true" aria-label="Editor">old</div><input id="disabled" disabled><button class="ambiguous">one</button><button class="ambiguous">two</button>
  <div id="shadow"></div><iframe src="/frame"></iframe><p id="long">${'harmless fixture text '.repeat(2000)}</p><div style="height:800px">Scrollable</div>
  <script>
  window.count=0;window.lastTrusted=null;window.dragMoves=0;
  document.querySelector('#drag').addEventListener('pointerdown',()=>window.dragging=true);
  document.addEventListener('pointermove',e=>{if(window.dragging&&e.buttons)window.dragMoves++});
  document.addEventListener('pointerup',()=>window.dragging=false);
  document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow button</button>';
  </script>`)
})
let browser, bridge, first, second, work
let diagnostics = ''
const timer = setTimeout(() => { console.error('Disposable browser test exceeded 180 seconds'); browser?.kill('SIGKILL'); process.exitCode = 1 }, 180000)
try {
  await mkdir(runtime, { recursive: true, mode: 0o700 })
  work = await mkdtemp(path.join(runtime, 'cdp-fixture-'))
  const extensionDir = path.join(work, 'extension'), profile = path.join(work, 'profile'), contenderDir = path.join(work, 'contender')
  await mkdir(extensionDir, { mode: 0o700 }); await mkdir(profile, { mode: 0o700 })
  // Copy only public/build assets. Never read or copy the production capability.
  for (const name of ['manifest.json','service-worker.js','content.js','panel.js','panel.html','styles.css']) await copyFile(path.join(root, 'dist', name), path.join(extensionDir, name))
  const manifest = JSON.parse(await readFile(path.join(extensionDir, 'manifest.json'), 'utf8'))
  const iconPaths = [...new Set([...Object.values(manifest.icons ?? {}), ...Object.values(manifest.action?.default_icon ?? {})])]
  for (const name of iconPaths) {
    // Keep the public asset allowlist narrow; never copy private configuration.
    assert.match(name, /^icons\/[\w-]+\.png$/)
    await mkdir(path.dirname(path.join(extensionDir, name)), { recursive: true })
    await copyFile(path.join(root, 'dist', name), path.join(extensionDir, name))
  }
  evidence.icons = iconPaths
  const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)))
  const config = { token: randomBytes(32).toString('base64url'), extensionId }
  bridge = await createBridge({ config, port: 0 })
  assert.notEqual(bridge.server.address().port, 3217)
  await writeFile(path.join(extensionDir, 'bridge-config.json'), JSON.stringify({ token: config.token, url: bridge.endpoint.replace('http:', 'ws:') + '/extension' }), { mode: 0o600 })
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${fixture.address().port}/`
  // Test-only second debugger establishes a genuine ownership conflict on a fixture tab.
  await mkdir(contenderDir, { mode: 0o700 })
  const contenderKey = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' })
  const contenderId = createHash('sha256').update(contenderKey).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)))
  await writeFile(path.join(contenderDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Disposable debugger contender', version: '1.0', key: contenderKey.toString('base64'), permissions: ['debugger','tabs'], externally_connectable: { matches: ['http://127.0.0.1/*'] }, background: { service_worker: 'worker.js' } }))
  await writeFile(path.join(contenderDir, 'worker.js'), `chrome.runtime.onMessageExternal.addListener((r,s,reply)=>{if(s.origin!==${JSON.stringify(new URL(url).origin)})return; (async()=>{const t=await chrome.tabs.get(r.tabId);if(!t.url.startsWith(${JSON.stringify(url)}))throw Error('Not a fixture tab');if(r.action==='attach')await chrome.debugger.attach({tabId:r.tabId},'1.3');else if(r.action==='detach')await chrome.debugger.detach({tabId:r.tabId});else throw Error('Invalid action');return {ok:true}})().then(reply,e=>reply({error:e.message}));return true})`)
  browser = spawn(process.env.BROWSER_PROXY_TEST_CHROMIUM || '/snap/bin/chromium', ['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,`--disable-extensions-except=${extensionDir},${contenderDir}`,`--load-extension=${extensionDir},${contenderDir}`,url], { stdio: ['ignore','pipe','pipe'], detached: true })
  browser.stdout.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-6000) })
  browser.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-6000) })
  browser.on('error', error => { diagnostics += error.message })
  for (let i = 0; i < 200 && !bridge.health().extensionConnected; i++) { if (browser.exitCode !== null) break; await sleep(100) }
  assert.equal(bridge.health().extensionConnected, true, `Disposable extension did not connect: ${diagnostics}`)
  first = await mcpClient(bridge.endpoint, config.token, 'fixture-first'); second = await mcpClient(bridge.endpoint, config.token, 'fixture-second')
  const catalogs = await Promise.all([first.listTools(), second.listTools()])
  assert.equal(catalogs[0].tools.length, 45); assert.deepEqual(catalogs[0].tools, catalogs[1].tools)
  evidence.tools = catalogs[0].tools.map(t => t.name)
  const call = async (name, args = {}, client = first) => {
    const result = await client.callTool({ name, arguments: args })
    if (result.isError) throw new Error(result.content[0].text)
    evidence.operations.push(name)
    return result.structuredContent ?? result
  }
  const fail = async (name, args, pattern) => { await assert.rejects(call(name, args), pattern); evidence.expectedFailures.push(name + ': ' + pattern.source) }
  const tabs = (await call('tabs_list')).items, tabId = tabs.find(t => t.url === url).tabId
  assert.equal((await call('debugger_status', { tabId })).attached, false)
  const snapshot = await call('page_snapshot', { tabId }), input = snapshot.elements.find(e => e.selector === '#name')
  await call('page_fill', { tabId, ref: input.ref, text: 'Carlos' }); await call('page_type', { tabId, selector: '#name', text: ' proxy' })
  assert.equal((await call('page_snapshot', { tabId })).elements.find(e => e.selector === '#name').value, 'Carlos proxy')
  await call('page_click', { tabId, selector: '#click' }); assert.equal((await call('page_read', { tabId, selector: '#count' })).text, '1')
  await call('page_click', { tabId, selector: '#rerender' }); await call('page_fill', { tabId, ref: input.ref, text: 'rerender' })
  await call('page_select', { tabId, selector: '#choice', values: ['b'] })
  const read = await call('page_read', { tabId, selector: '#long', limit: 100 }); assert.ok(read.nextOffset); assert.equal(read.text.length, 100)
  await call('page_scroll', { tabId, y: 500 }); await call('page_scroll', { tabId, y: -500 })
  const frames = (await call('page_frames', { tabId })).items
  await call('page_fill', { tabId, frameId: frames.find(f => f.url.includes('/frame')).frameId, selector: '#frameInput', text: 'frame fixture' })
  await fail('page_fill', { tabId, selector: '#file', text: 'x' }, /Unsupported/)
  await fail('page_click', { tabId, selector: '.ambiguous' }, /exactly one/)
  await call('tabs_select', { tabId })
  const legacyImage = await call('page_screenshot', { tabId }); assert.equal(legacyImage.content[0].type, 'image')
  const evalPage = async fn => JSON.parse((await call('evaluate_script', { tabId, function: fn })).json)
  assert.equal(await evalPage('()=>window.lastTrusted'), false)
  evidence.userAgent = await evalPage('()=>navigator.userAgent')
  const originalViewport = await evalPage('()=>[innerWidth,innerHeight,devicePixelRatio]')
  assert.equal((await call('debugger_status', { tabId })).attached, true)
  const snap = await call('take_snapshot', { tabId, limit: 500, verbose: true })
  const uid = name => { const node = snap.nodes.find(n => n.name?.trim() === name.trim() && n.uid && !['StaticText','InlineTextBox'].includes(n.role)); assert.ok(node, `Missing AX uid for ${name}`); return node.uid }
  assert.ok(snap.nodes.some(n => n.name === 'Shadow button'))
  const byUid = await call('evaluate_script', { tabId, function: '(el)=>el.id', args: [uid('Name ')] }); assert.equal(JSON.parse(byUid.json), 'name')
  const css = await call('get_css_styles', { tabId, uid: uid('Click') }); assert.ok(css.totalRules > 0)
  await call('click', { tabId, uid: uid('Click') }); assert.equal(await evalPage('()=>window.lastTrusted'), true)
  await call('hover', { tabId, uid: uid('Hover') }); assert.equal(await evalPage("()=>getComputedStyle(document.querySelector('#hover')).backgroundColor"), 'rgb(0, 255, 0)')
  const p = await evalPage("()=>{const r=document.querySelector('#click').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}")
  await call('click_at', { tabId, ...p }); assert.equal(await evalPage('()=>window.count'), 3)
  await call('fill_form', { tabId, elements: [{ uid: uid('Name '), value: 'CDP form' }, { uid: uid('Choice '), value: 'Alpha' }, { uid: uid('Check '), value: 'true' }] })
  assert.deepEqual(await evalPage("()=>[document.querySelector('#name').value,document.querySelector('#choice').value,document.querySelector('#check').checked]"), ['CDP form','a',true])
  await call('fill', { tabId, uid: uid('Name '), value: 'replace' })
  await evalPage("()=>document.querySelector('#name').focus()")
  await call('press_key', { tabId, key: 'Control+A' }); await call('type_text', { tabId, text: 'trusted typing', submitKey: 'Tab' })
  assert.equal(await evalPage("()=>document.querySelector('#name').value"), 'trusted typing')
  await call('drag', { tabId, from_uid: uid('Drag'), to_uid: uid('Drop') }); assert.ok(await evalPage('()=>window.dragMoves') > 0)
  const filePath = path.join(work, 'upload.txt'); await writeFile(filePath, 'bounded fixture upload')
  const uploaded = await call('upload_file', { tabId, uid: uid('File '), filePaths: [filePath] }); assert.equal(uploaded.files[0].size, 22)
  assert.equal(await evalPage("async()=>await document.querySelector('#file').files[0].text()"), 'bounded fixture upload')
  await evalPage("()=>{setTimeout(()=>document.body.append(' delayed fixture text'),100);return true}")
  await call('wait_for', { tabId, text: ['does not exist','delayed fixture text'] })
  await fail('wait_for', { tabId, text: ['absent'], timeout: 150 }, /timed out/)
  await call('click', { tabId, uid: uid('Prompt') })
  assert.equal((await call('debugger_status', { tabId })).dialog.type, 'prompt')
  await call('handle_dialog', { tabId, action: 'accept', promptText: 'handled' }); assert.equal(await evalPage('()=>window.promptValue'), 'handled')
  assert.equal(await evalPage("()=>prompt('auto-handled','default')"), '')
  await call('list_console_messages', { tabId }); await call('list_network_requests', { tabId })
  await evalPage("async()=>{console.warn('fixture-warning');await fetch('/data');return true}")
  const messages = await call('list_console_messages', { tabId, types: ['warn'] }); assert.ok(messages.items.some(m => m.args?.some(a => a.value === 'fixture-warning')))
  const message = await call('get_console_message', { tabId, msgid: messages.items.at(-1).msgid }); assert.equal(message.message.type, 'warn')
  const requests = await call('list_network_requests', { tabId, resourceTypes: ['fetch'] }), request = requests.items.find(r => r.url.endsWith('/data'))
  assert.ok(request)
  await sleep(100)
  const network = await call('get_network_request', { tabId, reqid: request.reqid }); assert.equal(network.request.response.status, 200); assert.ok(network.body.data.includes('network-body'))
  await evalPage("async()=>{await fetch('/large').then(r=>r.text());return true}")
  await sleep(100)
  const large = (await call('list_network_requests', { tabId })).items.find(r => r.url.endsWith('/large'))
  assert.equal((await call('get_network_request', { tabId, reqid: large.reqid })).body.available, false)
  const oversized = await call('evaluate_script', { tabId, function: "()=> 'x'.repeat(300000)" }); assert.equal(oversized.truncated, true); assert.equal(oversized.json.length, 200000)
  await fail('evaluate_script', { tabId, function: "()=>{throw Error('fixture-error')}" }, /fixture-error/)
  await call('resize_page', { tabId, width: 800, height: 600 }); assert.deepEqual(await evalPage('()=>[innerWidth,innerHeight]'), [800,600])
  await call('emulate', { tabId, colorScheme: 'dark', cpuThrottlingRate: 2, viewport: '900x700x1', userAgent: 'BrowserProxyFixture', extraHttpHeaders: '{"X-Test-Fixture":"yes"}', geolocation: '40,-73' })
  assert.equal(await evalPage("()=>matchMedia('(prefers-color-scheme: dark)').matches"), true)
  assert.equal(await evalPage('()=>navigator.userAgent'), 'BrowserProxyFixture')
  await call('emulate', { tabId, colorScheme: 'auto', userAgent: '', extraHttpHeaders: '' })
  const extra = await call('tabs_create', { url: url + 'next' }); await call('page_navigate', { tabId: extra.tabId, url: url + 'next' })
  await call('tabs_select', { tabId: extra.tabId })
  const image = await call('take_screenshot', { tabId, format: 'png' })
  assert.equal(image.content[0].mimeType, 'image/png'); assert.equal(Buffer.from(image.content[0].data,'base64').subarray(0,8).toString('hex'),'89504e470d0a1a0a')
  const jpeg = await call('take_screenshot', { tabId, format: 'jpeg', uid: uid('Click') }); assert.equal(jpeg.content[0].mimeType, 'image/jpeg')
  const full = await call('take_screenshot', { tabId: extra.tabId, fullPage: true, format: 'webp' }); assert.equal(full.content[0].mimeType, 'image/webp')
  await evalPage("()=>{document.body.style.minHeight='30000px';return true}")
  await fail('take_screenshot', { tabId, fullPage: true }, /pixel/)
  await evalPage("()=>{document.body.style.minHeight='';return true}")
  await fail('page_screenshot', { tabId }, /active/)
  await call('tabs_close', { tabId: extra.tabId })
  await call('performance_start_trace', { tabId, reload: false, autoStop: false })
  await evalPage("()=>{performance.mark('fixture-mark');for(let i=0;i<100000;i++)Math.sqrt(i);return true}")
  const trace = await call('performance_stop_trace', { tabId }); assert.ok(trace.traceEvents.length > 0); assert.ok(trace.retainedBytes <= 2097152)
  evidence.trace = { events: trace.traceEvents.length, truncated: trace.truncated, retainedBytes: trace.retainedBytes }
  await writeFile(path.join(runtime, 'cdp-fixture-trace.json'), JSON.stringify(trace), { mode: 0o600 })
  await writeFile(path.join(runtime, 'cdp-fixture-screenshot.png'), Buffer.from(image.content[0].data,'base64'), { mode: 0o600 })
  const newer = await call('new_page', { url: url + 'next', background: true }); await call('select_page', { tabId: newer.tabId, bringToFront: false })
  assert.ok((await call('list_pages')).items.some(t => t.tabId === newer.tabId))
  assert.equal((await evalPage(`async()=>await chrome.runtime.sendMessage(${JSON.stringify(contenderId)},{action:'attach',tabId:${newer.tabId}})`)).ok, true)
  await fail('evaluate_script', { tabId: newer.tabId, function: '()=>1' }, /DEBUGGER_CONFLICT/)
  assert.equal((await evalPage(`async()=>await chrome.runtime.sendMessage(${JSON.stringify(contenderId)},{action:'detach',tabId:${newer.tabId}})`)).ok, true)
  assert.equal(JSON.parse((await call('evaluate_script', { tabId: newer.tabId, function: '()=>1' })).json), 1)
  await call('close_page', { tabId: newer.tabId })
  await call('navigate_page', { tabId, type: 'url', url: url + 'next', initScript: 'window.fixtureInit=42' })
  assert.equal(await evalPage('()=>window.fixtureInit'), 42)
  await fail('click', { tabId, uid: uid('Click') }, /Stale/)
  await fail('page_fill', { tabId, ref: input.ref, text: 'stale' }, /Stale/)
  await fail('take_snapshot', { tabId, documentId: snap.documentId }, /Stale/)
  await call('navigate_page', { tabId, type: 'back' }); await call('navigate_page', { tabId, type: 'forward' }); await call('navigate_page', { tabId, type: 'reload', ignoreCache: true })
  assert.equal(await evalPage('()=>window.fixtureInit ?? null'), null)
  const autoTrace = await call('performance_start_trace', { tabId })
  assert.ok(autoTrace.traceEvents.length > 0)
  evidence.traceAutoStopAndReload = true
  await call('page_fill', { tabId, selector: '#name', text: '' })
  await Promise.all(Array.from({ length: 10 }, (_, i) => call('page_type', { tabId, selector: '#name', text: String(i) }, i % 2 ? first : second)))
  assert.equal(await evalPage("()=>document.querySelector('#name').value"), '0123456789')
  const before = bridge.health()
  for (let i = 0; i < 20; i++) await call('take_snapshot', { tabId })
  evidence.memory = { beforeRss: before.rssBytes, afterRss: bridge.health().rssBytes, debugger: await call('debugger_status', { tabId }) }
  await call('debugger_detach', { tabId }); assert.equal((await call('debugger_status', { tabId })).attached, false)
  assert.deepEqual(await evalPage('()=>[innerWidth,innerHeight,devicePixelRatio]'), originalViewport)
  await fail('evaluate_script', { tabId, function: 'async()=>await new Promise(()=>{})' }, /timed out|terminated/)
  assert.equal(JSON.parse((await call('evaluate_script', { tabId, function: '()=>21*2' })).json), 42)
  await first.close(); first = null
  assert.equal((await call('health', {}, second)).extensionConnected, true)
  await second.close(); second = null; assert.equal(bridge.health().extensionConnected, true)
  assert.equal(bridge.health().activeRequests + bridge.health().queuedRequests + bridge.health().tabQueues, 0)
  // Restart only this in-process ephemeral fixture bridge; test disconnect cleanup.
  await bridge.call('list_console_messages', { tabId })
  const testPort = bridge.server.address().port
  await bridge.close(); bridge = await createBridge({ config, port: testPort })
  for (let i = 0; i < 100 && !bridge.health().extensionConnected; i++) await sleep(100)
  assert.equal(bridge.health().extensionConnected, true)
  assert.equal((await bridge.call('debugger_status', { tabId })).attached, false)
  assert.equal((await bridge.call('page_read', { tabId })).title, 'Next document')
  evidence.reconnectAndDetachOnFixtureBridgeRestart = true
  evidence.operations = [...new Set(evidence.operations)]
  assert.equal(evidence.operations.length, 45)
  evidence.passed = true
  console.log(JSON.stringify({ passed: true, toolCount: evidence.operations.length, trace: evidence.trace, expectedFailures: evidence.expectedFailures.length, isolatedPort: bridge.server.address().port }, null, 2))
} catch (error) { evidence.passed = false; evidence.error = error.message; throw error }
finally {
  clearTimeout(timer)
  try {
    await writeFile(path.join(runtime, 'browser-evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
  } catch (error) {
    if (evidence.passed !== false) throw error
    console.error('Could not write browser evidence:', error.message)
  } finally {
    await Promise.race([Promise.allSettled([first?.close(), second?.close()]), sleep(1000)])
    if (browser) {
      try { process.kill(-browser.pid, 'SIGTERM') } catch {}
      await Promise.race([new Promise(resolve => browser.once('exit', resolve)), sleep(1000)])
      try { process.kill(-browser.pid, 'SIGKILL') } catch {}
    }
    await bridge?.close()
    fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve))
    if (work) await rm(work, { recursive: true, force: true })
  }
}
