import { GoogleGenAI, type Content, type Part } from '@google/genai'
import { runTool, toolDeclarations, type ToolHost } from './tools'
import type { Turn } from '../../../shared/types'

/**
 * Fallback brain (and the background helper for memory): Gemini Flash over plain HTTPS.
 * Used when Live is rate-limited or unavailable. It accepts typed text or a recorded utterance.
 */
export class TextBrain {
  private ai: GoogleGenAI | null = null
  model = 'gemini-3.8-flash'
  liteModel = 'gemini-3.5-flash-lite'
  unavailableUntil = 0

  constructor(private readonly tools: ToolHost, private readonly log: (m: string) => void) {}

  setKey(key: string) { this.ai = key ? new GoogleGenAI({ apiKey: key }) : null }
  get usable() { return !!this.ai && Date.now() > this.unavailableUntil && navigator.onLine }

  /** One reply. `input` is text, or 16 kHz mono audio of what they said. Returns her spoken text and what they said. */
  async reply(system: string, history: Turn[], input: { text?: string; audio?: Float32Array }): Promise<{ text: string; heard?: string }> {
    if (!this.ai) throw new Error('no key')
    const contents: Content[] = history.slice(-10).map((t) => ({ role: t.role === 'user' ? 'user' : 'model', parts: [{ text: t.text }] }))
    const userParts: Part[] = []
    if (input.audio) {
      userParts.push({ inlineData: { mimeType: 'audio/wav', data: wavBase64(input.audio, 16000) } })
      userParts.push({ text: 'That audio is what they just said to you. Reply to it naturally, and begin your reply with their words transcribed as <heard>...</heard>.' })
    } else if (input.text) userParts.push({ text: input.text })
    contents.push({ role: 'user', parts: userParts })

    for (let round = 0; round < 3; round++) {
      const res = await this.ai.models.generateContent({
        model: this.model,
        contents,
        config: { systemInstruction: system, tools: [{ functionDeclarations: toolDeclarations(false) }], maxOutputTokens: 300, temperature: 0.9 }
      }).catch((err: Error) => {
        if (/quota|exhaust|429/i.test(err.message)) this.unavailableUntil = Date.now() + 10 * 60000
        throw err
      })
      const calls = res.functionCalls ?? []
      const text = res.text ?? ''
      if (!calls.length) {
        const heard = text.match(/<heard>([\s\S]*?)<\/heard>/)?.[1]?.trim()
        return { text: text.replace(/<heard>[\s\S]*?<\/heard>/, '').trim(), heard }
      }
      contents.push(res.candidates?.[0]?.content ?? { role: 'model', parts: calls.map((c) => ({ functionCall: c })) })
      contents.push({
        role: 'user',
        parts: calls.map((c) => ({ functionResponse: { id: c.id, name: c.name, response: runTool(this.tools, c.name ?? '', (c.args ?? {}) as Record<string, unknown>) } }))
      })
      if (text.trim()) {
        const heard = text.match(/<heard>([\s\S]*?)<\/heard>/)?.[1]?.trim()
        return { text: text.replace(/<heard>[\s\S]*?<\/heard>/, '').trim(), heard }
      }
    }
    return { text: '' }
  }

  /** Pulls durable facts and a one-line summary out of recent conversation. Cheap model, JSON output. */
  async distill(turns: Turn[], known: string[]): Promise<{ facts: string[]; summary: string }> {
    if (!this.ai || turns.length < 2) return { facts: [], summary: '' }
    const transcript = turns.map((t) => `${t.role === 'user' ? 'User' : 'Manyaki'}: ${t.text}`).join('\n')
    const res = await this.ai.models.generateContent({
      model: this.liteModel,
      contents: [{
        role: 'user',
        parts: [{
          text: `From this conversation between the user and their companion Manyaki, extract NEW durable facts about the user worth remembering for weeks (name, exams/deadlines with dates, projects, goals, likes/dislikes, struggles, people in their life, routines). Skip small talk and anything already known. Also write a one-sentence summary of what was discussed.\n\nAlready known:\n${known.map((k) => '- ' + k).join('\n') || '(nothing)'}\n\nConversation:\n${transcript}\n\nReply as JSON: {"facts": string[], "summary": string}`
        }]
      }],
      config: { responseMimeType: 'application/json', maxOutputTokens: 400, temperature: 0.2 }
    })
    try {
      const j = JSON.parse(res.text ?? '{}') as { facts?: unknown; summary?: unknown }
      return {
        facts: Array.isArray(j.facts) ? j.facts.filter((f): f is string => typeof f === 'string').slice(0, 8) : [],
        summary: typeof j.summary === 'string' ? j.summary.slice(0, 300) : ''
      }
    } catch {
      this.log('distill: bad JSON')
      return { facts: [], summary: '' }
    }
  }
}

function wavBase64(samples: Float32Array, rate: number): string {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
