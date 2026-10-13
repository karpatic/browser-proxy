// Regenerate the bundled PNGs directly from the SVG at each target size.
// Requires local Inkscape; normal extension builds only copy the ready PNGs.
import { spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { root, runtime } from './setup.mjs'

const profile = path.join(runtime, 'icon-renderer')
await mkdir(profile, { recursive: true, mode: 0o700 })
for (const size of [16, 32, 48, 128]) {
  const output = path.join(root, 'src', 'icons', `icon-${size}.png`)
  const result = spawnSync('inkscape', [path.join(root, 'src', 'icons', 'browser-proxy.svg'),
    '--export-type=png', `--export-filename=${output}`, `--export-width=${size}`,
    `--export-height=${size}`, '--export-background-opacity=0'], {
    env: { ...process.env, INKSCAPE_PROFILE_DIR: profile }, stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Inkscape failed rendering the ${size}px icon`)
  console.log(`Rendered src/icons/icon-${size}.png`)
}
