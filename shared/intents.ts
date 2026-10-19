// Deterministic understanding of simple requests (English + Hinglish) for the offline brain.
// The local model only writes what she says; actions come from these rules applied to *your* words,
// so text from anywhere else (window titles, files, the model itself) can never trigger an action.

export type Intent =
  | { tool: 'open_folder' | 'open_app' | 'open_website'; arg: string }
  | { tool: 'start_focus'; arg: number }
  | { tool: 'stop_focus' }
  | { tool: 'add_goal'; arg: string }
  | { tool: 'complete_goal'; arg: string }
  | { tool: 'remember'; arg: string }
  | { tool: 'set_user_name'; arg: string }
  | { tool: 'browser_task'; arg: string }

const FILLER = /\b(please|plz|pls|can you|could you|will you|would you|kindly|hey|hi|manyaki|maniaki|my|mera|meri|mere|the|a|an|for me|mujhe|zara|jaldi|na|do|de|dena|karo|kar|open|khol|kholo|kholdo|kholna|launch|start|chalao|chala|run|up|now|abhi|ek|baar|this|that|wala|wali|vala)\b/gi
const KNOWN_FOLDERS = /\b(downloads?|documents?|docs|desktop|pictures?|photos?|music|videos?|home)\b/i
const WEBSITE_HINT = /\b(youtube|you tube|google|gmail|github|leetcode|chatgpt|instagram|insta|whatsapp web|twitter|reddit|netflix|spotify web|stack ?overflow|wikipedia|amazon|flipkart|twitch|discord web|linkedin|codeforces|geeksforgeeks)\b|\b[a-z0-9-]+\.(com|in|org|net|io|dev|ai|gg|tv)\b|\bsearch\b|\bwebsite\b|\bsite\b/i

const num = (s: string) => {
  const m = /(\d{1,3})\s*(min|minute|minutes|mins|m\b|minat|minute ka)?/i.exec(s)
  return m ? Number(m[1]) : null
}

function cleanTarget(s: string): string {
  return s
    .replace(/[?!.,"']/g, ' ')
    .replace(FILLER, ' ')
    .replace(/\b(folder|directory|app|application|program|software|website|site|page|wali|ko|ka|ki|ke|hai|on|in|me|mein|par|pe)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseIntent(raw: string): Intent | null {
  const t = raw.trim()
  const low = t.toLowerCase()

  // Name: "my name is Naman", "call me Nam", "mera naam Naman hai"
  const name = /\b(?:my name is|call me|mera naam)\s+([A-Za-zऀ-ॿ][\wऀ-ॿ-]{1,20})/i.exec(t)
  if (name && !/^(is|hai|nahi|not)$/i.test(name[1])) return { tool: 'set_user_name', arg: name[1] }

  // Browser tasks: "in my browser search for…", "is page pe form bhar do", "on this page click sign in".
  // Checked early so words inside the task ("focus", "goal") don't trigger other intents.
  const web = /\b(?:in|on) (?:my|the|this) (?:browser|page|tab|website|site)\b|\b(?:browser|page|tab|website|site) (?:me|mein|pe|par)\b|\b(?:is|iss|this) (?:page|site|form) (?:pe|par|me|mein|ko)\b/i
  if (web.test(t) && /\b(fill|search|click|press|choose|select|sign ?in|log ?in|book|buy|add|type|enter|open|find|bhar|bharo|dhundo|daalo|daal|karo|kar do|like|submit|check|tick)\b/i.test(t)) {
    const task = t.replace(web, ' ').replace(/\b(manyaki|please|plz|pls|can you|could you|zara)\b/gi, ' ').replace(/\s+/g, ' ').trim()
    if (task.length > 3) return { tool: 'browser_task', arg: task }
  }

  // Focus timer
  if (/\b(stop|end|cancel|band|khatam|ruk)\b.*\b(focus|timer|pomodoro)\b|\b(focus|timer|pomodoro)\b.*\b(stop|band|cancel|khatam)\b/i.test(low)) return { tool: 'stop_focus' }
  if (/\b(focus|pomodoro|study timer|padhai timer|timer)\b/i.test(low) && /\b(start|begin|shuru|lagao|laga|set|chalu|let'?s|karte|do|for)\b|\d/.test(low)) {
    return { tool: 'start_focus', arg: Math.max(1, Math.min(120, num(low) ?? 25)) }
  }

  // Goals
  const goal = /\b(?:add|daal|daalo|likh|likho|set)\b[^:]*?\b(?:goal|task|todo|to-do)\b\s*(?:to|:|-|ki|ke liye)?\s*(.+)/i.exec(t) ??
    /\b(?:my goal (?:for today )?is|today i (?:want|need) to|aaj mujhe)\s+(.+?)(?:\s+karna hai)?$/i.exec(t)
  if (goal && goal[1].trim().length > 2) return { tool: 'add_goal', arg: goal[1].replace(/[.!]+$/, '').trim() }
  const done = /\b(?:done with|finished|completed|complete|ho gaya|ho gayi|kar liya|kar li)\b.*?\b(?:goal|task)\s*(?:#|no\.?|number)?\s*(\d+|.+)?/i.exec(t) ??
    /\b(?:goal|task)\s*(?:#|no\.?|number)?\s*(\d+)\s*(?:done|complete|ho gaya|finished)\b/i.exec(t)
  if (done && done[1]) return { tool: 'complete_goal', arg: done[1].trim() }

  // Remember
  const rem = /\b(?:remember that|remember|yaad rakh(?:na|o)?(?: ki)?)\s+(.{4,160})/i.exec(t)
  if (rem) return { tool: 'remember', arg: rem[1].trim() }

  // Open folder / website / app
  if (/\b(open|khol|kholo|kholdo|kholna|launch|start|chalao|chala do|run|search)\b/i.test(low)) {
    const target = cleanTarget(t)
    if (!target) return null
    if (/\bsearch\b/i.test(low) && !/\b(folder|app)\b/i.test(low)) {
      const q = t.replace(/^.*?\bsearch\b(?:\s+for)?/i, '').replace(/\bon google\b/i, '').trim()
      return { tool: 'open_website', arg: q || target }
    }
    if (/\bfolder\b/i.test(low) || KNOWN_FOLDERS.test(target)) return { tool: 'open_folder', arg: target }
    if (WEBSITE_HINT.test(low)) return { tool: 'open_website', arg: target }
    return { tool: 'open_app', arg: target }
  }
  return null
}

export type Mood = { emotion: string; action: string; emote: string | null }

/** Picks her expression from what she is about to say (offline brain only). */
export function moodFromReply(say: string, intent: Intent | null): Mood {
  const s = say.toLowerCase()
  if (intent?.tool === 'start_focus') return { emotion: 'excited', action: 'cheer', emote: 'fire' }
  if (intent?.tool === 'complete_goal') return { emotion: 'excited', action: 'clap', emote: 'party' }
  if (intent && (intent.tool.startsWith('open_') || intent.tool === 'browser_task')) return { emotion: 'happy', action: 'none', emote: null }
  if (/\b(yay|proud|amazing|awesome|great job|well done|you did it|shabash|wah|congrat)/.test(s)) return { emotion: 'excited', action: 'cheer', emote: 'sparkle' }
  if (/\b(proud of you|so proud|you nailed|crushed it)/.test(s)) return { emotion: 'proud', action: 'clap', emote: 'star' }
  if (/\b(missed you|lonely|all alone|akeli)/.test(s)) return { emotion: 'lonely', action: 'none', emote: null }
  if (/\b(nervous|scary|exam|test tomorrow|deadline|darr)/.test(s)) return { emotion: 'nervous', action: 'none', emote: 'sweat' }
  if (/\b(wait what|confus|not sure|huh)\b/.test(s)) return { emotion: 'confused', action: 'think', emote: 'question' }
  if (/\b(let'?s go|you got this|we can do|chalo)\b/.test(s)) return { emotion: 'determined', action: 'cheer', emote: 'fire' }
  if (/\b(sorry|sad|tired|oh no|don't worry|it's okay|koi baat nahi|hug)/.test(s)) return { emotion: 'worried', action: 'none', emote: 'heart' }
  if (/\b(thank you|thanks|grateful|shukriya)/.test(s)) return { emotion: 'grateful', action: 'nod', emote: 'heart' }
  if (/\b(best|cute|love|aww|hehe)/.test(s)) return { emotion: 'shy', action: 'shy', emote: 'heart' }
  if (/\b(imagine|think of|let me explain|step|first|basically|samjho|matlab)/.test(s)) return { emotion: 'happy', action: 'think', emote: 'idea' }
  if (/\?\s*$/.test(s)) return { emotion: 'happy', action: 'none', emote: 'question' }
  if (/\b(break|rest|water|stretch|sleep)/.test(s)) return { emotion: 'relaxed', action: 'stretch', emote: 'coffee' }
  return { emotion: 'happy', action: 'nod', emote: null }
}

/** "explain/teach me/samjhao/how does…": she switches to step-by-step teaching. */
export function isTeachRequest(t: string): boolean {
  return /\b(explain|teach|tutor|walk me through|how (does|do|to)|what (is|are|does)|why (is|does|do)|help me understand|i don'?t (get|understand)|quiz me|samjha|samjhao|samjha do|samajh nahi|samjh nahi|sikha|sikhao|kya hota|kaise (karte|hota|kaam)|matlab kya)\b/i.test(t)
}

/** "look at my screen / ye kya hai screen pe / what's this error": take one screenshot (cloud only). */
export function isScreenRequest(t: string): boolean {
  return /\b(look at|see|check|dekh|dekho|dekhna)\b.*\b(screen|this|ye|yeh|error)\b|\b(screen pe|screen par|on my screen)\b|\bwhat'?s (this|on my screen)\b|\bye kya hai\b/i.test(t)
}

/** Common PC games and launchers (used for GLHF/GG moments and the "gaming counts as work" option). */
export const GAME_RE = /\b(valorant|league of legends|minecraft|fortnite|apex|counter-?strike|cs2|dota|genshin|roblox|overwatch|gta|elden ring|pubg|bgmi|free fire|rocket league|steam|epic games|riot client|battle\.net|osu|among us|call of duty|warzone)\b/i
