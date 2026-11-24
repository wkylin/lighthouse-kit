import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { CATEGORY_ORDER, RULES, findingsForPage, impactOf, pageFacts } from '../src/analyze/normalize.mjs'

const home = JSON.parse(fs.readFileSync(new URL('./fixtures/home.json', import.meta.url), 'utf8'))

test('rules map Lighthouse 13 audit ids to categories', () => {
  const expected = {
    'bootup-time': 'main-thread', 'mainthread-work-breakdown': 'main-thread', 'long-tasks': 'main-thread', 'forced-reflow-insight': 'main-thread',
    'unused-javascript': 'javascript', 'legacy-javascript-insight': 'javascript', 'duplicated-javascript-insight': 'javascript', 'unused-css-rules': 'css',
    'lcp-breakdown-insight': 'lcp', 'lcp-discovery-insight': 'lcp', 'render-blocking-insight': 'render-blocking', 'network-dependency-tree-insight': 'network',
    'document-latency-insight': 'network', 'modern-http-insight': 'network', redirects: 'network', 'image-delivery-insight': 'images', 'cache-insight': 'cache',
    'third-parties-insight': 'third-party', 'non-composited-animations': 'animation', 'cls-culprits-insight': 'layout-shift', 'dom-size-insight': 'dom',
    'font-display-insight': 'fonts', 'bf-cache': 'bfcache', 'viewport-insight': 'viewport',
  }
  for (const [id, cat] of Object.entries(expected)) assert.equal(RULES[id]?.category, cat, id)
  for (const rule of Object.values(RULES)) {
    assert.ok(rule.title && rule.advice, 'every rule has a title and advice')
    assert.ok(CATEGORY_ORDER.includes(rule.category), rule.category)
  }
})

test('home fixture findings', () => {
  const f = findingsForPage(home)
  const ids = f.map((x) => x.id)
  for (const id of ['bootup-time', 'mainthread-work-breakdown', 'unused-javascript', 'render-blocking-insight', 'cache-insight', 'image-delivery-insight', 'bf-cache'])
    assert.ok(ids.includes(id), id)
  for (const id of ['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'speed-index', 'interactive', 'max-potential-fid'])
    assert.ok(!ids.includes(id), `metric ${id} is not a finding`)
  const bootup = f.find((x) => x.id === 'bootup-time')
  assert.equal(bootup.savings.tbt, home.audits['bootup-time'].metricSavings.TBT)
  assert.equal(bootup.group, 'performance')
  assert.equal(bootup.category, 'main-thread')
  assert.equal(bootup.title, RULES['bootup-time'].title)
  assert.equal(bootup.evidence[0].url, home.audits['bootup-time'].details.items[0].url)
  assert.equal(bootup.evidence[0].ms, Math.round(home.audits['bootup-time'].details.items[0].total))
  const unused = f.find((x) => x.id === 'unused-javascript')
  assert.equal(unused.savings.bytes, home.audits['unused-javascript'].details.overallSavingsBytes)
  assert.ok(f.every((x) => x.evidence.length <= 10))
  assert.ok(f.filter((x) => x.group !== 'performance').every((x) => ['accessibility', 'best-practices', 'seo', 'agentic-browsing'].includes(x.group)))
  assert.ok(f.some((x) => x.group === 'agentic-browsing'), 'the failing agentic checks are findings')
})

test('impact weights LCP 25%, TBT 30%, FCP 10% and CLS 25% (CLS counted per 0.001)', () => {
  assert.equal(impactOf({ lcp: 400, tbt: 1000, fcp: 100, cls: 0.1, bytes: 5000 }), 435)
  assert.equal(impactOf({ lcp: 0, tbt: 0, fcp: 0, cls: 0, bytes: 0 }), 0)
})

test('audits not in RULES keep the Lighthouse title and fall into category "other"', () => {
  const lhr = {
    categories: { performance: { auditRefs: [{ id: 'made-up-audit', weight: 0, group: 'diagnostics' }] } },
    audits: { 'made-up-audit': { id: 'made-up-audit', title: 'Made up', description: 'Do [this](https://x.test). More text.', score: 0, scoreDisplayMode: 'binary' } },
  }
  const [f] = findingsForPage(lhr)
  assert.equal(f.category, 'other')
  assert.equal(f.title, 'Made up')
  assert.equal(f.advice, 'Do this. More text.')
  assert.deepEqual(f.evidence, [])
})

test('passing, informative and not-applicable audits are not findings', () => {
  const lhr = {
    categories: { performance: { auditRefs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] } },
    audits: {
      a: { id: 'a', title: 'A', score: 0.9, scoreDisplayMode: 'metricSavings' },
      b: { id: 'b', title: 'B', score: 1, scoreDisplayMode: 'informative' },
      c: { id: 'c', title: 'C', score: null, scoreDisplayMode: 'notApplicable' },
      d: { id: 'd', title: 'D', score: 0.89, scoreDisplayMode: 'numeric' },
    },
  }
  assert.deepEqual(findingsForPage(lhr).map((f) => f.id), ['d'])
})

test('page facts: LCP element selector and phases from lcp-breakdown-insight, top 5 scripts from bootup-time', () => {
  const p = pageFacts(home)
  assert.equal(p.lcpElement.selector, 'div#bsp > p.bsp__line > span')
  assert.deepEqual(p.lcpPhases.map((x) => x.phase), ['timeToFirstByte', 'elementRenderDelay'])
  assert.equal(p.lcpPhases[1].ms, Math.round(home.audits['lcp-breakdown-insight'].details.items[0].items[1].duration))
  assert.equal(p.topScripts.length, 5)
  assert.ok(p.topScripts[0].ms >= p.topScripts[4].ms)
  assert.equal(p.topScripts[0].source, null)
})

test('page facts are empty, not broken, when the report lacks those audits', () => {
  assert.deepEqual(pageFacts({ audits: {} }), { lcpElement: null, lcpPhases: [], topScripts: [] })
})
