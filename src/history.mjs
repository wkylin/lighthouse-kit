// 每轮的小汇总：<outDir>/history/<roundId>.json，供负责人版对比与趋势。
import fs from 'node:fs/promises'
import path from 'node:path'

const historyDir = (outDir) => path.join(outDir, 'history')

/**
 * @param {import('./types.mjs').RoundMeta} meta
 * @param {import('./types.mjs').PageSummary[]} pages
 * @returns {import('./types.mjs').HistoryEntry}
 */
export function historyEntryFromRound(meta, pages) {
  /** @type {Record<string, {scores: any, metrics: any}>} */
  const byPage = {}
  for (const p of pages) if (p.ok && p.median) byPage[p.page] = { scores: p.median.scores, metrics: p.median.metrics }
  return {
    roundId: meta.id,
    name: meta.name,
    partial: meta.partial,
    origin: meta.origin,
    lighthouseVersion: meta.lighthouseVersion,
    visit: meta.visit,
    formFactor: meta.formFactor,
    runs: meta.runs,
    git: meta.git,
    buildFingerprint: meta.buildFingerprint,
    finishedAt: meta.finishedAt,
    pages: byPage,
  }
}

export async function appendHistory(outDir, entry) {
  await fs.mkdir(historyDir(outDir), { recursive: true })
  await fs.writeFile(path.join(historyDir(outDir), `${entry.roundId}.json`), `${JSON.stringify(entry, null, 2)}\n`)
}

/** @returns {Promise<import('./types.mjs').HistoryEntry[]>} 按结束时间升序 */
export async function readHistory(outDir) {
  let files
  try {
    files = await fs.readdir(historyDir(outDir))
  } catch {
    return []
  }
  const entries = []
  for (const f of files.filter((n) => n.endsWith('.json'))) {
    try {
      entries.push(JSON.parse(await fs.readFile(path.join(historyDir(outDir), f), 'utf8')))
    } catch {
      // 损坏的条目忽略
    }
  }
  return sortEntries(entries)
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => a.finishedAt.localeCompare(b.finishedAt) || a.roundId.localeCompare(b.roundId))
}

const major = (v) => String(v ?? '').split('.')[0]

function comparable(a, b) {
  return (
    !a.partial &&
    !b.partial &&
    a.origin === b.origin &&
    major(a.lighthouseVersion) === major(b.lighthouseVersion) &&
    a.visit === b.visit &&
    a.formFactor === b.formFactor
  )
}

/**
 * 最近一条可比的、比 current 更早结束的记录。
 * @returns {import('./types.mjs').HistoryEntry|null}
 */
export function comparableBaseline(entries, current) {
  if (current.partial) return null
  const earlier = sortEntries(entries).filter((e) => e.roundId !== current.roundId && e.finishedAt < current.finishedAt && comparable(e, current))
  return earlier.at(-1) ?? null
}

/**
 * 最多 limit 条可比记录（含 current，按时间升序，以 current 结尾）。
 * @returns {import('./types.mjs').HistoryEntry[]}
 */
export function trend(entries, current, limit = 6) {
  if (current.partial) return []
  const earlier = sortEntries(entries).filter((e) => e.roundId !== current.roundId && e.finishedAt < current.finishedAt && comparable(e, current))
  return [...earlier, current].slice(-limit)
}
