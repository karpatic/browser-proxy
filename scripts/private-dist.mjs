import { chmod } from 'node:fs/promises'
await chmod(new URL('../dist/bridge-config.json', import.meta.url), 0o600)
