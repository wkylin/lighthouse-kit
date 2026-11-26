import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { analyzeRound } from '../src/analyze/index.mjs'
import { markdownToHtmlPage } from '../src/docs/html.mjs'
import { renderDevDoc } from '../src/docs/dev.mjs'
import { renderLeadDoc } from '../src/docs/lead.mjs'
import { writeDocs } from '../src/docs/index.mjs'
import { historyEntryFromRound } from '../src/history.mjs'
import { config, makeRound } from './helpers.mjs'

const dir = await makeRound()
const analysis = await analyzeRound(dir, config)
const current = historyEntryFromRound({ ...analysis.round, status: 'complete' }, analysis.pages)
const baseline = {
  ...current,
  roundId: 'r0',
  name: 'base',
  finishedAt: '2026-11-23T13:05:00.000Z',
  pages: Object.fromEntries(Object.entries(current.pages).map(([p, v]) => [p, { scores: { ...v.scores, perf: v.scores.perf - 5 }, metrics: { ...v.metrics, lcp: v.metrics.lcp + 500 } }])),
}

test('dev doc sections', () => {
  const md = renderDevDoc(analysis)
  for (const h of ['# 性能问题清单（开发版）', '## 本轮概况', '## 问题清单', '## 各页面']) assert.ok(md.includes(h), h)
  assert.ok(md.indexOf(`### 1. ${analysis.findings[0].title}`) >= 0)
  assert.ok(md.indexOf(analysis.findings[0].title) < md.indexOf(analysis.findings[1].title))
  assert.match(md, /\]\(\.\.\/pages\/m\/home\/run-1\/lighthouse\.html\)/)
  assert.ok(md.includes(analysis.round.origin))
  assert.ok(md.includes('| 文件或元素 | 耗时 | 大小 | 源文件 |'))
  assert.ok(md.includes('`src/mobile/ui/MBoard.vue`（60%）'), 'evidence shows the mapped source and its share')
  assert.ok(md.includes('/m/broken') && md.includes('页面加载超时'), 'failed pages are listed with their error')
  assert.ok(md.includes('div#bsp > p.bsp__line > span'), 'the LCP element is named in the page section')
  assert.ok(!md.includes('AI 建议'))
})

test('dev doc shows an AI block only for findings that have one, labelled "AI 建议"', () => {
  const withAi = structuredClone(analysis)
  withAi.findings[1].ai = { cause: '首屏同时挂载了整个列表', fix: '改成虚拟列表', model: 'claude-opus-5-5' }
  withAi.aiSent = [{ finding: withAi.findings[1].id, file: 'src/a.vue', chars: 120 }]
  const md = renderDevDoc(withAi)
  assert.equal(md.split('AI 建议').length - 1, 1, 'one block')
  assert.ok(md.includes('首屏同时挂载了整个列表') && md.includes('改成虚拟列表'))
  assert.ok(md.includes('## 附：发送给 AI 的内容') && md.includes('`src/a.vue`') && md.includes('120'))
})

test('a dry run never shows up in the doc as content that was sent', () => {
  const dry = structuredClone(analysis)
  dry.aiPlanned = [{ finding: dry.findings[0].id, file: 'src/a.vue', chars: 120 }]
  const md = renderDevDoc(dry)
  assert.ok(!md.includes('发送'), 'nothing was sent')
})

test('lead doc: scores table, worst pages, comparison with baseline, category distribution, trend', () => {
  const md = renderLeadDoc(analysis, { baseline, trend: [baseline, current] })
  for (const h of ['# 性能概况（负责人版）', '## 分数与核心指标', '## 最需要关注的页面', '## 与上一轮相比', '## 问题类别分布', '## 趋势']) assert.ok(md.includes(h), h)
  assert.ok(!/\.vue|\.js\b/.test(md), 'no code paths in the lead doc')
  assert.ok(md.includes('base'), 'the baseline round is named')
  assert.ok(md.includes('+5'), 'score change is signed')
  assert.ok(md.includes('主线程与脚本执行'), 'categories use their Chinese labels')
})

test('lead doc without baseline says 无可比的上一轮', () => {
  const md = renderLeadDoc(analysis, { baseline: null, trend: [current] })
  assert.ok(md.includes('无可比的上一轮'))
})

test('a partial round lead doc has no comparison and no trend', () => {
  const partial = structuredClone(analysis)
  partial.round.partial = true
  const md = renderLeadDoc(partial, { baseline, trend: [baseline, current] })
  assert.ok(md.includes('本轮只扫描了部分页面'))
  assert.ok(!md.includes('| 轮次 |'), 'no trend table')
})

test('docs are byte-identical for the same analysis', () => {
  assert.equal(renderDevDoc(analysis), renderDevDoc(structuredClone(analysis)))
  assert.equal(renderLeadDoc(analysis, { baseline, trend: [baseline, current] }), renderLeadDoc(structuredClone(analysis), { baseline, trend: [baseline, current] }))
})

test('html page renders markdown tables and follows prefers-color-scheme', () => {
  const html = markdownToHtmlPage('# 标题\n\n| a | b |\n|---|---|\n| 1 | <script>x</script> |\n', '标题')
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(html.includes('<title>标题</title>'))
  assert.ok(html.includes('<table'))
  assert.ok(html.includes('prefers-color-scheme: dark'))
  assert.ok(!html.includes('<script>x</script>'), 'raw html in markdown is escaped')
})

test('writeDocs writes md and html for the configured audiences', async () => {
  const written = await writeDocs(dir, analysis, { ...config, docs: { audiences: ['lead'], lang: 'zh-CN' } }, { baseline: null, trend: [] })
  assert.deepEqual(written.map((f) => path.relative(dir, f)).sort(), ['docs/lead.html', 'docs/lead.md'])
  assert.ok((await fs.readFile(path.join(dir, 'docs/lead.html'), 'utf8')).includes('性能概况（负责人版）'))
})

test('lead doc lists pages only one of the two rounds has', () => {
  const other = { ...baseline, pages: { '/m/home': baseline.pages['/m/home'], '/m/gone': baseline.pages['/m/home'] } }
  const md = renderLeadDoc(analysis, { baseline: other, trend: [other, current] })
  assert.ok(md.includes('上一轮有、本轮没有：/m/gone'))
  assert.ok(md.includes('本轮新增：/m/me/about-us'))
  assert.ok(md.split('\n').some((l) => l.startsWith('| /m/home |') && l.includes('→')), 'shared pages are compared')
})

test('a page that redirected is marked wherever its numbers appear; a hash or trailing slash is not a redirect', async () => {
  const a = structuredClone(analysis)
  a.pages[1].finalUrl = 'https://localhost:4443/auth/login?redirect=%2Fm%2Fme%2Fabout-us'
  a.pages[0].finalUrl = 'https://localhost:4443/m/home/#top'
  const lead = renderLeadDoc(a, { baseline: null, trend: [] })
  assert.ok(lead.split('\n').some((l) => l.startsWith('| /m/me/about-us（跳转到 /auth/login') ), 'lead table marks the redirect')
  assert.ok(lead.includes('跳转到'), 'and explains it')
  const dev = renderDevDoc(a)
  assert.ok(dev.includes('[/m/me/about-us](../pages/m/me/about-us/run-1/lighthouse.html)（跳转到 /auth/login'))
  assert.ok(!dev.includes('/m/home（跳转到') && !dev.includes('/m/home#top（'), 'hash and trailing slash are not redirects')
})

test('multi-line AI advice keeps its lines and code blocks', () => {
  const a = structuredClone(analysis)
  a.findings[0].ai = { cause: '第一行\n第二行', fix: '改成：\n```js\nconst a = 1\n```', model: 'm' }
  const md = renderDevDoc(a)
  assert.ok(md.includes('> 第二行'))
  assert.ok(md.includes('> ```js') && md.includes('> const a = 1'))
})

test('AI reports include source quotations, verification, and the status of carried advice', () => {
  const a = structuredClone(analysis)
  a.findings[0].ai = { cause: '静态推断', fix: '先确认调用路径', model: 'session', confidence: 'medium',
    evidence: [{ file: 'src/example.vue', quote: 'const rows = items.map(render)' }], verification: ['同一配置复测，并检查键盘交互'], carried: true }
  const md = renderDevDoc(a)
  for (const content of ['src/example.vue', 'const rows = items.map(render)', '同一配置复测，并检查键盘交互', '本次未重新核验', '不代表模型正确率'])
    assert.ok(md.includes(content), content)
})

test('a bundle that could not be mapped to source is called out', () => {
  const md = renderDevDoc(analysis)
  assert.ok(md.includes('未对到源码'), 'the note explains the empty 源文件 cell')
  assert.ok(md.includes('--sourcemap hidden'))
})

test('a page whose load timed out is flagged as possibly incomplete', () => {
  const a = structuredClone(analysis)
  a.pages[0].warnings = ['The page loaded too slowly to finish within the time limit. Results may be incomplete.']
  const dev = renderDevDoc(a)
  assert.ok(dev.includes('⚠') && dev.includes('没有加载完'))
  const lead = renderLeadDoc(a, { baseline: null, trend: [] })
  assert.ok(lead.split('\n').some((l) => l.startsWith('| /m/home') && l.includes('结果可能不完整')))
})
