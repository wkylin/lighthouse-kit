import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { analyzeRound, writeAnalysis } from '../src/analyze/index.mjs'
import { mergeFindings } from '../src/analyze/merge.mjs'
import { config, makeRound } from './helpers.mjs'

const f = (id, page, impact, extra = {}) => ({
  id, category: 'main-thread', group: 'performance', title: id, advice: 'a', score: 0, savings: { lcp: 0, tbt: 0, fcp: 0, cls: 0, bytes: 0 }, impact,
  evidence: [{ label: `${id}@${page}` }], ...extra,
})

test('same audit on two pages merges into one finding with both pages', () => {
  const merged = mergeFindings([
    { page: '/a', findings: [f('x', '/a', 10)] },
    { page: '/b', findings: [f('x', '/b', 30), f('y', '/b', 5)] },
  ])
  const x = merged.find((m) => m.id === 'x')
  assert.deepEqual(x.pages, ['/a', '/b'])
  assert.equal(x.impactTotal, 40)
  assert.deepEqual(x.evidence, [{ label: 'x@/b' }], 'evidence comes from the page with the largest impact')
  assert.deepEqual(x.perPage.map((p) => [p.page, p.impact]), [['/a', 10], ['/b', 30]])
  assert.equal(x.ai, null)
})

test('order: performance by impactTotal, bytes, pages count, id; other groups after by pages count then id', () => {
  const bytes = (n) => ({ savings: { lcp: 0, tbt: 0, fcp: 0, cls: 0, bytes: n } })
  const merged = mergeFindings([
    { page: '/a', findings: [f('p-low', '/a', 1), f('p-high', '/a', 50), f('p-tie-b', '/a', 20, bytes(10)), f('p-tie-a', '/a', 20, bytes(10)), f('p-bytes', '/a', 20, bytes(99)),
      f('a11y-one', '/a', 0, { group: 'accessibility', category: 'accessibility' })] },
    { page: '/b', findings: [f('seo-two', '/b', 0, { group: 'seo', category: 'seo' })] },
    { page: '/c', findings: [f('seo-two', '/c', 0, { group: 'seo', category: 'seo' })] },
  ])
  assert.deepEqual(merged.map((m) => m.id), ['p-high', 'p-bytes', 'p-tie-a', 'p-tie-b', 'p-low', 'seo-two', 'a11y-one'])
})

test('analyzeRound reads the representative run, attaches sources and writes analysis.json', async () => {
  const dir = await makeRound()
  const analysis = await analyzeRound(dir, config)
  assert.equal(analysis.round.id, 'r1')
  assert.deepEqual(analysis.pages.map((p) => [p.page, p.ok]), [['/m/home', true], ['/m/me/about-us', true], ['/m/broken', false]])
  assert.deepEqual(analysis.findings.find((x) => x.id === 'unused-javascript').pages, ['/m/home', '/m/me/about-us'])
  assert.deepEqual(analysis.findings.find((x) => x.id === 'bootup-time').pages, ['/m/home'], 'about-us has a passing TBT')
  const mboard = analysis.findings.flatMap((x) => x.evidence).find((e) => e.url?.endsWith('/js/MBoard-q88wBfdR.js'))
  assert.deepEqual(mboard.source, { file: 'src/mobile/ui/MBoard.vue', share: 0.6 })
  assert.ok(analysis.facts['/m/home'].topScripts.length > 0)
  assert.ok(!('/m/broken' in analysis.facts))
  assert.deepEqual(analysis.aiSent, [])
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'analysis.json'), 'utf8'))
  assert.equal(onDisk.findings.length, analysis.findings.length)
})

test('failed pages are listed in pages but produce no findings', async () => {
  const analysis = await analyzeRound(await makeRound(), config)
  assert.ok(analysis.findings.every((x) => !x.pages.includes('/m/broken')))
  assert.equal(analysis.pages.find((p) => p.page === '/m/broken').error, '页面加载超时')
})

test('a page with no summary is reported as not scanned', async () => {
  const dir = await makeRound()
  await fs.rm(path.join(dir, 'pages', 'm/broken'), { recursive: true })
  const analysis = await analyzeRound(dir, config)
  const p = analysis.pages.find((x) => x.page === '/m/broken')
  assert.equal(p.ok, false)
  assert.equal(p.error, '没有扫描结果')
})

test('analysis.json is byte-identical across two runs on the same round', async () => {
  const dir = await makeRound()
  await analyzeRound(dir, config)
  const first = await fs.readFile(path.join(dir, 'analysis.json'))
  const again = await analyzeRound(dir, config)
  assert.ok(first.equals(await fs.readFile(path.join(dir, 'analysis.json'))))
  await writeAnalysis(dir, again)
  assert.ok(first.equals(await fs.readFile(path.join(dir, 'analysis.json'))))
})
