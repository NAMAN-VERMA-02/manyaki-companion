import type { AgentAction, Box, PIIType, Role } from '../../shared/protocol'
import { classifyField } from '../../shared/pii'

// Runs inside each page. Two jobs:
// 1. Perceive: a compact, structured view of what's on screen (interactive elements, visible text, images)
//    with exact geometry. Raw values go only to the extension's own panel on this device; the panel
//    tokenises them before anything is sent anywhere.
// 2. Act: carry out validated actions (click, type, select, scroll) with a visible "agent cursor".
// It never talks to the network itself.

export interface RawElement {
  id: string
  role: Role
  tag: string
  label: string
  /** Text unit holding the element's visible text, for precise span boxes, and that text. */
  unit?: string
  unitText?: string
  value?: string
  box: Box
  checked?: boolean
  disabled?: boolean
  href?: string
  field: PIIType | null
  options?: string[]
}

export interface RawText { unit: string; text: string; box: Box; heading?: boolean }
export interface RawImage { id: string; box: Box; kind: 'img' | 'video' | 'canvas' | 'iframe' | 'svg'; avatar: boolean; payment?: boolean; crossOrigin?: boolean }

export interface Perception {
  page: { host: string; title: string; url: string; viewport: { w: number; h: number }; scrollY: number; scrollMax: number; dpr: number }
  elements: RawElement[]
  texts: RawText[]
  images: RawImage[]
  ms: number
}

export type ContentRequest =
  | { type: 'ping' }
  | { type: 'perceive' }
  | { type: 'rects'; spans: { unit: string; start: number; end: number }[] }
  | { type: 'field-rects'; spans: { id: string; start: number; end: number }[] }
  | { type: 'act'; action: AgentAction; value?: string }
  | { type: 'overlay'; show: boolean }
  | { type: 'privacy-view'; boxes: { box: Box; label: string; kind: 'black' | 'mosaic' }[] | null }
  | { type: 'truth' }

declare global { interface Window { __manyakiEyes?: boolean } }

if (!window.__manyakiEyes) {
  window.__manyakiEyes = true
  init()
}

function init() {
  const ids = new WeakMap<Element, string>()
  const byId = new Map<string, WeakRef<Element>>()
  let seq = 0
  // Text units: the visible text of one block (or one element) and the text nodes it came from, so a
  // character span can be turned back into exact on-screen rectangles.
  let units = new Map<string, { nodes: { node: Text; at: number }[]; text: string; dx: number; dy: number }>()

  const idOf = (el: Element) => {
    let id = ids.get(el)
    if (!id) {
      id = `e${++seq}`
      ids.set(el, id)
      byId.set(id, new WeakRef(el))
    }
    return id
  }
  const elOf = (id: string) => byId.get(id)?.deref() ?? null

  const vw = () => window.innerWidth
  const vh = () => window.innerHeight
  const toBox = (r: DOMRect, dx = 0, dy = 0): Box => ({ x: r.left + dx, y: r.top + dy, w: r.width, h: r.height })
  const onScreen = (b: Box) => b.w >= 2 && b.h >= 2 && b.x < vw() && b.y < vh() && b.x + b.w > 0 && b.y + b.h > 0

  function visible(el: Element): boolean {
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) return false
    return true
  }

  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=option],[role=combobox],[role=searchbox],[role=textbox],[role=slider],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])'

  function roleOf(el: Element): Role {
    const r = el.getAttribute('role')
    const tag = el.tagName.toLowerCase()
    if (r && ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'switch', 'option', 'slider', 'searchbox', 'textbox'].includes(r)) return r as Role
    if (r === 'combobox') return 'select'
    if (tag === 'a') return 'link'
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'select') return 'select'
    if (tag === 'textarea') return 'textarea'
    if (tag === 'input') {
      const t = (el as HTMLInputElement).type
      if (t === 'password') return 'password'
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (t === 'search') return 'searchbox'
      if (t === 'range') return 'slider'
      if (['submit', 'button', 'reset', 'image'].includes(t)) return 'button'
      return 'textbox'
    }
    if ((el as HTMLElement).isContentEditable) return 'textbox'
    return 'other'
  }

  function labelOf(el: Element): string {
    const h = el as HTMLElement
    const aria = el.getAttribute('aria-label')
    if (aria) return aria
    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const t = by.split(/\s+/).map((i) => el.ownerDocument.getElementById(i)?.textContent ?? '').join(' ').trim()
      if (t) return t
    }
    const inp = el as HTMLInputElement
    if (inp.labels?.length) return [...inp.labels].map((l) => l.innerText).join(' ').trim()
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(inp.type)) return inp.value
    const ph = el.getAttribute('placeholder') ?? el.getAttribute('title') ?? el.getAttribute('alt')
    const text = (h.innerText ?? el.textContent ?? '').trim()
    if (text) return text
    if (ph) return ph
    const img = el.querySelector('img[alt],svg[aria-label]')
    return img?.getAttribute('alt') ?? img?.getAttribute('aria-label') ?? (el.getAttribute('name') ?? '')
  }

  /** Records the visible text nodes under `root` as one unit; returns its key. */
  function addUnit(root: Element, key: string, dx = 0, dy = 0): string {
    const nodes: { node: Text; at: number }[] = []
    let text = ''
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const v = n.data
      if (!v.trim() || !n.parentElement || !visible(n.parentElement)) continue
      if (text && !/\s$/.test(text)) text += ' '
      nodes.push({ node: n, at: text.length })
      text += v.replace(/\s+/g, ' ')
      if (text.length > 600) break
    }
    units.set(key, { nodes, text, dx, dy })
    return key
  }

  /** On-screen rectangles for characters [start, end) of a unit. */
  function spanRects(unitKey: string, start: number, end: number): Box[] {
    const u = units.get(unitKey)
    if (!u) return []
    const { dx, dy } = u
    const out: Box[] = []
    for (const { node, at } of u.nodes) {
      const len = node.data.replace(/\s+/g, ' ').length
      const a = Math.max(start, at)
      const b = Math.min(end, at + len)
      if (a >= b) continue
      // Map positions in the collapsed text back to the raw node (whitespace runs collapse to one).
      const raw = node.data
      const map: number[] = []
      for (let i = 0, j = 0; i < raw.length; i++) {
        if (/\s/.test(raw[i]) && i > 0 && /\s/.test(raw[i - 1])) continue
        map[j++] = i
      }
      map.push(raw.length)
      const r = node.ownerDocument.createRange()
      try {
        r.setStart(node, map[a - at] ?? 0)
        r.setEnd(node, map[b - at] ?? raw.length)
        for (const rect of r.getClientRects()) if (rect.width > 0 && rect.height > 0) out.push(toBox(rect, dx, dy))
      } catch { /* node changed since perception */ }
    }
    return out
  }

  /**
   * Rectangles of characters [start, end) of a text field's value. Inputs have no text nodes, so a hidden
   * mirror element with the same box, font and wrapping is laid out at the same spot and measured.
   */
  function fieldRects(el: Element, start: number, end: number): Box[] {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return []
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const m = document.createElement('div')
    const copy = ['boxSizing', 'width', 'height', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize'] as const
    for (const p of copy) m.style[p] = cs[p]
    Object.assign(m.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, visibility: 'hidden', overflow: 'hidden', pointerEvents: 'none', borderColor: 'transparent', margin: '0' })
    const ta = el instanceof HTMLTextAreaElement
    m.style.whiteSpace = ta ? 'pre-wrap' : 'pre'
    m.style.overflowWrap = ta ? 'break-word' : 'normal'
    // Single-line inputs centre their text vertically; match it with the line height.
    if (!ta) m.style.lineHeight = `${r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth)}px`
    const v = el.value
    const span = document.createElement('span')
    span.textContent = v.slice(start, end)
    m.append(document.createTextNode(v.slice(0, start)), span, document.createTextNode(v.slice(end) || ' '))
    document.documentElement.append(m)
    m.scrollTop = el.scrollTop
    m.scrollLeft = el.scrollLeft
    const out = [...span.getClientRects()]
      .map((x) => toBox(x))
      .map((b) => { const x = Math.max(b.x, r.left), y = Math.max(b.y, r.top); return { x, y, w: Math.min(b.x + b.w, r.right) - x, h: Math.min(b.y + b.h, r.bottom) - y } })
      .filter((b) => b.w > 0 && b.h > 0)
    m.remove()
    return out
  }

  const BLOCK = /^(P|LI|TD|TH|H[1-6]|DD|DT|LABEL|FIGCAPTION|BLOCKQUOTE|PRE|CAPTION|SUMMARY|LEGEND|DIV|SPAN|SECTION|ARTICLE|HEADER|FOOTER|ASIDE|STRONG|EM|B|SMALL|CODE)$/
  const PAYMENT_HOST = /(stripe|razorpay|paypal|braintree|adyen|checkout\.com|paytm|phonepe|juspay|cashfree|payu|billdesk|cardinalcommerce|3dsecure)/i

  function perceive(): Perception {
    const t0 = performance.now()
    units = new Map()
    const elements: RawElement[] = []
    const texts: RawText[] = []
    const images: RawImage[] = []
    const seenEl = new Set<Element>()
    const textOwners = new Set<Element>()

    const scan = (doc: Document | ShadowRoot, dx: number, dy: number, depth: number) => {
      if (depth > 4) return
      // Interactive elements.
      for (const el of doc.querySelectorAll(INTERACTIVE)) {
        if (seenEl.has(el) || elements.length >= 250) continue
        const box = toBox(el.getBoundingClientRect(), dx, dy)
        if (!onScreen(box) || !visible(el)) continue
        seenEl.add(el)
        const role = roleOf(el)
        if (role === 'other' && !(el as HTMLElement).onclick && el.getAttribute('tabindex') === null) continue
        const id = idOf(el)
        const inp = el as HTMLInputElement
        const tag = el.tagName.toLowerCase()
        const isField = tag === 'input' || tag === 'textarea' || tag === 'select' || (el as HTMLElement).isContentEditable
        const label = labelOf(el).replace(/\s+/g, ' ').trim().slice(0, 160)
        const e: RawElement = {
          id, role, tag, label, box,
          field: isField ? classifyField({ tag, type: inp.type, name: inp.name, id: el.id, autocomplete: el.getAttribute('autocomplete') ?? '', placeholder: el.getAttribute('placeholder') ?? '', label, ariaLabel: el.getAttribute('aria-label') ?? '', inputMode: el.getAttribute('inputmode') ?? '' }) : null
        }
        if (!isField && label) { e.unit = addUnit(el, `u-${id}`, dx, dy); e.unitText = units.get(e.unit)!.text; textOwners.add(el) }
        if (tag === 'input' && ['checkbox', 'radio'].includes(inp.type)) e.checked = inp.checked
        else if (el.getAttribute('aria-checked')) e.checked = el.getAttribute('aria-checked') === 'true'
        if (tag === 'select') {
          const s = el as HTMLSelectElement
          e.options = [...s.options].slice(0, 30).map((o) => o.text.trim())
          e.value = s.selectedOptions[0]?.text.trim() ?? ''
        } else if (tag === 'input' || tag === 'textarea') {
          if (!['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file', 'hidden'].includes(inp.type) && inp.value) e.value = inp.value.slice(0, 300)
        } else if ((el as HTMLElement).isContentEditable) e.value = ((el as HTMLElement).innerText ?? '').slice(0, 300)
        if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') e.disabled = true
        if (tag === 'a') {
          try { e.href = new URL((el as HTMLAnchorElement).href).host } catch { /* javascript: etc. */ }
        }
        elements.push(e)
      }
      // Images, video, canvas and frames: where faces and text-in-pixels can hide.
      for (const el of doc.querySelectorAll('img,video,canvas,iframe,svg[role=img],picture,[style*="background-image"]')) {
        if (images.length >= 80) break
        const box = toBox(el.getBoundingClientRect(), dx, dy)
        if (!onScreen(box) || box.w < 24 || box.h < 24 || !visible(el)) continue
        const tag = el.tagName.toLowerCase()
        const hint = `${el.getAttribute('alt') ?? ''} ${el.getAttribute('class') ?? ''} ${el.getAttribute('src') ?? ''} ${el.id}`.toLowerCase()
        const kind: RawImage['kind'] = tag === 'video' ? 'video' : tag === 'canvas' ? 'canvas' : tag === 'iframe' ? 'iframe' : tag === 'svg' ? 'svg' : 'img'
        const img: RawImage = { id: idOf(el), box, kind, avatar: /avatar|profile|user|photo|face|selfie|headshot|portrait|dp\b/.test(hint) }
        if (tag === 'iframe') {
          const src = (el as HTMLIFrameElement).src
          let same = false
          try { same = !!(el as HTMLIFrameElement).contentDocument } catch { same = false }
          img.crossOrigin = !same
          img.payment = PAYMENT_HOST.test(src) || /card|payment|checkout|secure/i.test(el.getAttribute('title') ?? el.getAttribute('name') ?? '')
          if (same && (el as HTMLIFrameElement).contentDocument) {
            const r = el.getBoundingClientRect()
            scan((el as HTMLIFrameElement).contentDocument!, dx + r.left, dy + r.top, depth + 1)
          }
        }
        images.push(img)
      }
      // Open shadow roots (web components).
      for (const host of doc.querySelectorAll('*')) {
        const sr = (host as HTMLElement).shadowRoot
        if (sr) scan(sr, dx, dy, depth + 1)
      }
      // Visible prose, grouped by its nearest block.
      const root = doc instanceof Document ? doc.body : doc
      if (!root) return
      const walker = (doc instanceof Document ? doc : doc.ownerDocument).createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const blocks = new Set<Element>()
      for (let n = walker.nextNode(); n && blocks.size < 220; n = walker.nextNode()) {
        if (!n.textContent?.trim()) continue
        let p: Element | null = n.parentElement
        if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue
        if (p.closest(INTERACTIVE)) continue // part of an element's label
        while (p && !BLOCK.test(p.tagName) && p.parentElement) p = p.parentElement
        if (p && !textOwners.has(p)) blocks.add(p)
      }
      for (const b of blocks) {
        // Only the block's own text: skip nested blocks that will be their own unit.
        if ([...blocks].some((o) => o !== b && b.contains(o) && o.textContent?.trim() === b.textContent?.trim())) continue
        const box = toBox(b.getBoundingClientRect(), dx, dy)
        if (!onScreen(box) || !visible(b)) continue
        const key = addUnit(b, `t-${idOf(b)}`, dx, dy)
        const text = units.get(key)!.text.trim()
        if (text.length < 2) continue
        texts.push({ unit: key, text, box, heading: /^H[1-6]$/.test(b.tagName) })
      }
    }
    scan(document, 0, 0, 0)

    const se = document.scrollingElement ?? document.documentElement
    return {
      page: {
        host: location.host,
        title: document.title,
        url: location.href,
        viewport: { w: vw(), h: vh() },
        scrollY: window.scrollY,
        scrollMax: Math.max(0, se.scrollHeight - vh()),
        dpr: window.devicePixelRatio || 1
      },
      elements,
      texts: texts.slice(0, 200),
      images,
      ms: performance.now() - t0
    }
  }

  // ---------- overlay: agent cursor + optional privacy view (kept out of screenshots) ----------
  const host = document.createElement('manyaki-eyes')
  const shadow = host.attachShadow({ mode: 'closed' })
  shadow.innerHTML = `<style>
    :host{all:initial}
    .layer{position:fixed;inset:0;pointer-events:none;z-index:2147483647}
    .cursor{position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:#ff4f9a;box-shadow:0 0 0 4px rgba(255,79,154,.25),0 2px 8px rgba(0,0,0,.3);transition:left .35s cubic-bezier(.3,.7,.2,1),top .35s cubic-bezier(.3,.7,.2,1),opacity .2s;opacity:0}
    .tag{position:fixed;font:600 12px/1.2 system-ui,sans-serif;color:#fff;background:#ff4f9a;padding:3px 7px;border-radius:9px;white-space:nowrap;transform:translate(14px,-50%);transition:left .35s,top .35s,opacity .2s;opacity:0}
    .ring{position:fixed;border:2px solid #ff4f9a;border-radius:6px;box-shadow:0 0 0 3px rgba(255,79,154,.2);transition:all .25s;opacity:0}
    .pv{position:fixed;display:flex;align-items:center;justify-content:center;font:700 10px/1 ui-monospace,monospace;color:#fff;overflow:hidden;border-radius:2px}
    .pv.black{background:#111}
    .pv.mosaic{background:repeating-conic-gradient(#777 0 25%,#999 0 50%) 0 0/10px 10px;backdrop-filter:blur(12px)}
  </style><div class="layer"><div class="pvs"></div><div class="ring"></div><div class="cursor"></div><div class="tag"></div></div>`
  const layer = shadow.querySelector('.layer') as HTMLElement
  const cursor = shadow.querySelector('.cursor') as HTMLElement
  const tag = shadow.querySelector('.tag') as HTMLElement
  const ring = shadow.querySelector('.ring') as HTMLElement
  const pvs = shadow.querySelector('.pvs') as HTMLElement
  const mount = () => { if (!host.isConnected) document.documentElement.append(host) }

  function pointAt(el: Element, text: string) {
    mount()
    const r = el.getBoundingClientRect()
    const x = r.left + Math.min(r.width / 2, 40)
    const y = r.top + r.height / 2
    Object.assign(cursor.style, { left: `${x}px`, top: `${y}px`, opacity: '1' })
    Object.assign(tag.style, { left: `${x}px`, top: `${y}px`, opacity: '1' })
    tag.textContent = text
    Object.assign(ring.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px`, opacity: '1' })
    clearTimeout(fade)
    fade = window.setTimeout(() => { for (const n of [cursor, tag, ring]) n.style.opacity = '0' }, 2500)
  }
  let fade = 0

  function privacyView(boxes: { box: Box; label: string; kind: 'black' | 'mosaic' }[] | null) {
    pvs.innerHTML = ''
    if (!boxes) return
    mount()
    for (const b of boxes) {
      const d = document.createElement('div')
      d.className = `pv ${b.kind}`
      Object.assign(d.style, { left: `${b.box.x}px`, top: `${b.box.y}px`, width: `${b.box.w}px`, height: `${b.box.h}px` })
      if (b.box.w > 40 && b.box.h > 10) d.textContent = b.label
      pvs.append(d)
    }
  }

  // ---------- acting ----------
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    // Frameworks (React, Vue) track the value through the prototype setter; use it so they see the change.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  async function ensureVisible(el: Element) {
    const r = el.getBoundingClientRect()
    if (r.top < 0 || r.bottom > vh() || r.left < 0 || r.right > vw()) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior })
      await sleep(80)
    }
  }

  function clickLike(el: Element) {
    const r = el.getBoundingClientRect()
    const opts = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window }
    el.dispatchEvent(new PointerEvent('pointerdown', opts))
    el.dispatchEvent(new MouseEvent('mousedown', opts))
    ;(el as HTMLElement).focus?.({ preventScroll: true })
    el.dispatchEvent(new PointerEvent('pointerup', opts))
    el.dispatchEvent(new MouseEvent('mouseup', opts))
    ;(el as HTMLElement).click()
  }

  async function act(a: AgentAction, value?: string): Promise<{ ok: boolean; note?: string }> {
    switch (a.type) {
      case 'scroll': {
        window.scrollBy({ top: (a.direction === 'up' ? -1 : 1) * (a.amount ?? 0.8) * vh(), behavior: 'instant' as ScrollBehavior })
        await sleep(120)
        return { ok: true, note: `now at ${Math.round(window.scrollY)}px` }
      }
      case 'wait': await sleep(a.ms); return { ok: true }
      case 'navigate': location.href = a.url; return { ok: true }
      case 'done': case 'ask_user': return { ok: true }
    }
    const el = elOf(a.id)
    if (!el || !el.isConnected) return { ok: false, note: 'element is gone (the page changed)' }
    await ensureVisible(el)
    switch (a.type) {
      case 'click': {
        pointAt(el, 'click')
        await sleep(260)
        clickLike(el)
        return { ok: true }
      }
      case 'type': {
        pointAt(el, 'typing…')
        await sleep(200)
        const text = value ?? a.text
        const h = el as HTMLElement
        h.focus({ preventScroll: true })
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) setNativeValue(el, text)
        else if (h.isContentEditable) {
          document.getSelection()?.selectAllChildren(h)
          document.execCommand('insertText', false, text)
        } else return { ok: false, note: 'not a text field' }
        if (a.submit) {
          await sleep(60)
          const form = (el as HTMLInputElement).form
          const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
          const proceed = el.dispatchEvent(new KeyboardEvent('keydown', key))
          el.dispatchEvent(new KeyboardEvent('keyup', key))
          if (proceed && form) form.requestSubmit()
        }
        return { ok: true }
      }
      case 'select': {
        pointAt(el, 'select')
        if (el instanceof HTMLSelectElement) {
          const want = (value ?? a.option).trim().toLowerCase()
          const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want) ?? [...el.options].find((o) => o.text.toLowerCase().includes(want))
          if (!opt) return { ok: false, note: `no option "${a.option.slice(0, 40)}"` }
          el.value = opt.value
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          return { ok: true }
        }
        clickLike(el)
        return { ok: true, note: 'opened the list; choose next step' }
      }
      case 'check': {
        pointAt(el, a.checked ? 'tick' : 'untick')
        const cur = el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true'
        if (cur !== a.checked) clickLike(el)
        return { ok: true }
      }
    }
    return { ok: false, note: 'unknown action' }
  }

  /** Benchmark ground truth: elements the fixture marks with data-truth="EMAIL" etc. */
  function truth() {
    const out: { type: string; boxes: Box[] }[] = []
    for (const el of document.querySelectorAll('[data-truth]')) {
      // data-truth-span marks a substring of a field's value as the private part.
      const sub = el.getAttribute('data-truth-span')
      const v = (el as HTMLInputElement).value ?? ''
      const at = sub ? v.indexOf(sub) : -1
      const boxes = (at >= 0 ? fieldRects(el, at, at + sub!.length) : [...el.getClientRects()].filter((r) => r.width > 0 && r.height > 0).map((r) => toBox(r))).filter(onScreen)
      if (boxes.length) out.push({ type: el.getAttribute('data-truth')!, boxes })
    }
    const ui = [...document.querySelectorAll('[data-truth-ui]')].map((el) => ({ label: el.getAttribute('data-truth-ui')!, box: toBox(el.getBoundingClientRect()) })).filter((u) => onScreen(u.box))
    return { items: out, ui, title: document.title, meta: Object.fromEntries([...document.querySelectorAll('meta[name^="eyes-"]')].map((m) => [m.getAttribute('name')!, m.getAttribute('content') ?? ''])) }
  }

  chrome.runtime.onMessage.addListener((msg: ContentRequest, _sender, reply) => {
    void (async () => {
      try {
        switch (msg.type) {
          case 'ping': return reply({ ok: true })
          case 'perceive': return reply(perceive())
          case 'rects': return reply(msg.spans.map((s) => spanRects(s.unit, s.start, s.end)))
          case 'field-rects': return reply(msg.spans.map((s) => { const el = elOf(s.id); return el ? fieldRects(el, s.start, s.end) : [] }))
          case 'act': return reply(await act(msg.action, msg.value))
          case 'overlay': layer.style.visibility = msg.show ? 'visible' : 'hidden'; return reply({ ok: true })
          case 'privacy-view': privacyView(msg.boxes); return reply({ ok: true })
          case 'truth': return reply(truth())
        }
      } catch (e) {
        reply({ ok: false, error: (e as Error).message })
      }
    })()
    return true // async reply
  })
}
