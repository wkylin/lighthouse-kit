// 对一个轮次做规则分析，写出 analysis.json。
import fs from 'node:fs/promises'
import path from 'node:path'
import { readRoundMeta, pageSlug } from '../round.mjs'
import { mergeFindings } from './merge.mjs'
import { findingsForPage, pageFacts } from './normalize.mjs'
import { createSourceResolver } from './sourcemap.mjs'
import { aggregateMemory, memoryForSummary } from '../memory-summary.mjs'
import { memoryFindingsForPage } from './memory.mjs'

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

/** @returns {Promise<import('../types.mjs').PageSummary>} */
async function readSummary(roundDir, page) {
  const slug = pageSlug(page)
  try {
    return await readJson(path.join(roundDir, 'pages', slug, 'summary.json'))
  } catch {
    return { page, slug, ok: false, error: '没有扫描结果', finalUrl: null, runs: [], representative: null, median: null }
  }
}

// 采集器的完整空记录仍能证明尝试过采集，不能被当作没有内存功能的旧轮次。
const emptyMemoryCollection = (memory) => ['heapSnapshot', 'allocationTimeline', 'allocationSampling', 'detachedElements']
  .every((key) => Object.hasOwn(memory, key) && memory[key] === null) &&
  typeof memory.collectedAt === 'string' && Number.isFinite(Date.parse(memory.collectedAt))

// 早期摘要可能未内联逐次内存数据。只补缺失字段，显式 null 仍表示采集失败。
async function restoreRunMemory(roundDir, summary) {
  if (!summary.ok) return
  for (const run of summary.runs ?? []) {
    if (!run.ok || Object.hasOwn(run, 'memory') || !Number.isInteger(run.index) || run.index < 1) continue
    try {
      const memory = await readJson(path.join(roundDir, 'pages', summary.slug, `run-${run.index}`, 'memory.json'))
      if (memory && typeof memory === 'object' && !Array.isArray(memory) &&
        (emptyMemoryCollection(memory) || aggregateMemory([{ ok: true, memory }]))) run.memory = memory
    } catch {
      // 缺失、损坏或结构不合法的内存文件不影响其他运行及 Lighthouse 分析。
    }
  }
}

/**
 * @param {string} roundDir
 * @param {import('../types.mjs').Config} config
 * @returns {Promise<import('../types.mjs').Analysis>}
 */
export async function analyzeRound(roundDir, config) {
  const meta = await readRoundMeta(roundDir)
  let basePath = '/'
  try {
    basePath = new URL(meta.origin).pathname
  } catch {}
  const resolve = await createSourceResolver({ manifest: config.sourceMap.manifest, maps: config.sourceMap.maps, root: config.root, basePath })
  const pages = []
  const perPage = []
  /** @type {Record<string, import('../types.mjs').PageFacts>} */
  const facts = {}
  for (const page of meta.pagesRequested) {
    const summary = await readSummary(roundDir, page)
    // 早期 summary.memory 来自代表运行。把原始观测归还该运行，以保留报告证据链接。
    if (summary.memory && !Object.hasOwn(summary.memory, 'runs')) {
      const representative = summary.runs?.find((r) => r.ok && r.index === summary.representative)
      if (representative && !Object.hasOwn(representative, 'memory')) representative.memory = summary.memory
    }
    await restoreRunMemory(roundDir, summary)
    const memory = memoryForSummary(summary)
    if (memory || Object.hasOwn(summary, 'memory') || Object.hasOwn(summary.median ?? {}, 'memory')) {
      summary.memory = memory
      if (summary.median) summary.median.memory = memory
    }
    pages.push(summary)
    const findings = memoryFindingsForPage(memory)
    perPage.push({ page, findings })
    if (!summary.ok || summary.representative == null) continue
    let lhr
    try {
      lhr = await readJson(path.join(roundDir, 'pages', summary.slug, `run-${summary.representative}`, 'lighthouse.json'))
    } catch {
      continue
    }
    findings.push(...findingsForPage(lhr))
    for (const finding of findings) for (const e of finding.evidence) if (e.url) e.source = resolve(e.url)
    const pf = pageFacts(lhr)
    for (const s of pf.topScripts) s.source = resolve(s.url)
    facts[page] = pf
  }
  /** @type {import('../types.mjs').Analysis} */
  const analysis = { round: meta, pages, findings: mergeFindings(perPage), facts, aiSent: [] }
  await writeAnalysis(roundDir, analysis)
  return analysis
}

export async function writeAnalysis(roundDir, analysis) {
  await fs.writeFile(path.join(roundDir, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`)
}

export async function readAnalysis(roundDir) {
  return readJson(path.join(roundDir, 'analysis.json'))
}
