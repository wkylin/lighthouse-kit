import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { analyzeRound, writeAnalysis } from '../src/analyze/index.mjs'
import { mergeFindings } from '../src/analyze/merge.mjs'
import { aggregateMemory } from '../src/memory-summary.mjs'
import { renderDevDoc } from '../src/docs/dev.mjs'
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

test('reanalysis aggregates memory across successful runs, merges findings and preserves per-page evidence', async () => {
  const dir = await makeRound()
  const MiB = 1024 * 1024
  for (const [slug, sizes] of [['m/home', [120, 160, 1000]], ['m/me/about-us', [200, 240, 1000]]]) {
    const file = path.join(dir, 'pages', slug, 'summary.json')
    const summary = JSON.parse(await fs.readFile(file, 'utf8'))
    const representative = summary.runs[0]
    summary.runs = [
      { ...representative, memory: null },
      ...sizes.map((size, i) => ({ ...representative, index: i + 2, ok: i < 2,
        memory: { heapSnapshot: { usedJsHeapSize: size * MiB } } })),
    ]
    summary.memory = { heapSnapshot: { usedJsHeapSize: 0 } }
    await fs.writeFile(file, JSON.stringify(summary))
  }
  const a = await analyzeRound(dir, config)
  assert.equal(a.pages[0].median.memory.heapSnapshot.usedJsHeapSize, 140 * MiB)
  assert.equal(a.pages[0].median.memory.runs, 2)
  assert.equal(a.pages[1].memory.heapSnapshot.usedJsHeapSize, 220 * MiB)
  const finding = a.findings.find((f) => f.id === 'memory-high-heap')
  assert.deepEqual(finding.pages, ['/m/home', '/m/me/about-us'])
  assert.deepEqual(finding.perPage.map((p) => p.evidence[0].bytes), [140 * MiB, 220 * MiB])
  const memoryIndex = a.findings.indexOf(finding)
  assert.ok(a.findings.slice(0, memoryIndex).every((f) => f.group === 'performance'))
  assert.ok(a.findings.slice(memoryIndex + 1).every((f) => f.group !== 'performance'))
  const first = await fs.readFile(path.join(dir, 'analysis.json'), 'utf8')
  await analyzeRound(dir, config)
  assert.equal(await fs.readFile(path.join(dir, 'analysis.json'), 'utf8'), first)
})

test('memory analysis survives missing Lighthouse files and supports old representative-only memory', async () => {
  const dir = await makeRound()
  const file = path.join(dir, 'pages/m/home/summary.json')
  const summary = JSON.parse(await fs.readFile(file, 'utf8'))
  summary.memory = { detachedElements: { detachedCount: 15, detachedMemory: null } }
  await fs.writeFile(file, JSON.stringify(summary))
  await fs.rm(path.join(dir, 'pages/m/home/run-1/lighthouse.json'))
  const a = await analyzeRound(dir, config)
  assert.equal(a.pages[0].median.memory.detachedElements.detachedCount, 15)
  assert.deepEqual(a.findings.find((f) => f.id === 'memory-detached-elements').pages, ['/m/home'])
  assert.ok(!a.facts['/m/home'])
})

test('failed per-run collection does not reuse stale aggregate memory', async () => {
  const dir = await makeRound()
  const file = path.join(dir, 'pages/m/home/summary.json')
  const summary = JSON.parse(await fs.readFile(file, 'utf8'))
  summary.memory = aggregateMemory([{ ok: true, memory: { heapSnapshot: { usedJsHeapSize: 200 * 1024 * 1024 } } }])
  summary.median.memory = summary.memory
  summary.runs[0].memory = null
  await fs.writeFile(file, JSON.stringify(summary))
  const a = await analyzeRound(dir, config)
  assert.equal(a.pages[0].memory, null)
  assert.equal(a.pages[0].median.memory, null)
  assert.ok(!a.findings.some((f) => f.group === 'memory'))
})

test('reanalysis preserves raw evidence links for representative-only legacy memory', async () => {
  const dir = await makeRound()
  const file = path.join(dir, 'pages/m/home/summary.json')
  const summary = JSON.parse(await fs.readFile(file, 'utf8'))
  summary.memory = { heapSnapshot: { usedJsHeapSize: 150 * 1024 * 1024 } }
  await fs.writeFile(file, JSON.stringify(summary))
  const a = await analyzeRound(dir, config)
  assert.ok(renderDevDoc(a).includes('../pages/m/home/run-1/memory.json'))
  assert.equal(a.pages[0].runs[0].memory.heapSnapshot.usedJsHeapSize, 150 * 1024 * 1024)
})

test('reanalysis restores missing per-run memory from raw files before computing medians', async () => {
  const dir = await makeRound()
  const file = path.join(dir, 'pages/m/home/summary.json')
  const summary = JSON.parse(await fs.readFile(file, 'utf8'))
  summary.runs.push({ ...summary.runs[0], index: 2 })
  await fs.writeFile(file, JSON.stringify(summary))
  for (const [index, size] of [[1, 120], [2, 160]]) {
    const runDir = path.join(dir, 'pages/m/home', `run-${index}`)
    await fs.mkdir(runDir, { recursive: true })
    await fs.writeFile(path.join(runDir, 'memory.json'), JSON.stringify({ heapSnapshot: { usedJsHeapSize: size * 1024 * 1024 } }))
  }
  const a = await analyzeRound(dir, config)
  assert.equal(a.pages[0].median.memory.heapSnapshot.usedJsHeapSize, 140 * 1024 * 1024)
  assert.equal(a.pages[0].median.memory.runs, 2)
  assert.equal(a.pages[0].runs[1].memory.heapSnapshot.usedJsHeapSize, 160 * 1024 * 1024)
  assert.ok(renderDevDoc(a).includes('../pages/m/home/run-2/memory.json'))
  assert.ok(a.findings.some((f) => f.id === 'bootup-time'), 'Lighthouse findings remain available')
  const first = await fs.readFile(path.join(dir, 'analysis.json'), 'utf8')
  await analyzeRound(dir, config)
  assert.equal(await fs.readFile(path.join(dir, 'analysis.json'), 'utf8'), first)
})

test('raw memory files do not override explicit failed collection or failed scan runs', async () => {
  const dir = await makeRound()
  const file = path.join(dir, 'pages/m/home/summary.json')
  const summary = JSON.parse(await fs.readFile(file, 'utf8'))
  summary.runs[0].memory = null
  summary.runs.push({ ...summary.runs[0], index: 2, ok: false })
  delete summary.runs[1].memory
  await fs.writeFile(file, JSON.stringify(summary))
  for (const index of [1, 2]) {
    const runDir = path.join(dir, 'pages/m/home', `run-${index}`)
    await fs.mkdir(runDir, { recursive: true })
    await fs.writeFile(path.join(runDir, 'memory.json'), JSON.stringify({ heapSnapshot: { usedJsHeapSize: 200 * 1024 * 1024 } }))
  }
  const a = await analyzeRound(dir, config)
  assert.equal(a.pages[0].runs[0].memory, null)
  assert.ok(!Object.hasOwn(a.pages[0].runs[1], 'memory'))
  assert.ok(!a.findings.some((f) => f.group === 'memory'))
})

test('missing, malformed and invalid raw memory files leave legacy Lighthouse analysis intact', async () => {
  for (const contents of [null, '{broken', 'null', '[]', '"memory"', '{}',
    '{"heapSnapshot":{"usedJsHeapSize":-1}}', '{"allocationTimeline":{"allocations":{}}}',
    '{"heapSnapshot":null,"allocationTimeline":null,"allocationSampling":null,"detachedElements":null}',
    '{"heapSnapshot":null,"allocationTimeline":null,"allocationSampling":null,"detachedElements":null,"collectedAt":"invalid"}']) {
    const dir = await makeRound()
    if (contents != null) await fs.writeFile(path.join(dir, 'pages/m/home/run-1/memory.json'), contents)
    const a = await analyzeRound(dir, config)
    assert.ok(!Object.hasOwn(a.pages[0].runs[0], 'memory'), `invalid file is not adopted: ${contents}`)
    assert.ok(!a.findings.some((f) => f.group === 'memory'))
    assert.ok(a.findings.some((f) => f.id === 'bootup-time'))
    assert.ok(a.facts['/m/home'].topScripts.length > 0)
  }
})

test('all four memory rules from raw files merge across pages and persist in analysis.json', async () => {
  const dir = await makeRound()
  const MiB = 1024 * 1024
  for (const [slug, used] of [['m/home', 150], ['m/me/about-us', 250]]) {
    const raw = {
      heapSnapshot: { usedJsHeapSize: used * MiB, totalJsHeapSize: 300 * MiB, jsHeapSizeLimit: 500 * MiB },
      allocationTimeline: { baselineMemory: 20 * MiB, peakMemory: 40 * MiB, duration: 1000 },
      allocationSampling: { samplingInterval: 32768, duration: 1000, sampleCount: 200, totalAllocatedBytes: 8 * MiB },
      detachedElements: { detachedCount: 20, detachedMemory: null },
    }
    await fs.writeFile(path.join(dir, 'pages', slug, 'run-1/memory.json'), JSON.stringify(raw))
  }
  const analysis = await analyzeRound(dir, config)
  const persisted = JSON.parse(await fs.readFile(path.join(dir, 'analysis.json'), 'utf8'))
  const findings = persisted.findings.filter((f) => f.group === 'memory')
  assert.deepEqual(findings.map((f) => f.id), ['memory-detached-elements', 'memory-high-allocation-rate', 'memory-high-heap', 'memory-rapid-growth'])
  for (const finding of findings) {
    assert.deepEqual(finding.pages, ['/m/home', '/m/me/about-us'])
    assert.equal(finding.perPage.length, 2)
    assert.ok(finding.perPage.every((row) => row.evidence.length > 0))
    assert.equal(finding.impactTotal, 0)
  }
  assert.deepEqual(persisted, analysis)
  assert.equal(persisted.pages[0].median.memory.allocationTimeline.growthRatePerSecond, 20 * MiB)
  assert.equal(persisted.pages[1].median.memory.allocationSampling.allocationRate, 200)
  assert.ok(!persisted.findings.some((f) => f.pages.includes('/m/broken')))
})

test('legacy representative memory joins other inline run observations', async () => {
  const dir = await makeRound()
  const file = path.join(dir, 'pages/m/home/summary.json')
  const summary = JSON.parse(await fs.readFile(file, 'utf8'))
  summary.memory = { heapSnapshot: { usedJsHeapSize: 200 * 1024 ** 2 } }
  summary.runs.push({ ...summary.runs[0], index: 2, memory: { heapSnapshot: { usedJsHeapSize: 0 } } })
  await fs.writeFile(file, JSON.stringify(summary))
  const analysis = await analyzeRound(dir, config)
  const page = analysis.pages[0]
  assert.equal(page.runs[0].memory.heapSnapshot.usedJsHeapSize, 200 * 1024 ** 2)
  assert.equal(page.median.memory.runs, 2)
  assert.equal(page.median.memory.heapSnapshot.usedJsHeapSize, 100 * 1024 ** 2)
  assert.ok(analysis.findings.some((f) => f.id === 'memory-high-heap'))
  assert.ok(renderDevDoc(analysis).includes('../pages/m/home/run-1/memory.json'))
})

test('all-null raw collection keeps its attempted status through analysis and reporting', async () => {
  const dir = await makeRound()
  const memory = { heapSnapshot: null, allocationTimeline: null, allocationSampling: null,
    detachedElements: null, collectedAt: '2026-11-28T00:00:00.000Z' }
  await fs.writeFile(path.join(dir, 'pages/m/home/run-1/memory.json'), JSON.stringify(memory))
  const analysis = await analyzeRound(dir, config)
  assert.deepEqual(analysis.pages[0].runs[0].memory, memory)
  assert.ok(!analysis.findings.some((f) => f.group === 'memory'))
  const md = renderDevDoc(analysis)
  assert.ok(md.includes('## 内存概况'))
  assert.ok(md.includes('本轮内存采集未获得有效数据，无法判断是否存在内存问题'))
  assert.ok(!md.includes('已采集数据未触发内存规则'))
})
