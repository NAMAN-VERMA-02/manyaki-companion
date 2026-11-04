import { chartNumbers, layoutGraph, type BoardItem, type BoardState } from '../../shared/board'
import type { Bridge } from '../../shared/types'
import { arrowHead, ellipse, hachure, icon, line, rect, rng, slice } from './sketch'

// Draws the board by hand: strokes draw themselves on, words appear at about her speaking pace.
// Everything comes from the model, so it only ever goes in as text (textContent).

const bridge = (window as unknown as { manyaki: Bridge }).manyaki
const board = document.getElementById('board')!
const SVG = 'http://www.w3.org/2000/svg'
const WORD_MS = 430 // about how long she takes to say a word at a teaching pace
const STROKE_PACE = 1.6 // drawn with care, not flicked on
const ALREADY_THERE = -100000 // an animation that started long ago: drawn, with no motion
const shown = new Map<string, { el: HTMLElement; item: BoardItem }>()

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function svgEl(w: number, h: number, label?: string) {
  const s = document.createElementNS(SVG, 'svg')
  s.setAttribute('viewBox', `0 0 ${w} ${h}`)
  if (label) { s.setAttribute('role', 'img'); s.setAttribute('aria-label', label) } else s.setAttribute('aria-hidden', 'true')
  return s
}

/** Adds strokes that draw themselves on one after another. Returns when the last one finishes (ms). */
function ink(svg: SVGElement, strokes: string[], at: number, cls = '', stroke = 130) {
  const each = stroke * STROKE_PACE
  strokes.forEach((d, i) => {
    const p = document.createElementNS(SVG, 'path')
    p.setAttribute('d', d)
    p.setAttribute('pathLength', '1')
    p.setAttribute('class', `ink ${cls}`)
    p.style.setProperty('--d', `${at + i * each}ms`)
    p.style.setProperty('--t', `${each + 60}ms`)
    svg.append(p)
  })
  return at + strokes.length * each
}

function label(svg: SVGElement, x: number, y: number, text: string, at: number, cls = '') {
  const t = document.createElementNS(SVG, 'text')
  t.setAttribute('x', String(x))
  t.setAttribute('y', String(y))
  t.setAttribute('class', `chalk ${cls}`)
  t.style.setProperty('--d', `${at}ms`)
  t.textContent = text
  svg.append(t)
}

/** Writes text word by word. Returns how long that takes. */
/** A small chalk icon in a line of writing. Returns when it has been drawn. */
function inlineIcon(parent: HTMLElement, name: string | undefined, at: number, cls = 'c0') {
  const strokes = name ? icon(rng(name), name, 15, 15, 26) : null
  if (!strokes) return at
  const s = svgEl(30, 30)
  s.setAttribute('class', 'inline-icon')
  const end = ink(s, strokes, at, cls, 40)
  parent.append(s)
  return end
}

function writeWords(parent: HTMLElement, text: string, at: number) {
  const words = text.split(/(\s+)/)
  let i = 0
  for (const w of words) {
    if (!w.trim()) { parent.append(w); continue }
    const s = el('span', 'word', w)
    s.style.setProperty('--d', `${at + i * WORD_MS}ms`)
    parent.append(s)
    i++
  }
  return at + i * WORD_MS
}

function caption(root: HTMLElement, item: BoardItem, at: number) {
  if (!item.text) return at
  const p = el('p', 'caption')
  root.append(p)
  return writeWords(p, item.text, at)
}

function drawArray(root: HTMLElement, item: BoardItem, before: BoardItem | undefined, start: number) {
  const r = rng(item.id)
  let at = caption(root, item, start)
  const row = el('div', 'cells')
  item.values!.forEach((v, i) => {
    const changed = before && before.values?.[i] !== v
    const on = item.highlight?.includes(i)
    const wrap = el('div', 'cell')
    const s = svgEl(72, 56, `index ${i}: ${v}`)
    // A redraw only animates what changed; the rest of the array just stays put.
    const t = before && !changed ? ALREADY_THERE : at
    if (on) ink(s, hachure(r, 6, 6, 60, 44, 8), t, 'shade', 25)
    ink(s, rect(r, 3, 3, 66, 50), t, changed ? 'hot' : '', before ? 60 : 45)
    label(s, 36, 29, v.slice(0, 7), t + 60, on ? 'strong' : '')
    wrap.append(s, el('small', '', String(i)))
    const ptr = item.pointers?.filter((p) => p.index === i).map((p) => p.label).join(', ')
    if (ptr) wrap.append(el('em', '', `↑ ${ptr}`))
    row.append(wrap)
    if (!before) at += 60
  })
  root.append(row)
  return at + 200
}

/** A dot that keeps travelling along an arrow, so the picture shows what goes where. */
function movingDot(svg: SVGElement, path: string, cls: string, at: number) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const dot = document.createElementNS(SVG, 'circle')
  dot.setAttribute('r', '6')
  dot.setAttribute('class', `dot ${cls}`)
  dot.setAttribute('opacity', '0')
  const trips = 14 // long enough to explain it over, then still, so a finished board costs nothing
  const trip = 1.7
  const motion = document.createElementNS(SVG, 'animateMotion')
  motion.setAttribute('path', path)
  motion.setAttribute('dur', `${trip}s`)
  motion.setAttribute('begin', `${at / 1000}s`)
  motion.setAttribute('repeatCount', String(trips))
  const show = document.createElementNS(SVG, 'set')
  show.setAttribute('attributeName', 'opacity')
  show.setAttribute('to', '1')
  show.setAttribute('begin', `${at / 1000}s`)
  show.setAttribute('dur', `${trip * trips}s`)
  dot.append(motion, show)
  svg.append(dot)
}

function drawGraph(root: HTMLElement, item: BoardItem, start: number) {
  const r = rng(item.id)
  let at = caption(root, item, start)
  const labels = item.values!
  const edges = item.edges ?? []
  const layout = item.layout ?? 'line'
  const pos = layoutGraph(labels.length, edges, layout)
  const rows = new Set(pos.map((p) => p.y)).size
  const w = 720
  const h = layout === 'flow' ? rows * 130 : layout === 'tree' ? Math.max(260, rows * 110) : 130
  // Cards fit their words, within their share of the width, so a name never runs out of its box.
  const inRow = Math.max(...[...new Set(pos.map((p) => p.y))].map((y) => pos.filter((p) => p.y === y).length))
  const maxW = Math.max(84, (w / inRow) * 0.78)
  const chars = Math.floor((maxW - 18) / 10)
  const text = labels.map((l) => (l.length > chars ? `${l.slice(0, chars - 1)}…` : l))
  const hasIcons = !!item.icons?.some(Boolean)
  const size = (i: number) => ({ w: Math.max(72, Math.min(maxW, text[i].length * 10.5 + 26)), h: hasIcons ? 78 : 50 })
  const p = (i: number) => ({ x: pos[i].x * w, y: pos[i].y * h })
  const s = svgEl(w, h, labels.join(', '))
  s.style.maxHeight = `${h}px`
  const colour = (i: number) => COLOURS[i % COLOURS.length]
  // Boxes first, then arrows between them, in the order a teacher would draw them.
  labels.forEach((_, i) => {
    const c = p(i)
    const b = size(i)
    const on = item.highlight?.includes(i)
    if (on) ink(s, hachure(r, c.x - b.w / 2 + 3, c.y - b.h / 2 + 3, b.w - 6, b.h - 6, 9), at, `shade ${colour(i)}`, 16)
    at = ink(s, rect(r, c.x - b.w / 2, c.y - b.h / 2, b.w, b.h), at, on ? 'hot' : colour(i), 55)
    const drawn = hasIcons && item.icons?.[i] ? icon(r, item.icons[i], c.x, c.y - 14, 34) : null
    if (drawn) at = ink(s, drawn, at, on ? 'hot' : colour(i), 28)
    label(s, c.x, hasIcons ? c.y + 20 : c.y, text[i], at, on ? 'strong' : colour(i))
    at += 120
  })
  edges.forEach(([a, b]) => {
    const from = p(a)
    const to = p(b)
    const len = Math.hypot(to.x - from.x, to.y - from.y) || 1
    const ux = (to.x - from.x) / len
    const uy = (to.y - from.y) / len
    // Where the straight line leaves one card and enters the other.
    const edge = (i: number) => { const c = size(i); return Math.min(Math.abs(ux) > 0.01 ? c.w / 2 / Math.abs(ux) : Infinity, Math.abs(uy) > 0.01 ? c.h / 2 / Math.abs(uy) : Infinity) + 5 }
    const x1 = from.x + ux * edge(a)
    const y1 = from.y + uy * edge(a)
    const x2 = to.x - ux * edge(b)
    const y2 = to.y - uy * edge(b)
    at = ink(s, [line(r, x1, y1, x2, y2)], at, colour(a), 90)
    if (layout !== 'tree' || item.moving) at = ink(s, arrowHead(r, x1, y1, x2, y2), at, colour(a), 35)
    if (item.moving) movingDot(s, `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`, colour(a), at)
  })
  root.append(s)
  return at
}

const COLOURS = ['c0', 'c1', 'c2', 'c3', 'c4']

function drawChart(root: HTMLElement, item: BoardItem, start: number) {
  const r = rng(item.id)
  let at = caption(root, item, start)
  const nums = chartNumbers(item.values!)
  const names = item.labels ?? []
  const w = 640
  const h = 260
  const s = svgEl(w, h, names.map((n, i) => `${n}: ${nums[i]}`).join(', ') || nums.join(', '))
  if (item.kind === 'pie') {
    const total = nums.reduce((a, b) => a + Math.abs(b), 0) || 1
    let a0 = -Math.PI / 2
    nums.forEach((v, i) => {
      const a1 = a0 + (Math.abs(v) / total) * Math.PI * 2
      at = ink(s, slice(r, 210, 130, 110, a0, a1), at, COLOURS[i % 5], 110)
      const mid = (a0 + a1) / 2
      label(s, 210 + Math.cos(mid) * 72, 130 + Math.sin(mid) * 72, `${Math.round((Math.abs(v) / total) * 100)}%`, at, 'small')
      label(s, 480, 40 + i * 30, `${names[i] ?? ''} ${v}`, at, `legend ${COLOURS[i % 5]}`)
      a0 = a1
    })
  } else {
    const top = 24
    const base = h - 34
    const left = 40
    const max = Math.max(...nums, 0) || 1
    const min = Math.min(...nums, 0)
    const y = (v: number) => base - ((v - min) / (max - min || 1)) * (base - top)
    at = ink(s, [line(r, left, top - 8, left, base), line(r, left, y(0), w - 10, y(0))], at, '', 150)
    const band = (w - left - 20) / nums.length
    const cx = (i: number) => left + band * (i + 0.5)
    if (item.kind === 'line') {
      nums.forEach((v, i) => {
        if (i) at = ink(s, [line(r, cx(i - 1), y(nums[i - 1]), cx(i), y(v))], at, 'hot', 190)
        ink(s, [ellipse(r, cx(i), y(v), 4, 4)], at, 'hot', 60)
        label(s, cx(i), y(v) - 16, String(v), at, 'small')
      })
    } else {
      nums.forEach((v, i) => {
        const bw = Math.min(70, band * 0.62)
        const x = cx(i) - bw / 2
        const yv = Math.min(y(v), y(0))
        const bh = Math.max(2, Math.abs(y(v) - y(0)))
        ink(s, hachure(r, x, yv, bw, bh, 8), at, `shade ${COLOURS[i % 5]}`, 24)
        at = ink(s, rect(r, x, yv, bw, bh), at, COLOURS[i % 5], 90)
        label(s, cx(i), yv - 13, String(v), at, 'small')
      })
    }
    names.slice(0, nums.length).forEach((n, i) => label(s, cx(i), h - 14, n.slice(0, 12), at, 'small'))
  }
  root.append(s)
  return at
}

function drawQuiz(root: HTMLElement, item: BoardItem, start: number) {
  root.classList.add('quiz')
  const q = el('p')
  root.append(q)
  const at = writeWords(q, item.text!, start)
  item.values!.forEach((opt, i) => {
    const b = el('button', 'option', opt)
    b.type = 'button'
    b.style.setProperty('--d', `${at + i * 120}ms`)
    b.onclick = () => {
      const right = i === item.answer
      for (const other of root.querySelectorAll('button')) other.disabled = true
      b.classList.add(right ? 'right' : 'wrong')
      if (!right) root.querySelectorAll('button')[item.answer!].classList.add('right')
      bridge.sendCommand({ type: 'board-ask', text: `Quiz "${item.text}": I picked "${opt}". That is ${right ? 'right' : `wrong, the answer is "${item.values![item.answer!]}"`}.` })
    }
    root.append(b)
  })
  return at
}

/** A heading, written, then underlined in chalk. */
function drawHeading(root: HTMLElement, text: string, seed: string, at: number) {
  const h = el('h3', 'heading')
  root.append(h)
  const end = writeWords(h, text, at)
  const w = Math.max(40, h.offsetWidth)
  const u = svgEl(w, 8)
  u.style.width = `${w}px`
  u.style.height = '8px'
  const stop = ink(u, [line(rng(seed), 0, 4, w, 4)], end, 'hot', 150)
  root.append(u)
  return stop
}

function fill(root: HTMLElement, item: BoardItem, before: BoardItem | undefined, start: number) {
  root.replaceChildren()
  root.classList.remove('quiz')
  const at = item.heading ? drawHeading(root, item.heading, item.id, start) + 100 : start
  switch (item.type) {
    case 'heading': return drawHeading(root, item.text!, item.id, at)
    case 'text': { const p = el('p'); root.append(p); return writeWords(p, item.text!, inlineIcon(p, item.icons?.[0], at)) }
    case 'note': {
      const p = el('p', 'note-text')
      root.append(p)
      const end = writeWords(p, item.text!, inlineIcon(p, item.icons?.[0], at + 400))
      // Measured after the words are in, so the frame is drawn at its real size and its strokes aren't stretched.
      const w = root.offsetWidth
      const h = root.offsetHeight
      const frame = svgEl(w, h)
      frame.setAttribute('class', 'frame')
      const r = rng(item.id)
      ink(frame, rect(r, 2, 2, w - 4, h - 4), at, COLOURS[Math.floor(r() * COLOURS.length)], 90)
      root.prepend(frame)
      return end
    }
    case 'code': {
      const pre = el('pre')
      root.append(pre)
      item.text!.split('\n').forEach((l, i) => {
        const s = el('span', 'code-line', l || ' ')
        s.style.setProperty('--d', `${at + i * 750}ms`)
        pre.append(s)
      })
      return at + item.text!.split('\n').length * 750
    }
    case 'list': {
      const ul = el('ul')
      root.append(ul)
      let t = at
      item.values!.forEach((v, i) => {
        const li = el('li')
        if (item.icons?.[i] && icon(rng(''), item.icons[i], 0, 0, 1)) t = inlineIcon(li, item.icons[i], t, COLOURS[i % COLOURS.length])
        else {
          const tick = svgEl(20, 20)
          ink(tick, [line(rng(`${item.id}${i}`), 3, 11, 8, 17), line(rng(`${item.id}${i}b`), 8, 17, 18, 3)], t, 'hot', 70)
          li.append(tick)
        }
        t = writeWords(li.appendChild(el('span')), v, t + 150)
        ul.append(li)
      })
      return t
    }
    case 'var': {
      const v = el('div', 'var')
      const s = svgEl(150, 54, `${item.name} = ${item.value}`)
      const changed = before && before.value !== item.value
      ink(s, rect(rng(item.id), 3, 3, 144, 48), before && !changed ? ALREADY_THERE : at, changed ? 'hot' : '', 80)
      label(s, 75, 27, (item.value ?? '').slice(0, 14), at + 200, 'strong')
      v.append(el('span', '', item.name), s)
      root.append(v)
      return at + 500
    }
    case 'array': return drawArray(root, item, before, at)
    case 'graph': return drawGraph(root, item, at)
    case 'chart': return drawChart(root, item, at)
    case 'quiz': return drawQuiz(root, item, at)
  }
}

/** A chalk circle, underline or box scribbled over the whole item. */
function drawMark(root: HTMLElement, item: BoardItem, at: number) {
  root.querySelector(':scope > .mark')?.remove()
  if (!item.mark) return at
  const w = root.offsetWidth || 400
  const h = root.offsetHeight || 60
  const s = svgEl(w, h)
  s.setAttribute('class', 'mark')
  const r = rng(`${item.id}${item.mark}`)
  const strokes = item.mark === 'circle' ? [ellipse(r, w / 2, h / 2, w / 2 + 10, h / 2 + 9)]
    : item.mark === 'box' ? rect(r, -6, -6, w + 12, h + 12)
    : [line(r, 0, h + 5, w, h + 3), line(r, w * 0.02, h + 11, w * 0.9, h + 9)]
  root.append(s)
  return ink(s, strokes, at, 'hot', item.mark === 'circle' ? 520 : 240)
}

const sameExceptMark = (a: BoardItem, b: BoardItem) => JSON.stringify({ ...a, mark: 0 }) === JSON.stringify({ ...b, mark: 0 })

/** Only what changed is touched, so a redraw with the same id animates just that part. */
function render(state: BoardState) {
  document.getElementById('title')!.textContent = [state.owner && `${state.owner}'s board`, state.title].filter(Boolean).join(' · ') || 'Blackboard'
  const keep = new Set(state.items.map((i) => i.id))
  for (const [id, s] of shown) {
    if (keep.has(id)) continue
    // Wiped off with a duster rather than vanishing.
    s.el.classList.add('wipe')
    window.setTimeout(() => s.el.remove(), 280)
    shown.delete(id)
  }
  let at = 0
  let last: HTMLElement | null = null
  for (const item of state.items) {
    const old = shown.get(item.id)
    if (old) {
      const same = JSON.stringify(old.item) === JSON.stringify(item)
      if (same) continue
      // A circle added around something doesn't redraw the thing itself.
      if (!sameExceptMark(old.item, item)) at = fill(old.el, item, old.item, at)
      at = drawMark(old.el, item, at)
      old.item = item
      last = old.el
      continue
    }
    const root = el('section', 'item')
    root.dataset.type = item.type
    board.append(root)
    at = fill(root, item, undefined, at)
    at = drawMark(root, item, at)
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
