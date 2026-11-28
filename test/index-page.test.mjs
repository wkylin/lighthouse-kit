import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { analyzeRound } from '../src/analyze/index.mjs'
import { writeIndex } from '../src/report/index-page.mjs'
import { writeLighthouseHtml } from '../src/report/lighthouse-html.mjs'
import { config, makeRound } from './helpers.mjs'

test('index page links each page report and both docs, marks failed pages, shows Agentic as pass/total', async () => {
  const dir = await makeRound()
  const analysis = await analyzeRound(dir, config)
  const file = writeIndex(dir, analysis, ['dev', 'lead'])
  assert.equal(file, path.join(dir, 'index.html'))
  const html = await fs.readFile(file, 'utf8')
  assert.ok(html.includes('href="pages/m/home/run-1/lighthouse.html"'))
  assert.ok(html.includes('href="pages/m/me/about-us/run-1/lighthouse.html"'))
  assert.ok(html.includes('href="docs/dev.html"') && html.includes('href="docs/lead.html"'))
  assert.ok(html.includes('/m/broken') && html.includes('页面加载超时'))
  assert.ok(html.includes('>1/4<'), 'agentic shown as passed/total')
  assert.ok(html.includes('https://localhost:4443'))
  assert.ok(html.includes('prefers-color-scheme: dark'))
})

test('index page only links the docs that were generated', async () => {
  const dir = await makeRound()
  const html = await fs.readFile(writeIndex(dir, await analyzeRound(dir, config), ['lead']), 'utf8')
  assert.ok(!html.includes('docs/dev.html'))
  assert.ok(html.includes('docs/lead.html'))
})

test('writeLighthouseHtml writes the Lighthouse report next to its json', async () => {
  const dir = await makeRound()
  const json = path.join(dir, 'pages/m/home/run-1/lighthouse.json')
  const out = writeLighthouseHtml(json)
  assert.equal(out, path.join(dir, 'pages/m/home/run-1/lighthouse.html'))
  const html = await fs.readFile(out, 'utf8')
  assert.ok(html.includes('__LIGHTHOUSE_JSON__'))
  assert.ok(html.length > 100000)
})

async function memoryRound() {
  const dir = await makeRound()
  const file = path.join(dir, 'pages/m/home/summary.json')
  const summary = JSON.parse(await fs.readFile(file, 'utf8'))
  const mib = 1024 ** 2
  summary.runs[0].memory = {
    heapSnapshot: { usedJsHeapSize: 140 * mib, jsHeapSizeLimit: 200 * mib },
    allocationTimeline: { baselineMemory: 100 * mib, peakMemory: 120 * mib, duration: 2000 },
    allocationSampling: { samplingInterval: 32768, duration: 1000, sampleCount: 120, totalAllocatedBytes: 120 * 32768 },
    detachedElements: { detachedCount: 12, detachedMemory: null },
  }
  await fs.writeFile(file, JSON.stringify(summary))
  return { dir, analysis: await analyzeRound(dir, config) }
}

test('overview shows all four memory findings, measurements, advice and raw links without docs', async () => {
  const { dir, analysis } = await memoryRound()
  const html = await fs.readFile(writeIndex(dir, analysis, []), 'utf8')
  assert.ok(html.includes('内存概况'))
  for (const value of ['140 MiB', '70%', '10 MiB/s', '120 样本/s']) assert.ok(html.includes(value), value)
  for (const id of ['memory-high-heap', 'memory-rapid-growth', 'memory-high-allocation-rate', 'memory-detached-elements']) {
    const finding = analysis.findings.find((f) => f.id === id)
    assert.ok(html.includes(finding.title), id)
    assert.ok(html.includes(finding.advice), id)
    for (const evidence of finding.perPage[0].evidence) assert.ok(html.includes(evidence.label), evidence.label)
  }
  assert.ok(html.includes('href="./pages/m/home/run-1/memory.json"'))
  assert.ok(!html.includes('../pages/m/home/run-1/memory.json'), 'overview links resolve within this round')
  assert.ok(!html.includes('docs/dev.html') && !html.includes('docs/lead.html'))
  assert.ok(html.includes('不计入 Lighthouse 分数'))
  assert.ok(!/NaN|Infinity|undefined/.test(html))
})

test('overview preserves each affected page measurement when memory findings merge', async () => {
  const { dir, analysis } = await memoryRound()
  const home = analysis.findings.find((f) => f.id === 'memory-high-heap')
  home.pages.push('/m/me/about-us')
  home.perPage.push({ page: '/m/me/about-us', impact: 0, evidence: [{ label: '已用 JS 堆 240.0 MiB' }] })
  const html = await fs.readFile(writeIndex(dir, analysis), 'utf8')
  assert.ok(html.includes('/m/home：已用 JS 堆 140.0 MiB'))
  assert.ok(html.includes('/m/me/about-us：已用 JS 堆 240.0 MiB'))
})

test('overview distinguishes no findings, unsuccessful collection and legacy rounds', async () => {
  const { dir, analysis } = await memoryRound()
  analysis.findings = analysis.findings.filter((f) => f.group !== 'memory')
  let html = await fs.readFile(writeIndex(dir, analysis), 'utf8')
  assert.ok(html.includes('已采集数据未触发内存规则'))
  analysis.pages[0].runs[0].memory = null
  html = await fs.readFile(writeIndex(dir, analysis), 'utf8')
  assert.ok(html.includes('本轮内存采集未获得有效数据，无法判断'))
  assert.ok(!html.includes('已采集数据未触发内存规则'))
  assert.ok(!html.includes('href="./pages/m/home/run-1/memory.json"'))
  delete analysis.pages[0].runs[0].memory
  delete analysis.pages[0].memory
  delete analysis.pages[0].median.memory
  html = await fs.readFile(writeIndex(dir, analysis), 'utf8')
  assert.ok(!html.includes('内存概况'))
})

test('overview escapes HTML in memory evidence and advice', async () => {
  const { dir, analysis } = await memoryRound()
  const finding = analysis.findings.find((f) => f.group === 'memory')
  finding.title = '<script>alert("title")</script>'
  finding.advice = '<img src=x onerror=alert(1)>'
  finding.perPage[0].evidence[0].label = '<script>alert("evidence")</script>'
  const html = await fs.readFile(writeIndex(dir, analysis), 'utf8')
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('&lt;img'))
  assert.ok(!html.includes('<script>') && !html.includes('<img src=x'))
})
