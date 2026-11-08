import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { blockedInPrivateMode } from '../electron/netguard'

describe('private mode network guard', () => {
  it('blocks the Gemini host over https and wss, including subdomains', () => {
    expect(blockedInPrivateMode(true, 'https://generativelanguage.googleapis.com/v1beta/models')).toBe(true)
    expect(blockedInPrivateMode(true, 'wss://generativelanguage.googleapis.com/ws/x')).toBe(true)
    expect(blockedInPrivateMode(true, 'https://eu.generativelanguage.googleapis.com/')).toBe(true)
  })

  it('blocks nothing when private mode is off', () => {
    expect(blockedInPrivateMode(false, 'https://generativelanguage.googleapis.com/v1beta/models')).toBe(false)
  })

  it('does not block local files, the dev server or model download hosts', () => {
    for (const u of ['file:///C:/app/index.html', 'http://localhost:5173/', 'manyaki-asset://models/x.vrm', 'https://huggingface.co/x/y.onnx', 'data:text/plain,hi'])
      expect(blockedInPrivateMode(true, u)).toBe(false)
  })

  it('is not fooled by lookalike hosts or junk input', () => {
    expect(blockedInPrivateMode(true, 'https://generativelanguage.googleapis.com.evil.example/')).toBe(false) // a different host, not Gemini
    expect(blockedInPrivateMode(true, 'not a url')).toBe(false)
  })
})

describe('renderer connect-src allowlist', () => {
  // If a new host is added to the page's Content-Security-Policy, this fails until someone decides whether it can
  // receive user data (and, if so, adds it to USER_DATA_HOSTS in electron/netguard.ts).
  it('lists only known hosts', () => {
    const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8')
    const csp = html.match(/content="([^"]*default-src[^"]*)"/)?.[1] ?? ''
    const connect = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src')) ?? ''
    const hosts = connect.split(/\s+/).slice(1).filter((t) => t.includes('.')).sort()
    expect(hosts).toEqual([
      'https://*.hf.co',
      'https://*.huggingface.co',
      'https://cdn.jsdelivr.net',
      'https://generativelanguage.googleapis.com',
      'https://huggingface.co',
      'wss://generativelanguage.googleapis.com',
    ])
  })
})
