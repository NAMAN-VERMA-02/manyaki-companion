import type { PIIType } from './protocol'

// Sensitive-data detection for text and form fields. Pure (no DOM), so it runs in the content script,
// the server's leak guard and unit tests alike.
//
// Text detection returns exact character spans so the client can redact precisely the "a@b.com" inside a
// sentence (and only that) on screen. Patterns are validated where a checksum exists (Luhn for cards,
// Verhoeff for Aadhaar) to keep false positives down; context words ("Name:", "DOB") catch what has no
// fixed shape.

export interface Span { start: number; end: number; type: PIIType; source: 'regex' | 'context'; confidence: number }

function luhn(d: string): boolean {
  let sum = 0
  let alt = false
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48
    if (alt) { n *= 2; if (n > 9) n -= 9 }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

// Verhoeff checksum (used by Aadhaar numbers).
const VD = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]]
const VP = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]]
export function verhoeff(d: string): boolean {
  let c = 0
  const r = d.split('').reverse()
  for (let i = 0; i < r.length; i++) c = VD[c][VP[i % 8][Number(r[i])]]
  return c === 0
}

interface Rule { type: PIIType; re: RegExp; check?: (m: string, text: string, at: number) => boolean; confidence?: number }

const UPI_HANDLES = 'ok(?:sbi|hdfcbank|icici|axis)|ybl|ibl|axl|apl|paytm|upi|okaxis|oksbi|okicici|okhdfcbank|freecharge|airtel|jio|waicici|wahdfcbank|yapl|abfspay|pingpay'

// Order matters only for ties; overlaps are resolved by confidence, then length.
const RULES: Rule[] = [
  { type: 'SECRET', re: /\b(?:AIza[0-9A-Za-z_-]{30,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, confidence: 0.98 },
  { type: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g, confidence: 0.97 },
  { type: 'UPI', re: new RegExp(String.raw`\b[A-Za-z0-9._-]{2,}@(?:${UPI_HANDLES})\b`, 'gi'), confidence: 0.9 },
  { type: 'CARD', re: /\b(?:\d[ -]?){12,18}\d\b/g, check: (m) => { const d = m.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d) }, confidence: 0.95 },
  { type: 'AADHAAR', re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g, check: (m) => verhoeff(m.replace(/\D/g, '')), confidence: 0.92 },
  { type: 'PAN', re: /\b[A-Z]{3}[PCHABGJLFT][A-Z]\d{4}[A-Z]\b/g, confidence: 0.93 },
  { type: 'IFSC', re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, confidence: 0.85 },
  { type: 'PASSPORT', re: /\b[A-PR-WY][1-9]\d\s?\d{4}[1-9]\b/g, confidence: 0.6 },
  { type: 'SSN', re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g, confidence: 0.9 },
  { type: 'PHONE', re: /(?:\+91[\s-]?|\b0)?\b[6-9]\d{4}[\s-]?\d{5}\b/g, confidence: 0.85 },
  { type: 'PHONE', re: /\+\d{1,3}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g, confidence: 0.8 },
  { type: 'PHONE', re: /\(\d{3}\)\s?\d{3}-\d{4}\b/g, confidence: 0.8 },
  // Not version strings: after "v", another dot-number (1.2.3.4.5) or a word like "version"/"build".
  { type: 'IP', re: /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w]|\.\d)/g, check: (_m, t, at) => !/\b(version|ver|build|firmware|release|batch|model|sku|v)\.?\s*$/i.test(t.slice(Math.max(0, at - 14), at)), confidence: 0.8 },
  // A bare date is usually just a date (orders, posts); dates of birth are caught by context below.
]

// Capitalised words that follow "by"/"from" but aren't people.
const NOT_PEOPLE = /^(Admin|Administrator|Team|Support|Staff|Desk|Bot|System|Campus|Store|Shop|Official|Moderator|Moderators|Google|Amazon|Microsoft|Apple|Customer|Service|The|Our|Your|Anonymous|Unknown|Guest)$/

// Context words: the value that follows "Name:", "DOB", "Address" etc.
const CONTEXT: { type: PIIType; re: RegExp; confidence: number; check?: (v: string) => boolean }[] = [
  // Label words in any case; the value must look like a capitalised name (on one line).
  { type: 'NAME', re: /\b(?:[Ff]ull [Nn]ame|[Nn]ame|NAME|[Aa]ccount [Hh]older|[Cc]ard ?[Hh]older|[Pp]atient|[Ss]tudent [Nn]ame|[Ff]ather'?s [Nn]ame|[Mm]other'?s [Nn]ame|[Bb]eneficiary|[Nn]aam)\s*[:\-–]\s*((?:[A-Z][a-zA-Z'.-]+)(?:[ \t]+[A-Z][a-zA-Z'.-]+){0,3})/g, confidence: 0.8 },
  { type: 'NAME', re: /\b(?:Mr|Mrs|Ms|Miss|Dr|Shri|Smt|Kumari)\.?\s+((?:[A-Z][a-zA-Z'-]+)(?:\s+[A-Z][a-zA-Z'-]+){0,2})/g, confidence: 0.75 },
  // "Posted by Meera Krishnan", "Signed in as Asha Verma", "Hi Rahul Mehta": two or more capitalised words.
  {
    type: 'NAME',
    re: /\b(?:[Pp]osted by|[Ww]ritten by|[Ss]hared by|[Ss]ent by|[Ff]rom|[Bb]y|[Ss]igned in as|[Ll]ogged in as|[Ww]elcome back,?|[Hh]i,?|[Hh]ello,?|[Dd]ear|[Cc]ontact person:?|[Aa]uthor:?)\s+((?:[A-Z][a-z'-]+)(?:[ \t]+[A-Z][a-z'-]+){1,2})\b/g,
    confidence: 0.7,
    check: (v) => !v.split(/\s+/).some((w) => NOT_PEOPLE.test(w))
  },
  { type: 'DOB', re: /\b(?:dob|d\.o\.b\.?|date of birth|born on|birthday|janm tithi)\s*[:\-–]?\s*([0-9]{1,2}[\s/.-](?:[0-9]{1,2}|[A-Za-z]{3,9})[\s/.,-]*[0-9]{2,4})/gi, confidence: 0.9 },
  { type: 'ADDRESS', re: /\b(?:address|addr|residence|lives at|pata)\s*[:\-–]\s*([^\n]{6,120}?)(?=\s*(?:\n|$|\||;|\b(?:phone|email|mobile|pin)\b))/gi, confidence: 0.75 },
  { type: 'PINCODE', re: /\b(?:pin ?code|pincode|postal code|zip(?: code)?)\s*[:\-–]?\s*(\d{6}|\d{5}(?:-\d{4})?)\b/gi, confidence: 0.85 },
  { type: 'OTP', re: /\b(?:otp|one[- ]time (?:password|code)|verification code|security code|passcode)\D{0,20}?(\d{4,8})\b/gi, confidence: 0.92 },
  { type: 'CVV', re: /\b(?:cvv|cvc|cvv2|card verification)\s*[:\-–]?\s*(\d{3,4})\b/gi, confidence: 0.92 },
  { type: 'PASSWORD', re: /\b(?:password|passwd|pwd|pin)\s*(?:is|=|:|-)\s*("[^"]+"|'[^']+'|\S+)/gi, confidence: 0.9 },
  // Natural language: "…and password Tr0ub4dor&3". Only values that look like a secret (digits, symbols
  // or mixed case), so "enter your password below" stays untouched.
  {
    type: 'PASSWORD',
    re: /\b(?:[Pp]assword|[Pp]asswd|[Pp]wd|[Pp]asscode)\s+((?=\S*[\d\W_]|\S*[a-z]\S*[A-Z]|\S*[A-Z]\S*[a-z])\S{4,64})/g,
    confidence: 0.85,
    check: (v) => !/^(is|was|for|to|and|or|the|field|below|here|again|reset)$/i.test(v) && !/^\[\[/.test(v)
  },
  { type: 'BANK_ACCOUNT', re: /\b(?:a\/c|acct|account)\s*(?:no\.?|number|#)?\s*[:\-–]?\s*(\d{9,18})\b/gi, confidence: 0.9 }
]

/** All sensitive spans in `text`, non-overlapping, sorted by position. */
export function findPII(text: string): Span[] {
  if (!text) return []
  const found: Span[] = []
  for (const r of RULES) {
    r.re.lastIndex = 0
    for (let m = r.re.exec(text); m; m = r.re.exec(text)) {
      if (m[0].length === 0) { r.re.lastIndex++; continue }
      if (r.check && !r.check(m[0], text, m.index)) continue
      found.push({ start: m.index, end: m.index + m[0].length, type: r.type, source: 'regex', confidence: r.confidence ?? 0.8 })
    }
  }
  for (const c of CONTEXT) {
    c.re.lastIndex = 0
    for (let m = c.re.exec(text); m; m = c.re.exec(text)) {
      const value = c.type === 'PASSWORD' ? m[1] : m[1]?.replace(/[.,;!?)]+$/, '')
      if (!value || (c.check && !c.check(value))) continue
      const start = m.index + m[0].lastIndexOf(value)
      found.push({ start, end: start + value.length, type: c.type, source: 'context', confidence: c.confidence })
    }
  }
  return resolveOverlaps(found)
}

/** Keeps the most confident (then longest) span wherever spans overlap. */
export function resolveOverlaps(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => b.confidence - a.confidence || (b.end - b.start) - (a.end - a.start) || a.start - b.start)
  const kept: Span[] = []
  for (const s of sorted) if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s)
  return kept.sort((a, b) => a.start - b.start)
}

/** Attributes of a form field, as the content script reads them. */
export interface FieldInfo {
  tag: string
  type?: string
  name?: string
  id?: string
  autocomplete?: string
  placeholder?: string
  label?: string
  ariaLabel?: string
  inputMode?: string
}

const AUTOCOMPLETE: Record<string, PIIType> = {
  'current-password': 'PASSWORD', 'new-password': 'PASSWORD', 'one-time-code': 'OTP',
  'cc-number': 'CARD', 'cc-csc': 'CVV', 'cc-exp': 'CARD', 'cc-exp-month': 'CARD', 'cc-exp-year': 'CARD', 'cc-name': 'NAME',
  email: 'EMAIL', tel: 'PHONE', 'tel-national': 'PHONE', 'tel-local': 'PHONE',
  name: 'NAME', 'given-name': 'NAME', 'family-name': 'NAME', 'additional-name': 'NAME', nickname: 'NAME',
  'street-address': 'ADDRESS', 'address-line1': 'ADDRESS', 'address-line2': 'ADDRESS', 'address-line3': 'ADDRESS',
  'postal-code': 'PINCODE', bday: 'DOB', 'bday-day': 'DOB', 'bday-month': 'DOB', 'bday-year': 'DOB'
}

const FIELD_HINTS: [RegExp, PIIType][] = [
  [/pass(word|wd|code)?\b|\bpwd\b|\bsecret\b|\bpin\b(?!\s*code)/i, 'PASSWORD'],
  [/\b(otp|one[-_ ]?time|verification[-_ ]?code|2fa|totp)\b/i, 'OTP'],
  [/\b(cvv|cvc|csc|security[-_ ]?code)\b/i, 'CVV'],
  [/\b(card[-_ ]?(number|no)|cc[-_ ]?num|credit[-_ ]?card|debit[-_ ]?card)\b/i, 'CARD'],
  [/\b(aadhaa?r|uidai|uid)\b/i, 'AADHAAR'],
  [/\bpan(\s|_|-)?(card|number|no)?\b/i, 'PAN'],
  [/\b(ssn|social[-_ ]?security)\b/i, 'SSN'],
  [/\b(ifsc)\b/i, 'IFSC'],
  [/\b(account[-_ ]?(number|no)|acc[-_ ]?no|iban)\b/i, 'BANK_ACCOUNT'],
  [/\b(upi|vpa)\b/i, 'UPI'],
  [/\b(api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|client[-_ ]?secret)\b/i, 'SECRET'],
  [/\b(passport)\b/i, 'PASSPORT'],
  [/\b(e-?mail)\b/i, 'EMAIL'],
  [/\b(phone|mobile|contact[-_ ]?(number|no)|tel|whatsapp)\b/i, 'PHONE'],
  [/\b(dob|birth|birthday)\b/i, 'DOB'],
  [/\b(address|street|locality|landmark)\b/i, 'ADDRESS'],
  [/\b(pin[-_ ]?code|postal|zip)\b/i, 'PINCODE'],
  [/\b((first|last|full|middle|given|family|sur)[-_ ]?name|surname|your name|name)\b/i, 'NAME']
]

/**
 * What kind of private data a field holds, from its attributes alone (works before the user types).
 * Type and autocomplete are the strongest signals; names, ids, labels and placeholders come next.
 */
export function classifyField(f: FieldInfo): PIIType | null {
  const type = (f.type ?? '').toLowerCase()
  if (type === 'password') return 'PASSWORD'
  if (type === 'email') return 'EMAIL'
  if (type === 'tel') return 'PHONE'
  for (const token of (f.autocomplete ?? '').toLowerCase().split(/\s+/)) {
    const t = AUTOCOMPLETE[token]
    if (t) return t
  }
  // Search boxes, coupons and the like mention "name" or "code" without being private.
  // camelCase and snake_case become words so \b boundaries work ("aadhaar_no", "otpCode").
  const hay = [f.name, f.id, f.label, f.ariaLabel, f.placeholder].filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
  if (!hay) return null
  if (/\b(search|query|coupon|promo|captcha|username\s*or|company|organi[sz]ation|project|file|product|repo(sitory)?)\b/i.test(hay) && !/\b(pass|card|otp|cvv)\b/i.test(hay)) return null
  for (const [re, t] of FIELD_HINTS) if (re.test(hay)) return t
  return null
}

/** Text with each span replaced through `replace` (used to tokenise or mask). */
export function replaceSpans(text: string, spans: Span[], replace: (s: Span, value: string) => string): string {
  let out = ''
  let i = 0
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.start < i) continue
    out += text.slice(i, s.start) + replace(s, text.slice(s.start, s.end))
    i = s.end
  }
  return out + text.slice(i)
}
