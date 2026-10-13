#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { runtime } from '../scripts/setup.mjs'
import path from 'node:path'
try {
  const { token } = JSON.parse(await readFile(path.join(runtime, 'capability.json'), 'utf8'))
  const [name = 'health', raw = '{}', flag, file] = process.argv.slice(2)
  if (flag && (flag !== '--output' || !file || !['page_screenshot', 'take_screenshot'].includes(name))) throw new Error('--output FILE is available for page_screenshot and take_screenshot only')
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const response = await fetch(`http://127.0.0.1:3217/${name === 'tools' ? 'tools' : name === 'health' ? 'health' : 'call'}`, name === 'tools' || name === 'health' ? { headers } : { method: 'POST', headers, body: JSON.stringify({ name, arguments: JSON.parse(raw) }), signal: AbortSignal.timeout(30000) })
  const result = await response.json()
  if (!response.ok || result.ok === false) throw new Error(result.error || `HTTP ${response.status}`)
  const data = result.data ?? result
  if (file) { await writeFile(file, Buffer.from(data.dataUrl.split(',')[1], 'base64'), { mode: 0o600 }); delete data.dataUrl; data.output = file }
  console.log(JSON.stringify(data, null, 2))
} catch (error) { console.error(`Browser Proxy: ${error.message}`); process.exitCode = 1 }
