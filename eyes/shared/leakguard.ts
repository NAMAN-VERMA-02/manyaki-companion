import { TOKEN_RE } from './protocol'
import { findPII, replaceSpans } from './pii'

// Last line of defence, run on the exact object about to be sent (client) or just received (server).
// Every string field is scanned again with the text detectors; anything that still looks private is
// masked and counted. A count above zero means an earlier stage missed something: the client shows it
// in its metrics, and the server refuses to forward such a request to the model.

export interface LeakFinding { path: string; type: string }

/** Fields that are allowed to contain non-text data and are not scanned (the image is already pixels). */
const SKIP = new Set(['image', 'scheme'])

export function scrubPayload<T>(payload: T): { clean: T; findings: LeakFinding[] } {
  const findings: LeakFinding[] = []
  const walk = (v: unknown, path: string): unknown => {
    if (typeof v === 'string') {
      // Tokens look like nothing private, but strip them before scanning so their digits can't match.
      const probe = v.replace(TOKEN_RE, (m) => ' '.repeat(m.length))
      const spans = findPII(probe).filter((s) => s.confidence >= 0.7)
      if (!spans.length) return v
      for (const s of spans) findings.push({ path, type: s.type })
      return replaceSpans(v, spans, (s) => `[[${s.type}_LEAK]]`)
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`))
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) out[k] = SKIP.has(k) ? x : walk(x, path ? `${path}.${k}` : k)
      return out
    }
    return v
  }
  return { clean: walk(payload, '') as T, findings }
}
