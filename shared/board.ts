// Her blackboard: what the model may draw. The model sends plain data, never markup; it is validated
// here and only ever rendered as text, so nothing it says (or reads off a page) can run on the board.

export interface BoardItem {
  id: string
  type: 'text' | 'list' | 'code' | 'array' | 'var' | 'graph' | 'quiz'
  text?: string          // text, code; the question of a quiz; the caption of an array or graph
  values?: string[]      // list lines, array cells, graph node labels, quiz options
  highlight?: number[]   // cells or nodes to light up
  pointers?: { index: number; label: string }[] // arrows under array cells: i, j, low, high
  name?: string          // var
  value?: string         // var
  edges?: [number, number][] // graph: node index pairs
  layout?: 'line' | 'tree' // graph: a chain (linked list, stack) or layered (tree, graph)
  answer?: number        // quiz: index of the right option
}

export interface BoardState { title: string; owner: string; items: BoardItem[] }

const TYPES = new Set(['text', 'list', 'code', 'array', 'var', 'graph', 'quiz'])
const MAX_ITEMS = 30
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
  const text = str(r.text, type === 'code' ? 1500 : 400)
  if (text) item.text = text
  const values = strs(r.values)
  if (type === 'text' || type === 'code') return text ? item : null
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
  if (Array.isArray(r.highlight)) item.highlight = r.highlight.filter((i) => inRange(i, values.length))
  if (type === 'array' && Array.isArray(r.pointers)) {
    // "2:low" keeps the tool schema flat for the model.
    item.pointers = r.pointers.flatMap((p) => {
      const m = /^(\d+):(.{1,12})$/.exec(String(p))
      return m && inRange(Number(m[1]), values.length) ? [{ index: Number(m[1]), label: m[2] }] : []
    })
  }
  if (type === 'graph') {
    item.layout = r.layout === 'tree' ? 'tree' : 'line'
    item.edges = (Array.isArray(r.edges) ? r.edges : []).flatMap((e): [number, number][] => {
      const m = /^(\d+)-(\d+)$/.exec(String(e))
      return m && inRange(Number(m[1]), values.length) && inRange(Number(m[2]), values.length) ? [[Number(m[1]), Number(m[2])]] : []
    })
  }
  return item
}

/** Applies a draw call: same id updates in place (that's the animation), new ids append, fresh clears first. */
export function applyDraw(state: BoardState, args: { title?: unknown; fresh?: unknown; items?: unknown }): { state: BoardState; drawn: number } {
  const items = args.fresh === true ? [] : [...state.items]
  const parsed = (Array.isArray(args.items) ? args.items.slice(0, 12) : []).flatMap((raw, i) => {
    const it = parseItem(raw, `item${items.length + i}`)
    return it ? [it] : []
  })
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
export function layoutGraph(count: number, edges: [number, number][], layout: 'line' | 'tree'): { x: number; y: number }[] {
  if (layout === 'line') return Array.from({ length: count }, (_, i) => ({ x: (i + 0.5) / count, y: 0.5 }))
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
