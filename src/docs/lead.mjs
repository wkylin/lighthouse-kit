// 负责人版文档：分数、最差页面、与上一轮的变化、问题类别分布、趋势；不含代码细节。
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../analyze/rules.mjs'
import { memorySection } from './memory.mjs'
import { TIMEOUT_MARK, VISIT_LABELS, cell, fmtAgentic, fmtCls, fmtMs, fmtS, fmtScore, fmtTime, loadTimedOut, median, redirectMark, signed } from './format.mjs'

const okPages = (a) => a.pages.filter((p) => p.ok && p.median)
const roundLabel = (e) => e.name ?? e.roundId

function medians(pages) {
  const pick = (f) => median(pages.map(f))
  return {
    perf: pick((p) => p.scores.perf),
    a11y: pick((p) => p.scores.a11y),
    bp: pick((p) => p.scores.bp),
    seo: pick((p) => p.scores.seo),
    lcp: pick((p) => p.metrics.lcp),
    tbt: pick((p) => p.metrics.tbt),
    cls: pick((p) => p.metrics.cls),
  }
}

function scoresSection(a, lines) {
  const pages = okPages(a)
  const m = medians(pages.map((p) => p.median))
  lines.push('## 分数与核心指标', '')
  lines.push('全站中位数：', '')
  lines.push('| 性能 | 无障碍 | 最佳实践 | SEO | LCP | TBT | CLS |', '|---|---|---|---|---|---|---|')
  lines.push(`| ${fmtScore(m.perf)} | ${fmtScore(m.a11y)} | ${fmtScore(m.bp)} | ${fmtScore(m.seo)} | ${fmtS(m.lcp)} | ${fmtMs(m.tbt)} | ${fmtCls(m.cls)} |`, '')
  lines.push('各页面（按性能分从低到高）：', '')
  lines.push('| 页面 | 性能 | 无障碍 | 最佳实践 | SEO | Agentic | LCP | TBT | CLS |', '|---|---|---|---|---|---|---|---|---|')
  const sorted = [...pages].sort((x, y) => (x.median.scores.perf ?? 101) - (y.median.scores.perf ?? 101) || x.page.localeCompare(y.page))
  for (const p of sorted) {
    const s = p.median.scores
    const mm = p.median.metrics
    lines.push(`| ${cell(p.page + redirectMark(p, a.round.origin) + (loadTimedOut(p) ? TIMEOUT_MARK : ''))} | ${fmtScore(s.perf)} | ${fmtScore(s.a11y)} | ${fmtScore(s.bp)} | ${fmtScore(s.seo)} | ${fmtAgentic(s.agentic)} | ${fmtS(mm.lcp)} | ${fmtMs(mm.tbt)} | ${fmtCls(mm.cls)} |`)
  }
  for (const p of a.pages.filter((x) => !x.ok)) lines.push(`| ${cell(p.page)} | 失败 | | | | | | | |`)
  lines.push('')
  if (pages.some((p) => redirectMark(p, a.round.origin)))
    lines.push('标“跳转到”的页面测到的是跳转后的页面（例如未登录时跳到登录页），分数不代表原页面。', '')
}

function worstSection(a, lines) {
  lines.push('## 最需要关注的页面', '')
  const worst = [...okPages(a)].sort((x, y) => (x.median.scores.perf ?? 101) - (y.median.scores.perf ?? 101) || x.page.localeCompare(y.page)).slice(0, 5)
  if (!worst.length) lines.push('没有扫描成功的页面。')
  for (const p of worst) {
    const cats = []
    for (const f of a.findings) {
      if (f.group !== 'performance' || !f.pages.includes(p.page)) continue
      const label = CATEGORY_LABELS[f.category] ?? f.category
      if (!cats.includes(label)) cats.push(label)
      if (cats.length === 2) break
    }
    const m = p.median.metrics
    lines.push(`- ${p.page}${redirectMark(p, a.round.origin)}${loadTimedOut(p) ? TIMEOUT_MARK : ''}：性能 ${fmtScore(p.median.scores.perf)}，LCP ${fmtS(m.lcp)}，TBT ${fmtMs(m.tbt)}${cats.length ? `；主要问题：${cats.join('、')}` : ''}`)
  }
  lines.push('')
}

function compareSection(a, ctx, lines) {
  lines.push('## 与上一轮相比', '')
  if (a.round.partial) {
    lines.push('本轮只扫描了部分页面，不做对比。', '')
    return
  }
  const base = ctx.baseline
  if (!base) {
    lines.push('无可比的上一轮（需要目标地址、Lighthouse 大版本、访问方式和页面清单都相同的完整轮次）。', '')
    return
  }
  lines.push(`对比对象：上一轮 ${roundLabel(base)}（${fmtTime(base.finishedAt)}${base.git ? `，提交 ${base.git.commit.slice(0, 7)}` : ''}）。`, '')
  lines.push('| 页面 | 性能 | 变化 | LCP | 变化 | TBT | 变化 |', '|---|---|---|---|---|---|---|')
  const nowPages = okPages(a)
  for (const p of nowPages) {
    const b = base.pages[p.page]
    if (!b) continue
    const s = p.median.scores
    const m = p.median.metrics
    const dLcp = m.lcp != null && b.metrics.lcp != null ? (m.lcp - b.metrics.lcp) / 1000 : null
    const dTbt = m.tbt != null && b.metrics.tbt != null ? m.tbt - b.metrics.tbt : null
    const dPerf = s.perf != null && b.scores.perf != null ? s.perf - b.scores.perf : null
    lines.push(`| ${cell(p.page + redirectMark(p, a.round.origin))} | ${fmtScore(b.scores.perf)} → ${fmtScore(s.perf)} | ${signed(dPerf)} | ${fmtS(b.metrics.lcp)} → ${fmtS(m.lcp)} | ${dLcp == null ? '–' : `${signed(dLcp, 1)} s`} | ${fmtMs(b.metrics.tbt)} → ${fmtMs(m.tbt)} | ${dTbt == null ? '–' : `${signed(dTbt)} ms`} |`)
  }
  const shared = nowPages.filter((p) => base.pages[p.page])
  const now = medians(shared.map((p) => p.median))
  const before = medians(shared.map((p) => base.pages[p.page]))
  lines.push('')
  const added = nowPages.filter((p) => !base.pages[p.page]).map((p) => p.page)
  const gone = Object.keys(base.pages).filter((p) => !nowPages.some((x) => x.page === p))
  if (added.length) lines.push(`- 本轮新增：${added.join('、')}`)
  if (gone.length) lines.push(`- 上一轮有、本轮没有：${gone.join('、')}`)
  if (added.length || gone.length) lines.push('')
  lines.push(`两轮都有的页面：性能分中位数 ${fmtScore(before.perf)} → ${fmtScore(now.perf)}（${signed(now.perf != null && before.perf != null ? now.perf - before.perf : null)}），LCP 中位数 ${fmtS(before.lcp)} → ${fmtS(now.lcp)}，TBT 中位数 ${fmtMs(before.tbt)} → ${fmtMs(now.tbt)}。`, '')
}

function categorySection(a, lines) {
  lines.push('## 问题类别分布', '')
  const rows = []
  for (const cat of CATEGORY_ORDER) {
    const fs = a.findings.filter((f) => f.category === cat)
    if (!fs.length) continue
    const pages = new Set(fs.flatMap((f) => f.pages))
    const impact = fs.reduce((s, f) => s + f.impactTotal, 0)
    rows.push(`| ${CATEGORY_LABELS[cat] ?? cat} | ${fs.length} | ${pages.size} | ${cat !== 'memory' && impact ? fmtMs(impact) : '–'} |`)
  }
  if (!rows.length) {
    lines.push('没有未通过的审计项。', '')
    return
  }
  lines.push('| 类别 | 问题数 | 涉及页面 | 估算影响 |', '|---|---|---|---|', ...rows, '')
  lines.push('估算影响按 Lighthouse 的分数权重折算（LCP 25%、TBT 30%、FCP 10%、CLS 25%），只用于排序比较。', '')
  if (a.findings.some((f) => f.group === 'memory')) lines.push('内存发现不换算为毫秒，也不计入 Lighthouse 估算收益。', '')
}

function trendSection(a, ctx, lines) {
  lines.push('## 趋势', '')
  if (a.round.partial) {
    lines.push('本轮只扫描了部分页面，没有趋势。', '')
    return
  }
  if (ctx.trend.length < 2) {
    lines.push('可比的轮次不足两轮，暂无趋势。', '')
    return
  }
  lines.push('| 轮次 | 时间 | 性能中位数 | LCP 中位数 | TBT 中位数 |', '|---|---|---|---|---|')
  for (const e of ctx.trend) {
    const m = medians(Object.values(e.pages))
    lines.push(`| ${cell(roundLabel(e))} | ${fmtTime(e.finishedAt)} | ${fmtScore(m.perf)} | ${fmtS(m.lcp)} | ${fmtMs(m.tbt)} |`)
  }
  lines.push('')
}

/**
 * @param {import('../types.mjs').Analysis} analysis
 * @param {{baseline: import('../types.mjs').HistoryEntry|null, trend: import('../types.mjs').HistoryEntry[]}} ctx
 * @returns {string}
 */
export function renderLeadDoc(analysis, ctx) {
  const r = analysis.round
  const ok = okPages(analysis).length
  const lines = ['# 性能概况（负责人版）', '', '## 本轮概况', '']
  lines.push(`- 目标地址：${r.origin}`)
  lines.push(`- 轮次：${r.name ?? r.id}${r.partial ? '（部分页面）' : ''}，${fmtTime(r.startedAt)} – ${fmtTime(r.finishedAt)}`)
  lines.push(`- 方式：Lighthouse ${r.lighthouseVersion}，手机模式，${VISIT_LABELS[r.visit] ?? r.visit}，每页 ${r.runs} 次`)
  lines.push(`- 页面：${analysis.pages.length} 个，成功 ${ok}，失败 ${analysis.pages.length - ok}`, '')
  scoresSection(analysis, lines)
  memorySection(analysis, lines, { findings: true })
  worstSection(analysis, lines)
  compareSection(analysis, ctx, lines)
  categorySection(analysis, lines)
  trendSection(analysis, ctx, lines)
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}
