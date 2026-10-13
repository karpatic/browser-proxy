import path from 'node:path'
import { fileURLToPath } from 'node:url'
import CopyWebpackPlugin from 'copy-webpack-plugin'
const root = path.dirname(fileURLToPath(import.meta.url))
export default {
  mode: 'production',
  entry: { 'service-worker': './src/service-worker.js', content: './src/content.js', panel: './src/panel.js' },
  output: { path: path.join(root, 'dist'), filename: '[name].js', clean: true },
  devtool: false,
  plugins: [new CopyWebpackPlugin({ patterns: [
    { from: 'src/manifest.json', to: 'manifest.json' },
    { from: 'src/panel.html', to: 'panel.html' },
    { from: 'src/styles.css', to: 'styles.css' },
    { from: 'src/icons', to: 'icons' },
    { from: '.runtime/extension-config.json', to: 'bridge-config.json' },
  ] })],
  optimization: { runtimeChunk: false, splitChunks: false },
}
