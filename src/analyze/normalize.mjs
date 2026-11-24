// 单页 Lighthouse 报告 → 问题（Finding）与页面要点（PageFacts）。
import { CATEGORY_ORDER, RULES } from './rules.mjs'

export { CATEGORY_ORDER, RULES }

const FINDING_MODES = new Set(['metricSavings', 'numeric', 'binary'])
const SKIP_PERF_GROUPS = new Set(['metrics', 'hidden'])
const MAX_EVIDENCE = 10

/** 估算对性能分的影响：按 Lighthouse 分数权重折算的毫秒数（CLS 每 0.001 记 1）。 */
export function impactOf(savings) {
  const v = 0.25 * (savings.lcp || 0) + 0.3 * (savings.tbt || 0) + 0.1 * (savings.fcp || 0) + 0.25 * (savings.cls || 0) * 1000
  return Math.round(v * 100) / 100
}

const stripLinks = (text) => String(text ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim()
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const text = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.text === 'string' ? v.text : undefined)

/** 审计 id → 所属分类：先看 performance，其余按报告里的分类顺序；performance 的 metrics/hidden 组不算。 */
function auditGroups(lhr) {
  const groups = new Map()
  const cats = lhr.categories ?? {}
  const order = ['performance', ...Object.keys(cats).filter((k) => k !== 'performance')]
  for (const cat of order) {
    for (const ref of cats[cat]?.auditRefs ?? []) {
      if (groups.has(ref.id)) continue
      groups.set(ref.id, cat === 'performance' && SKIP_PERF_GROUPS.has(ref.group) ? null : cat)
    }
  }
  return groups
}

/** 一行明细 → 证据；没有可识别的内容时返回 null。 */
function evidenceOf(row) {
  if (!row || typeof row !== 'object') return null
  const e = {}
  const url = typeof row.url === 'string' ? row.url : typeof row.source?.url === 'string' ? row.source.url : undefined
  if (url) e.url = url
  const node = row.type === 'node' ? row : row.node
  if (node?.selector) e.selector = node.selector
  if (node?.snippet) e.snippet = node.snippet
  const label = text(row.label) ?? text(row.groupLabel) ?? text(row.reason) ?? text(row.statistic) ?? text(row.entity) ?? text(row.subpart)
  if (label) e.label = label
  const ms = num(row.wastedMs) ?? num(row.duration) ?? num(row.total) ?? num(row.mainThreadTime)
  if (ms !== undefined) e.ms = Math.round(ms)
  const bytes = num(row.wastedBytes) ?? num(row.transferSize) ?? num(row.totalBytes)
  if (bytes !== undefined) e.bytes = Math.round(bytes)
  return e.url || e.selector || e.label ? e : null
}

function rowsOf(details) {
  if (!details) return []
  if (details.type === 'table' || details.type === 'opportunity') return details.items ?? []
  if (details.type === 'list') {
    const rows = []
    for (const item of details.items ?? []) {
      if (item?.type === 'table') rows.push(...(item.items ?? []))
      else if (item?.type === 'node') rows.push(item)
    }
    return rows
  }
  return []
}

function bytesSaved(details) {
  if (num(details?.overallSavingsBytes) !== undefined) return Math.round(details.overallSavingsBytes)
  const total = rowsOf(details).reduce((s, r) => s + (num(r?.wastedBytes) ?? 0), 0)
  return Math.round(total)
}

/**
 * @param {any} lhr
 * @returns {import('../types.mjs').Finding[]}
 */
export function findingsForPage(lhr) {
  const findings = []
  for (const [id, group] of auditGroups(lhr)) {
    if (!group) continue
    const audit = lhr.audits?.[id]
    if (!audit || !FINDING_MODES.has(audit.scoreDisplayMode)) continue
    if (audit.score === null || audit.score === undefined || audit.score >= 0.9) continue
    const ms = audit.metricSavings ?? {}
    const savings = { lcp: ms.LCP ?? 0, tbt: ms.TBT ?? 0, fcp: ms.FCP ?? 0, cls: ms.CLS ?? 0, bytes: bytesSaved(audit.details) }
    const rule = RULES[id]
    const evidence = []
    for (const row of rowsOf(audit.details)) {
      const e = evidenceOf(row)
      if (e) evidence.push(e)
      if (evidence.length === MAX_EVIDENCE) break
    }
    findings.push({
      id,
      category: rule?.category ?? (group === 'performance' ? 'other' : group),
      group,
      title: rule?.title ?? audit.title,
      advice: rule?.advice ?? stripLinks(audit.description),
      score: audit.score,
      savings,
      impact: impactOf(savings),
      evidence,
    })
  }
  return findings
}

/**
 * @param {any} lhr
 * @returns {import('../types.mjs').PageFacts}
 */
export function pageFacts(lhr) {
  const audits = lhr.audits ?? {}
  let lcpElement = null
  const lcpPhases = []
  const lcp = audits['lcp-breakdown-insight']?.details ?? audits['largest-contentful-paint-element']?.details
  for (const item of lcp?.items ?? []) {
    if (item?.type === 'node' && !lcpElement) lcpElement = { selector: item.selector ?? '', snippet: item.snippet ?? '' }
    if (item?.type === 'table') {
      for (const row of item.items ?? []) {
        if (row?.node && !lcpElement) lcpElement = { selector: row.node.selector ?? '', snippet: row.node.snippet ?? '' }
        const phase = row?.subpart ?? row?.phase
        const ms = num(row?.duration) ?? num(row?.timing)
        if (phase && ms !== undefined) lcpPhases.push({ phase, ms: Math.round(ms) })
      }
    }
  }
  const scripts = [...(audits['bootup-time']?.details?.items ?? [])]
    .filter((r) => typeof r?.url === 'string' && num(r.total) !== undefined)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)
    .map((r) => ({ url: r.url, ms: Math.round(r.total), source: null }))
  return { lcpElement, lcpPhases, topScripts: scripts }
}
