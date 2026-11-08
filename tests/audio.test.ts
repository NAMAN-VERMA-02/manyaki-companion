import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioOut } from '../src/core/voice/audioOut'

// A context whose clock only moves when the test says so; `dead` ones never run.
class FakeContext {
  static all: FakeContext[] = []
  currentTime = 0
  state = 'running'
  destination = {}
  started: number[] = []
  listeners: Record<string, () => void> = {}
  constructor() { FakeContext.all.push(this) }
  createGain() { return { connect() {}, gain: { value: 1 } } }
  createAnalyser() { return { connect() {}, fftSize: 0 } }
  createBuffer(_c: number, n: number, rate: number) { return { duration: n / rate, copyToChannel() {} } }
  createBufferSource() {
    return { connect() {}, buffer: null, onended: null, stop() {}, start: (t: number) => this.started.push(t) }
  }
  addEventListener(name: string, cb: () => void) { this.listeners[name] = cb }
  resume() { return Promise.resolve() }
  suspend() { return Promise.resolve() }
  close() { return Promise.resolve() }
}

describe('audio output recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeContext.all = []
    vi.stubGlobal('AudioContext', FakeContext)
    vi.stubGlobal('window', globalThis)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
  const speech = new Float32Array(24000)

  it('rebuilds when the clock stops and replays what had not been heard', () => {
    const out = new AudioOut()
    out.enqueueFloat(speech, 24000)
    expect(out.speaking).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(FakeContext.all).toHaveLength(2)
    expect(FakeContext.all[1].started).toHaveLength(1)
    expect(out.speaking).toBe(true)
  })
  it('leaves a healthy clock alone', () => {
    const out = new AudioOut()
    out.enqueueFloat(speech, 24000)
    for (let i = 0; i < 5; i++) {
      FakeContext.all[0].currentTime += 0.5
      vi.advanceTimersByTime(1000)
    }
    expect(FakeContext.all).toHaveLength(1)
  })
  it('rebuilds on a device error event', () => {
    const out = new AudioOut()
    out.enqueueFloat(speech, 24000)
    FakeContext.all[0].listeners.error()
    expect(FakeContext.all).toHaveLength(2)
    expect(out.speaking).toBe(true)
  })
  it('gives up after repeated failures instead of hanging as "speaking"', () => {
    const out = new AudioOut()
    const ended = vi.fn()
    out.onEnded(ended)
    out.enqueueFloat(speech, 24000)
    vi.advanceTimersByTime(20000)
    expect(ended).toHaveBeenCalled()
    expect(out.speaking).toBe(false)
  })
})
