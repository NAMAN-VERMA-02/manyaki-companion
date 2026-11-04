import { describe, expect, it } from 'vitest'
import { applyDraw, layoutGraph, parseItem, type BoardState } from '../shared/board'

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
    for (let i = 0; i < 10; i++) state = applyDraw(state, { items: Array.from({ length: 12 }, (_, n) => ({ id: `${i}-${n}`, type: 'text', text: 'x' })) }).state
    expect(state.items).toHaveLength(30)
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
