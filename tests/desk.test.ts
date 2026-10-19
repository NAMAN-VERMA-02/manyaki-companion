import { describe, expect, it } from 'vitest'
import { describeControls, describeWindows, errorOnScreen, findText, hide, isPrivateWindow, pickWindow, redactOcr, riskOf, type Ctl, type OcrLine, type Win } from '../shared/desk'
import { Vault } from '../eyes/shared/vault'
import { asBullets, isRecallQuestion, search, touch, tokens } from '../shared/recall'
import { addMinute, EMPTY_USAGE, routines, usualNow } from '../shared/patterns'

const win = (app: string, title: string, extra: Partial<Win> = {}): Win => ({ hwnd: Math.floor(Math.random() * 1e6), title, pid: 1, app, x: 0, y: 0, w: 800, h: 600, min: false, max: false, active: false, ...extra })

describe('desktop: choosing windows', () => {
  const wins = [win('chrome', 'lofi beats - YouTube - Google Chrome'), win('Code', 'main.ts - manyaki - Visual Studio Code', { active: true }), win('explorer', 'Downloads - File Explorer')]
  it('matches by app or title words', () => {
    expect(pickWindow(wins, 'the youtube one')?.app).toBe('chrome')
    expect(pickWindow(wins, 'chrome window')?.app).toBe('chrome')
    expect(pickWindow(wins, 'downloads')?.app).toBe('explorer')
    expect(pickWindow(wins, 'this')?.app).toBe('Code')
    expect(pickWindow(wins, 'spotify')).toBeNull()
  })
  it('never reads private windows', () => {
    expect(isPrivateWindow('chrome', 'HDFC Bank NetBanking - Google Chrome')).toBe(true)
    expect(isPrivateWindow('msedge', 'New InPrivate tab - Microsoft Edge')).toBe(true)
    expect(isPrivateWindow('Bitwarden', 'Vault')).toBe(true)
    expect(isPrivateWindow('Code', 'main.ts')).toBe(false)
    expect(describeWindows([win('chrome', 'Incognito - Chrome')], null, true)).toContain('(private window)')
  })
})

describe('desktop: what she reads is redacted', () => {
  it('hides private details with tokens she can type back, or masks', () => {
    const v = new Vault()
    expect(hide('Mail asha@example.com now', v, true)).toBe('Mail [[EMAIL_1]] now')
    expect(v.rehydrate('[[EMAIL_1]]')).toBe('asha@example.com')
    expect(hide('Call 9876543210', null, true)).toBe('Call [phone]')
    expect(hide('Call 9876543210', null, false)).toBe('Call 9876543210')
  })
  it('lists controls with passwords never shown', () => {
    const ctls: Ctl[] = [
      { id: 'u1', type: 'edit', name: 'Email', x: 0, y: 0, w: 100, h: 20, enabled: true, focus: true, password: false, value: 'asha@example.com', toggle: null, act: true, aid: 'email' },
      { id: 'u2', type: 'edit', name: 'Password', x: 0, y: 30, w: 100, h: 20, enabled: true, focus: false, password: true, value: null, toggle: null, act: true, aid: 'pw' },
      { id: 'u3', type: 'button', name: 'Sign in', x: 0, y: 60, w: 80, h: 24, enabled: true, focus: false, password: false, value: null, toggle: null, act: true, aid: null }
    ]
    const out = describeControls(ctls, new Vault(), true)
    expect(out).toContain('u1 edit "Email" value="[[EMAIL_1]]" (focused)')
    expect(out).toContain('u2 edit "Password" value=[hidden password]')
    expect(out).not.toContain('asha@')
  })
  it('blacks out exactly the words that are private', () => {
    const line: OcrLine = { text: 'Call me at 9876543210 today', x: 100, y: 50, w: 300, h: 20, words: [
      { t: 'Call', x: 100, w: 40 }, { t: 'me', x: 145, w: 20 }, { t: 'at', x: 170, w: 18 }, { t: '9876543210', x: 192, w: 110 }, { t: 'today', x: 306, w: 50 }
    ] }
    const r = redactOcr([line], null, true)
    expect(r.text).toEqual(['Call me at [phone] today'])
    expect(r.boxes).toEqual([190, 48, 114, 24])
    expect(redactOcr([line], null, false).boxes).toEqual([])
  })
  it('finds text to click', () => {
    const lines: OcrLine[] = [
      { text: 'Please press Submit to continue', x: 0, y: 0, w: 400, h: 20, words: [{ t: 'Please', x: 0, w: 60 }, { t: 'press', x: 65, w: 50 }, { t: 'Submit', x: 120, w: 70 }, { t: 'to', x: 195, w: 20 }, { t: 'continue', x: 220, w: 80 }] },
      { text: 'Submit', x: 500, y: 300, w: 80, h: 30, words: [{ t: 'Submit', x: 500, w: 80 }] }
    ]
    expect(findText(lines, 'submit')).toMatchObject({ x: 540, y: 315 })
    expect(findText(lines, 'cancel')).toBeNull()
  })
})

describe('desktop: risky actions need an OK', () => {
  const term = win('WindowsTerminal', 'PowerShell')
  it('confirms typing or Enter in terminals, the Run box, and closing unsaved work', () => {
    expect(riskOf({ kind: 'type', text: 'rm -rf /' }, term)).toMatch(/terminal|WindowsTerminal/)
    expect(riskOf({ kind: 'keys', text: 'enter' }, term)).toMatch(/Enter/)
    expect(riskOf({ kind: 'keys', text: 'win+r' }, null)).toMatch(/Run/)
    expect(riskOf({ kind: 'close' }, win('Code', '● main.ts - Visual Studio Code'))).toMatch(/unsaved/)
    expect(riskOf({ kind: 'type', text: 'hello' }, win('notepad', 'notes.txt - Notepad'))).toBeNull()
    expect(riskOf({ kind: 'close' }, win('chrome', 'YouTube'))).toBeNull()
  })
  it('spots errors on screen worth offering help with', () => {
    expect(errorOnScreen(['import x', "TypeError: Cannot read properties of undefined (reading 'map')"])).toMatch(/TypeError/)
    expect(errorOnScreen(['npm ERR! code ENOENT'])).toMatch(/npm ERR/)
    expect(errorOnScreen(['All tests passed', 'Done in 2.1s'])).toBeNull()
  })
})

describe('memory: bullets found only when relevant', () => {
  const now = Date.now()
  const facts = [
    { text: 'Has a DBMS exam on Nov 3', at: now - 2 * 86400000 },
    { text: 'Favourite food is rajma chawal', at: now - 40 * 86400000 },
    { text: 'Best friend is Rohan, they play Valorant together', at: now - 5 * 86400000 },
    { text: 'Wants an internship at a product company', at: now - 1 * 86400000 },
    { text: 'Usually in VS Code around 10 PM – 1 AM', at: now, kind: 'routine' as const }
  ]
  it('finds the right bullet, including synonyms and word forms', () => {
    expect(search(facts, 'when is my test?')[0].fact.text).toMatch(/DBMS exam/)
    expect(search(facts, 'what do I like to eat')[0].fact.text).toMatch(/rajma/)
    expect(search(facts, 'who do I play valorant with')[0].fact.text).toMatch(/Rohan/)
    expect(search(facts, 'jobs')[0].fact.text).toMatch(/internship/)
    expect(search(facts, 'when do I usually code')[0].fact.text).toMatch(/VS Code/)
  })
  it('returns nothing for unrelated questions', () => {
    expect(search(facts, 'what is the capital of France')).toEqual([])
    expect(search([], 'exam')).toEqual([])
  })
  it('formats bullets and ranks useful ones higher next time', () => {
    const hits = search(facts, 'exam')
    expect(asBullets(hits)).toMatch(/^• Has a DBMS exam on Nov 3 \(noted 2 days ago\)$/)
    expect(touch(facts, hits)[0].uses).toBe(1)
    expect(tokens('Coding exams!')).toEqual(['cod', 'exam'])
  })
  it('knows when it is being asked to remember', () => {
    expect(isRecallQuestion('do you remember my exam date?')).toBe(true)
    expect(isRecallQuestion('mera exam kab hai yaad hai?')).toBe(true)
    expect(isRecallQuestion('open chrome')).toBe(false)
  })
})

describe('routines: learned from what is in front', () => {
  it('turns minutes of use into routine bullets', () => {
    let u = EMPTY_USAGE
    // Five weekday nights of VS Code 10–12 PM, and LeetCode at 8 AM.
    for (let d = 12; d <= 16; d++) { // Mon 12 – Fri 16 Oct 2026
      for (let m = 0; m < 120; m++) u = addMinute(u, 'VS Code', new Date(2026, 9, d, 22, m))
      for (let m = 0; m < 45; m++) u = addMinute(u, 'LeetCode', new Date(2026, 9, d, 8, m))
    }
    const r = routines(u)
    expect(r[0]).toMatch(/^Usually in VS Code around 10 PM – 12 AM, mostly on weekdays$/)
    expect(r.some((x) => /LeetCode around 8 AM – 9 AM/.test(x))).toBe(true)
    expect(r.at(-1)).toMatch(/computer day usually starts around 8 AM and ends around 12 AM/)
    expect(usualNow(u, new Date(2026, 9, 20, 22, 30))).toBe('VS Code')
    expect(usualNow(u, new Date(2026, 9, 20, 15, 0))).toBeNull()
  })
  it('needs enough data before claiming a routine', () => {
    let u = EMPTY_USAGE
    for (let m = 0; m < 30; m++) u = addMinute(u, 'Notepad', new Date(2026, 9, 19, 14, m))
    expect(routines(u)).toEqual([])
  })
})
