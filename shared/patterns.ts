// Learning their routines from what's in front of them, on this PC: minutes per app per hour of the
// week, plus when their computer day starts and ends. From that come a few bullets ("Usually in VS Code
// around 10 PM – 1 AM") that go into her memory like anything else. Pure and clock-injected (tested).

export interface Usage {
  /** label -> 168 slots (day-of-week × 24 + hour), minutes seen. */
  apps: Record<string, number[]>
  /** First and last active hour per day (YYYY-MM-DD -> [first, last]), last 21 days. */
  days: Record<string, [number, number]>
}

export const EMPTY_USAGE: Usage = { apps: {}, days: {} }
const MAX_APPS = 30

const slot = (d: Date) => d.getDay() * 24 + d.getHours()
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Counts one minute of `label` in front at time `now`. */
export function addMinute(u: Usage, label: string, now: Date): Usage {
  const apps = { ...u.apps }
  const row = [...(apps[label] ?? new Array(168).fill(0))]
  row[slot(now)] = Math.min(60, row[slot(now)] + 1)
  apps[label] = row
  // Keep the busiest apps only.
  const names = Object.keys(apps)
  if (names.length > MAX_APPS) {
    const total = (n: string) => apps[n].reduce((a, b) => a + b, 0)
    names.sort((a, b) => total(a) - total(b))
    for (const n of names.slice(0, names.length - MAX_APPS)) delete apps[n]
  }
  const days = { ...u.days }
  const k = dayKey(now)
  const h = now.getHours() + now.getMinutes() / 60
  // Times after midnight but before 5 AM belong to the previous computer day.
  const key = now.getHours() < 5 ? dayKey(new Date(now.getTime() - 5 * 3600000)) : k
  const hh = now.getHours() < 5 ? h + 24 : h
  const cur = days[key]
  days[key] = cur ? [Math.min(cur[0], hh), Math.max(cur[1], hh)] : [hh, hh]
  const keep = Object.keys(days).sort().slice(-21)
  return { apps, days: Object.fromEntries(keep.map((d) => [d, days[d]])) }
}

const fmtHour = (h: number) => {
  const x = ((Math.round(h) % 24) + 24) % 24
  return x === 0 ? '12 AM' : x < 12 ? `${x} AM` : x === 12 ? '12 PM' : `${x - 12} PM`
}

/** Routine bullets worth remembering (only once there's enough data to mean something). */
export function routines(u: Usage, minMinutes = 180): string[] {
  const out: string[] = []
  const ranked = Object.entries(u.apps).map(([name, row]) => ({ name, row, total: row.reduce((a, b) => a + b, 0) })).filter((a) => a.total >= minMinutes).sort((a, b) => b.total - a.total)
  for (const a of ranked.slice(0, 5)) {
    // Fold the week into 24 hours and find the busiest stretch.
    const byHour = new Array(24).fill(0)
    a.row.forEach((m, i) => { byHour[i % 24] += m })
    const peak = Math.max(...byHour)
    const hot = byHour.map((m) => m >= peak * 0.45)
    let start = byHour.indexOf(peak)
    let end = start
    while (hot[(start + 23) % 24] && (start + 23) % 24 !== end) start = (start + 23) % 24
    while (hot[(end + 1) % 24] && (end + 1) % 24 !== start) end = (end + 1) % 24
    const weekday = a.row.slice(24, 144).reduce((x, y) => x + y, 0)
    const weekend = a.total - weekday
    const when = weekend > weekday * 0.8 ? 'especially at weekends' : weekday > weekend * 4 ? 'mostly on weekdays' : ''
    out.push(`Usually in ${a.name} around ${fmtHour(start)} – ${fmtHour(end + 1)}${when ? `, ${when}` : ''}`)
  }
  const days = Object.values(u.days)
  if (days.length >= 5) {
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    const first = med(days.map((d) => d[0]))
    const last = med(days.map((d) => d[1]))
    out.push(`Their computer day usually starts around ${fmtHour(first)} and ends around ${fmtHour(last)}`)
  }
  return out
}

/** The app they usually have in front at this hour (for "it's your usual DSA time"), if clear. */
export function usualNow(u: Usage, now: Date): string | null {
  const s = slot(now)
  let best: [string, number] | null = null
  for (const [name, row] of Object.entries(u.apps)) {
    // Same hour on the same weekday, plus the same hour on other days at half weight.
    const sameHour = row.filter((_, i) => i % 24 === s % 24).reduce((a, b) => a + b, 0)
    const score = row[s] + sameHour * 0.5
    if (!best || score > best[1]) best = [name, score]
  }
  return best && best[1] >= 60 ? best[0] : null
}
