import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { compareRounds } from '../src/compare.mjs'
import { pageSlug } from '../src/round.mjs'

const metrics = (lcp, tbt) => ({ fcp: 2000, lcp, tbt, cls: 0.01, si: 5000 })
const scores = (perf) => ({ perf, a11y: 90, bp: 100, seo: 83, agentic: null })

async function round(outDir, id, pages, meta = {}) {
  const dir = path.join(outDir, 'runs', id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'round.json'), JSON.stringify({
    id, name: id, partial: false, pagesRequested: Object.keys(pages), origin: 'https://localhost:4443', startedAt: '2026-11-24T10:00:00.000Z',
    finishedAt: '2026-11-24T10:10:00.000Z', status: 'complete', failedPages: [], lighthouseVersion: '13.5.0', visit: 'first', formFactor: 'mobile', runs: 1,
    git: null, buildFingerprint: null, ...meta,
  }))
  for (const [page, v] of Object.entries(pages)) {
    const slug = pageSlug(page)
    await fs.mkdir(path.join(dir, 'pages', slug), { recursive: true })
    const ok = v !== null
    await fs.writeFile(path.join(dir, 'pages', slug, 'summary.json'), JSON.stringify({ page, slug, ok, error: ok ? null : '超时', finalUrl: v?.finalUrl ?? null, runs: [],
      representative: ok ? 1 : null, median: ok ? { scores: scores(v.perf), metrics: metrics(v.lcp, v.tbt) } : null }))
  }
}

test('pages in both rounds get score and metric deltas; pages in one round are listed apart', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-compare-'))
  await round(out, 'base', { '/a': { perf: 40, lcp: 6000, tbt: 1500 }, '/b': { perf: 50, lcp: 5000, tbt: 900 }, '/old': { perf: 60, lcp: 3000, tbt: 100 }, '/flaky': { perf: 70, lcp: 2000, tbt: 50 } })
  await round(out, 'new', { '/a': { perf: 53, lcp: 5500, tbt: 700 }, '/b': { perf: 48, lcp: 5200, tbt: 950 }, '/added': { perf: 80, lcp: 2000, tbt: 10 }, '/flaky': null })
  const r = await compareRounds(out, 'base', 'new')
  assert.equal(r.mdPath, path.join(out, 'compare', 'base-vs-new.md'))
  assert.equal(r.htmlPath, path.join(out, 'compare', 'base-vs-new.html'))
  assert.equal(await fs.readFile(r.mdPath, 'utf8'), r.md)
  assert.ok((await fs.readFile(r.htmlPath, 'utf8')).includes('<table'))
  const rowA = r.md.split('\n').find((l) => l.startsWith('| /a |'))
  assert.ok(rowA.includes('40 → 53') && rowA.includes('+13'))
  assert.ok(rowA.includes('6.0 s → 5.5 s') && rowA.includes('-0.5 s'))
  assert.ok(rowA.includes('1500 ms → 700 ms') && rowA.includes('-800 ms'))
  assert.ok(r.md.split('\n').find((l) => l.startsWith('| /b |')).includes('-2'))
  assert.ok(r.md.includes('只在 base 中：/old'))
  assert.ok(r.md.includes('只在 new 中：/added'))
  assert.ok(r.md.includes('/flaky') && r.md.includes('有一轮扫描失败'))
  assert.ok(!r.md.split('\n').some((l) => l.startsWith('| /old |') || l.startsWith('| /flaky |')))
})

test('different origin, lighthouse major, visit or formFactor puts a warning line at the top', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-compare-'))
  await round(out, 'local', { '/a': { perf: 40, lcp: 6000, tbt: 1500 } })
  await round(out, 'staging', { '/a': { perf: 50, lcp: 5000, tbt: 900 } }, { origin: 'https://staging.test', lighthouseVersion: '12.8.2', visit: 'repeat' })
  const { md } = await compareRounds(out, 'local', 'staging')
  const warning = md.split('\n').find((l) => l.startsWith('> 注意'))
  assert.ok(warning && md.indexOf(warning) < md.indexOf('| 页面 |'))
  for (const word of ['目标地址', 'Lighthouse 版本', '访问方式']) assert.ok(warning.includes(word), word)
  const same = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-compare-'))
  await round(same, 'x', { '/a': { perf: 40, lcp: 6000, tbt: 1500 } })
  await round(same, 'y', { '/a': { perf: 41, lcp: 6000, tbt: 1500 } }, { lighthouseVersion: '13.4.0' })
  assert.ok(!(await compareRounds(same, 'x', 'y')).md.includes('> 注意'), 'minor version differences are fine')
})

test('a median row closes the table', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-compare-'))
  await round(out, 'base', { '/a': { perf: 40, lcp: 6000, tbt: 1500 }, '/b': { perf: 50, lcp: 5000, tbt: 900 }, '/c': { perf: 60, lcp: 4000, tbt: 300 } })
  await round(out, 'new', { '/a': { perf: 45, lcp: 5000, tbt: 1000 }, '/b': { perf: 55, lcp: 4000, tbt: 500 }, '/c': { perf: 65, lcp: 3000, tbt: 100 } })
  const lines = (await compareRounds(out, 'base', 'new')).md.split('\n')
  const tableEnd = lines.findIndex((l, i) => l.startsWith('|') && !(lines[i + 1] ?? '').startsWith('|'))
  assert.ok(lines[tableEnd].startsWith('| 中位数 |'))
  assert.ok(lines[tableEnd].includes('50 → 55') && lines[tableEnd].includes('+5'))
})

test('a page that redirected in either round is marked in its row', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-compare-'))
  await round(out, 'base', { '/me': { perf: 40, lcp: 6000, tbt: 1500 } })
  await round(out, 'new', { '/me': { perf: 90, lcp: 2000, tbt: 100, finalUrl: 'https://localhost:4443/login?next=/me' } })
  const row = (await compareRounds(out, 'base', 'new')).md.split('\n').find((l) => l.startsWith('| /me'))
  assert.ok(row.includes('跳转到 /login'), row)
})

test('different run counts and partial or interrupted rounds are flagged', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-compare-'))
  await round(out, 'one', { '/a': { perf: 40, lcp: 6000, tbt: 1500 } })
  await round(out, 'three', { '/a': { perf: 50, lcp: 5000, tbt: 900 } }, { runs: 3, partial: true, status: 'aborted' })
  const warning = (await compareRounds(out, 'one', 'three')).md.split('\n').find((l) => l.startsWith('> 注意'))
  for (const word of ['每页次数', '部分页面', '中断']) assert.ok(warning?.includes(word), word)
})
