// Pure helpers for opening things (no Electron imports, so they are unit-tested directly).

export const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()

/** How well a candidate name matches what was asked (0 = no match). */
export function matchScore(query: string, candidate: string): number {
  const q = norm(query)
  const c = norm(candidate)
  if (!q || !c) return 0
  if (c === q) return 100
  if (c.startsWith(q)) return 80
  if (c.includes(q)) return 60
  const words = q.split(' ').filter((w) => w.length > 1)
  const hit = words.filter((w) => c.includes(w)).length
  return hit === words.length ? 40 : hit ? 10 * hit : 0
}

// ---------- websites ----------

const SITES: Record<string, string> = {
  youtube: 'https://www.youtube.com', 'you tube': 'https://www.youtube.com', gmail: 'https://mail.google.com',
  google: 'https://www.google.com', github: 'https://github.com', leetcode: 'https://leetcode.com',
  chatgpt: 'https://chatgpt.com', claude: 'https://claude.ai', gemini: 'https://gemini.google.com',
  'google drive': 'https://drive.google.com', drive: 'https://drive.google.com', 'google docs': 'https://docs.google.com',
  'google calendar': 'https://calendar.google.com', calendar: 'https://calendar.google.com', maps: 'https://maps.google.com',
  instagram: 'https://www.instagram.com', whatsapp: 'https://web.whatsapp.com', 'whatsapp web': 'https://web.whatsapp.com',
  linkedin: 'https://www.linkedin.com', twitter: 'https://x.com', x: 'https://x.com', reddit: 'https://www.reddit.com',
  netflix: 'https://www.netflix.com', spotify: 'https://open.spotify.com', 'stack overflow': 'https://stackoverflow.com',
  stackoverflow: 'https://stackoverflow.com', notion: 'https://www.notion.so', wikipedia: 'https://www.wikipedia.org',
  amazon: 'https://www.amazon.in', flipkart: 'https://www.flipkart.com', geeksforgeeks: 'https://www.geeksforgeeks.org',
  codeforces: 'https://codeforces.com', coursera: 'https://www.coursera.org', 'ai studio': 'https://aistudio.google.com'
}

/** Turns "youtube", "github.com/foo" or "lofi beats on youtube" into a safe https URL. */
export function resolveWebsite(target: string): string {
  const t = target.trim()
  const key = norm(t)
  if (SITES[key]) return SITES[key]
  if (/^https:\/\/[^\s]+$/i.test(t)) return t
  if (/^http:\/\/[^\s]+$/i.test(t)) return t.replace(/^http:/i, 'https:')
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/[^\s]*)?$/i.test(t)) return `https://${t}`
  // "X on youtube" -> YouTube search; anything else -> Google search.
  const yt = /^(.*)\s+(on|in|pe|par)\s+you\s?tube$/i.exec(t)
  if (yt) return `https://www.youtube.com/results?search_query=${encodeURIComponent(yt[1])}`
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`
}
