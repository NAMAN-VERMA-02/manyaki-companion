import { TOKEN_RE, tokenFor, type PIIType } from './protocol'
import { findPII, replaceSpans, type Span } from './pii'

/**
 * Lives only in the client. Maps each private value to a stable token ([[EMAIL_1]]) for one task, so the
 * server can say "type [[EMAIL_1]] into e7" without ever seeing the address; `rehydrate` puts the real
 * value back right before the client types it.
 */
export class Vault {
  private byValue = new Map<string, string>()
  private byToken = new Map<string, { value: string; type: PIIType }>()
  private counts = new Map<PIIType, number>()

  token(type: PIIType, value: string): string {
    const key = `${type}\u0000${value.trim()}`
    const hit = this.byValue.get(key)
    if (hit) return hit
    const n = (this.counts.get(type) ?? 0) + 1
    this.counts.set(type, n)
    const t = tokenFor(type, n)
    this.byValue.set(key, t)
    this.byToken.set(t, { value, type })
    return t
  }

  /** Text with every detected span replaced by its token. Returns the spans too (for on-screen boxes). */
  tokenize(text: string, spans: Span[] = findPII(text)): { text: string; spans: Span[]; tokens: string[] } {
    const tokens: string[] = []
    const out = replaceSpans(text, spans, (s, v) => { const t = this.token(s.type, v); tokens.push(t); return t })
    return { text: out, spans, tokens }
  }

  /** Real values back in place of known tokens. Unknown tokens are left as they are. */
  rehydrate(text: string): string {
    return text.replace(TOKEN_RE, (m) => this.byToken.get(m)?.value ?? m)
  }

  has(token: string): boolean { return this.byToken.has(token) }
  typeOf(token: string): PIIType | undefined { return this.byToken.get(token)?.type }
  get size(): number { return this.byToken.size }
  clear(): void { this.byValue.clear(); this.byToken.clear(); this.counts.clear() }
}
