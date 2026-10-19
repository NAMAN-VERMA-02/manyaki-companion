// Loads the built extension into a throwaway browser profile, runs the benchmark page against a running
// Eyes server, and prints the scores. Your own browser profile is never touched.
//
//   npm run eyes:build && npm run eyes:server   (in another terminal)
//   node eyes/tests/run-bench.mjs [--deep] [--headed] [--reps 3] [--browser "C:\...\msedge.exe"]

import { chromium } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = resolve(here, '../extension/dist')
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const flag = (k) => process.argv.includes(k)
const candidates = [arg('--browser'), process.env.EYES_BROWSER, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean)
const executablePath = candidates.find((p) => existsSync(p))
const server = arg('--server', 'http://127.0.0.1:47821')

const profile = mkdtempSync(join(tmpdir(), 'eyes-bench-'))
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath,
  headless: !flag('--headed'),
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--enable-unsafe-webgpu'].filter((a) => flag('--headed') ? a !== '--headless=new' : true)
})
try {
  let [sw] = ctx.serviceWorkers()
  sw ??= await ctx.waitForEvent('serviceworker', { timeout: 15000 })
  const id = new URL(sw.url()).host
  console.log(`extension ${id} loaded in ${executablePath ?? 'bundled chromium'}`)
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[bench console] ${m.text().slice(0, 300)}`) })
  await page.goto(`chrome-extension://${id}/bench.html`)
  await page.evaluate((s) => chrome.storage.local.set({ settings: { serverUrl: s, pairing: '', sendImage: true, maxSteps: 8, faces: true, deep: false } }), server)
  if (flag('--deep')) await page.check('#deep')
  await page.fill('#reps', arg('--reps', '3'))
  await page.click('#go')
  // The benchmark opens fixture tabs; keep the bench page alive until it says Done.
  await page.waitForFunction(() => /^Done|Could not/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 15 * 60000, polling: 1000 })
  const summary = await page.$$eval('#summary tr', (rows) => rows.map((r) => [...r.children].map((c) => c.textContent)))
  const pages = await page.$$eval('#pages tr', (rows) => rows.map((r) => [...r.children].map((c) => c.textContent)))
  console.log('\nSCORES'); for (const [a, b] of summary) console.log(`  ${a.padEnd(58)} ${b}`)
  console.log('\nPER PAGE'); for (const r of pages) console.log('  ' + r.map((c, i) => (i === 0 ? c.padEnd(14) : c.padStart(9))).join(''))
  console.log(`\n${await page.textContent('#status')}`)
  const out = join(here, `bench-${Date.now()}.json`)
  writeFileSync(out, JSON.stringify({ summary, pages }, null, 2))
  await page.screenshot({ path: out.replace(/\.json$/, '.png'), fullPage: true })
  console.log(`saved ${out}`)
} finally {
  await ctx.close()
  rmSync(profile, { recursive: true, force: true })
}
