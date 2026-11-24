// 对一个轮次做规则分析，写出 analysis.json。
import fs from 'node:fs/promises'
import path from 'node:path'
import { readRoundMeta, pageSlug } from '../round.mjs'
import { mergeFindings } from './merge.mjs'
import { findingsForPage, pageFacts } from './normalize.mjs'
import { createSourceResolver } from './sourcemap.mjs'

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
    pages.push(summary)
    if (!summary.ok || summary.representative == null) continue
    let lhr
    try {
      lhr = await readJson(path.join(roundDir, 'pages', summary.slug, `run-${summary.representative}`, 'lighthouse.json'))
    } catch {
      continue
    }
    const findings = findingsForPage(lhr)
    for (const finding of findings) for (const e of finding.evidence) if (e.url) e.source = resolve(e.url)
    perPage.push({ page, findings })
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
