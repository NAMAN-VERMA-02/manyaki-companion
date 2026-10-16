import type { AppCategory } from '../shared/types'

// Friendly labels for common apps/sites, matched against "owner app + window title".
const LABELS: [RegExp, string][] = [
  [/youtube/i, 'YouTube'], [/instagram/i, 'Instagram'], [/netflix/i, 'Netflix'], [/reddit/i, 'Reddit'],
  [/twitch/i, 'Twitch'], [/discord/i, 'Discord'], [/whatsapp/i, 'WhatsApp'], [/spotify/i, 'Spotify'],
  [/leetcode/i, 'LeetCode'], [/github/i, 'GitHub'], [/stack ?overflow/i, 'Stack Overflow'],
  [/notion/i, 'Notion'], [/obsidian/i, 'Obsidian'], [/figma/i, 'Figma'], [/overleaf/i, 'Overleaf'],
  [/visual studio code|\bcode\.exe|^code$/i, 'VS Code'], [/intellij|pycharm|webstorm|android studio/i, 'an IDE'],
  [/powerpoint/i, 'PowerPoint'], [/word/i, 'Word'], [/excel/i, 'Excel'],
  [/terminal|powershell|cmd\.exe/i, 'the terminal'], [/claude/i, 'Claude'], [/chatgpt/i, 'ChatGPT']
]

const BROWSERS = /chrome|msedge|edge|firefox|brave|opera|vivaldi|arc/i

export interface Classified { category: AppCategory; label: string }

export function classify(app: string, title: string, rules: { work: string[]; distraction: string[] }): Classified {
  const hay = ` ${app} ${title} `.toLowerCase()
  const match = (list: string[]) => list.some((k) => k.trim() && hay.includes(k.toLowerCase()))
  // Distraction wins over work: "YouTube - Chrome" should not count as work just because it is a browser tab.
  let category: AppCategory = 'neutral'
  if (match(rules.distraction)) category = 'distraction'
  else if (match(rules.work)) category = 'work'

  let label = LABELS.find(([re]) => re.test(hay))?.[1] ?? ''
  if (!label) label = BROWSERS.test(app) ? 'the browser' : prettyApp(app)
  return { category, label }
}

function prettyApp(app: string): string {
  const name = app.replace(/\.exe$/i, '').trim()
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'something'
}
