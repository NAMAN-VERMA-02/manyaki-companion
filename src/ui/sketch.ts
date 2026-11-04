// Hand-drawn strokes for the blackboard, as SVG path strings. Seeded, so redrawing an item keeps the same
// wobble instead of shivering. No DOM here, so it is unit-tested directly.

export function rng(seed: string) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return () => {
    h = (h + 0x6d2b79f5) | 0
    let t = Math.imul(h ^ (h >>> 15), 1 | h)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export type Rng = ReturnType<typeof rng>

const n = (v: number) => +v.toFixed(1)
const off = (r: Rng, a: number) => (r() - 0.5) * 2 * a

/** One slightly bowed stroke, overshooting its ends a touch the way a hand does. */
export function line(r: Rng, x1: number, y1: number, x2: number, y2: number): string {
  const len = Math.hypot(x2 - x1, y2 - y1)
  const bow = Math.min(4, Math.max(1, len * 0.02))
  return `M${n(x1 + off(r, 1.2))} ${n(y1 + off(r, 1.2))}Q${n((x1 + x2) / 2 + off(r, bow))} ${n((y1 + y2) / 2 + off(r, bow))} ${n(x2 + off(r, 1.2))} ${n(y2 + off(r, 1.2))}`
}

/** Four separate strokes, so they can be drawn one after another. */
export function rect(r: Rng, x: number, y: number, w: number, h: number): string[] {
  return [line(r, x, y, x + w, y), line(r, x + w, y, x + w, y + h), line(r, x + w, y + h, x, y + h), line(r, x, y + h, x, y)]
}

/** A circle drawn in one go that overshoots where it started, like circling something on a board. */
export function ellipse(r: Rng, cx: number, cy: number, rx: number, ry: number, turns = 1.08): string {
  const steps = 26
  const start = r() * Math.PI * 2
  const pts = Array.from({ length: steps + 1 }, (_, i) => {
    const a = start + (i / steps) * Math.PI * 2 * turns
    const wobble = 1 + off(r, 0.02)
    return { x: cx + Math.cos(a) * rx * wobble, y: cy + Math.sin(a) * ry * wobble }
  })
  // Curving through the midpoints keeps it round even when it's stretched around something wide.
  let d = `M${n(pts[0].x)} ${n(pts[0].y)}`
  for (let i = 1; i < pts.length - 1; i++) d += `Q${n(pts[i].x)} ${n(pts[i].y)} ${n((pts[i].x + pts[i + 1].x) / 2)} ${n((pts[i].y + pts[i + 1].y) / 2)}`
  return d
}

/** Slanted scribble filling a box: how a bar or highlighted cell gets shaded in. */
export function hachure(r: Rng, x: number, y: number, w: number, h: number, gap = 9): string[] {
  const out: string[] = []
  // 45° strokes: each starts on the left then bottom edge and ends on the top then right edge.
  for (let o = gap; o < w + h; o += gap) {
    const x0 = o <= h ? x : x + o - h
    const y0 = o <= h ? y + o : y + h
    const x1 = o <= w ? x + o : x + w
    const y1 = o <= w ? y : y + o - w
    out.push(line(r, x0, y0, x1, y1))
  }
  return out
}

/** The two short strokes of an arrow tip at (x2, y2), pointing away from (x1, y1). */
export function arrowHead(r: Rng, x1: number, y1: number, x2: number, y2: number, size = 12): string[] {
  const a = Math.atan2(y2 - y1, x2 - x1)
  return [0.5, -0.5].map((s) => line(r, x2, y2, x2 - Math.cos(a + s) * size, y2 - Math.sin(a + s) * size))
}

/** The outline of a pie slice. Angles in radians. */
export function slice(r: Rng, cx: number, cy: number, radius: number, a0: number, a1: number): string[] {
  const steps = Math.max(3, Math.ceil((a1 - a0) / 0.3))
  let arc = ''
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps
    const w = radius * (1 + off(r, 0.012))
    arc += `${i ? 'L' : 'M'}${n(cx + Math.cos(a) * w)} ${n(cy + Math.sin(a) * w)}`
  }
  return [line(r, cx, cy, cx + Math.cos(a0) * radius, cy + Math.sin(a0) * radius), arc, line(r, cx + Math.cos(a1) * radius, cy + Math.sin(a1) * radius, cx, cy)]
}

// Chalk icons on a 24x24 grid: 4 numbers are a line, 3 a circle (x, y, r), 5 an ellipse (x, y, rx, ry, 0).
const BOX = (x1: number, y1: number, x2: number, y2: number) => [[x1, y1, x2, y1], [x2, y1, x2, y2], [x2, y2, x1, y2], [x1, y2, x1, y1]]
export const ICONS: Record<string, number[][]> = {
  pc: [...BOX(3, 4, 21, 15), [12, 15, 12, 19], [7, 20, 17, 20]],
  phone: [...BOX(7, 2, 17, 22), [11, 19, 13, 19]],
  server: [...BOX(4, 3, 20, 11), ...BOX(4, 13, 20, 21), [7, 7, 1], [7, 17, 1]],
  router: [...BOX(3, 14, 21, 20), [7, 14, 5, 6], [17, 14, 19, 6], [8, 17, 1], [12, 17, 1]],
  globe: [[12, 12, 9], [3, 12, 21, 12], [12, 12, 4, 9, 0]],
  cloud: [[8, 14, 4], [14, 10, 5], [18, 15, 3], [6, 18, 19, 18]],
  database: [[12, 5, 8, 3, 0], [4, 5, 4, 19], [20, 5, 20, 19], [12, 19, 8, 3, 0], [12, 12, 8, 3, 0]],
  file: [[6, 2, 15, 2], [15, 2, 19, 7], [19, 7, 19, 22], [19, 22, 6, 22], [6, 22, 6, 2], [15, 2, 15, 7], [15, 7, 19, 7], [9, 12, 16, 12], [9, 16, 16, 16]],
  folder: [[3, 6, 3, 20], [3, 20, 21, 20], [21, 20, 21, 9], [21, 9, 11, 9], [11, 9, 9, 6], [9, 6, 3, 6]],
  lock: [...BOX(5, 11, 19, 21), [12, 7, 4, 5, 0], [12, 16, 1]],
  key: [[7, 12, 4], [11, 12, 21, 12], [18, 12, 18, 16], [21, 12, 21, 15]],
  user: [[12, 7, 4], [4, 21, 7, 15], [7, 15, 17, 15], [17, 15, 20, 21]],
  gear: [[12, 12, 4], [12, 12, 8], [12, 1, 12, 4], [12, 20, 12, 23], [1, 12, 4, 12], [20, 12, 23, 12], [4, 4, 6, 6], [18, 18, 20, 20], [4, 20, 6, 18], [18, 6, 20, 4]],
  code: [[8, 7, 3, 12], [3, 12, 8, 17], [16, 7, 21, 12], [21, 12, 16, 17], [14, 5, 10, 19]],
  bulb: [[12, 9, 6], [9, 15, 9, 19], [15, 15, 15, 19], [9, 19, 15, 19], [10, 22, 14, 22]],
  book: [[12, 5, 3, 3], [3, 3, 3, 19], [3, 19, 12, 21], [12, 21, 21, 19], [21, 19, 21, 3], [21, 3, 12, 5], [12, 5, 12, 21]],
  box: [[3, 8, 12, 3], [12, 3, 21, 8], [21, 8, 21, 17], [21, 17, 12, 22], [12, 22, 3, 17], [3, 17, 3, 8], [3, 8, 12, 13], [12, 13, 21, 8], [12, 13, 12, 22]],
  clock: [[12, 12, 9], [12, 12, 12, 6], [12, 12, 16, 14]],
  check: [[4, 13, 10, 19], [10, 19, 20, 5]],
  cross: [[5, 5, 19, 19], [19, 5, 5, 19]],
  star: [[12, 2, 15, 9], [15, 9, 22, 9], [22, 9, 16, 14], [16, 14, 18, 21], [18, 21, 12, 17], [12, 17, 6, 21], [6, 21, 8, 14], [8, 14, 2, 9], [2, 9, 9, 9], [9, 9, 12, 2]],
  mail: [...BOX(3, 6, 21, 18), [3, 6, 12, 13], [12, 13, 21, 6]],
  search: [[10, 10, 6], [15, 15, 21, 21]]
}

/** The strokes of a chalk icon centred at (cx, cy), or null if she doesn't know that one. */
export function icon(r: Rng, name: string, cx: number, cy: number, size: number): string[] | null {
  // The name comes from the model: "constructor" must not find something on the object itself.
  if (!Object.hasOwn(ICONS, name)) return null
  const parts = ICONS[name]
  const k = size / 24
  const X = (v: number) => cx + (v - 12) * k
  const Y = (v: number) => cy + (v - 12) * k
  return parts.map((p) => (p.length === 4 ? line(r, X(p[0]), Y(p[1]), X(p[2]), Y(p[3]))
    : p.length === 3 ? ellipse(r, X(p[0]), Y(p[1]), p[2] * k, p[2] * k, 1.02)
    : ellipse(r, X(p[0]), Y(p[1]), p[2] * k, p[3] * k, 1.02)))
}
