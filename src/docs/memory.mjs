// 两版报告共用的内存概况；缺少采集数据时保留未知状态。
import { memoryForSummary } from '../memory-summary.mjs'
import { cell, redirectMark } from './format.mjs'

const amount = (value, unit = '', scale = 1) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  ? `${(value / scale).toFixed(1).replace(/\.0$/, '')}${unit}`
  : '–'
const mib = (bytes) => amount(bytes, ' MiB', 1024 ** 2)

export function memorySection(analysis, lines, { findings = false, details = false, rawLinks = false, basePath = '..' } = {}) {
  const pages = analysis.pages.filter((p) => p.ok).map((page) => ({ page, memory: memoryForSummary(page) }))
  const available = pages.some(({ memory }) => memory)
  const attempted = pages.some(({ page }) => Object.hasOwn(page, 'memory') || Object.hasOwn(page.median ?? {}, 'memory') ||
    (page.runs ?? []).some((r) => r.ok && Object.hasOwn(r, 'memory')))
  if (!available && !attempted) return
  lines.push('## 内存概况', '')
  if (!available) lines.push('本轮内存采集未获得有效数据，无法判断是否存在内存问题。请检查扫描日志中的内存采集错误后重新扫描。', '')
  lines.push('各项取成功运行中有效采集值的中位数；增长率和分配样本率先按每次运行的观测时长计算，再取中位数。有效次数指至少采集到一项内存数据的运行数，各项可用次数可能不同；“–”表示未采集或无法测量。', '')
  lines.push('| 页面 | 有效次数 | 已用堆 | 堆上限占比 | 堆增长 | 分配样本率 | 脱离节点 |', '|---|---|---|---|---|---|---|')
  for (const { page, memory: m } of pages) {
    const total = (page.runs ?? []).filter((run) => run.ok).length
    const count = m ? `${m.runs}${total ? `/${total}` : ''}` : '0'
    lines.push(`| ${cell(page.page + redirectMark(page, analysis.round.origin))} | ${count} | ${mib(m?.heapSnapshot?.usedJsHeapSize)} | ${amount(m?.heapSnapshot?.heapUsageRatio, '%', 0.01)} | ${amount(m?.allocationTimeline?.growthRatePerSecond, ' MiB/s', 1024 ** 2)} | ${amount(m?.allocationSampling?.allocationRate, ' 样本/s')} | ${amount(m?.detachedElements?.detachedCount)} |`)
  }
  lines.push('', '内存规则采用工具内置的启发式阈值，不计入 Lighthouse 分数或估算收益。默认堆时间轴和分配采样各观察 1 秒；分配样本率是采样代理量，脱离节点仅提示疑似泄漏，需重复交互和堆快照复核。', '')
  if (rawLinks) {
    const links = pages.flatMap(({ page }) => memoryEvidenceLinks(page, basePath))
    if (links.length) lines.push(`原始内存数据：${links.join('、')}`, '')
  }
  if (!findings) return
  const issues = analysis.findings.filter((f) => f.group === 'memory')
  if (!issues.length) {
    if (available) lines.push('已采集数据未触发内存规则；缺失数据不表示不存在内存问题。', '')
    return
  }
  lines.push(`内存发现：${issues.length} 类，涉及 ${new Set(issues.flatMap((f) => f.pages)).size} 个页面。`, '')
  for (const finding of issues) {
    if (!details) {
      lines.push(`- ${finding.title}：${finding.pages.join('、')}`)
      continue
    }
    lines.push(`### ${finding.title}`, '', `- 内存规则：\`${finding.id}\``, `- 涉及页面：${finding.pages.map(cell).join('、')}`, '')
    const rows = finding.perPage?.length ? finding.perPage : [{ page: finding.pages.join('、'), evidence: finding.evidence }]
    for (const row of rows) {
      for (const evidence of row.evidence ?? []) if (evidence.label) lines.push(`- ${cell(row.page)}：${cell(evidence.label)}`)
    }
    lines.push('', `**建议**：${finding.advice}`, '')
  }
  lines.push('')
}

/** 内存 Finding 的原始证据链接，不指向 Lighthouse 审计报告。 */
export function memoryEvidenceLinks(summary, basePath = '..') {
  if (!summary) return []
  let runs = (summary.runs ?? []).filter((run) => run.ok && run.memory).map((run) => run.index)
  // 早期摘要只保留代表运行内存，仍可链接到其原始文件。
  if (!runs.length && summary.memory && !('runs' in summary.memory) && summary.representative != null)
    runs = [summary.representative]
  return runs.map((index) => `[${cell(summary.page)} · 第 ${index} 次](${basePath}/pages/${summary.slug}/run-${index}/memory.json)`)
}
