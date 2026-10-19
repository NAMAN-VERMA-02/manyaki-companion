// Model back ends for the planner. Open-weights first: Ollama on this machine (or a server), then any
// OpenAI-compatible endpoint (vLLM, llama.cpp server, LM Studio, or a host serving open models), and
// Gemini only as a last resort. With none of them the server falls back to the rule planner.

export type ProviderName = 'auto' | 'ollama' | 'openai' | 'gemini' | 'rules'

export interface ProviderConfig {
  provider: ProviderName
  model?: string
  baseUrl?: string
  apiKey?: string
  /** Gemini key, used only when no open-weights model is reachable. */
  geminiKey?: string
}

export interface Planner {
  name: string
  /** The model accepts images (the redacted screenshot). */
  vision: boolean
  plan(system: string, user: string, image?: string): Promise<string>
}

const VISION_RE = /(qwen2\.5-?vl|qwen3-?vl|gemma3|llama3\.2-vision|llama4|minicpm-v|llava|moondream|granite3\.2-vision|mistral-small3\.[12]|pixtral|internvl|phi4-multimodal|-vl\b|vision)/i
const PREFER = [/qwen2\.5-?vl|qwen3-?vl/i, /gemma3/i, /llama3\.2-vision|llama4/i, /minicpm-v/i, /llava/i, /qwen/i, /llama3/i, /gemma/i, /mistral/i, /phi/i]

const timeout = (ms: number) => AbortSignal.timeout(ms)

function pickModel(names: string[]): string | null {
  for (const re of PREFER) {
    const hit = names.find((n) => re.test(n) && !/embed/i.test(n))
    if (hit) return hit
  }
  return names.find((n) => !/embed/i.test(n)) ?? null
}

function ollama(base: string, model: string): Planner {
  return {
    name: `ollama:${model}`,
    vision: VISION_RE.test(model),
    async plan(system, user, image) {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          format: 'json',
          options: { temperature: 0.1, num_ctx: 8192 },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user, ...(image && VISION_RE.test(model) ? { images: [image] } : {}) }]
        }),
        signal: timeout(120000)
      })
      if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const j = (await res.json()) as { message?: { content?: string } }
      return j.message?.content ?? ''
    }
  }
}

function openaiCompatible(base: string, model: string, apiKey?: string): Planner {
  const vision = VISION_RE.test(model)
  return {
    name: `openai:${model}`,
    vision,
    async plan(system, user, image) {
      const content = image && vision
        ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }]
        : user
      const body = (json: boolean) => JSON.stringify({
        model,
        temperature: 0.1,
        messages: [{ role: 'system', content: system }, { role: 'user', content }],
        ...(json ? { response_format: { type: 'json_object' } } : {})
      })
      const headers: Record<string, string> = { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }
      let res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers, body: body(true), signal: timeout(120000) })
      // Some servers don't support JSON mode; the prompt asks for JSON anyway.
      if (res.status === 400) res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers, body: body(false), signal: timeout(120000) })
      if (!res.ok) throw new Error(`openai-compatible ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      return j.choices?.[0]?.message?.content ?? ''
    }
  }
}

function gemini(key: string, model: string): Planner {
  return {
    name: `gemini:${model}`,
    vision: true,
    async plan(system, user, image) {
      const parts: unknown[] = [{ text: user }]
      if (image) parts.push({ inlineData: { mimeType: 'image/jpeg', data: image } })
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 800 }
        }),
        signal: timeout(60000)
      })
      if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
      return j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
    }
  }
}

/** Models an Ollama server has installed, or null if it isn't reachable. */
export async function ollamaModels(base: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${base}/api/tags`, { signal: timeout(1200) })
    if (!res.ok) return null
    const j = (await res.json()) as { models?: { name: string }[] }
    return (j.models ?? []).map((m) => m.name)
  } catch {
    return null
  }
}

/** The planner to use for this config, or null for the rule planner. */
export async function resolvePlanner(cfg: ProviderConfig): Promise<Planner | null> {
  const p = cfg.provider
  if (p === 'rules') return null
  if (p === 'ollama' || p === 'auto') {
    const base = (p === 'ollama' && cfg.baseUrl) || process.env.OLLAMA_HOST?.replace(/^(?!https?:)/, 'http://') || 'http://127.0.0.1:11434'
    const models = await ollamaModels(base)
    const model = (p === 'ollama' && cfg.model) || (models ? pickModel(models) : null)
    if (models && model) return ollama(base, model)
    if (p === 'ollama') throw new Error(`Ollama not reachable at ${base} (or no models installed: try "ollama pull qwen2.5vl:3b")`)
  }
  if (p === 'openai' || (p === 'auto' && cfg.baseUrl)) {
    if (!cfg.baseUrl || !cfg.model) throw new Error('openai-compatible provider needs baseUrl and model')
    return openaiCompatible(cfg.baseUrl, cfg.model, cfg.apiKey)
  }
  if (p === 'gemini' || (p === 'auto' && cfg.geminiKey)) {
    const key = cfg.geminiKey ?? cfg.apiKey
    if (!key) throw new Error('gemini provider needs a key')
    return gemini(key, (p === 'gemini' && cfg.model) || 'gemini-3.5-flash-lite')
  }
  return null
}
