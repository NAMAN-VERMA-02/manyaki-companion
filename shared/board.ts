// Her blackboard: what the model may draw. The model sends plain data, never markup; it is validated
// here and only ever rendered as text, so nothing it says (or reads off a page) can run on the board.

export interface BoardItem {
  id: string
  type: 'heading' | 'text' | 'note' | 'list' | 'code' | 'array' | 'var' | 'graph' | 'chart' | 'quiz'
  heading?: string       // code: what this code is, shown above it
  text?: string          // text, note, code; the question of a quiz; the caption of an array, graph or chart
  values?: string[]      // list lines, array cells, graph node labels, chart numbers, quiz options
  labels?: string[]      // chart: the name under each number
  kind?: 'bar' | 'line' | 'pie' // chart
  mark?: 'circle' | 'underline' | 'box' // chalk scribbled over the item to point at it
  highlight?: number[]   // cells or nodes to light up
  pointers?: { index: number; label: string }[] // arrows under array cells: i, j, low, high
  name?: string          // var
  value?: string         // var
  edges?: [number, number][] // graph: node index pairs
  layout?: 'line' | 'tree' | 'flow' // graph: a chain, layered (tree, graph), or a process wrapping across rows
  moving?: boolean       // graph: dots travel along the arrows, showing what flows where
  icons?: string[]       // a chalk icon name per node or list line; the first one for a text or note
  answer?: number        // quiz: index of the right option
}

export interface BoardState { title: string; owner: string; items: BoardItem[] }

/** Chalk icons she can draw (the strokes are in src/ui/sketch.ts). */
export const ICON_NAMES = ['pc', 'phone', 'server', 'router', 'globe', 'cloud', 'database', 'file', 'folder', 'lock', 'key', 'user', 'gear', 'code', 'bulb', 'book', 'box', 'clock', 'check', 'cross', 'star', 'mail', 'search'] as const

const PICTURES = new Set(['array', 'var', 'graph', 'chart'])
const TYPES = new Set(['heading', 'text', 'note', 'list', 'code', 'array', 'var', 'graph', 'chart', 'quiz'])
const MARKS = new Set(['circle', 'underline', 'box'])
const MAX_ITEMS = 30
/** One draw call at a time on purpose: she says each thing before writing the next, so words keep pace with chalk. */
export const MAX_PER_DRAW = 3
const str = (v: unknown, max = 400) => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v) : '')
const strs = (v: unknown, n = 40) => (Array.isArray(v) ? v.slice(0, n).map((x) => str(x, 120)) : [])
const inRange = (i: unknown, len: number): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < len

/** One drawn thing from the model, or null if it isn't usable. */
export function parseItem(raw: unknown, fallbackId: string): BoardItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const type = String(r.type)
  if (!TYPES.has(type)) return null
  const item: BoardItem = { id: str(r.id, 40) || fallbackId, type: type as BoardItem['type'] }
  // Models often put a heading's words in the field named heading.
  const text = str(r.text, type === 'code' ? 1500 : 400) || (type === 'heading' ? str(r.heading, 80) : '')
  if (text) item.text = text
  const icons = strs(r.icons, 40).map((i) => i.slice(0, 8))
  if (icons.some(Boolean)) item.icons = icons
  if (MARKS.has(String(r.mark))) item.mark = r.mark as BoardItem['mark']
  const values = strs(r.values)
  if (type === 'code') {
    // Code on its own means nothing to a learner: it always says what it is.
    const heading = str(r.heading, 80)
    if (!text || !heading) return null
    item.heading = heading
    return item
  }
  if (type === 'heading' || type === 'text' || type === 'note') return text ? item : null
  if (type === 'var') {
    item.name = str(r.name, 40)
    item.value = str(r.value, 120)
    return item.name ? item : null
  }
  if (!values.length) return null
  item.values = values
  if (type === 'quiz') {
    if (!text || values.length < 2 || !inRange(r.answer, values.length)) return null
    item.answer = r.answer
    return item
  }
  if (type === 'list') return item
  if (type === 'chart') {
    if (!chartNumbers(values).some((n) => n !== 0)) return null
    item.values = values.slice(0, 12)
    item.kind = r.kind === 'line' || r.kind === 'pie' ? r.kind : 'bar'
    item.labels = strs(r.labels, 12)
    return item
  }
  if (Array.isArray(r.highlight)) item.highlight = r.highlight.filter((i) => inRange(i, values.length))
  if (type === 'array' && Array.isArray(r.pointers)) {
    // "2:low" keeps the tool schema flat for the model.
    item.pointers = r.pointers.flatMap((p) => {
      const m = /^(\d+):(.{1,12})$/.exec(String(p))
      return m && inRange(Number(m[1]), values.length) ? [{ index: Number(m[1]), label: m[2] }] : []
    })
  }
  if (type === 'graph') {
    item.values = values.slice(0, 12)
    item.layout = r.layout === 'tree' || r.layout === 'flow' ? r.layout : 'line'
    item.moving = r.moving === true || item.layout === 'flow'
    item.edges = (Array.isArray(r.edges) ? r.edges : []).flatMap((e): [number, number][] => {
      const m = /^(\d+)-(\d+)$/.exec(String(e))
      return m && inRange(Number(m[1]), item.values!.length) && inRange(Number(m[2]), item.values!.length) ? [[Number(m[1]), Number(m[2])]] : []
    })
    // A process with no links spelled out just runs in order.
    if (item.layout !== 'tree' && !item.edges.length) item.edges = item.values.slice(1).map((_, i): [number, number] => [i, i + 1])
  }
  return item
}

/** Chart values as numbers; anything that isn't one counts as zero. */
export function chartNumbers(values: string[]): number[] {
  return values.map((v) => { const n = Number(String(v).replace(/[,%\s]/g, '')); return Number.isFinite(n) ? n : 0 })
}

/** Whether a draw call has an actual picture in it, not only words. */
export function hasPicture(items: unknown): boolean {
  return Array.isArray(items) && items.slice(0, MAX_PER_DRAW).some((i) => PICTURES.has(String((i as { type?: unknown })?.type)))
}

const onlyQuiz = (items: unknown) => Array.isArray(items) && items.length > 0 && items.every((i) => (i as { type?: unknown })?.type === 'quiz')

/**
 * Every idea starts as a picture and the words come out of it, so a draw of only words is allowed just
 * after a picture: never to open a topic, and never twice in a row. A quiz can come any time.
 */
export function boardAllows(args: { fresh?: unknown; items?: unknown }, lastHadPicture: boolean): boolean {
  return hasPicture(args.items) || onlyQuiz(args.items) || (lastHadPicture && args.fresh !== true)
}

/** The words on a draw call, for telling her what to say out loud. */
export function writtenWords(items: unknown): string {
  if (!Array.isArray(items)) return ''
  return items.slice(0, MAX_PER_DRAW).flatMap((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>
    if (r.type === 'list') return strs(r.values)
    if (r.type === 'quiz') return [str(r.text), ...strs(r.values)]
    if (r.type === 'code') return [str(r.heading, 80)]
    return [str(r.text)]
  }).filter(Boolean).join('. ').slice(0, 600)
}

/** Applies a draw call: same id updates in place (that's the animation), new ids append, fresh clears first. */
export function applyDraw(state: BoardState, args: { title?: unknown; fresh?: unknown; items?: unknown }): { state: BoardState; drawn: number } {
  const items = args.fresh === true ? [] : [...state.items]
  const parsed = (Array.isArray(args.items) ? args.items.slice(0, MAX_PER_DRAW) : []).flatMap((raw, i) => {
    const it = parseItem(raw, `item${items.length + i}`)
    return it ? [it] : []
  })
  // Within a draw too: the picture goes up first, the words after it.
  parsed.sort((a, b) => Number(PICTURES.has(b.type)) - Number(PICTURES.has(a.type)))
  for (const it of parsed) {
    const at = items.findIndex((x) => x.id === it.id)
    if (at >= 0) items[at] = it
    else items.push(it)
  }
  return {
    state: { ...state, title: str(args.title, 80) || (args.fresh === true ? '' : state.title), items: items.slice(-MAX_ITEMS) },
    drawn: parsed.length
  }
}

/** Node positions as fractions of the drawing (0..1). Trees are layered from the first node by edge distance. */
export function layoutGraph(count: number, edges: [number, number][], layout: 'line' | 'tree' | 'flow'): { x: number; y: number }[] {
  if (layout === 'line') return Array.from({ length: count }, (_, i) => ({ x: (i + 0.5) / count, y: 0.5 }))
  if (layout === 'flow') {
    // Snakes: left to right, then back, so every arrow is short and nothing crosses.
    const perRow = count <= 4 ? count : count <= 8 ? Math.ceil(count / 2) : 4
    const rows = Math.ceil(count / perRow)
    return Array.from({ length: count }, (_, i) => {
      const row = Math.floor(i / perRow)
      const col = i % perRow
      return { x: ((row % 2 ? perRow - 1 - col : col) + 0.5) / perRow, y: (row + 0.5) / rows }
    })
  }
  const depth = new Array<number>(count).fill(-1)
  depth[0] = 0
  const queue = [0]
  while (queue.length) {
    const n = queue.shift()!
    for (const [a, b] of edges) {
      const next = a === n ? b : b === n ? a : -1
      if (next >= 0 && depth[next] < 0) { depth[next] = depth[n] + 1; queue.push(next) }
    }
  }
  // Nodes nothing connects to sit one layer below the rest rather than on top of the root.
  const deepest = Math.max(...depth)
  const layers: number[][] = []
  depth.forEach((d, i) => { const l = d < 0 ? deepest + 1 : d; (layers[l] ??= []).push(i) })
  const out: { x: number; y: number }[] = []
  layers.forEach((nodes, l) => nodes.forEach((n, i) => { out[n] = { x: (i + 0.5) / nodes.length, y: (l + 0.5) / layers.length } }))
  return out
}
