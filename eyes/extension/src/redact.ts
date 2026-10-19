import type { Box, PIIType } from '../../shared/protocol'

// Draws redactions onto a copy of the screenshot. Text and secrets become solid black bars labelled with
// their token (so the server knows *what* is there, never *which*); faces become a coarse mosaic with
// noise (unlike a blur, it can't be sharpened back), labelled FACE. Only the redacted copy is ever encoded.

export interface Mark { box: Box; type: PIIType; token: string }

const MOSAIC: Set<PIIType> = new Set(['FACE'])

export function redact(src: HTMLCanvasElement, marks: Mark[]): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = src.width
  out.height = src.height
  const ctx = out.getContext('2d')!
  ctx.drawImage(src, 0, 0)
  const tmp = document.createElement('canvas')
  const tctx = tmp.getContext('2d')!
  for (const m of marks) {
    const b = clampBox(m.box, out.width, out.height)
    if (b.w < 1 || b.h < 1) continue
    if (MOSAIC.has(m.type)) {
      // Downsample to ~8 cells across, upscale with no smoothing, then add noise.
      const cells = Math.max(4, Math.min(10, Math.round(b.w / 12)))
      tmp.width = cells
      tmp.height = Math.max(3, Math.round((cells * b.h) / b.w))
      tctx.imageSmoothingEnabled = true
      tctx.drawImage(out, b.x, b.y, b.w, b.h, 0, 0, tmp.width, tmp.height)
      const px = tctx.getImageData(0, 0, tmp.width, tmp.height)
      for (let i = 0; i < px.data.length; i += 4) {
        const n = (Math.random() - 0.5) * 60
        px.data[i] = clamp8(px.data[i] * 0.6 + 70 + n)
        px.data[i + 1] = clamp8(px.data[i + 1] * 0.6 + 70 + n)
        px.data[i + 2] = clamp8(px.data[i + 2] * 0.6 + 70 + n)
      }
      tctx.putImageData(px, 0, 0)
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, b.x, b.y, b.w, b.h)
      ctx.imageSmoothingEnabled = true
    } else {
      ctx.fillStyle = '#0b0b0f'
      ctx.fillRect(b.x - 1, b.y - 1, b.w + 2, b.h + 2)
    }
    label(ctx, b, m.type === 'FACE' ? 'FACE' : m.token.replace(/^\[\[|\]\]$/g, ''))
  }
  return out
}

function label(ctx: CanvasRenderingContext2D, b: Box, text: string) {
  const size = Math.max(8, Math.min(13, b.h * 0.6))
  ctx.font = `700 ${size}px ui-monospace, Consolas, monospace`
  const w = ctx.measureText(text).width
  if (w + 6 > b.w && b.h < size * 2) return
  ctx.fillStyle = 'rgba(255,79,154,.95)'
  ctx.fillRect(b.x, b.y, Math.min(b.w, w + 6), size + 4)
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'top'
  ctx.fillText(text, b.x + 3, b.y + 2, b.w - 6)
}

const clamp8 = (v: number) => Math.max(0, Math.min(255, v))
function clampBox(b: Box, W: number, H: number): Box {
  const x = Math.max(0, Math.floor(b.x)), y = Math.max(0, Math.floor(b.y))
  return { x, y, w: Math.min(W, Math.ceil(b.x + b.w)) - x, h: Math.min(H, Math.ceil(b.y + b.h)) - y }
}

/** Screenshot data URL -> canvas at CSS-pixel scale (so boxes from the page map 1:1). */
export async function toCanvas(dataUrl: string, cssW: number, cssH: number): Promise<HTMLCanvasElement> {
  const img = await createImageBitmap(await (await fetch(dataUrl)).blob())
  const c = document.createElement('canvas')
  c.width = cssW
  c.height = cssH
  c.getContext('2d')!.drawImage(img, 0, 0, cssW, cssH)
  img.close()
  return c
}

/** JPEG base64 (no data: prefix), scaled down to `maxW` for the wire. */
export function encode(c: HTMLCanvasElement, maxW = 1280, quality = 0.72): string {
  const scale = Math.min(1, maxW / c.width)
  let src = c
  if (scale < 1) {
    src = document.createElement('canvas')
    src.width = Math.round(c.width * scale)
    src.height = Math.round(c.height * scale)
    src.getContext('2d')!.drawImage(c, 0, 0, src.width, src.height)
  }
  return src.toDataURL('image/jpeg', quality).split(',')[1]
}
