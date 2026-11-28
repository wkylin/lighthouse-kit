// 同一审计跨页面合并，并按优先级排序。

const round2 = (n) => Math.round(n * 100) / 100

/**
 * @param {{page: string, findings: import('../types.mjs').Finding[]}[]} perPage 按页面顺序
 * @returns {import('../types.mjs').MergedFinding[]}
 */
export function mergeFindings(perPage) {
  /** @type {Map<string, {lead: import('../types.mjs').Finding, rows: {page: string, impact: number, evidence: any[]}[]}>} */
  const byId = new Map()
  for (const { page, findings } of perPage) {
    for (const finding of findings) {
      const slot = byId.get(finding.id)
      const row = { page, impact: finding.impact, evidence: finding.evidence }
      if (!slot) byId.set(finding.id, { lead: finding, rows: [row] })
      else {
        slot.rows.push(row)
        if (finding.impact > slot.lead.impact) slot.lead = finding
      }
    }
  }
  const merged = [...byId.values()].map(({ lead, rows }) => ({
    id: lead.id,
    category: lead.category,
    group: lead.group,
    title: lead.title,
    advice: lead.advice,
    score: lead.score,
    savings: lead.savings,
    impact: lead.impact,
    evidence: lead.evidence,
    pages: rows.map((r) => r.page),
    impactTotal: round2(rows.reduce((s, r) => s + r.impact, 0)),
    perPage: rows,
    ai: null,
  }))
  const perf = merged
    .filter((m) => m.group === 'performance')
    .sort((a, b) => b.impactTotal - a.impactTotal || b.savings.bytes - a.savings.bytes || b.pages.length - a.pages.length || a.id.localeCompare(b.id))
  const rest = merged
    .filter((m) => m.group !== 'performance' && m.group !== 'memory')
    .sort((a, b) => b.pages.length - a.pages.length || a.id.localeCompare(b.id))
  const memory = merged
    .filter((m) => m.group === 'memory')
    .sort((a, b) => b.pages.length - a.pages.length || a.id.localeCompare(b.id))
  return [...perf, ...memory, ...rest]
}
