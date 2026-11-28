// 轮次总览 index.html：各页分数与指标，链接到每页报告和文档。
import fs from 'node:fs'
import path from 'node:path'
import { PAGE_CSS, markdownToHtmlFragment } from '../docs/html.mjs'
import { memorySection } from '../docs/memory.mjs'
import { VISIT_LABELS, fmtAgentic, fmtTime, median, redirectedTo, reportPath } from '../docs/format.mjs'

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const grade = (v, good, poor) => (v == null ? '' : v <= good ? 'good' : v <= poor ? 'mid' : 'bad')
const scoreGrade = (s) => (s == null ? '' : s >= 90 ? 'good' : s >= 50 ? 'mid' : 'bad')
const agenticGrade = (a) => (!a ? '' : a.pass === a.total ? 'good' : a.pass * 2 >= a.total ? 'mid' : 'bad')
const s = (v) => (v == null ? '–' : `${(v / 1000).toFixed(1)} s`)
const ms = (v) => (v == null ? '–' : `${Math.round(v)} ms`)
const n = (v) => (v == null ? '–' : String(Math.round(v)))
const cls = (v) => (v == null ? '–' : v.toFixed(3))
const td = (klass, text) => `<td class="${klass}">${text}</td>`

function row(label, sc, m) {
  return `${td('score ' + scoreGrade(sc.perf), n(sc.perf))}${td('score ' + scoreGrade(sc.a11y), n(sc.a11y))}${td('score ' + scoreGrade(sc.bp), n(sc.bp))}${td('score ' + scoreGrade(sc.seo), n(sc.seo))}${td('score ' + agenticGrade(sc.agentic), fmtAgentic(sc.agentic))}${td(grade(m.fcp, 1800, 3000), s(m.fcp))}${td(grade(m.lcp, 2500, 4000), s(m.lcp))}${td(grade(m.tbt, 200, 600), ms(m.tbt))}${td(grade(m.cls, 0.1, 0.25), cls(m.cls))}${td(grade(m.si, 3400, 5800), s(m.si))}`
}

/**
 * @param {string} roundDir
 * @param {import('../types.mjs').Analysis} analysis
 * @param {('dev'|'lead')[]} [audiences]
 * @returns {string} index.html 路径
 */
export function writeIndex(roundDir, analysis, audiences = ['dev', 'lead']) {
  const r = analysis.round
  const ok = analysis.pages.filter((p) => p.ok && p.median)
  const sorted = [...ok].sort((a, b) => (a.median.scores.perf ?? 101) - (b.median.scores.perf ?? 101) || a.page.localeCompare(b.page))
  const lines = sorted.map((p) => {
    const to = redirectedTo(p, r.origin)
    const moved = to ? `<div class="moved">→ ${esc(to)}</div>` : ''
    return `<tr><td class="page"><a href="${esc(reportPath(p))}">${esc(p.page)}</a>${moved}</td>${row(p.page, p.median.scores, p.median.metrics)}</tr>`
  })
  for (const p of analysis.pages.filter((x) => !x.ok || !x.median))
    lines.push(`<tr><td class="page">${esc(p.page)}</td><td class="error bad" colspan="10">失败：${esc(p.error ?? '未知原因')}</td></tr>`)
  const med = (f) => median(ok.map((p) => f(p.median)))
  const medScores = { perf: med((x) => x.scores.perf), a11y: med((x) => x.scores.a11y), bp: med((x) => x.scores.bp), seo: med((x) => x.scores.seo), agentic: null }
  const medMetrics = { fcp: med((x) => x.metrics.fcp), lcp: med((x) => x.metrics.lcp), tbt: med((x) => x.metrics.tbt), cls: med((x) => x.metrics.cls), si: med((x) => x.metrics.si) }
  const docLinks = [
    audiences.includes('dev') ? '<a href="docs/dev.html">开发版文档：问题清单</a>' : '',
    audiences.includes('lead') ? '<a href="docs/lead.html">负责人版文档：性能概况</a>' : '',
  ].filter(Boolean)
  const title = `Lighthouse 扫描结果 · ${r.name ?? r.id}`
  const memoryLines = []
  memorySection(analysis, memoryLines, { findings: true, details: true, rawLinks: true, basePath: '.' })
  const memoryHtml = markdownToHtmlFragment(memoryLines.join('\n'))
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${PAGE_CSS}
  .meta { margin: 0 0 14px; opacity: 0.7; font-size: 13px; }
  .docs { display: flex; gap: 18px; margin: 0 0 18px; font-weight: 600; }
  th, td { text-align: right; white-space: nowrap; }
  th.page, td.page { text-align: left; }
  td.page a { font-weight: 600; text-decoration: none; }
  td.score { font-weight: 700; }
  td.error { text-align: left; white-space: normal; }
  .moved { font-size: 11px; opacity: 0.6; }
  tfoot td { font-weight: 700; border-top: 2px solid var(--line); border-bottom: 0; }
  .hint { margin-top: 14px; font-size: 12px; opacity: 0.6; }
  .memory { overflow-wrap: anywhere; }
  .memory th:first-child, .memory td:first-child { text-align: left; }
</style></head><body><main>
<h1>${esc(title)}</h1>
<p class="meta">${esc(r.origin)} · ${analysis.pages.length} 个页面（成功 ${ok.length}） · Lighthouse ${esc(r.lighthouseVersion)} · 手机模式 · ${esc(VISIT_LABELS[r.visit] ?? r.visit)} · 每页 ${r.runs} 次 · ${esc(fmtTime(r.startedAt))} – ${esc(fmtTime(r.finishedAt))}</p>
${docLinks.length ? `<p class="docs">${docLinks.join('')}</p>` : ''}
<div class="wrap"><table>
<thead><tr><th class="page">页面（点开看完整报告）</th><th>性能</th><th>无障碍</th><th>最佳实践</th><th>SEO</th><th>Agentic</th><th>FCP</th><th>LCP</th><th>TBT</th><th>CLS</th><th>SI</th></tr></thead>
<tbody>
${lines.join('\n')}
</tbody>
<tfoot><tr><td class="page">中位数</td>${row('中位数', medScores, medMetrics)}</tr></tfoot>
</table></div>
<p class="hint">按性能分从低到高排列。颜色按 Lighthouse 手机端阈值：绿＝好，橙＝需改进，红＝差。“→”表示页面被重定向到的地址（例如未登录时跳到登录页）。</p>
${memoryHtml ? `<section class="memory" aria-label="内存分析">\n${memoryHtml}</section>` : ''}
</main></body></html>
`
  const file = path.join(roundDir, 'index.html')
  fs.writeFileSync(file, html)
  return file
}
