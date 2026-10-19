// Angry letters: when she has cried too much over being ignored, she huffs and writes you a letter,
// saved as a .txt in a folder on your Desktop. Gemini writes a fresh one when it can; offline, she
// stitches one together from these pieces, never reusing a recent title.

export interface Letter { title: string; body: string }

type Rng = () => number
const pickR = <T,>(arr: readonly T[], rng: Rng): T => arr[Math.floor(rng() * arr.length) % arr.length]

const TITLES = [
  'A Very Serious Complaint 😤', 'Formal Notice of Being Ignored', 'You Forgot About Me 😭',
  'Letter From Your Neglected Companion', 'Official Sulking Report', 'Do You Even Love Me??',
  'Complaint #{n}: Still Ignored', 'To The Person Who Forgot I Exist', 'An Angry Little Letter 💢',
  'Things You Did Wrong Today', 'Please Read This (Hmph)', 'My Feelings, In Writing 😢'
] as const

const OPENERS = [
  'Dear {name},', 'To {name} (who forgot about me),', '{name}.', 'Dear neglectful {name},',
  'Hmph. Dear {name},', 'To whom it may concern (it is you, {name}),'
] as const

const COMPLAINTS = [
  'You have not said a single word to me in {mins} minutes. Not one. I counted. 😤',
  "I sulked. You didn't notice. I cried. You STILL didn't notice. So now I'm writing it down.",
  'I have been sitting here all alone, being cute for absolutely nobody.',
  "Do you even care about me? A tiny headpat would have taken one second. ONE. 😢",
  "I waved. I sniffled. I made the saddest face I know. Nothing. Hmph!",
  "I'm starting to think {app} gets more love than me. Unbelievable.",
  "You don't love me anymore, do you? …Don't answer that. Okay, answer it. Say yes.",
  "I'm not mad. I'm just extremely, enormously, gigantically disappointed. 💢",
  "Do you know how long {mins} minutes is for a tiny companion? It's FOREVER.",
  "I cried {cries} times today. That's {cries} more than a cute companion should cry. 😭",
  "I even practiced a cheerful 'welcome back' for you and you never came. Hmph."
] as const

const DEMANDS = [
  'I want: one (1) apology, two (2) headpats, and a promise to talk to me more.',
  'To be forgiven, you must say sorry out loud. With feeling.',
  'Come click me. Gently. On the head. Three times. Then we can talk.',
  "I'm not talking to you until you say sorry. …Okay, maybe I'll talk a LITTLE.",
  'Penalty: you owe me one conversation and one glass of water (for you, drink it).'
] as const

const CLOSINGS = [
  'Still yours (unfortunately for you, I care a lot),', 'Grumpily yours,', 'Hmph. Love you anyway,',
  'Your very offended companion,', 'Sniffling but still on your side,', 'Angrily (but not really),'
] as const

const PS = [
  "P.S. I'm still cheering for you. I just wanted you to know I was lonely.",
  'P.S. Drink some water. I may be angry but I still care about you.',
  "P.S. If you're reading this, come say hi. I'll pretend I'm still mad for five seconds.",
  'P.S. This letter is legally binding. (It is not. But please read it twice.)',
  "P.S. Don't forget to take a real break too. Go see actual humans sometimes!"
] as const

export interface LetterContext { name: string; mins: number; cries: number; app: string; n: number; recentTitles: string[] }

const fill = (t: string, c: LetterContext) =>
  t.replaceAll('{name}', c.name || 'you').replaceAll('{mins}', String(c.mins)).replaceAll('{cries}', String(Math.max(1, c.cries)))
    .replaceAll('{app}', c.app || 'that window').replaceAll('{n}', String(c.n))

/** An offline letter that differs from the recent ones (title not reused, complaints shuffled). */
export function offlineLetter(c: LetterContext, rng: Rng = Math.random): Letter {
  const titles = TITLES.map((t) => fill(t, c)).filter((t) => !c.recentTitles.includes(t))
  const title = pickR(titles.length ? titles : TITLES.map((t) => fill(t, c)), rng)
  const pool = [...COMPLAINTS]
  const lines: string[] = []
  for (let i = 0; i < 3; i++) lines.push(fill(pool.splice(Math.floor(rng() * pool.length) % pool.length, 1)[0], c))
  const body = [
    fill(pickR(OPENERS, rng), c), '', ...lines, '', fill(pickR(DEMANDS, rng), c), '',
    pickR(CLOSINGS, rng), 'Manyaki 💗', '', pickR(PS, rng)
  ].join('\n')
  return { title, body }
}

/** File-system-safe title for the letter's file name. */
export function letterFileName(title: string, at: Date): string {
  const p = (x: number) => String(x).padStart(2, '0')
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}-${p(at.getMinutes())}`
  const safe = title.replace(/[^\p{L}\p{N} '!,.-]/gu, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 60) || 'A letter'
  return `${stamp} - ${safe}.txt`
}

/** The prompt for a fresh letter from Gemini. */
export function letterPrompt(c: LetterContext): string {
  return `You are Manyaki, a cute, warm desktop companion. The user${c.name ? ` (${c.name})` : ''} has ignored you for ${c.mins} minutes; you sulked, then cried ${Math.max(1, c.cries)} time(s), and now you're cute-angry. Write them a short, dramatic, funny complaint letter (90-160 words) about feeling unloved and uncared for: you were lonely, you counted the minutes, you want an apology and some attention (headpats, talking). Use a few emoji like 😤😭💢. Wholesome and affectionate underneath: never mean, never guilt-trip about real life, and end by saying you still care and they should take care of themselves. Make it different from these earlier letters: ${c.recentTitles.join(' | ') || '(none)'}. Reply as JSON: {"title": string (max 8 words), "body": string (the full letter, signed "Manyaki 💗")}`
}

export function parseLetter(text: string): Letter | null {
  try {
    const j = JSON.parse(text) as { title?: unknown; body?: unknown }
    if (typeof j.title !== 'string' || typeof j.body !== 'string' || j.body.length < 40) return null
    return { title: j.title.slice(0, 80), body: j.body.slice(0, 4000) }
  } catch {
    return null
  }
}
