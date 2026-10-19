import type { VoiceFeatures } from './empathy'

// Prosody of one utterance (16 kHz mono float samples), computed on this PC in a few milliseconds:
// loudness, pitch (normalised autocorrelation), pitch spread in semitones and a syllable-rate proxy.
// No model download, and nothing here is ever sent anywhere; only the empathy label is used.

const MIN_HZ = 70
const MAX_HZ = 420

export function analyzeUtterance(samples: Float32Array, rate = 16000): VoiceFeatures {
  const frame = Math.round(rate * 0.03)
  const hop = Math.round(rate * 0.015)
  const durationSec = samples.length / rate
  if (samples.length < frame * 4) return { energy: 0, pitchHz: 0, pitchVar: 0, rate: 0, durationSec }

  const rms: number[] = []
  for (let s = 0; s + frame <= samples.length; s += hop) {
    let sum = 0
    for (let i = s; i < s + frame; i++) sum += samples[i] * samples[i]
    rms.push(Math.sqrt(sum / frame))
  }
  const sorted = [...rms].sort((a, b) => a - b)
  const p90 = sorted[Math.floor(sorted.length * 0.9)]
  const gate = Math.max(0.008, p90 * 0.25)

  const minLag = Math.floor(rate / MAX_HZ)
  const maxLag = Math.ceil(rate / MIN_HZ)
  const pitches: number[] = []
  let voicedEnergy = 0
  let voicedFrames = 0
  for (let f = 0; f < rms.length; f++) {
    if (rms[f] < gate) continue
    voicedEnergy += rms[f]
    voicedFrames++
    const start = f * hop
    const len = Math.min(frame * 2, samples.length - start) // two frames give enough periods for low voices
    if (len < maxLag * 2) continue
    const hz = pitchOf(samples, start, len, minLag, maxLag, rate)
    if (hz) pitches.push(hz)
  }
  if (!voicedFrames) return { energy: 0, pitchHz: 0, pitchVar: 0, rate: 0, durationSec }

  pitches.sort((a, b) => a - b)
  const pitchHz = pitches.length >= 3 ? pitches[Math.floor(pitches.length / 2)] : 0
  let pitchVar = 0
  if (pitchHz) {
    const st = pitches.map((p) => 12 * Math.log2(p / pitchHz))
    const mean = st.reduce((a, b) => a + b, 0) / st.length
    pitchVar = Math.sqrt(st.reduce((a, b) => a + (b - mean) ** 2, 0) / st.length)
  }

  // Syllable proxy: peaks of the smoothed loudness envelope, at least 110 ms apart.
  const smooth = rms.map((_, i) => (rms[i - 1] ?? rms[i]) * 0.25 + rms[i] * 0.5 + (rms[i + 1] ?? rms[i]) * 0.25)
  const minGap = Math.round(0.11 / (hop / rate))
  let peaks = 0
  let last = -minGap
  for (let i = 1; i < smooth.length - 1; i++) {
    if (smooth[i] > gate * 1.5 && smooth[i] >= smooth[i - 1] && smooth[i] > smooth[i + 1] && i - last >= minGap) {
      peaks++
      last = i
    }
  }
  const voicedSec = (voicedFrames * hop) / rate
  return {
    energy: voicedEnergy / voicedFrames,
    pitchHz,
    pitchVar,
    rate: voicedSec > 0.2 ? peaks / voicedSec : 0,
    durationSec
  }
}

/** Pitch of one window by normalised autocorrelation, or 0 when it isn't clearly periodic. */
function pitchOf(x: Float32Array, start: number, len: number, minLag: number, maxLag: number, rate: number): number {
  let mean = 0
  for (let i = start; i < start + len; i++) mean += x[i]
  mean /= len
  let best = 0
  let bestLag = 0
  const n = len - maxLag
  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0
    let e0 = 0
    let e1 = 0
    for (let i = start; i < start + n; i++) {
      const a = x[i] - mean
      const b = x[i + lag] - mean
      num += a * b
      e0 += a * a
      e1 += b * b
    }
    const r = num / (Math.sqrt(e0 * e1) || 1)
    if (r > best) { best = r; bestLag = lag }
  }
  if (best < 0.55 || !bestLag) return 0
  // Prefer the fundamental: if half the lag is nearly as periodic, the peak we found was an octave below.
  const half = Math.round(bestLag / 2)
  if (half >= minLag) {
    let num = 0, e0 = 0, e1 = 0
    for (let i = start; i < start + n; i++) {
      const a = x[i] - mean
      const b = x[i + half] - mean
      num += a * b; e0 += a * a; e1 += b * b
    }
    if (num / (Math.sqrt(e0 * e1) || 1) > best * 0.92) bestLag = half
  }
  return rate / bestLag
}
