import type { Fact } from './types'

// Her memory is a list of short bullets on this PC. Nothing is sent to the brain by default: when a
// question depends on the past she searches the bullets (BM25 over words, with light stemming, plus a
// small boost for recent and often-useful bullets) and only the few that match are used. Pure (tested).

const STOP = new Set('a an the is are was were be been am i me my mine you your he she they them their it its we our of to in on at for with and or but not no do does did have has had this that these those what when where who why how which there here so if then than as by from about up down out over just very really can could would should will shall may might must hai hain tha thi ka ki ke ko se me mein aur ya kya'.split(' '))

export function tokens(s: string): string[] {
  return s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem)
}

/** Very light English stemming: enough that "exams" finds "exam" and "coding" finds "code". */
function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3).replace(/(.)\1$/, '$1')
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

// A few everyday synonyms so a question in other words still finds the bullet.
const SYN: Record<string, string[]> = {
  exam: ['test', 'paper', 'quiz', 'viva'], test: ['exam'], birthday: ['bday', 'born'], mom: ['mother', 'maa', 'mummy'],
  dad: ['father', 'papa'], friend: ['dost', 'buddy'], like: ['love', 'favourite', 'favorite', 'enjoy'], job: ['work', 'internship', 'placement'],
  code: ['program', 'develop', 'dev'], college: ['university', 'kiet', 'campus'], sleep: ['bed', 'night'], food: ['eat', 'dish']
}

function expand(q: string[]): string[] {
  const out = new Set(q)
  for (const w of q) {
    for (const s of SYN[w] ?? []) out.add(stem(s))
    for (const [k, vs] of Object.entries(SYN)) if (vs.map(stem).includes(w)) out.add(k)
  }
  return [...out]
}

export interface Hit { fact: Fact; score: number; index: number }

/** The bullets most relevant to `query` (best first), empty when nothing really matches. */
export function search(facts: Fact[], query: string, k = 5, now = Date.now()): Hit[] {
  const q = expand(tokens(query))
  if (!q.length || !facts.length) return []
  const docs = facts.map((f) => tokens(f.text))
  const N = docs.length
  const avg = docs.reduce((a, d) => a + d.length, 0) / N || 1
  const df = new Map<string, number>()
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1)
  const k1 = 1.4
  const b = 0.7
  const hits: Hit[] = []
  docs.forEach((d, i) => {
    let s = 0
    for (const w of q) {
      const tf = d.filter((x) => x === w).length
      if (!tf) continue
      const idf = Math.log(1 + (N - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5))
      s += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avg)))
    }
    if (s <= 0) return
    const f = facts[i]
    const ageDays = Math.max(0, (now - f.at) / 86400000)
    s *= 1 + 0.25 * Math.exp(-ageDays / 30) + 0.05 * Math.min(10, f.uses ?? 0)
    hits.push({ fact: f, score: s, index: i })
  })
  hits.sort((x, y) => y.score - x.score)
  // Drop weak tails: anything far below the best match is probably noise.
  const top = hits[0]?.score ?? 0
  return hits.filter((h) => h.score >= top * 0.35).slice(0, k)
}

/** Bullets as she'd read them back: "• text (noted 3 days ago)". */
export function asBullets(hits: Hit[], now = Date.now()): string {
  return hits.map((h) => `• ${h.fact.text} (${ago(now - h.fact.at)})`).join('\n')
}

function ago(ms: number): string {
  const d = Math.floor(ms / 86400000)
  return d <= 0 ? 'noted today' : d === 1 ? 'noted yesterday' : d < 30 ? `noted ${d} days ago` : `noted ${Math.round(d / 30)} month(s) ago`
}

/** Marks bullets as used (they rank a little higher next time). */
export function touch(facts: Fact[], hits: Hit[]): Fact[] {
  const used = new Set(hits.map((h) => h.index))
  return facts.map((f, i) => (used.has(i) ? { ...f, uses: (f.uses ?? 0) + 1 } : f))
}

/** Is the user asking about her memory ("do you remember…", "what did I tell you about…")? */
export function isRecallQuestion(t: string): boolean {
  return /\b(do you remember|you remember|remember (what|when|my|the)|what did i (tell|say)|did i (tell|mention)|what('s| is) my|when('s| is) my|who('s| is) my|what do you know about|yaad hai|yaad h|kya bataya tha|maine kya bola)\b/i.test(t)
}
