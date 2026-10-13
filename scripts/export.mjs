// Share source only. Built dist contains this machine's private capability.
import { mkdir, cp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { root, runtime } from './setup.mjs'
import path from 'node:path'
const staging = path.join(runtime, 'export', 'browser-proxy')
await rm(path.dirname(staging), { recursive: true, force: true })
await mkdir(staging, { recursive: true })
for (const file of ['src', 'bridge', 'scripts', 'test', 'docs', 'package.json', 'package-lock.json', 'webpack.config.js', '.gitignore', 'README.md', 'AGENTS.md', 'LICENSE']) await cp(path.join(root, file), path.join(staging, file), { recursive: true })
const archive = path.join(runtime, 'browser-proxy-source.tgz')
const result = spawnSync('tar', ['-czf', archive, '-C', path.dirname(staging), 'browser-proxy'], { stdio: 'inherit' })
if (result.status) process.exit(result.status)
console.log('Source export: .runtime/browser-proxy-source.tgz (no capabilities, runtime, or dist)')
