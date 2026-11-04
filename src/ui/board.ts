import { layoutGraph, type BoardItem, type BoardState } from '../../shared/board'
import type { Bridge } from '../../shared/types'

// Draws the board. Everything comes from the model, so it only ever goes in as text (textContent).

const bridge = (window as unknown as { manyaki: Bridge }).manyaki
const board = document.getElementById('board')!
const SVG = 'http://www.w3.org/2000/svg'
const shown = new Map<string, { el: HTMLElement; item: BoardItem }>()

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function caption(parent: HTMLElement, text?: string) {
  if (text) parent.append(el('p', 'caption', text))
}

function drawArray(root: HTMLElement, item: BoardItem, before?: BoardItem) {
  caption(root, item.text)
  const row = el('div', 'cells')
  item.values!.forEach((v, i) => {
    const cell = el('div', 'cell')
    if (item.highlight?.includes(i)) cell.classList.add('on')
    if (before && before.values?.[i] !== v) cell.classList.add('changed')
    cell.append(el('b', '', v), el('small', '', String(i)))
    const ptr = item.pointers?.filter((p) => p.index === i).map((p) => p.label).join(', ')
    if (ptr) cell.append(el('em', '', `↑ ${ptr}`))
    row.append(cell)
  })
  root.append(row)
}

function drawGraph(root: HTMLElement, item: BoardItem) {
  caption(root, item.text)
  const labels = item.values!
  const edges = item.edges ?? []
  const pos = layoutGraph(labels.length, edges, item.layout ?? 'line')
  const w = 640
  const h = item.layout === 'tree' ? 280 : 110
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', labels.join(', '))
  const at = (i: number) => ({ x: pos[i].x * w, y: pos[i].y * h })
  for (const [a, b] of edges) {
    const line = document.createElementNS(SVG, 'line')
    line.setAttribute('x1', String(at(a).x)); line.setAttribute('y1', String(at(a).y))
    line.setAttribute('x2', String(at(b).x)); line.setAttribute('y2', String(at(b).y))
    svg.append(line)
  }
  labels.forEach((label, i) => {
    const g = document.createElementNS(SVG, 'g')
    if (item.highlight?.includes(i)) g.setAttribute('class', 'on')
    const c = document.createElementNS(SVG, 'circle')
    c.setAttribute('cx', String(at(i).x)); c.setAttribute('cy', String(at(i).y)); c.setAttribute('r', '24')
    const t = document.createElementNS(SVG, 'text')
    t.setAttribute('x', String(at(i).x)); t.setAttribute('y', String(at(i).y))
    t.textContent = label.slice(0, 6)
    g.append(c, t)
    svg.append(g)
  })
  root.append(svg)
}

function drawQuiz(root: HTMLElement, item: BoardItem) {
  root.classList.add('quiz')
  root.append(el('p', '', item.text))
  item.values!.forEach((opt, i) => {
    const b = el('button', '', opt)
    b.type = 'button'
    b.onclick = () => {
      const right = i === item.answer
      for (const other of root.querySelectorAll('button')) other.disabled = true
      b.classList.add(right ? 'right' : 'wrong')
      if (!right) root.querySelectorAll('button')[item.answer!].classList.add('right')
      bridge.sendCommand({ type: 'board-ask', text: `Quiz "${item.text}": I picked "${opt}". That is ${right ? 'right' : `wrong, the answer is "${item.values![item.answer!]}"`}.` })
    }
    root.append(b)
  })
}

function fill(root: HTMLElement, item: BoardItem, before?: BoardItem) {
  root.replaceChildren()
  switch (item.type) {
    case 'text': root.append(el('p', '', item.text)); break
    case 'code': root.append(el('pre', '', item.text)); break
    case 'list': {
      const ul = el('ul')
      for (const v of item.values!) ul.append(el('li', '', v))
      root.append(ul)
      break
    }
    case 'var': {
      const v = el('div', 'var')
      v.append(el('span', '', item.name), el('b', '', item.value ?? ''))
      root.append(v)
      break
    }
    case 'array': drawArray(root, item, before); break
    case 'graph': drawGraph(root, item); break
    case 'quiz': drawQuiz(root, item); break
  }
}

/** Keeps what didn't change, so a redraw with the same id animates just the cells that moved. */
function render(state: BoardState) {
  document.getElementById('title')!.textContent = [state.owner && `${state.owner}'s board`, state.title].filter(Boolean).join(' · ') || 'Blackboard'
  const keep = new Set(state.items.map((i) => i.id))
  for (const [id, s] of shown) if (!keep.has(id)) { s.el.remove(); shown.delete(id) }
  let last: HTMLElement | null = null
  for (const item of state.items) {
    const old = shown.get(item.id)
    if (old) {
      // An answered quiz stays answered unless it really is a new question.
      if (JSON.stringify(old.item) !== JSON.stringify(item)) {
        fill(old.el, item, old.item)
        old.item = item
        last = old.el
      }
      continue
    }
    const root = el('section', 'item')
    fill(root, item)
    board.append(root)
    shown.set(item.id, { el: root, item })
    last = root
  }
  last?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' })
}

bridge.on('board', render)
document.getElementById('close')!.onclick = () => window.close()
document.getElementById('ask')!.addEventListener('submit', (e) => {
  e.preventDefault()
  const input = document.getElementById('question') as HTMLInputElement
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  bridge.sendCommand({ type: 'board-ask', text })
})
