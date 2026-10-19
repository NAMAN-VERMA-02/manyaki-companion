import type { Box } from './protocol'

// The evaluation maths for the benchmark page and tests: precision/recall for detection, box matching,
// and pixel-level precision/recall for redaction (how much of what we blacked out was actually private,
// and how much of what was private we covered).

export interface PRF { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number }

export function prf(tp: number, fp: number, fn: number): PRF {
  const precision = tp + fp ? tp / (tp + fp) : 1
  const recall = tp + fn ? tp / (tp + fn) : 1
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
  return { tp, fp, fn, precision, recall, f1 }
}

export const area = (b: Box) => Math.max(0, b.w) * Math.max(0, b.h)

export function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const r = Math.min(a.x + a.w, b.x + b.w)
  const btm = Math.min(a.y + a.h, b.y + b.h)
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null
}

export function iou(a: Box, b: Box): number {
  const i = intersect(a, b)
  if (!i) return 0
  const ia = area(i)
  return ia / (area(a) + area(b) - ia)
}

/**
 * Greedy one-to-one matching of predicted boxes to truth boxes. A truth box counts as found when a
 * prediction overlaps it with IoU >= thr, or covers most of it (redaction boxes are often a bit larger).
 */
export function matchBoxes(pred: Box[], truth: Box[], thr = 0.3): PRF {
  const used = new Set<number>()
  let tp = 0
  for (const t of truth) {
    let best = -1
    let bestScore = 0
    pred.forEach((p, i) => {
      if (used.has(i)) return
      const inter = intersect(p, t)
      const cover = inter ? area(inter) / Math.max(1, area(t)) : 0
      const score = Math.max(iou(p, t), cover >= 0.7 ? thr + cover * 0.01 : 0)
      if (score >= thr && score > bestScore) { best = i; bestScore = score }
    })
    if (best >= 0) { used.add(best); tp++ }
  }
  return prf(tp, pred.length - used.size, truth.length - tp)
}

/**
 * Pixel precision/recall of a redaction mask against the true private regions, by rasterising both on a
 * grid of `cell` px (fast and exact enough for UI-sized boxes).
 */
export function pixelScores(pred: Box[], truth: Box[], cell = 2): { precision: number; recall: number; f1: number; redactedPx: number; privatePx: number } {
  const all = [...pred, ...truth]
  if (!all.length) return { precision: 1, recall: 1, f1: 1, redactedPx: 0, privatePx: 0 }
  const minX = Math.floor(Math.min(...all.map((b) => b.x)))
  const minY = Math.floor(Math.min(...all.map((b) => b.y)))
  const maxX = Math.ceil(Math.max(...all.map((b) => b.x + b.w)))
  const maxY = Math.ceil(Math.max(...all.map((b) => b.y + b.h)))
  const W = Math.max(1, Math.ceil((maxX - minX) / cell))
  const H = Math.max(1, Math.ceil((maxY - minY) / cell))
  const paint = (boxes: Box[]) => {
    const g = new Uint8Array(W * H)
    for (const b of boxes) {
      const x0 = Math.max(0, Math.floor((b.x - minX) / cell))
      const y0 = Math.max(0, Math.floor((b.y - minY) / cell))
      const x1 = Math.min(W, Math.ceil((b.x + b.w - minX) / cell))
      const y1 = Math.min(H, Math.ceil((b.y + b.h - minY) / cell))
      for (let y = y0; y < y1; y++) g.fill(1, y * W + x0, y * W + x1)
    }
    return g
  }
  const p = paint(pred)
  const t = paint(truth)
  let pn = 0, tn = 0, both = 0
  for (let i = 0; i < p.length; i++) { pn += p[i]; tn += t[i]; both += p[i] & t[i] }
  const precision = pn ? both / pn : 1
  const recall = tn ? both / tn : 1
  return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0, redactedPx: pn * cell * cell, privatePx: tn * cell * cell }
}

/** Running latency statistics for one pipeline stage. */
export class Timer {
  private samples: number[] = []
  add(ms: number) { this.samples.push(ms); if (this.samples.length > 500) this.samples.shift() }
  get count() { return this.samples.length }
  pct(p: number) {
    if (!this.samples.length) return 0
    const s = [...this.samples].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
  }
  get mean() { return this.samples.length ? this.samples.reduce((a, b) => a + b, 0) / this.samples.length : 0 }
}
