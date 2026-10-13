import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { randomBytes, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const runtime = path.join(root, '.runtime')
export async function setup() {
  await mkdir(runtime, { recursive: true, mode: 0o700 })
  await chmod(runtime, 0o700)
  const dist = path.join(root, 'dist')
  await mkdir(dist, { recursive: true, mode: 0o700 })
  await chmod(dist, 0o700)
  const file = path.join(runtime, 'capability.json')
  let config
  try { config = JSON.parse(await readFile(file, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    config = { token: randomBytes(32).toString('base64url') }
    await writeFile(file, JSON.stringify(config), { mode: 0o600, flag: 'wx' })
  }
  if (!/^[\w-]{43}$/.test(config.token)) throw new Error('Invalid private capability file')
  await chmod(file, 0o600)
  const manifest = JSON.parse(await readFile(path.join(root, 'src/manifest.json'), 'utf8'))
  const hash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
  const extensionId = hash.replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)))
  await writeFile(path.join(runtime, 'extension-config.json'), JSON.stringify({ ...config, url: 'ws://127.0.0.1:3217/extension' }), { mode: 0o600 })
  await writeFile(path.join(runtime, 'hermes-mcp.json'), JSON.stringify({ mcp_servers: { browser_proxy: { url: 'http://127.0.0.1:3217/mcp', protocol: 'legacy', trust: 'full', skip_preflight: true, supports_parallel_tool_calls: true, timeout: 30, connect_timeout: 10, tools: { resources: false, prompts: false }, headers: { Authorization: `Bearer ${config.token}` } } } }, null, 2), { mode: 0o600 })
  return { ...config, extensionId }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { extensionId } = await setup()
  console.log(`Private local configuration ready. Extension ID: ${extensionId}. Hermes example: .runtime/hermes-mcp.json`)
}
