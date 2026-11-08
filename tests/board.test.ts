import { describe, expect, it } from 'vitest'
import { applyDraw, boardAllows, chartNumbers, hasPicture, ICON_NAMES, layoutGraph, MAX_PER_DRAW, parseItem, writtenWords, type BoardState } from '../shared/board'
import { arrowHead, ellipse, hachure, icon, ICONS, line, rect, rng, slice } from '../src/ui/sketch'

const empty: BoardState = { title: '', owner: 'Naman', items: [] }

describe('blackboard: what the model may draw', () => {
  it('rejects anything unusable and caps sizes', () => {
    expect(parseItem(null, 'a')).toBeNull()
    expect(parseItem({ type: 'html', text: '<script>' }, 'a')).toBeNull()
    expect(parseItem({ type: 'text' }, 'a')).toBeNull()
    expect(parseItem({ type: 'array', values: [] }, 'a')).toBeNull()
    expect(parseItem({ type: 'var', value: '5' }, 'a')).toBeNull()
    expect(parseItem({ type: 'quiz', text: 'q', values: ['a', 'b'], answer: 5 }, 'a')).toBeNull()
    expect(parseItem({ type: 'quiz', text: 'q', values: ['a'], answer: 0 }, 'a')).toBeNull()
    expect(parseItem({ type: 'text', text: 'x'.repeat(9000) }, 'a')?.text).toHaveLength(400)
    expect(parseItem({ type: 'array', values: Array(99).fill('1') }, 'a')?.values).toHaveLength(40)
  })
  it('keeps only highlights, pointers and edges that exist', () => {
    const arr = parseItem({ type: 'array', values: [10, 20, 30], highlight: [1, 9, -1, 'x'], pointers: ['0:low', '2:high', '7:no', 'junk'] }, 'a')
    expect(arr).toMatchObject({ values: ['10', '20', '30'], highlight: [1], pointers: [{ index: 0, label: 'low' }, { index: 2, label: 'high' }] })
    expect(parseItem({ type: 'graph', values: ['a', 'b'], edges: ['0-1', '0-9', 'x'], layout: 'tree' }, 'g')).toMatchObject({ edges: [[0, 1]], layout: 'tree' })
    expect(parseItem({ type: 'quiz', text: 'q', values: ['a', 'b'], answer: 1 }, 'q')?.answer).toBe(1)
  })
  it('updates by id in place, appends new ones, and fresh starts clean', () => {
    let { state } = applyDraw(empty, { title: 'Arrays', items: [{ id: 'arr', type: 'array', values: [1, 2] }, { type: 'text', text: 'hello' }] })
    expect(state.items.map((i) => i.id)).toEqual(['arr', 'item1'])
    ;({ state } = applyDraw(state, { items: [{ id: 'arr', type: 'array', values: [1, 9] }] }))
    expect(state.items.map((i) => i.id)).toEqual(['arr', 'item1'])
    expect(state.items[0].values).toEqual(['1', '9'])
    expect(state.title).toBe('Arrays')
    const next = applyDraw(state, { fresh: true, title: 'Variables', items: [{ type: 'var', name: 'x', value: 5 }] })
    expect(next.state.items).toHaveLength(1)
    expect(next.state.owner).toBe('Naman')
    expect(next.drawn).toBe(1)
    expect(applyDraw(state, { items: 'nope' }).drawn).toBe(0)
  })
  it('never grows without limit', () => {
    let state = empty
    for (let i = 0; i < 20; i++) state = applyDraw(state, { items: Array.from({ length: 12 }, (_, n) => ({ id: `${i}-${n}`, type: 'text', text: 'x' })) }).state
    expect(state.items).toHaveLength(30)
  })
  it('draws a few things at a time so her words can keep up', () => {
    const items = Array.from({ length: 9 }, (_, n) => ({ type: 'text', text: `line ${n}` }))
    expect(applyDraw(empty, { items }).drawn).toBe(MAX_PER_DRAW)
    expect(writtenWords(items)).toBe('line 0. line 1. line 2')
    expect(writtenWords([{ type: 'code', text: 'x = 1' }, { type: 'array', values: [1] }])).toBe('')
    expect(writtenWords([{ type: 'list', values: ['a', 'b'] }, { type: 'quiz', text: 'q?', values: ['y', 'n'], answer: 0 }])).toBe('a. b. q?. y. n')
    expect(writtenWords('nope')).toBe('')
  })
  it('accepts charts with real numbers only, and marks from the known set', () => {
    expect(parseItem({ type: 'chart', values: ['a', 'b'] }, 'c')).toBeNull()
    expect(parseItem({ type: 'chart', values: [1, 2], kind: 'pie', labels: ['x', 'y'] }, 'c')).toMatchObject({ kind: 'pie', labels: ['x', 'y'] })
    expect(parseItem({ type: 'chart', values: [1], kind: 'weird' }, 'c')?.kind).toBe('bar')
    expect(chartNumbers(['1,000', '50%', 'x'])).toEqual([1000, 50, 0])
    expect(parseItem({ type: 'note', text: 'hi', mark: 'circle' }, 'n')?.mark).toBe('circle')
    expect(parseItem({ type: 'note', text: 'hi', mark: '<svg>' }, 'n')?.mark).toBeUndefined()
  })
})

describe('blackboard: hand-drawn strokes', () => {
  const finite = (d: string) => (d.match(/-?\d+(\.\d+)?|NaN|Infinity/g) ?? []).every((v) => Number.isFinite(Number(v)))
  it('are stable for the same item and differ between items', () => {
    expect(line(rng('a'), 0, 0, 100, 50)).toBe(line(rng('a'), 0, 0, 100, 50))
    expect(line(rng('a'), 0, 0, 100, 50)).not.toBe(line(rng('b'), 0, 0, 100, 50))
  })
  it('never produce broken paths, even for thin shapes', () => {
    const r = rng('x')
    const all = [...rect(r, 0, 0, 10, 10), ellipse(r, 5, 5, 3, 3), ...arrowHead(r, 0, 0, 0, 0), ...slice(r, 50, 50, 40, 0, 1), ...hachure(r, 0, 0, 2, 200), ...hachure(r, 0, 0, 200, 2), ...hachure(r, 0, 0, 60, 44)]
    expect(all.length).toBeGreaterThan(8)
    for (const d of all) expect(finite(d)).toBe(true)
  })
})

describe('blackboard: picture first', () => {
  const pic = [{ type: 'graph', values: ['a'] }]
  const words = [{ type: 'text', text: 'x' }]
  const quiz = [{ type: 'quiz', text: 'q', values: ['a', 'b'], answer: 0 }]
  it('opens every topic with a picture, then allows words, but never words twice', () => {
    expect(boardAllows({ fresh: true, items: words }, true)).toBe(false)
    expect(boardAllows({ items: words }, false)).toBe(false)
    expect(boardAllows({ fresh: true, items: pic }, false)).toBe(true)
    expect(boardAllows({ items: words }, true)).toBe(true)
    expect(boardAllows({ items: quiz }, false)).toBe(true)
  })
  it('puts the picture above the words in the same draw, and code always says what it is', () => {
    const { state } = applyDraw(empty, { items: [{ id: 'h', type: 'heading', text: 'x' }, { id: 'p', type: 'array', values: [1] }] })
    expect(state.items.map((i) => i.id)).toEqual(['p', 'h'])
    expect(parseItem({ type: 'code', text: 'x = 1' }, 'c')).toBeNull()
    expect(parseItem({ type: 'code', text: 'x = 1', heading: 'Insert' }, 'c')?.heading).toBe('Insert')
    expect(writtenWords([{ type: 'code', text: 'x = 1', heading: 'Insert' }])).toBe('Insert')
    expect(parseItem({ type: 'heading', heading: 'Deletion' }, 'h')?.text).toBe('Deletion')
  })
})

describe('blackboard: chalk icons', () => {
  it('has strokes for every icon she is told about, and ignores anything else', () => {
    expect(Object.keys(ICONS).sort()).toEqual([...ICON_NAMES].sort())
    for (const name of ICON_NAMES) {
      const strokes = icon(rng(name), name, 50, 50, 30)
      expect(strokes?.length).toBeGreaterThan(0)
      expect(strokes!.join('')).not.toMatch(/NaN|undefined/)
    }
    expect(icon(rng('x'), '💻', 0, 0, 10)).toBeNull()
    expect(icon(rng('x'), 'constructor', 0, 0, 10)).toBeNull()
  })
})

describe('blackboard: pictures', () => {
  it('runs a flow in order when no links are given, with moving dots and icons', () => {
    const f = parseItem({ type: 'graph', layout: 'flow', values: ['a', 'b', 'c'], icons: ['pc', '', 'globe'] }, 'f')
    expect(f).toMatchObject({ edges: [[0, 1], [1, 2]], moving: true, icons: ['pc', '', 'globe'] })
    expect(parseItem({ type: 'graph', layout: 'tree', values: ['a', 'b'] }, 't')).toMatchObject({ edges: [], moving: false })
    expect(parseItem({ type: 'graph', layout: 'tree', values: ['a', 'b'], moving: true }, 't')?.moving).toBe(true)
    expect(parseItem({ type: 'graph', values: Array(30).fill('x') }, 'g')?.values).toHaveLength(12)
    expect(parseItem({ type: 'text', text: 'x', icons: ['<svg onload=x>aaaaa'] }, 't')?.icons?.[0]).toHaveLength(8)
  })
  it('snakes a long flow so each step is beside the next', () => {
    const p = layoutGraph(6, [], 'flow')
    expect(p[0].y).toBe(p[2].y)
    expect(p[3].y).toBeGreaterThan(p[2].y)
    expect(p[3].x).toBe(p[2].x)
    expect(p[5].x).toBe(p[0].x)
    expect(new Set(p.map((v) => `${v.x},${v.y}`)).size).toBe(6)
  })
  it('knows a picture from plain words', () => {
    expect(hasPicture([{ type: 'text', text: 'x' }, { type: 'note', text: 'y' }])).toBe(false)
    expect(hasPicture([{ type: 'text', text: 'x' }, { type: 'graph', values: ['a'] }])).toBe(true)
    expect(hasPicture('nope')).toBe(false)
  })
})

describe('blackboard: graph layout', () => {
  it('spreads a chain evenly', () => {
    expect(layoutGraph(2, [[0, 1]], 'line')).toEqual([{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }])
  })
  it('layers a tree from its root and keeps stray nodes off the root', () => {
    const p = layoutGraph(4, [[0, 1], [0, 2]], 'tree')
    expect(p[0].y).toBeLessThan(p[1].y)
    expect(p[1].y).toBe(p[2].y)
    expect(p[1].x).toBeLessThan(p[2].x)
    expect(p[3].y).toBeGreaterThan(p[1].y)
  })
})
