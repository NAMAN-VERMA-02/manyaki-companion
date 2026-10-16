/** The speech bubble above her head. Text streams in as she speaks; it fades after she stops. */
export class Bubble {
  private readonly el = document.getElementById('bubble') as HTMLDivElement
  private readonly text = this.el.querySelector('.bubble-text') as HTMLDivElement
  private hideTimer = 0
  private shown = ''

  get visible() { return !this.el.classList.contains('hidden') }
  get element() { return this.el }

  /** Show text (replacing what is there). `holdMs` = how long it stays after the last update. */
  show(text: string, opts: { holdMs?: number; thinking?: boolean; you?: boolean } = {}) {
    clearTimeout(this.hideTimer)
    const t = text.trim()
    if (t !== this.shown) {
      this.text.textContent = t.length > 280 ? '…' + t.slice(-277) : t
      this.shown = t
    }
    this.el.classList.toggle('thinking', !!opts.thinking)
    this.el.classList.toggle('you', !!opts.you)
    this.el.classList.remove('hidden')
    if (opts.holdMs !== 0) this.hideTimer = window.setTimeout(() => this.hide(), opts.holdMs ?? 6000)
  }

  hide() {
    clearTimeout(this.hideTimer)
    this.el.classList.add('hidden')
    this.shown = ''
  }

  /** Keep the bubble over her head and inside the screen. */
  place(x: number, headTopY: number) {
    if (!this.visible) return
    const w = this.el.offsetWidth
    const h = this.el.offsetHeight
    const cx = Math.max(w / 2 + 8, Math.min(window.innerWidth - w / 2 - 8, x))
    const cy = Math.max(h + 8, headTopY - 10)
    this.el.style.left = `${cx}px`
    this.el.style.top = `${cy}px`
  }
}

/** Little chip under her feet: "listening…", "loading voice 40%", "focus 12:40". */
export class StatusChip {
  private readonly el = document.getElementById('status') as HTMLDivElement
  private timer = 0

  set(text: string, kind: '' | 'listening' = '', holdMs = 0) {
    clearTimeout(this.timer)
    if (!text) { this.el.classList.add('hidden'); return }
    this.el.textContent = text
    this.el.className = `status ${kind}`
    if (holdMs) this.timer = window.setTimeout(() => this.el.classList.add('hidden'), holdMs)
  }

  place(x: number, y: number) {
    const w = this.el.offsetWidth
    this.el.style.left = `${Math.max(w / 2 + 4, Math.min(window.innerWidth - w / 2 - 4, x))}px`
    this.el.style.top = `${Math.min(window.innerHeight - 26, y + 4)}px`
  }
}
