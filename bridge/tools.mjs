import { z } from 'zod'
import { cdpTools } from './cdp-tools.mjs'
const tabId = z.number().int().nonnegative().describe('Explicit Chrome tab ID from tabs_list')
const frameId = z.number().int().nonnegative().default(0)
const target = { tabId, frameId, documentId: z.string().optional().describe('Snapshot documentId; rejects navigation races'), ref: z.string().optional(), selector: z.string().max(4000).optional() }
const page = { tabId, frameId, documentId: z.string().optional() }
const url = z.string().max(8192).refine(v => { try { return ['http:', 'https:'].includes(new URL(v).protocol) } catch { return false } }, 'Only http/https URLs are supported')
const define = (name, description, shape) => ({ name, description, schema: z.object(shape).strict() })
export const tools = [
  define('health', 'Connection and bounded state counters; contains no page data.', {}),
  define('tabs_list', 'List existing tabs with explicit IDs and URLs.', {}),
  define('tabs_select', 'Activate and focus an explicit tab ID. Does not change future tool targets.', { tabId }),
  define('tabs_create', 'Create a tab only when explicitly requested.', { url, active: z.boolean().default(false) }),
  define('tabs_close', 'Close an explicitly requested tab.', { tabId }),
  define('page_frames', 'List frame IDs and URLs. Restricted frames cannot be controlled.', { tabId }),
  define('page_snapshot', 'Visible controls with document-scoped refs, selectors, labels and values. Paginate using nextOffset; refs survive matching DOM rerenders but expire on navigation or eviction.', { ...page, offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(500).default(100) }),
  define('page_read', 'Read rendered text from a page or selector. Returns total length and nextOffset for explicit pagination.', { ...page, selector: z.string().max(4000).optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200000).default(20000) }),
  define('page_click', 'Synthetic DOM click on one visible control by ref or unique CSS selector. Does not create a trusted user gesture.', target),
  define('page_fill', 'Replace a text input, textarea or contenteditable value and dispatch input/change events. File inputs and non-text controls unsupported.', { ...target, text: z.string().max(200000) }),
  define('page_type', 'Append text using DOM value updates and input/change events; no hardware keyboard events or trusted gesture.', { ...target, text: z.string().max(200000) }),
  define('page_select', 'Set native select values and dispatch input/change. Custom widgets require their own DOM controls.', { ...target, values: z.array(z.string()).min(1).max(100) }),
  define('page_scroll', 'Scroll the page or a unique CSS target by pixel offsets.', { ...page, selector: z.string().max(4000).optional(), x: z.number().min(-1000000).max(1000000).default(0), y: z.number().min(-1000000).max(1000000).default(600) }),
  define('page_navigate', 'Navigate an explicit tab to http/https and wait up to 15 seconds for load completion.', { tabId, url }),
  define('page_screenshot', 'Capture the visible viewport of an already active tab. Fails if target is inactive, focus changes or Chrome denies capture. Returns PNG data URL; no disk cache.', { tabId }),
  ...cdpTools,
]
const legacyReads = new Set(['health', 'tabs_list', 'page_read', 'page_snapshot', 'page_frames', 'page_screenshot'])
for (const t of tools) t.annotations ??= { readOnlyHint: legacyReads.has(t.name), destructiveHint: !legacyReads.has(t.name), idempotentHint: legacyReads.has(t.name), openWorldHint: true }
export const catalog = new Map(tools.map(t => [t.name, t]))
export function validate(name, args) {
  const tool = catalog.get(name)
  if (!tool) throw new Error(`Unknown tool: ${name}`)
  return tool.schema.parse(args ?? {})
}
export function toolList() { return tools.map(({ name, description, schema, annotations }) => ({ name, description, annotations, inputSchema: z.toJSONSchema(schema) })) }
