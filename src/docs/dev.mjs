// 开发版文档：问题清单（证据、源码位置、建议），以及各页面要点。
import { CATEGORY_LABELS } from '../analyze/rules.mjs'
import { PHASE_LABELS, VISIT_LABELS, cell, fmtAgentic, fmtCls, fmtKb, fmtMs, fmtS, fmtScore, fmtTime, isLoadTimeout, loadTimedOut, redirectMark, redirectedTo, reportPath, shortUrl } from './format.mjs'

const link = (summary, text) => `[${text}](../${reportPath(summary)})`

function overview(a, lines) {
  const r = a.round
  const ok = a.pages.filter((p) => p.ok)
  const failed = a.pages.filter((p) => !p.ok)
  lines.push('## 本轮概况', '')
  lines.push(`- 目标地址：${r.origin}`)
  lines.push(`- 轮次：${r.name ?? r.id}${r.partial ? '（部分页面）' : ''}，${fmtTime(r.startedAt)} – ${fmtTime(r.finishedAt)}`)
  lines.push(`- Lighthouse ${r.lighthouseVersion} · 手机模式 · ${VISIT_LABELS[r.visit] ?? r.visit} · 每页 ${r.runs} 次`)
  if (r.git) lines.push(`- git：${r.git.commit.slice(0, 10)}${r.git.dirty ? '（有未提交的改动）' : ''}`)
  lines.push(`- 页面：${a.pages.length} 个，成功 ${ok.length}，失败 ${failed.length}`)
  for (const p of failed) lines.push(`  - ${p.page}：${p.error ?? '失败'}`)
  const slow = ok.filter(loadTimedOut).map((p) => p.page)
  if (slow.length) lines.push(`- ⚠ 在限定时间内没有加载完、结果可能不完整：${slow.join('、')}`)
  const unmapped = unmappedBundles(a)
  if (unmapped.length)
    lines.push(`- 有 ${unmapped.length} 个本站的 JS/CSS 文件未对到源码（问题清单“源文件”一栏为空）。还没有 source map 的话：构建时生成 source map（例如 Vite 的 \`--sourcemap hidden\`），并把配置里的 sourceMap 指向构建产物目录，再运行 lhkit analyze`)
  lines.push('')
  lines.push('| 页面 | 性能 | 无障碍 | 最佳实践 | SEO | Agentic | FCP | LCP | TBT | CLS | SI |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const p of a.pages) {
    if (!p.ok || !p.median) {
      lines.push(`| ${cell(p.page)} | 失败：${cell(p.error ?? '')} | | | | | | | | | |`)
      continue
    }
    const s = p.median.scores
    const m = p.median.metrics
    lines.push(`| ${link(p, cell(p.page))}${cell(redirectMark(p, a.round.origin))} | ${fmtScore(s.perf)} | ${fmtScore(s.a11y)} | ${fmtScore(s.bp)} | ${fmtScore(s.seo)} | ${fmtAgentic(s.agentic)} | ${fmtS(m.fcp)} | ${fmtS(m.lcp)} | ${fmtMs(m.tbt)} | ${fmtCls(m.cls)} | ${fmtS(m.si)} |`)
  }
  lines.push('')
}

/** 证据里本站的 .js/.css 文件，却没有对应的源文件。 */
function unmappedBundles(a) {
  let origin
  try {
    origin = new URL(a.round.origin).origin
  } catch {
    return []
  }
  const urls = new Set()
  for (const f of a.findings) {
    for (const e of f.evidence) {
      if (!e.url || e.source) continue
      try {
        const u = new URL(e.url)
        if (u.origin === origin && /\.(m?js|css)$/i.test(u.pathname)) urls.add(u.origin + u.pathname)
      } catch {
        // 不是网址
      }
    }
  }
  return [...urls]
}

function evidenceTable(f, origin, lines) {
  if (!f.evidence.length) return
  lines.push('| 文件或元素 | 耗时 | 大小 | 源文件 |', '|---|---|---|---|')
  for (const e of f.evidence) {
    const what = e.url ? `\`${cell(shortUrl(e.url, origin))}\`` : e.selector ? `\`${cell(e.selector)}\`` : cell(e.label)
    const extra = (e.url || e.selector) && e.label ? ` ${cell(e.label)}` : ''
    const src = e.source ? `\`${cell(e.source.file)}\`${e.source.share < 1 ? `（${Math.round(e.source.share * 100)}%）` : ''}` : ''
    lines.push(`| ${what}${extra} | ${e.ms != null ? fmtMs(e.ms) : ''} | ${e.bytes != null ? fmtKb(e.bytes) : ''} | ${src} |`)
  }
  lines.push('')
}

function savingsLine(s) {
  const parts = []
  if (s.lcp) parts.push(`LCP 约 ${fmtMs(s.lcp)}`)
  if (s.tbt) parts.push(`TBT 约 ${fmtMs(s.tbt)}`)
  if (s.fcp) parts.push(`FCP 约 ${fmtMs(s.fcp)}`)
  if (s.cls) parts.push(`CLS 约 ${fmtCls(s.cls)}`)
  if (s.bytes) parts.push(`可省 ${fmtKb(s.bytes)}`)
  return parts.length ? parts.join('，') : null
}

function findingsSection(a, lines) {
  const byPage = new Map(a.pages.map((p) => [p.page, p]))
  lines.push('## 问题清单', '')
  if (!a.findings.length) {
    lines.push('没有未通过的审计项。', '')
    return
  }
  lines.push('按优先级排列：性能问题按“估算影响 × 涉及页面”排序，其后是无障碍、最佳实践、SEO 与 Agentic Browsing 未通过的项。', '')
  a.findings.forEach((f, i) => {
    lines.push(`### ${i + 1}. ${f.title}`, '')
    lines.push(`- 类别：${CATEGORY_LABELS[f.category] ?? f.category} · 涉及 ${f.pages.length} 个页面：${f.pages.join('、')}`)
    const saving = savingsLine(f.savings)
    if (saving) lines.push(`- 估算收益（影响最大的页面）：${saving}`)
    lines.push(`- 报告：${f.pages.map((p) => (byPage.get(p)?.representative ? link(byPage.get(p), p) : p)).join('、')}`)
    lines.push(`- 审计项：\`${f.id}\``, '')
    evidenceTable(f, a.round.origin, lines)
    lines.push(`**建议**：${f.advice}`, '')
    if (f.ai) {
      // 逐行放进引用块，保留 AI 给出的分行和代码块。
      const quoted = (text) => text.split('\n').map((l) => (l ? `> ${l}` : '>'))
      lines.push(`> **AI 建议**（${f.ai.model}）`, '>', ...quoted(`原因：${f.ai.cause}`), '>', ...quoted(`改法：${f.ai.fix}`), '')
      if (f.ai.carried) lines.push('> 沿用此前建议，本次未重新核验。', '')
      if (f.ai.confidence) {
        const label = { high: '较充分', medium: '部分充分', low: '不足，需确认' }[f.ai.confidence]
        lines.push(`> 证据充分程度：${label}（不代表模型正确率）`, '')
      }
      for (const e of f.ai.evidence ?? []) lines.push(...quoted(`源码引用：${e.file}\n\n\`\`\`\n${e.quote}\n\`\`\``), '')
      if (f.ai.verification?.length) lines.push('> 验证步骤：', ...f.ai.verification.flatMap((s) => quoted(`- ${s}`)), '')
    }
  })
}

function pagesSection(a, lines) {
  lines.push('## 各页面', '')
  for (const p of a.pages) {
    lines.push(`### ${p.page}`, '')
    if (!p.ok || !p.median) {
      lines.push(`扫描失败：${p.error ?? '未知原因'}`, '')
      continue
    }
    const m = p.median.metrics
    lines.push(`- 性能 ${fmtScore(p.median.scores.perf)} · LCP ${fmtS(m.lcp)} · TBT ${fmtMs(m.tbt)} · CLS ${fmtCls(m.cls)} · ${link(p, '完整报告')}`)
    if (redirectedTo(p, a.round.origin)) lines.push(`- 最终地址：${p.finalUrl}（发生了重定向，以上数据是跳转后的页面）`)
    for (const w of p.warnings ?? [])
      lines.push(isLoadTimeout(w) ? `- ⚠ 页面在限定时间内没有加载完，结果可能不完整（Lighthouse：${w}）` : `- ⚠ Lighthouse 提示：${w}`)
    const facts = a.facts[p.page]
    if (facts?.lcpElement) {
      const phases = facts.lcpPhases.map((x) => `${PHASE_LABELS[x.phase] ?? x.phase} ${fmtMs(x.ms)}`).join('，')
      lines.push(`- LCP 元素：\`${facts.lcpElement.selector}\`${phases ? `；各阶段：${phases}` : ''}`)
    }
    if (facts?.topScripts.length) {
      const scripts = facts.topScripts.map((s) => `\`${shortUrl(s.url, a.round.origin)}\` ${fmtMs(s.ms)}${s.source ? `（${s.source.file}）` : ''}`)
      lines.push(`- 执行最久的脚本：${scripts.join('，')}`)
    }
    const top = a.findings
      .filter((f) => f.group === 'performance')
      .map((f) => ({ f, row: f.perPage.find((r) => r.page === p.page) }))
      .filter((x) => x.row)
      .sort((x, y) => y.row.impact - x.row.impact || x.f.id.localeCompare(y.f.id))
      .slice(0, 5)
    if (top.length) {
      lines.push('- 本页主要性能问题：')
      for (const { f } of top) lines.push(`  - 第 ${a.findings.indexOf(f) + 1} 条：${f.title}`)
    }
    lines.push('')
  }
}

function aiAppendix(a, lines) {
  if (!a.aiSent.length) return
  const description = a.findings.some((f) => f.ai?.carried)
    ? '以下包含本次发送记录，以及沿用建议对应的历史发送记录：'
    : '本轮 AI 分析发送了以下源文件片段：'
  lines.push('## 附：发送给 AI 的内容', '', description, '')
  lines.push('| 问题 | 文件 | 字符数 |', '|---|---|---|')
  for (const s of a.aiSent) lines.push(`| \`${cell(s.finding)}\` | \`${cell(s.file)}\` | ${s.chars} |`)
  lines.push('')
}

/**
 * @param {import('../types.mjs').Analysis} analysis
 * @returns {string}
 */
export function renderDevDoc(analysis) {
  const lines = ['# 性能问题清单（开发版）', '']
  overview(analysis, lines)
  findingsSection(analysis, lines)
  pagesSection(analysis, lines)
  aiAppendix(analysis, lines)
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}
